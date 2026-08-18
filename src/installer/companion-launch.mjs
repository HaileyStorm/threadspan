import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { access, lstat, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnManagedChild } from "../core/managed-process.mjs";
import { encodeResumeCapsule, verifyResumeCapsule } from "./update-check.mjs";

const STAGED_GUI_ROUTES = new Map([
  ["/threadspan/install/", ["ui/install.html", "text/html; charset=utf-8"]],
  ["/threadspan/install/index.html", ["ui/install.html", "text/html; charset=utf-8"]],
  ["/threadspan/install/install.css", ["ui/install.css", "text/css; charset=utf-8"]],
  ["/threadspan/install/install.js", ["ui/install.js", "text/javascript; charset=utf-8"]],
  ["/threadspan/mark.svg", ["ui/mark.svg", "image/svg+xml"]],
]);
const RELAUNCH_PAYLOAD_ENV = "THREADSPAN_STAGED_GUI_RELAUNCH";

export async function discoverCompanionBrowser(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const candidates = options.candidates ?? defaultCandidates(platform, environment);
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`No app-window-capable browser was found for ${platform}`);
}

export function createCompanionLaunchPlan(options) {
  if (typeof options?.browserPath !== "string" || !options.browserPath) throw new TypeError("browserPath is required");
  const url = new URL(String(options.url));
  if (!isLoopbackHost(url.hostname)) throw new TypeError("Companion window URL must be loopback-only");
  if (!url.pathname.startsWith("/threadspan/")) throw new TypeError("Companion window URL must target the Threadspan UI");
  return Object.freeze({
    command: options.browserPath,
    args: [`--app=${url.toString()}`, "--new-window"],
    url: url.toString(),
  });
}

export async function launchCompanionWindow(options) {
  const browserPath = options.browserPath ?? await discoverCompanionBrowser(options);
  const plan = createCompanionLaunchPlan({ browserPath, url: options.url });
  const spawnChild = options.spawnChild ?? spawnManagedChild;
  const child = spawnChild(plan.command, plan.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    killTree: false,
    ...(options.environment ? { env: options.environment } : {}),
  });
  await waitForSpawn(child);
  child.unref();
  return { ...plan, pid: child.pid };
}

/** Build an argv-safe helper launch; the session capsule stays out of argv and process listings. */
export function createUpdatedInstallerRelaunchPlan(options) {
  const stagedRoot = resolveRequiredPath(options?.stagedRoot, "stagedRoot");
  const daemonBaseUrl = normalizeLoopbackBase(options?.daemonBaseUrl);
  const resumeCapsule = verifyResumeCapsule(options?.resumeCapsule);
  const verifiedAssets = normalizeVerifiedAssets(options?.verifiedAssets);
  const helperToken = options.helperToken ?? randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(helperToken)) throw new TypeError("Updated installer helper token is invalid");
  const modulePath = fileURLToPath(import.meta.url);
  const environment = safeRelaunchEnvironment(options.environment ?? process.env);
  environment[RELAUNCH_PAYLOAD_ENV] = Buffer.from(JSON.stringify({
    stagedRoot,
    daemonBaseUrl,
    browserPath: options.browserPath ?? null,
    helperToken,
    resumeCapsule,
    verifiedAssets,
  })).toString("base64url");
  return Object.freeze({
    command: process.execPath,
    args: [modulePath, "--serve-staged-gui"],
    environment,
    stagedRoot,
  });
}

/** Launch a detached loopback helper that serves only checksum-verified staged GUI assets. */
export async function relaunchUpdatedInstaller(options) {
  const plan = createUpdatedInstallerRelaunchPlan(options);
  const child = spawnManagedChild(plan.command, plan.args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    killTree: false,
    cwd: plan.stagedRoot,
    env: plan.environment,
  });
  const ready = await waitForHelperReady(child);
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  return { pid: child.pid, stagedRoot: plan.stagedRoot, helperPort: ready.port };
}

/** Pin any absolute-form or origin-form helper request back to the configured loopback daemon. */
export function resolveInstallerProxyUrl(requestTarget, daemonBaseUrl) {
  const parsed = requestTarget instanceof URL ? requestTarget : new URL(String(requestTarget), "http://127.0.0.1");
  if (!parsed.pathname.startsWith("/threadspan/install/api/")) throw new TypeError("Staged helper may proxy only installer API paths");
  return new URL(`${parsed.pathname}${parsed.search}`, normalizeLoopbackBase(daemonBaseUrl));
}

