import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { ManagedProcessError, runCapturedProcess } from "../core/managed-process.mjs";
import { ProviderError, RequestError } from "../core/errors.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { sha256Text, workspacePathFingerprint } from "../core/run-ledger.mjs";
import { enforceGitWorkspacePolicy, inspectGitWorkspace } from "../workspace/git-workspace.mjs";
import { ProviderAdapter } from "./base.mjs";

const DEFAULT_PROFILE = "threadspan_integrated";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

/**
 * One-shot Codex CLI worker that gives a raw Integrated route a bounded Delegate tool loop.
 * Authentication remains owned by the invoked Codex command and its existing session.
 */
export class CodexWorkerProvider extends ProviderAdapter {
  /** Return the worker's fixed Delegate-only capability boundary. */
  capabilities() {
    return {
      modes: {
        consult: { supported: false, reason: "Codex Worker is a writable execution adapter, not an advisory Consult surface" },
        integrated: { supported: false, reason: "Codex Worker owns its tool loop; select the raw provider route for Integrated mode" },
        delegate: { supported: true, mutationBoundary: "supplied-linked-git-worktree" },
      },
      streaming: false,
      tools: false,
      images: false,
      durableThreads: false,
      providerOwnsTools: true,
      localRuntime: true,
      authentication: "existing-codex-cli-session",
      integrationAuthority: false,
    };
  }

