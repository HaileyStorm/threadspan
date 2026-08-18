import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname } from "node:path";

const TERMINATIONS = new WeakMap();

/**
 * Spawn a child in its own POSIX process group so cancellation can terminate descendants.
 * Windows process trees are terminated with `taskkill` by `terminateProcessTree`.
 *
 * @param {string} command Executable path or name.
 * @param {string[]} args Argument vector.
 * @param {import("node:child_process").SpawnOptionsWithoutStdio & {killTree?: boolean, expectedExecutableSha256?: string}} [options] Spawn options.
 * @returns {import("node:child_process").ChildProcessWithoutNullStreams}
 */
export function spawnManagedChild(command, args, options = {}) {
  const { killTree = true, expectedExecutableSha256, ...spawnOptions } = options;
  const normalized = normalizeManagedCommand(command, args, {
    platform: process.platform,
    environment: spawnOptions.env ?? process.env,
    expectedExecutableSha256,
  });
  return spawn(normalized.command, normalized.args, {
    ...spawnOptions,
    shell: normalized.viaCommandShim ? false : spawnOptions.shell,
    detached: spawnOptions.detached ?? (killTree && process.platform !== "win32"),
    stdio: spawnOptions.stdio ?? ["pipe", "pipe", "pipe"],
  });
}

/**
 * Route a Windows PowerShell command shim through powershell.exe without enabling a shell.
 * A `.cmd` launcher is never evaluated: its canonical sibling `.ps1` file becomes the executable
 * artifact, and the original argv remains distinct from PowerShell's own fixed arguments.
 *
 * @param {string} command Executable path or name.
 * @param {string[]} args Argument vector.
 * @param {{platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv, expectedExecutableSha256?: string}} [options] Platform inputs.
 * @returns {{command:string,args:string[],executable:string,viaCommandShim:boolean}}
 */
export function normalizeManagedCommand(command, args = [], options = {}) {
  const platform = options.platform ?? process.platform;
  const requestedCommand = String(command);
  const extension = extname(requestedCommand).toLowerCase();
  if (platform === "win32" && extension === ".bat") {
    throw new TypeError("Windows .bat launchers are not supported; configure a native executable or npm .ps1 shim");
  }

  let executable = requestedCommand;
  let viaCommandShim = false;
  if (platform === "win32" && extension === ".cmd") {
    const canonicalLauncher = canonicalRegularFile(requestedCommand, "Windows .cmd launcher", { allowSymbolicLink: true });
    if (extname(canonicalLauncher).toLowerCase() !== ".cmd") {
      throw new TypeError(`Windows .cmd launcher resolves to a non-.cmd file: ${canonicalLauncher}`);
    }
    executable = canonicalRegularFile(`${canonicalLauncher.slice(0, -4)}.ps1`, "sibling PowerShell shim");
    viaCommandShim = true;
  } else if (platform === "win32" && extension === ".ps1") {
    executable = canonicalRegularFile(requestedCommand, "PowerShell shim");
    viaCommandShim = true;
  }

  if (options.expectedExecutableSha256) assertExecutableSha256(executable, options.expectedExecutableSha256);
  if (!viaCommandShim) {
    return { command, args: [...args], executable, viaCommandShim: false };
  }

  const environment = options.environment ?? process.env;
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const powershell = systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : "powershell.exe";
  return {
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable, ...args],
    executable,
    viaCommandShim: true,
  };
}

/** Resolve a launch artifact while rejecting unsafe or non-file PowerShell shim targets. */
function canonicalRegularFile(path, label, options = {}) {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throw new TypeError(`${label} does not exist: ${path}`, { cause: error });
  }
  if (entry.isSymbolicLink() && options.allowSymbolicLink !== true) {
    throw new TypeError(`${label} must not be a symbolic link: ${path}`);
  }

  let canonical;
  let target;
  try {
    canonical = realpathSync(path);
    target = statSync(canonical);
  } catch (error) {
    throw new TypeError(`${label} could not be resolved safely: ${path}`, { cause: error });
  }
  if (!target.isFile()) throw new TypeError(`${label} is not a regular file: ${canonical}`);
  return canonical;
}

