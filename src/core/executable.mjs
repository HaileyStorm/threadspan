import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { runCapturedProcess } from "./managed-process.mjs";

/**
 * Resolve an executable through an exact path or PATH/PATHEXT lookup.
 * @param {unknown} command Executable name or path.
 * @param {{platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv, cwd?: string}} [options] Resolution overrides.
 * @returns {Promise<string|undefined>}
 */
export async function resolveExecutablePath(command, options = {}) {
  if (typeof command !== "string" || command.length === 0) return undefined;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const accessMode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  const expanded = expandHomePath(command);
  const hasPathSeparator = expanded.includes("/") || expanded.includes("\\");
  const candidates = [];

  const configuredExtensions = platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const extensions = platform === "win32" && extname(expanded).length === 0
    ? (hasPathSeparator || isAbsolute(expanded) ? ["", ...configuredExtensions] : [...configuredExtensions, ""])
    : [""];

  if (isAbsolute(expanded) || hasPathSeparator) {
    const base = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    for (const extension of extensions) candidates.push(`${base}${extension}`);
  } else {
    const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
    const pathSeparator = platform === "win32" ? ";" : ":";
    const pathEntries = pathValue.split(pathSeparator).map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
    for (const directory of pathEntries) {
      for (const extension of extensions) candidates.push(resolve(directory, `${expanded}${extension}`));
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, accessMode);
      return candidate;
    } catch {}
  }
  return undefined;
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(homedir(), value.slice(2));
  return value;
}

/** Calculate a file SHA-256 digest without loading the complete executable into memory. */
export function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

/** Run a bounded non-consuming version command and return trimmed combined output. */
export async function readExecutableVersion(executable, options = {}) {
  const result = await runCapturedProcess({
    command: executable,
    args: options.args ?? ["--version"],
    timeoutMs: options.timeoutMs ?? 5000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
    env: options.env ?? process.env,
  });
  if (result.exitCode !== 0) throw new Error(`Version command exited with code ${result.exitCode}`);
  return (result.stdout || result.stderr).trim();
}

/** Resolve and bind one canonical executable to stable content and version evidence. */
export async function bindExecutable(command, options = {}) {
  const resolved = await resolveExecutablePath(command, options);
  if (!resolved) throw new Error(`Executable '${command}' was not found`);
  const path = await realpath(resolved);
  if ((options.platform ?? process.platform) === "win32" && [".bat", ".cmd"].includes(extname(path).toLowerCase())) {
    throw new Error(`Authoritative executable binding refuses indirect Windows launcher '${path}'`);
  }
  const before = await executableMetadata(path);
  if (!before.isFile) throw new Error(`Executable '${path}' is not a regular file`);
  const sha256 = await sha256File(path);
  const version = await readExecutableVersion(path, {
    args: options.versionArgs,
    timeoutMs: options.versionTimeoutMs,
    env: options.environment,
  });
  if (!version) throw new Error(`Executable '${path}' returned an empty version`);
  const after = await executableMetadata(path);
  if (metadataDigest(before) !== metadataDigest(after) || await sha256File(path) !== sha256) {
    throw new Error(`Executable '${path}' changed during source binding`);
  }
  return Object.freeze({ path, sha256, version, metadataDigest: metadataDigest(after) });
}

/** Fail closed unless a previously bound executable is unchanged after an authoritative read. */
export async function verifyExecutableBinding(binding) {
  if (!binding?.path || !binding?.sha256 || !binding?.metadataDigest) throw new TypeError("Executable binding is incomplete");
  const path = await realpath(binding.path);
  const metadata = await executableMetadata(path);
  const sha256 = await sha256File(path);
  if (path !== binding.path || metadataDigest(metadata) !== binding.metadataDigest || sha256 !== binding.sha256) {
    throw new Error(`Executable '${binding.path}' changed during authoritative read`);
  }
  return true;
}

async function executableMetadata(path) {
  const value = await stat(path, { bigint: true });
  return {
    isFile: value.isFile(),
    device: String(value.dev),
    inode: String(value.ino),
    mode: String(value.mode),
    size: String(value.size),
    modifiedNanoseconds: String(value.mtimeNs),
    changedNanoseconds: String(value.ctimeNs),
  };
}

function metadataDigest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
