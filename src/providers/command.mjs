import { once } from "node:events";
import { ProviderError, RequestError } from "../core/errors.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { spawnManagedChild, terminateProcessTree } from "../core/managed-process.mjs";
import { ProviderAdapter } from "./base.mjs";

/**
 * Provider adapter for CLI agents and future subscription-backed command integrations.
 *
 * The child receives the rendered prompt on stdin by default. Arguments and environment values may
 * use `{mode}`, `{model}`, `{workspace}`, and `{threadId}` placeholders. `outputFormat: "jsonl"`
 * accepts normalized provider events; `text` treats stdout as streamed assistant text.
 */
export class CommandProvider extends ProviderAdapter {
  /** Return command-provider capabilities derived from explicit configuration. */
  capabilities() {
    return {
      ...super.capabilities(),
      tools: this.config.tools === true,
      durableThreads: this.config.durableThreads === true,
      executionBoundary: "child-process",
    };
  }

  /**
   * Run a configured child process and normalize its output.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {AsyncIterable<Record<string, any>>}
   */
  async *run(request) {
    this.assertMode(request.mode);
    const command = this.config.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new RequestError(`Command provider '${this.id}' is missing a command`);
    }
    if (this.config.shell === true) {
      throw new RequestError(`Command provider '${this.id}' does not support shell:true; configure a fixed executable or wrapper with structured arguments`);
    }

    const substitutions = {
      mode: request.mode,
      model: request.model,
      workspace: request.workspace ?? process.cwd(),
      threadId: request.threadId ?? "",
    };
    const args = (Array.isArray(this.config.args) ? this.config.args : []).map((value) => substitute(String(value), substitutions));
    const cwd = resolveCommandCwd(this.config.cwd, substitutions.workspace);
    const outputFormat = this.config.outputFormat ?? "text";
    const maxOutputBytes = this.config.maxOutputBytes ?? 16 * 1024 * 1024;
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs ?? 30 * 60 * 1000;
    const prompt = renderMessagesForAgent(request.messages, {
      outputSummary: this.config.outputSummary,
      providerId: this.id,
      adapter: this.config.adapter ?? "command",
      purpose: "agent-prompt",
    });
    const configuredEnvironment = Object.fromEntries(
      Object.entries(this.config.env ?? {}).map(([key, value]) => [key, substitute(String(value), substitutions)]),
    );
    const child = spawnManagedChild(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      killTree: (this.config.killTree ?? this.config.killProcessTree) !== false,
      env: buildCommandEnvironment(this.config, configuredEnvironment, {
        CURSOR_BRIDGE_MODE: request.mode,
        CURSOR_BRIDGE_MODEL: request.model,
        CURSOR_BRIDGE_THREAD_ID: request.threadId ?? "",
        CURSOR_BRIDGE_WORKSPACE: request.workspace ?? "",
      }),
    });

    const exitPromise = once(child, "exit");
    // Observe early spawn failures immediately even when stdout iteration fails before the explicit await.
    exitPromise.catch(() => undefined);
    let stdinError;
    child.stdin.on("error", (error) => { stdinError = error; });
    const abort = () => { void terminateProcessTree(child, { graceMs: this.config.terminationGraceMs ?? 2000, killTree: (this.config.killTree ?? this.config.killProcessTree) !== false }); };
    request.signal?.addEventListener("abort", abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, { graceMs: this.config.terminationGraceMs ?? 2000, killTree: (this.config.killTree ?? this.config.killProcessTree) !== false });
    }, timeoutMs);
    timer.unref?.();
    child.stdin.end(this.config.stdin === false ? undefined : prompt);

    let stderr = "";
    let outputBytes = 0;
    const stderrTask = (async () => {
      for await (const chunk of child.stderr) {
        stderr += chunk.toString("utf8");
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
      }
    })();

    yield { type: "status", status: "started" };
    let text = "";
    try {
      if (outputFormat === "jsonl") {
        for await (const event of parseJsonLines(child.stdout, (count) => {
          outputBytes += count;
          if (outputBytes > maxOutputBytes) throw new ProviderError(this.id, `Command output exceeded ${maxOutputBytes} bytes`);
        }, this.id)) {
          yield event;
          if (event.type === "text-delta") text += event.delta ?? "";
        }
      } else if (outputFormat === "json") {
        const chunks = [];
        for await (const chunk of child.stdout) {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) throw new ProviderError(this.id, `Command output exceeded ${maxOutputBytes} bytes`);
          chunks.push(chunk);
        }
        const payload = parseCommandJson(Buffer.concat(chunks).toString("utf8"), this.id, "JSON");
        text = extractCommandText(payload);
        if (text) yield { type: "text-delta", delta: text };
      } else {
        for await (const chunk of child.stdout) {
          outputBytes += chunk.length;
          if (outputBytes > maxOutputBytes) throw new ProviderError(this.id, `Command output exceeded ${maxOutputBytes} bytes`);
          const delta = chunk.toString("utf8");
          text += delta;
          yield { type: "text-delta", delta };
        }
      }

      let exitCode;
      let exitSignal;
      try {
        [exitCode, exitSignal] = await exitPromise;
      } catch (error) {
        throw new ProviderError(this.id, `Could not start or monitor command '${command}': ${error instanceof Error ? error.message : String(error)}`, {
          retryable: false,
          cause: error,
        });
      }
      await stderrTask;
      if (request.signal?.aborted) throw request.signal.reason ?? new Error("Command provider aborted");
      if (timedOut) {
        throw new ProviderError(this.id, `Command timed out after ${timeoutMs} ms`, {
          status: 504,
          retryable: true,
          details: { timeoutMs, exitCode, exitSignal, stderr: truncate(stderr, 8000) },
        });
      }
      if (exitCode !== 0) {
        throw new ProviderError(this.id, `Command exited with code ${exitCode ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}${stderr ? ` — ${truncate(stderr, 2000)}` : ""}`, {
          retryable: false,
          details: { exitCode, exitSignal, stderr: truncate(stderr, 8000) },
        });
      }
      if (stdinError) {
        throw new ProviderError(this.id, `Could not deliver prompt to command '${command}': ${stdinError.message}`, {
          retryable: false,
          details: { code: stdinError.code },
          cause: stdinError,
        });
      }
      yield { type: "done", finishReason: "stop", message: { role: "assistant", content: text } };
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const spawnFailure = error && typeof error === "object" && (error.code === "ENOENT" || String(error.syscall ?? "").startsWith("spawn"));
      throw new ProviderError(this.id, spawnFailure
        ? `Could not start or monitor command '${command}': ${message}`
        : `Command execution failed: ${message}`, {
        retryable: false,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child, { graceMs: this.config.terminationGraceMs ?? 2000, killTree: (this.config.killTree ?? this.config.killProcessTree) !== false }).catch(() => undefined);
      await stderrTask.catch(() => undefined);
    }
  }
}

