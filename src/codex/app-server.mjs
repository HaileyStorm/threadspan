import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { toCodexModelInfo } from "./catalog.mjs";
import { normalizeManagedCommand } from "../core/managed-process.mjs";
import { bindExecutable, resolveExecutablePath, verifyExecutableBinding } from "../core/executable.mjs";

/** Discover the current signed-in Codex native picker catalog through App Server. */
export async function discoverNativeCodexCatalog(options = {}) {
  const command = options.command ?? "codex";
  const commandArgs = options.commandArgs ?? ["app-server", "--stdio"];
  const timeoutMs = positiveInteger(options.timeoutMs, 20_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 8 * 1024 * 1024);
  const executable = options.platform === "win32" || (options.platform === undefined && process.platform === "win32")
    ? await resolveExecutablePath(command, { platform: "win32", environment: options.environment ?? process.env, cwd: options.cwd }) ?? command
    : command;
  const normalized = normalizeManagedCommand(executable, commandArgs, {
    platform: options.platform ?? process.platform,
    environment: options.environment ?? process.env,
  });
  const child = spawn(normalized.command, normalized.args, {
    cwd: options.cwd,
    env: options.environment ?? process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let settled = false;

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Codex App Server model discovery timed out after ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    child.once("error", (error) => finish(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      try { errors = boundedAppend(errors, chunk, 64 * 1024); }
      catch (error) { finish(error); }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try { output = boundedAppend(output, chunk, maxOutputBytes); }
      catch (error) { finish(error); return; }
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2) {
          if (message.error) finish(new Error(`Codex App Server model/list failed: ${message.error.message ?? JSON.stringify(message.error)}`));
          else finish(undefined, message.result?.data ?? []);
          return;
        }
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`Codex App Server exited before model/list completed (${signal ?? code}); ${errors.slice(0, 1000)}`));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "threadspan", version: "0.3.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} })}\n`);
  });

  if (!Array.isArray(result)) throw new TypeError("Codex App Server model/list did not return an array");
  return { models: result.map(appServerModelToCatalog).filter(Boolean) };
}

/** Execute one public App Server v2 request in a bounded temporary process. */
export async function callCodexAppServer(method, params = {}, options = {}) {
  return (await callCodexAppServerWithReceipt(method, params, options)).result;
}

/** Execute one public App Server v2 request and return a source-bound process receipt. */
export async function callCodexAppServerWithReceipt(method, params = {}, options = {}) {
  const response = await callCodexAppServerBatchWithReceipt([{ method, params }], options);
  return { result: response.results[0], receipt: response.receipt };
}