/** Recheck a preflight digest immediately before spawning the selected artifact. */
function assertExecutableSha256(executable, expected) {
  let actual;
  try {
    actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
  } catch (error) {
    throw new TypeError(`Could not re-hash executable '${executable}' before launch`, { cause: error });
  }
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new TypeError(`Executable SHA-256 '${actual}' no longer matches the verified preflight artifact`);
  }
}

/**
 * Terminate a child and its descendants with a bounded graceful-then-forced sequence.
 * Calls are idempotent for the same child.
 *
 * @param {import("node:child_process").ChildProcess} child Child process.
 * @param {{graceMs?: number, platform?: NodeJS.Platform, killTree?: boolean}} [options] Termination options.
 * @returns {Promise<void>}
 */
export function terminateProcessTree(child, options = {}) {
  const existing = TERMINATIONS.get(child);
  if (existing) return existing;
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  const operation = terminateProcessTreeOnce(child, options).finally(() => TERMINATIONS.delete(child));
  TERMINATIONS.set(child, operation);
  return operation;
}

/**
 * Terminate a live managed child, then reap POSIX descendants that outlive its group leader.
 * Windows retains `terminateProcessTree` semantics because a completed leader no longer provides
 * a safe process-tree identity for a second `taskkill` pass.
 *
 * @param {import("node:child_process").ChildProcess} child Child process.
 * @param {{graceMs?: number, platform?: NodeJS.Platform, killTree?: boolean}} [options] Cleanup options.
 * @returns {Promise<void>}
 */
export async function reapManagedProcessTree(child, options = {}) {
  const platform = options.platform ?? process.platform;
  const killTree = options.killTree !== false;
  if (child.exitCode === null && child.signalCode === null) {
    await terminateProcessTree(child, { ...options, platform, killTree });
  }
  if (platform !== "win32" && killTree) {
    await reapExitedProcessGroup(child, { graceMs: options.graceMs, platform });
  }
}

/** Execute the process-tree termination sequence once. */
async function terminateProcessTreeOnce(child, options) {
  const graceMs = options.graceMs ?? 2000;
  const platform = options.platform ?? process.platform;
  const killTree = options.killTree !== false;
  const exited = waitForExit(child);

  if (platform === "win32" && child.pid && killTree) {
    await taskkill(child.pid, false).catch(() => child.kill("SIGTERM"));
  } else if (platform !== "win32" && killTree) {
    signalPosixProcessGroup(child, "SIGTERM");
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }

  if (await settlesWithin(exited, graceMs)) return;

  if (platform === "win32" && child.pid && killTree) {
    await taskkill(child.pid, true).catch(() => child.kill("SIGKILL"));
  } else if (platform !== "win32" && killTree) {
    signalPosixProcessGroup(child, "SIGKILL");
  } else {
    try { child.kill("SIGKILL"); } catch {}
  }
  await settlesWithin(exited, Math.max(250, graceMs)).catch(() => false);
}

/** Signal a detached POSIX process group, falling back to the direct child. */
function signalPosixProcessGroup(child, signal) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      try { child.kill(signal); } catch {}
      return;
    }
  }
  try { child.kill(signal); } catch {}
}