  /** Execute one finite Codex CLI Delegate run. */
  async *run(request) {
    this.assertMode(request.mode);
    if (!request.workspace) throw new RequestError("Codex Worker Delegate requires an explicit workspace path");

    const workspace = resolve(request.workspace);
    const contract = resolveCodexWorkerContract(request);
    const profile = resolveCodexProfile(this.config, request);
    const route = resolveIntegratedRoute(this.config, request);
    const modelProvider = resolveModelProvider(this.config, request);
    await assertWritableWorkspace(workspace);
    const gitBefore = await enforceGitWorkspacePolicy(workspace, {
      requireGit: true,
      requireLinkedWorktree: true,
      requireCleanStart: this.config.delegate?.requireCleanStart !== false,
      denyBranches: this.config.delegate?.denyBranches ?? ["main", "master", "trunk"],
    });
    if (gitBefore.topLevel !== workspace) {
      throw new RequestError(`Codex Worker workspace must be the linked worktree root: ${gitBefore.topLevel}`);
    }

    const prompt = renderCodexWorkerPrompt(request, contract, gitBefore);
    const maxPromptChars = this.config.maxPromptChars ?? 64_000;
    if (prompt.length > maxPromptChars) {
      throw new RequestError(`Codex Worker task packet exceeds ${maxPromptChars} characters`);
    }
    const args = [
      ...(Array.isArray(this.config.commandArgs) ? this.config.commandArgs.map(String) : []),
      ...buildCodexWorkerArguments(this.config, request, { workspace, profile, route, modelProvider }),
    ];

    yield { type: "status", status: "started" };
    let result;
    try {
      result = await runCapturedProcess({
        command: this.config.command ?? "codex",
        args,
        cwd: workspace,
        stdin: prompt,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxStdoutBytes: this.config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        maxStderrBytes: this.config.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
        shell: false,
        windowsHide: true,
        killTree: true,
      });
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason ?? error;
      if (error instanceof ManagedProcessError) {
        throw new ProviderError(this.id, `Codex Worker process ${error.kind} failure: ${error.message}`, {
          status: error.kind === "timeout" ? 504 : 502,
          retryable: false,
          details: { ...error.details, retryPolicy: "no-automatic-retry" },
          cause: error,
        });
      }
      throw new ProviderError(this.id, `Codex Worker execution failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false,
        cause: error,
      });
    }

    let parsed;
    try {
      parsed = parseCodexWorkerJsonl(result.stdout, this.id);
    } catch (error) {
      if (result.exitCode === 0) throw error;
      throw createCodexWorkerExitError(this.id, result, undefined, error);
    }
    if (result.exitCode !== 0) throw createCodexWorkerExitError(this.id, result, parsed);
    if (parsed.failure) {
      throw new ProviderError(this.id, `Codex Worker reported a failed turn: ${parsed.failure}`, {
        retryable: false,
        details: { retryPolicy: "no-automatic-retry", threadId: parsed.threadId, turnId: parsed.turnId },
      });
    }
    if (!parsed.completed) {
      throw new ProviderError(this.id, "Codex Worker JSONL ended without a terminal turn.completed event", {
        retryable: false,
        details: { retryPolicy: "no-automatic-retry", eventCount: parsed.eventCount },
      });
    }

    const gitAfter = await inspectGitWorkspace(workspace).catch(() => undefined);
    const providerMetadata = {
      codexWorker: {
        profile,
        route,
        modelProvider,
        oneShot: true,
        ephemeral: true,
        authentication: "existing-codex-cli-session",
        integrationAuthority: false,
        independentAcceptanceRequired: true,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        eventCount: parsed.eventCount,
        process: {
          pid: result.pid,
          exitCode: result.exitCode,
          exitSignal: result.exitSignal,
          durationMs: result.durationMs,
        },
        evidence: {
          promptSha256: sha256Text(prompt),
          stdoutSha256: sha256Text(result.stdout),
          stderrSha256: sha256Text(result.stderr),
        },
        workspaceFingerprint: workspacePathFingerprint(workspace),
        gitBefore: summarizeGitState(gitBefore),
        gitAfter: summarizeGitState(gitAfter),
        scope: contract.scope,
        acceptanceCommands: contract.acceptanceCommands,
      },
    };

    if (parsed.text) yield { type: "text-delta", delta: parsed.text };
    if (parsed.usage) yield { type: "usage", usage: parsed.usage };
    yield {
      type: "done",
      finishReason: "stop",
      message: { role: "assistant", content: parsed.text },
      usage: parsed.usage,
      providerMetadata,
    };
  }

  /** Return count-only runtime diagnostics without probing auth or a live process. */
  runtimeStats() {
    return {
      kind: "codex-worker",
      authentication: "existing-codex-cli-session",
      retainedWorkers: 0,
      oneShot: true,
    };
  }
}

/** Build structured Codex argv; the task packet is intentionally supplied on stdin. */
export function buildCodexWorkerArguments(config, request, resolved = {}) {
  const workspace = resolved.workspace ?? resolve(String(request.workspace ?? process.cwd()));
  const profile = resolved.profile ?? resolveCodexProfile(config, request);
  const route = resolved.route ?? resolveIntegratedRoute(config, request);
  const modelProvider = resolved.modelProvider ?? resolveModelProvider(config, request);
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--color", "never",
    "--sandbox", config.sandbox ?? "workspace-write",
    "--config", `approval_policy=${JSON.stringify(resolveApprovalPolicy(config.approvalPolicy))}`,
    "--cd", workspace,
    "--profile", profile,
    "--model", route,
    "--config", `model_providers.${tomlKey(modelProvider)}.request_max_retries=0`,
    "--config", `model_providers.${tomlKey(modelProvider)}.stream_max_retries=0`,
    ...(config.disableGoals === false ? [] : ["--disable", "goals"]),
    "-",
  ];
}

function resolveApprovalPolicy(value) {
  const policy = value ?? "never";
  if (!["never", "on-request", "on-failure", "untrusted"].includes(policy)) {
    throw new RequestError(`Codex Worker approvalPolicy '${policy}' is unsupported`);
  }
  return policy;
}

/** Render the authoritative workspace, scope, acceptance, and authority packet. */
export function renderCodexWorkerPrompt(request, contract, gitBefore) {
  const scope = [
    ...contract.scope.allowed.map((entry) => `- May change: ${entry}`),
    ...contract.scope.denied.map((entry) => `- Must not change: ${entry}`),
    ...contract.scope.nonGoals.map((entry) => `- Non-goal: ${entry}`),
  ].join("\n");
  const acceptance = contract.acceptanceCommands.length > 0
    ? contract.acceptanceCommands.map((command, index) => `${index + 1}. ${command}`).join("\n")
    : "- No runnable acceptance command was authorized; report the unverified acceptance gap.";
  return `EXECUTION BOUNDARY
You are a finite, one-shot Codex worker. Own only the bounded task below inside the supplied linked Git worktree. Do not modify anything outside the explicit scope.
You have no integration authority: do not merge, rebase, push, force-push, tag, publish, release, or alter a canonical branch. Do not broaden permissions, workspace roots, provider routing, or credentials.
A separate coordinator will inspect the diff and independently reproduce acceptance. Your own test report is evidence, not acceptance authority.

WORKSPACE CONTRACT
root=${gitBefore.topLevel}
branch=${gitBefore.branch}
base_commit=${gitBefore.commit}
linked_worktree=${gitBefore.linkedWorktree}
clean_start=${gitBefore.clean}

SCOPE CONTRACT
${scope}

ACCEPTANCE CONTRACT
Run only these exact commands when permitted by the active Codex policy. Record command, exit status, and relevant bounded output.
${acceptance}

EVIDENCE REQUIRED
- changed files and concise rationale;
- exact commands run and terminal results;
- unresolved risks or unverified assumptions;
- no claim of merge, push, release, or independent acceptance.

AUTHORITATIVE TASK TRANSCRIPT
${renderMessagesForAgent(request.messages)}`;
}

/** Parse Codex `exec --json` JSONL into normalized text, usage, and lifecycle metadata. */
export function parseCodexWorkerJsonl(text, providerId = "codex-worker") {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new ProviderError(providerId, "Codex Worker returned no JSONL events", { retryable: false });
  }

  const messages = [];
  const deltas = [];
  let usage;
  let threadId;
  let turnId;
  let completed = false;
  let failure;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new ProviderError(providerId, `Codex Worker returned malformed JSONL: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false,
        details: { sample: truncate(line, 1000) },
        cause: error,
      });
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      throw new ProviderError(providerId, "Codex Worker JSONL event must be an object with a type", { retryable: false });
    }