/**
 * Substitute command-template variables.
 * @param {string} value Template value.
 * @param {Record<string, string>} substitutions Replacement values.
 * @returns {string}
 */
function substitute(value, substitutions) {
  return value.replace(/\{(mode|model|workspace|threadId)\}/g, (_match, key) => substitutions[key] ?? "");
}

/**
 * Resolve the child working directory from provider policy.
 * @param {unknown} configured Configured cwd.
 * @param {string} workspace Request workspace.
 * @returns {string}
 */
function resolveCommandCwd(configured, workspace) {
  if (configured === "workspace" || configured === undefined) return workspace || process.cwd();
  return String(configured);
}

/**
 * Parse newline-delimited normalized provider events from a command.
 * @param {NodeJS.ReadableStream} stream Child stdout.
 * @param {(count: number) => void} accountBytes Output accounting callback.
 * @returns {AsyncIterable<Record<string, any>>}
 */
async function* parseJsonLines(stream, accountBytes, providerId) {
  let buffer = "";
  for await (const chunk of stream) {
    accountBytes(chunk.length);
    buffer += chunk.toString("utf8");
    while (true) {
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) break;
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line) yield parseCommandEvent(line, providerId);
    }
  }
  if (buffer.trim()) yield parseCommandEvent(buffer, providerId);
}

/** Parse one JSONL line and normalize parse/schema failures as provider errors. */
function parseCommandEvent(line, providerId) {
  const payload = parseCommandJson(line, providerId, "JSONL");
  try {
    return normalizeCommandEvent(payload);
  } catch (error) {
    throw new ProviderError(providerId, `Command JSONL event is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      cause: error,
    });
  }
}

/** Parse command JSON with bounded diagnostics. */
function parseCommandJson(text, providerId, format) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProviderError(providerId, `Command returned malformed ${format}: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      details: { sample: truncate(text, 1000) },
      cause: error,
    });
  }
}

/**
 * Validate and normalize one command event.
 * @param {Record<string, any>} event Raw event.
 * @returns {Record<string, any>}
 */
function normalizeCommandEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new Error("Command JSONL event must be an object with a type");
  }
  if (event.type === "text") return { type: "text-delta", delta: String(event.text ?? "") };
  return event;
}

/**
 * Extract assistant text from a JSON command result.
 * @param {unknown} payload Command JSON payload.
 * @returns {string}
 */
function extractCommandText(payload) {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return JSON.stringify(payload ?? null);
  return String(payload.text ?? payload.output_text ?? payload.result ?? payload.message?.content ?? JSON.stringify(payload));
}

/**
 * Build the child environment, optionally replacing broad process inheritance with an allowlist.
 * @param {Record<string, any>} config Provider configuration.
 * @param {Record<string, string>} configured Explicit provider environment.
 * @param {Record<string, string>} bridgeEnvironment Bridge request metadata.
 * @returns {NodeJS.ProcessEnv}
 */
function buildCommandEnvironment(config, configured, bridgeEnvironment) {
  const inherited = config.inheritEnv === false
    ? Object.fromEntries((config.envAllowlist ?? []).flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
    : process.env;
  return { ...inherited, ...configured, ...bridgeEnvironment };
}

/**
 * Truncate diagnostic text to a bounded size.
 * @param {string} value Text.
 * @param {number} max Maximum characters.
 * @returns {string}
 */
function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