function defaultCandidates(platform, environment) {
  if (platform === "win32") {
    return [
      `${environment.LOCALAPPDATA ?? ""}\\Vivaldi\\Application\\vivaldi.exe`,
      `${environment.ProgramFiles ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
      `${environment["ProgramFiles(x86)"] ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ].filter((value) => !value.startsWith("\\"));
  }
  return ["/usr/bin/vivaldi-stable", "/usr/bin/vivaldi", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
}

function isLoopbackHost(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

async function runStagedGuiHelper() {
  const encoded = process.env[RELAUNCH_PAYLOAD_ENV];
  if (!encoded) throw new Error("Staged GUI relaunch payload is missing");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const capsule = verifyResumeCapsule(payload.resumeCapsule);
  const root = resolveRequiredPath(payload.stagedRoot, "stagedRoot");
  const daemonBaseUrl = normalizeLoopbackBase(payload.daemonBaseUrl);
  const verifiedAssets = normalizeVerifiedAssets(payload.verifiedAssets);
  const helperToken = String(payload.helperToken ?? "");
  if (!/^[0-9a-f]{64}$/.test(helperToken)) throw new Error("Staged GUI helper token is invalid");
  delete process.env[RELAUNCH_PAYLOAD_ENV];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const asset = STAGED_GUI_ROUTES.get(url.pathname);
      if (request.method === "GET" && asset) {
        const [relativePath, contentType] = asset;
        const bytes = await readVerifiedAsset(root, relativePath, verifiedAssets[relativePath]);
        response.writeHead(200, {
          "content-type": contentType,
          "content-length": bytes.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(bytes);
        return;
      }
      if (url.pathname.startsWith("/threadspan/install/api/")) {
        authorizeHelper(request, helperToken);
        const terminal = await proxyInstallerApi(request, response, daemonBaseUrl, capsule.nonce, url);
        if (terminal) setTimeout(() => server.close(), 250).unref?.();
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { message } }));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Staged GUI helper did not bind a TCP port");
  const resume = encodeURIComponent(encodeResumeCapsule(capsule));
  const session = encodeURIComponent(capsule.nonce);
  const helper = encodeURIComponent(helperToken);
  const url = `http://127.0.0.1:${address.port}/threadspan/install/#session=${session}&resume=${resume}&helper=${helper}`;
  const browserEnvironment = safeRelaunchEnvironment(process.env);
  await launchCompanionWindow({
    url,
    browserPath: payload.browserPath ?? undefined,
    environment: browserEnvironment,
  });
  const expiry = setTimeout(() => server.close(), 2 * 60 * 60_000);
  expiry.unref?.();
  return { port: address.port };
}

async function proxyInstallerApi(request, response, daemonBaseUrl, nonce, requestUrl) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("Installer API request is too large");
    chunks.push(chunk);
  }
  const upstreamUrl = resolveInstallerProxyUrl(requestUrl, daemonBaseUrl);
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers: {
      "x-threadspan-install-session": nonce,
      ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
    },
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
  return upstream.status === 410 || requestUrl.pathname.endsWith("/close");
}

function authorizeHelper(request, expected) {
  const supplied = String(request.headers["x-threadspan-helper-token"] ?? "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("Staged installer helper capability is missing or invalid");
}

function waitForHelperReady(child, timeoutMs = 20_000) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    let errors = "";
    const timeout = setTimeout(() => finish(new Error("Updated installer helper did not become ready")), timeoutMs);
    timeout.unref?.();
    const onOutput = (chunk) => {
      output += String(chunk);
      if (output.length > 4096) return finish(new Error("Updated installer helper emitted an oversized readiness response"));
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(output.slice(0, newline));
        if (value.ready !== true || !Number.isSafeInteger(value.port)) throw new Error(value.error ?? "Updated installer helper failed before readiness");
        finish(null, value);
      } catch (error) {
        finish(error);
      }
    };
    const onErrorOutput = (chunk) => { errors = `${errors}${String(chunk)}`.slice(-2048); };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(new Error(`Updated installer helper exited before readiness (code ${code})${errors ? `: ${errors}` : ""}`));
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrorOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        try { child.kill(); } catch {}
        rejectReady(error);
      } else resolveReady(value);
    };
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrorOutput);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForSpawn(child) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolveSpawn();
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      rejectSpawn(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function readVerifiedAsset(root, relativePath, expectedSha256) {
  const path = resolve(root, relativePath);
  assertBoundedPath(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Staged GUI asset '${relativePath}' is not a regular file`);
  const bytes = await readFile(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new Error(`Staged GUI asset '${relativePath}' changed after verification`);
  return bytes;
}

function normalizeVerifiedAssets(value) {
  const output = {};
  for (const [, [relativePath]] of STAGED_GUI_ROUTES) {
    const digest = value?.[relativePath];
    if (!/^[0-9a-f]{64}$/.test(String(digest ?? ""))) throw new TypeError(`Missing verified digest for '${relativePath}'`);
    output[relativePath] = digest;
  }
  return Object.freeze(output);
}

function normalizeLoopbackBase(value) {
  const url = new URL(String(value));
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new TypeError("Updated installer daemon URL must be an uncredentialed loopback HTTP origin");
  }
  return url.origin;
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value || !isAbsolute(value)) throw new TypeError(`${label} must be an absolute path`);
  return resolve(value);
}

function assertBoundedPath(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new TypeError("Staged GUI asset escapes its verified root");
}

function safeRelaunchEnvironment(environment) {
  const allowed = [
    "PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "LANG", "LC_ALL",
  ];
  return Object.fromEntries(allowed.filter((key) => typeof environment[key] === "string").map((key) => [key, environment[key]]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--serve-staged-gui") {
  try {
    const ready = await runStagedGuiHelper();
    process.stdout.write(`${JSON.stringify({ ready: true, ...ready })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ready: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}