    if (event.type === "thread.started") threadId = stringOrUndefined(event.thread_id ?? event.threadId);
    if (event.type === "turn.started") turnId = stringOrUndefined(event.turn_id ?? event.turnId);
    if (event.type === "turn.completed") {
      completed = true;
      turnId ??= stringOrUndefined(event.turn_id ?? event.turnId);
      usage = normalizeCodexUsage(event.usage) ?? usage;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      failure = extractFailure(event);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const value = event.item.text ?? event.item.content ?? event.item.message?.content;
      if (value !== undefined && value !== null) messages.push(renderText(value));
    }
    if (event.type === "response.output_text.delta" || event.type === "text-delta") {
      deltas.push(String(event.delta ?? ""));
    }
    usage = normalizeCodexUsage(event.response?.usage) ?? usage;
  }

  return {
    text: messages.length > 0 ? messages.join("\n") : deltas.join(""),
    usage,
    threadId,
    turnId,
    completed,
    failure,
    eventCount: lines.length,
  };
}

/** Require an explicit scope plus explicit (possibly empty) acceptance command list. */
export function resolveCodexWorkerContract(request) {
  const rawScope = request.metadata?.bridge_scope ?? request.metadata?.bridge_allowed_paths;
  const scope = normalizeScope(rawScope);
  if (scope.allowed.length === 0) {
    throw new RequestError("Codex Worker Delegate requires non-empty metadata.bridge_scope (or bridge_allowed_paths)");
  }
  if (!Array.isArray(request.metadata?.bridge_acceptance_commands)) {
    throw new RequestError("Codex Worker Delegate requires an explicit metadata.bridge_acceptance_commands array");
  }
  const acceptanceCommands = normalizeStringArray(request.metadata.bridge_acceptance_commands, "bridge_acceptance_commands");
  return { scope, acceptanceCommands };
}