/** Run Windows taskkill without inheriting stdio. */
function taskkill(pid, force) {
  return new Promise((resolve, reject) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    killer.once("error", reject);
    killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exited with code ${code}`)));
  });
}

/** Resolve when a child reaches any terminal process state. */
function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      child.off("exit", done);
      child.off("close", done);
      child.off("error", done);
      resolve();
    };
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
  });
}

/** Return whether a promise settled within a duration. */
async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Error raised by `runCapturedProcess` for process lifecycle failures. */
export class ManagedProcessError extends Error {
  /**
   * @param {string} message Error message.
   * @param {{kind: string, details?: Record<string, any>, cause?: unknown}} options Error metadata.
   */
  constructor(message, options) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ManagedProcessError";
    this.kind = options.kind;
    this.details = options.details;
  }
}

/**
 * Run a child process to completion while bounding output, timeout, cancellation, and descendants.
 *
 * @param {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdin?: string|Buffer,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxStdoutBytes?: number,
 *   maxStderrBytes?: number,
 *   shell?: boolean,
 *   windowsHide?: boolean,
 *   killTree?: boolean,
 *   expectedExecutableSha256?: string,
 *   onSpawn?: (state: {pid?: number, startedAt: number}) => void|Promise<void>,
 * }} options Process options.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, exitSignal: NodeJS.Signals|null, pid?: number, startedAt: number, durationMs: number}>}
 */
export async function runCapturedProcess(options) {
  options.signal?.throwIfAborted();
  const startedAt = Date.now();
  let child;
  try {
    child = spawnManagedChild(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell === true,
      windowsHide: options.windowsHide !== false,
      killTree: options.killTree !== false,
      expectedExecutableSha256: options.expectedExecutableSha256,
    });
  } catch (error) {
    throw new ManagedProcessError(`Could not start '${options.command}': ${error instanceof Error ? error.message : String(error)}`, {
      kind: "spawn",
      cause: error,
    });
  }

  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });
  exitPromise.catch(() => undefined);

  let timedOut = false;
  let streamFailure;
  let terminationTask;
  const requestTermination = () => {
    terminationTask ??= terminateProcessTree(child, { killTree: options.killTree !== false });
    terminationTask.catch(() => undefined);
    return terminationTask;
  };
  const abort = () => { void requestTermination(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    void requestTermination();
  }, timeoutMs);
  timer.unref?.();

  const stdoutTask = readBoundedStream(child.stdout, options.maxStdoutBytes ?? 16 * 1024 * 1024, "error")
    .catch((error) => {
      streamFailure ??= error;
      void requestTermination();
      return "";
    });
  const stderrTask = readBoundedStream(child.stderr, options.maxStderrBytes ?? 64 * 1024, "tail")
    .catch((error) => {
      streamFailure ??= error;
      void requestTermination();
      return "";
    });

  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();

  try {
    await options.onSpawn?.({ pid: child.pid, startedAt });
    let terminal;
    try {
      terminal = await exitPromise;
    } catch (error) {
      throw new ManagedProcessError(`Could not start or monitor '${options.command}': ${error instanceof Error ? error.message : String(error)}`, {
        kind: "spawn",
        cause: error,
      });
    }
    const [stdout, stderr] = await Promise.all([stdoutTask, stderrTask]);
    const details = {
      ...terminal,
      pid: child.pid,
      durationMs: Date.now() - startedAt,
      stderr,
    };
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Process aborted");
    if (timedOut) {
      throw new ManagedProcessError(`Process timed out after ${timeoutMs} ms`, { kind: "timeout", details });
    }
    if (streamFailure) {
      throw new ManagedProcessError(streamFailure.message, { kind: "output", details, cause: streamFailure });
    }
    return {
      stdout,
      stderr,
      exitCode: terminal.exitCode,
      exitSignal: terminal.exitSignal,
      pid: child.pid,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (terminationTask) await terminationTask.catch(() => undefined);
    await reapManagedProcessTree(child, { killTree: options.killTree !== false }).catch(() => undefined);
    await Promise.allSettled([stdoutTask, stderrTask]);
  }
}

/** Reap descendants that outlive an exited detached POSIX group leader. */
async function reapExitedProcessGroup(child, options = {}) {
  if ((options.platform ?? process.platform) === "win32" || !child.pid) return;
  if (!processGroupExists(child.pid)) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const graceMs = options.graceMs ?? 500;
  if (await waitForProcessGroupExit(child.pid, graceMs)) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
  await waitForProcessGroupExit(child.pid, Math.max(250, graceMs));
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/** Wait a bounded duration for a POSIX process group to disappear. */
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, remaining)));
  }
  return true;
}

/** Read a stream with either a hard limit or a retained-tail limit. */
async function readBoundedStream(stream, maxBytes, behavior) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    chunks.push(buffer);
    if (behavior === "error" && bytes > maxBytes) {
      throw new Error(`Process stdout exceeded ${maxBytes} bytes`);
    }
    if (behavior === "tail" && bytes > maxBytes) {
      let retained = Buffer.concat(chunks);
      retained = retained.subarray(Math.max(0, retained.length - maxBytes));
      chunks.length = 0;
      chunks.push(retained);
      bytes = retained.length;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
