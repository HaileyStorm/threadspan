import { spawn } from "node:child_process";

const TERMINATIONS = new WeakMap();

/**
 * Spawn a child in its own POSIX process group so cancellation can terminate descendants.
 * Windows process trees are terminated with `taskkill` by `terminateProcessTree`.
 *
 * @param {string} command Executable path or name.
 * @param {string[]} args Argument vector.
 * @param {import("node:child_process").SpawnOptionsWithoutStdio & {killTree?: boolean}} [options] Spawn options.
 * @returns {import("node:child_process").ChildProcessWithoutNullStreams}
 */
export function spawnManagedChild(command, args, options = {}) {
  const { killTree = true, ...spawnOptions } = options;
  return spawn(command, args, {
    ...spawnOptions,
    detached: spawnOptions.detached ?? (killTree && process.platform !== "win32"),
    stdio: spawnOptions.stdio ?? ["pipe", "pipe", "pipe"],
  });
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
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const existing = TERMINATIONS.get(child);
  if (existing) return existing;

  const operation = terminateProcessTreeOnce(child, options).finally(() => TERMINATIONS.delete(child));
  TERMINATIONS.set(child, operation);
  return operation;
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
  const abort = () => { void terminateProcessTree(child, { killTree: options.killTree !== false }); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(child, { killTree: options.killTree !== false });
  }, timeoutMs);
  timer.unref?.();

  const stdoutTask = readBoundedStream(child.stdout, options.maxStdoutBytes ?? 16 * 1024 * 1024, "error")
    .catch((error) => {
      streamFailure ??= error;
      void terminateProcessTree(child, { killTree: options.killTree !== false });
      return "";
    });
  const stderrTask = readBoundedStream(child.stderr, options.maxStderrBytes ?? 64 * 1024, "tail")
    .catch((error) => {
      streamFailure ??= error;
      void terminateProcessTree(child, { killTree: options.killTree !== false });
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
    if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child, { killTree: options.killTree !== false }).catch(() => undefined);
    else if (options.killTree !== false) await reapExitedProcessGroup(child).catch(() => undefined);
    await Promise.allSettled([stdoutTask, stderrTask]);
  }
}

/** Reap descendants that outlive an exited detached POSIX group leader. */
async function reapExitedProcessGroup(child, options = {}) {
  if (process.platform === "win32" || !child.pid) return;
  if (!processGroupExists(child.pid)) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + (options.graceMs ?? 500);
  while (Date.now() < deadline) {
    if (!processGroupExists(child.pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
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
