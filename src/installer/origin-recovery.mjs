import { runCapturedProcess } from "../core/managed-process.mjs";
import { nativeRecoveryContract } from "../core/host-surfaces.mjs";
import { resolveExecutablePath } from "../core/executable.mjs";

const RECOVERY_MESSAGE = "Threadspan setup closed before completion. Ask the user whether to relaunch setup or cancel it; do not continue installation automatically.";

/** Notify an originating host through that host's own execution/session surface. */
export async function notifyNativeOrigin(origin, options = {}) {
  const kind = origin?.kind ?? "direct";
  if (kind === "direct" || !origin?.id) return { notified: false, kind, reason: "no-resumable-origin" };
  const contract = nativeRecoveryContract(kind);
  if (contract.available === false) return { notified: false, kind, contract, reason: "native-recovery-contract-unavailable" };
  const message = options.message ?? RECOVERY_MESSAGE;
  if (kind === "codex") {
    return runCliRecovery(options.codexCommand ?? "codex", ["exec", "resume", "--json", origin.id, message], kind, contract, options);
  }
  if (kind === "grok") {
    return runCliRecovery(options.grokCommand ?? "grok", ["--resume", origin.id, "--single", message, "--output-format", "json", "--no-alt-screen"], kind, contract, options);
  }
  if (kind === "cursor") {
    if (typeof options.cursorResume !== "function") return { notified: false, kind, contract, reason: "cursor-sdk-resume-not-configured" };
    await options.cursorResume(origin.id, message);
    return { notified: true, kind, contract };
  }
  if (kind === "hermes") {
    if (typeof options.hermesResume !== "function") return { notified: false, kind, contract, reason: "hermes-session-api-not-configured" };
    await options.hermesResume(origin.id, message);
    return { notified: true, kind, contract };
  }
  return { notified: false, kind, reason: "unsupported-origin" };
}

async function runCliRecovery(command, args, kind, contract, options) {
  const executable = process.platform === "win32"
    ? await resolveExecutablePath(command, { platform: "win32", environment: process.env, cwd: options.cwd }) ?? command
    : command;
  const result = await runCapturedProcess({
    command: executable,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 128 * 1024,
    windowsHide: true,
    killTree: true,
  });
  return { notified: result.exitCode === 0, kind, contract, exitCode: result.exitCode, durationMs: result.durationMs };
}