function resolveCodexProfile(config, request) {
  const profile = request.metadata?.bridge_codex_profile ?? request.metadata?.bridge_profile ?? config.profile ?? DEFAULT_PROFILE;
  if (typeof profile !== "string" || profile.trim().length === 0) throw new RequestError("Codex Worker requires a non-empty Codex profile");
  return profile.trim();
}

function resolveIntegratedRoute(config, request) {
  const route = request.metadata?.bridge_model_route ?? config.integratedRoute ?? request.model ?? config.model;
  if (typeof route !== "string" || !/^integrated\/[^/]+\/.+/.test(route)) {
    throw new RequestError("Codex Worker model must be a full Integrated route such as integrated/nous/deepseek/deepseek-v4-flash-0731");
  }
  return route;
}

function resolveModelProvider(config, request) {
  const provider = request.metadata?.bridge_codex_model_provider ?? config.modelProvider ?? "threadspan_bridge";
  if (typeof provider !== "string" || provider.trim().length === 0) {
    throw new RequestError("Codex Worker requires a non-empty shared-daemon Codex model provider id");
  }
  return provider.trim();
}

function tomlKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function normalizeScope(value) {
  if (typeof value === "string" || Array.isArray(value)) {
    return { allowed: normalizeStringArray(value, "bridge_scope"), denied: [], nonGoals: [] };
  }
  if (!value || typeof value !== "object") return { allowed: [], denied: [], nonGoals: [] };
  return {
    allowed: normalizeStringArray(value.allowed ?? value.allow ?? value.mayChange ?? value.paths ?? [], "bridge_scope.allowed"),
    denied: normalizeStringArray(value.denied ?? value.deny ?? value.mustNotChange ?? [], "bridge_scope.denied"),
    nonGoals: normalizeStringArray(value.nonGoals ?? value.non_goals ?? [], "bridge_scope.nonGoals"),
  };
}

function normalizeStringArray(value, field) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    throw new RequestError(`Codex Worker ${field} must contain only non-empty strings`);
  }
  return values.map((entry) => entry.trim());
}

async function assertWritableWorkspace(workspace) {
  try {
    await access(workspace, fsConstants.R_OK | fsConstants.W_OK);
  } catch (error) {
    throw new RequestError(`Codex Worker Delegate workspace is not readable and writable: ${workspace}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeCodexUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = numberOrZero(value.inputTokens ?? value.input_tokens ?? value.prompt_tokens);
  const outputTokens = numberOrZero(value.outputTokens ?? value.output_tokens ?? value.completion_tokens);
  const cachedInputTokens = numberOrZero(value.cachedInputTokens ?? value.cached_input_tokens ?? value.input_tokens_details?.cached_tokens);
  const reasoningTokens = numberOrZero(value.reasoningTokens ?? value.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberOrZero(value.totalTokens ?? value.total_tokens) || inputTokens + outputTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}

function createCodexWorkerExitError(providerId, result, parsed, cause) {
  const failure = parsed?.failure ?? truncate(result.stderr || result.stdout, 1600);
  return new ProviderError(providerId, `Codex Worker exited with code ${result.exitCode ?? "null"}${result.exitSignal ? ` (${result.exitSignal})` : ""}${failure ? `: ${failure}` : ""}`, {
    retryable: false,
    details: {
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
      threadId: parsed?.threadId,
      turnId: parsed?.turnId,
      stderr: truncate(result.stderr, 8000),
      retryPolicy: "no-automatic-retry",
    },
    cause,
  });
}

function extractFailure(event) {
  const value = event.error?.message ?? event.error ?? event.message ?? event.reason ?? event.item?.text;
  return truncate(typeof value === "string" ? value : JSON.stringify(value ?? "unknown Codex failure"), 1600);
}

function renderText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => part?.text ?? part?.content ?? "").join("");
  return String(value ?? "");
}

function summarizeGitState(state) {
  if (!state) return undefined;
  return {
    branch: state.branch,
    commit: state.commit,
    clean: state.clean,
    linkedWorktree: state.linkedWorktree,
    changedPaths: state.status.length,
  };
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function stringOrUndefined(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}