/** Execute related App Server v2 requests in one source-bound process. */
export async function callCodexAppServerBatchWithReceipt(requests, options = {}) {
  const normalizedRequests = normalizeRequests(requests);
  const command = options.command ?? "codex";
  const commandArgs = options.commandArgs ?? ["app-server", "--stdio"];
  const environment = options.environment ?? process.env;
  const executable = await bindExecutable(command, {
    platform: options.platform ?? process.platform,
    environment,
    cwd: options.cwd,
    versionArgs: options.versionArgs,
    versionTimeoutMs: options.versionTimeoutMs,
  });
  const codexHome = await canonicalDirectory(environment.CODEX_HOME, "CODEX_HOME");
  const normalized = normalizeManagedCommand(executable.path, commandArgs, {
    platform: options.platform ?? process.platform,
    environment,
  });
  const child = spawn(normalized.command, normalized.args, {
    cwd: options.cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timeoutMs = positiveInteger(options.timeoutMs, 20_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, 8 * 1024 * 1024);
  let pending = "";
  let errors = "";
  let settled = false;
  const results = new Array(normalizedRequests.length);
  let remaining = normalizedRequests.length;
  const startedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const methods = normalizedRequests.map((request) => request.method);
    const timer = setTimeout(() => { void finish(new Error(`Codex App Server ${methods.join(", ")} timed out after ${timeoutMs} ms`)); }, timeoutMs);
    timer.unref?.();
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else {
        try {
          await verifyExecutableBinding(executable);
          const completedAt = new Date().toISOString();
          const receipt = {
            kind: "codex-app-server-process",
            methods,
            ...(methods.length === 1 ? { method: methods[0] } : {}),
            processId: child.pid ?? null,
            startedAt,
            completedAt,
            executable,
            argv: [executable.path, ...commandArgs],
            spawnArgv: [normalized.command, ...normalized.args],
            codexHome,
            executableVerifiedAfterRead: true,
            resultDigest: createHash("sha256").update(stableStringify(results)).digest("hex"),
          };
          receipt.id = createHash("sha256").update(stableStringify(receipt)).digest("hex");
          resolve({ results, receipt });
        } catch (verificationError) {
          reject(verificationError);
        }
      }
    };
    child.once("error", (error) => { void finish(error); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      try { errors = boundedAppend(errors, chunk, 64 * 1024); }
      catch (error) { void finish(error); }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      try { pending = boundedAppend(pending, chunk, maxOutputBytes); }
      catch (error) { void finish(error); return; }
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!Number.isSafeInteger(message.id) || message.id < 2 || message.id >= normalizedRequests.length + 2) continue;
        const index = message.id - 2;
        if (results[index] !== undefined) continue;
        if (message.error) {
          void finish(new Error(`Codex App Server ${normalizedRequests[index].method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
          return;
        }
        results[index] = message.result;
        remaining -= 1;
        if (remaining === 0) void finish();
      }
    });
    child.once("exit", (code, signal) => {
      if (!settled) void finish(new Error(`Codex App Server exited before ${methods.join(", ")} completed (${signal ?? code}); ${errors.slice(0, 1000)}`));
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "threadspan", version: "0.4.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
    normalizedRequests.forEach((request, index) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: index + 2, method: request.method, params: request.params })}\n`);
    });
  });
}

function normalizeRequests(value) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("Codex App Server requests must be a non-empty array");
  return value.map((request) => {
    const method = typeof request?.method === "string" ? request.method.trim() : "";
    if (!method) throw new TypeError("Codex App Server request method is required");
    const params = request.params ?? {};
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new TypeError(`Codex App Server ${method} params must be an object`);
    return { method, params };
  });
}

async function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required for a source-bound Codex App Server read`);
  const path = await realpath(value);
  if (!(await stat(path)).isDirectory()) throw new Error(`${label} must resolve to a directory`);
  return path;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/** Convert App Server's public camel-case model record to model-catalog ModelInfo. */
export function appServerModelToCatalog(model) {
  const slug = String(model?.model ?? model?.id ?? "").trim();
  if (!slug) return null;
  const levels = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((entry) => ({ effort: entry.reasoningEffort, description: entry.description }))
    : [];
  const base = toCodexModelInfo({
    id: slug,
    owned_by: "openai",
    metadata: {
      bridge_mode: "integrated",
      provider: "openai",
      upstream_model: slug,
      supported_reasoning_levels: levels,
      default_reasoning_level: model.defaultReasoningEffort,
      images: model.inputModalities?.includes("image") === true,
    },
  });
  return {
    ...base,
    slug,
    display_name: String(model.displayName ?? slug),
    description: String(model.description ?? "Native Codex model."),
    visibility: model.hidden === true ? "hide" : "list",
    priority: model.isDefault === true ? 1000 : 500,
    upgrade: model.upgrade ?? null,
    availability_nux: model.availabilityNux ?? null,
    additional_speed_tiers: model.additionalSpeedTiers ?? [],
    service_tiers: model.serviceTiers ?? [],
    default_service_tier: model.defaultServiceTier ?? null,
    input_modalities: Array.isArray(model.inputModalities) ? model.inputModalities : ["text"],
    model_specialty: model.modelSpecialty ?? null,
  };
}

function boundedAppend(current, chunk, maximum) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > maximum) throw new Error(`Codex App Server output exceeded ${maximum} bytes`);
  return next;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
