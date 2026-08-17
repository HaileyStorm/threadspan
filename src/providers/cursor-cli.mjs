import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, RequestError } from "../core/errors.mjs";
import { runCapturedProcess } from "../core/managed-process.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { enforceGitWorkspacePolicy } from "../workspace/git-workspace.mjs";
import { createWorkspaceSnapshot } from "../workspace/snapshot.mjs";
import { ProviderAdapter } from "./base.mjs";

/** Cursor Agent CLI adapter for an existing signed-in Cursor subscription. */
export class CursorCliProvider extends ProviderAdapter {
  capabilities() {
    const configured = new Set(this.config.capabilities ?? ["consult", "delegate"]);
    return {
      modes: {
        consult: { supported: configured.has("consult"), readOnlyBoundary: "disposable-workspace-snapshot" },
        integrated: { supported: false, reason: "Cursor Agent owns its tool loop and is not a raw inference endpoint" },
        delegate: { supported: configured.has("delegate"), mutationBoundary: "isolated-live-worktree" },
      },
      streaming: false,
      tools: false,
      images: false,
      durableThreads: false,
      providerOwnsTools: true,
      localRuntime: true,
      authentication: "existing-cli-session",
    };
  }

  async listModels() {
    const configured = Array.isArray(this.config.models) ? this.config.models : undefined;
    if (configured) return super.listModels();
    const result = await this.#runProcess(["models"], { timeoutMs: this.config.discoveryTimeoutMs ?? 30_000 });
    this.#assertSuccess(result, "model discovery");
    const models = parseCursorModels(result.stdout);
    if (models.length === 0) throw new ProviderError(this.id, "Cursor CLI returned no models", { retryable: false });
    return models;
  }

  async *run(request) {
    this.assertMode(request.mode);
    const prompt = renderMessagesForAgent(request.messages);
    const maxPromptChars = this.config.maxPromptChars ?? 24_000;
    if (prompt.length > maxPromptChars) {
      throw new RequestError(`Cursor CLI prompt exceeds the portable ${maxPromptChars}-character command-line limit; use the Cursor SDK adapter for larger retained context`);
    }
    if (request.mode === "delegate" && !request.workspace) throw new RequestError("Cursor CLI Delegate requires a workspace path");

    let snapshot;
    let emptyWorkspace;
    let workspace = request.workspace;
    try {
      if (request.mode === "consult") {
        if (request.workspace) {
          snapshot = await createWorkspaceSnapshot(request.workspace, {
            root: this.config.consult?.snapshotRoot,
            exclude: this.config.consult?.exclude,
            maxBytes: this.config.consult?.snapshotMaxBytes,
            maxFiles: this.config.consult?.snapshotMaxFiles,
            copyInternalSymlinks: this.config.consult?.copyInternalSymlinks === true,
            logger: this.logger,
          });
          workspace = snapshot.path;
        } else {
          emptyWorkspace = await mkdtemp(join(tmpdir(), "threadspan-cursor-consult-"));
          workspace = emptyWorkspace;
        }
      } else if (this.config.delegate?.requireGit !== false) {
        await enforceGitWorkspacePolicy(request.workspace, {
          requireLinkedWorktree: this.config.delegate?.requireLinkedWorktree !== false,
          requireCleanStart: this.config.delegate?.requireCleanStart !== false,
          denyBranches: this.config.delegate?.denyBranches ?? ["main", "master", "trunk"],
        });
      }

      const args = [
        "--print",
        "--output-format", "json",
        "--sandbox", this.config.sandbox ?? "disabled",
        "--trust",
        "--workspace", String(workspace),
        "--model", request.model,
        ...(request.mode === "consult" ? ["--mode", this.config.consult?.agentMode ?? "plan"] : []),
        ...(request.mode === "delegate" && this.config.delegate?.force === true ? ["--force"] : []),
        prompt,
      ];
      yield { type: "status", status: "started" };
      const result = await this.#runProcess(args, {
        cwd: workspace,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? 30 * 60 * 1000,
      });
      this.#assertSuccess(result, request.mode);
      const payload = parseCursorResult(result.stdout);
      const text = String(payload.result ?? payload.text ?? payload.message ?? "");
      if (text) yield { type: "text-delta", delta: text };
      const usage = normalizeCursorUsage(payload.usage);
      if (usage) yield { type: "usage", usage };
      yield {
        type: "done",
        finishReason: "stop",
        message: { role: "assistant", content: text },
        usage,
        providerMetadata: {
          cursorCli: {
            sessionId: payload.session_id ?? payload.sessionId,
            requestId: payload.request_id ?? payload.requestId,
            durationMs: result.durationMs,
          },
        },
      };
    } finally {
      await snapshot?.dispose();
      if (emptyWorkspace) await rm(emptyWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  runtimeStats() {
    return { kind: "cursor-cli", authentication: "existing-cli-session", retainedAgents: 0 };
  }

  #runProcess(args, options = {}) {
    return runCapturedProcess({
      command: this.config.command ?? "cursor-agent",
      args: [...(this.config.commandArgs ?? []), ...args],
      cwd: options.cwd,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: this.config.maxOutputBytes ?? 16 * 1024 * 1024,
      maxStderrBytes: this.config.maxStderrBytes ?? 256 * 1024,
      shell: false,
      killTree: true,
    });
  }

  #assertSuccess(result, operation) {
    if (result.exitCode === 0) return;
    throw new ProviderError(this.id, `Cursor CLI ${operation} failed with exit code ${result.exitCode}: ${truncate(result.stderr || result.stdout, 1200)}`, {
      retryable: false,
    });
  }
}

export function parseCursorModels(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).flatMap((line) => {
    const match = /^([^\s]+)\s+-\s+(.+)$/.exec(line);
    return match ? [{ id: match[1], name: match[2] }] : [];
  });
}

function parseCursorResult(text) {
  try { return JSON.parse(String(text).trim()); }
  catch (error) { throw new ProviderError("cursor-cli", `Cursor CLI returned malformed JSON: ${error.message}`, { retryable: false }); }
}

function normalizeCursorUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = numberOrZero(usage.inputTokens ?? usage.input_tokens);
  const outputTokens = numberOrZero(usage.outputTokens ?? usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberOrZero(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens,
    cachedInputTokens: numberOrZero(usage.cacheReadTokens ?? usage.cachedInputTokens),
    reasoningTokens: numberOrZero(usage.reasoningTokens),
  };
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
