import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { ManagedProcessError, runCapturedProcess } from "../core/managed-process.mjs";
import { ProviderError, RequestError } from "../core/errors.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { sha256Text, workspacePathFingerprint } from "../core/run-ledger.mjs";
import { enforceGitWorkspacePolicy, inspectGitWorkspace } from "../workspace/git-workspace.mjs";
import { createEffectiveSettingsReport, EFFECTIVE_EXECUTION_SETTINGS, ProviderAdapter } from "./base.mjs";

const DEFAULT_PROFILE = "threadspan_integrated";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
export const CODEX_NATIVE_ACCOUNT_FALLBACK_POLICY = "codex-native-usage-limit-v1";
export const CODEX_NATIVE_USAGE_LIMIT_KIND = "codex_native_usage_limit";

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
      settingsOwnership: "provider",
    };
  }

  /** Report native inheritance plus the bridge-route settings required by this wrapper. */
  effectiveSettings(request = {}) {
    const profile = resolveCodexProfile(this.config, request);
    const route = resolveIntegratedRoute(this.config, request);
    const modelProvider = resolveModelProvider(this.config, request);
    return createEffectiveSettingsReport({
      owner: "provider",
      inheritance: "native-user-project-with-explicit-bridge-route",
      authentication: "existing-codex-cli-session",
      preserved: inheritedSettings(this.config),
      divergences: [
        divergence("profile", profile, "provider-config", "worker", "The Integrated wrapper must select its reviewed Codex bridge profile."),
        divergence("model", route, "request-route", "request", "The caller selected this explicit Integrated bridge route."),
        divergence("modelProvider", modelProvider, "provider-config", "worker", "The bridge profile routes inference through the shared Threadspan daemon."),
        divergence("requestRetries", 0, "bridge-required", "worker", "Avoid nested bridge retries; the caller remains retry owner."),
        ...configuredExecutionDivergences(this.config, request),
      ],
      exclusions: [],
    });
  }

  /** Codex exec is one-shot: interruption cleanup owns the process tree and leaves no retained worker handle. */
  async auditRecovery(context = {}) {
    return {
      adapter: "codex-worker",
      status: "one-shot-process-tree-audited",
      resumable: false,
      orphaned: false,
      threadId: context.threadId ?? null,
      instruction: "Confirm the managed process tree terminated, preserve the task packet and workspace, then start a fresh bounded turn only if still authorized.",
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
        effectiveSettings: this.effectiveSettings(request),
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

/**
 * One-shot provider-native OpenAI Codex worker bound to one isolated CODEX_HOME.
 * The isolated home contributes native authentication and user settings; workspace project settings still compose normally.
 */
export class CodexNativeWorkerProvider extends ProviderAdapter {
  /** Return the native worker's fixed Delegate-only capability boundary. */
  capabilities() {
    return {
      modes: {
        consult: { supported: false, reason: "Codex Native Worker is a writable execution adapter, not an advisory Consult surface" },
        integrated: { supported: false, reason: "Codex Native Worker owns its tool loop; use an OpenAI API adapter for Integrated mode" },
        delegate: { supported: true, mutationBoundary: "supplied-linked-git-worktree" },
      },
      streaming: false,
      tools: false,
      images: false,
      durableThreads: false,
      providerOwnsTools: true,
      localRuntime: true,
      authentication: "isolated-provider-native-codex-home",
      integrationAuthority: false,
      settingsOwnership: "provider",
    };
  }

  /** Preserve the selected profile's user settings and the workspace's project settings by default. */
  effectiveSettings(request = {}) {
    const model = resolveNativeCodexModel(this.config, request);
    return createEffectiveSettingsReport({
      owner: "provider",
      inheritance: "isolated-native-user-profile-plus-project",
      authentication: "isolated-provider-native-codex-home",
      preserved: inheritedSettings(this.config, request),
      divergences: [
        divergence("model", model, request.model ? "request-route" : "provider-config", "request", "The caller selected this native Codex route."),
        ...configuredExecutionDivergences(this.config, request),
      ],
      exclusions: [
        { setting: "custom-base-url-environment", reason: "Removed from the child environment to keep the isolated native account binding authoritative." },
      ],
    });
  }

  /** Native Codex exec is one-shot; preserve workspace/task state and never guess a resumable session. */
  async auditRecovery(context = {}) {
    return {
      adapter: "codex-native-worker",
      status: "one-shot-process-tree-audited",
      resumable: false,
      orphaned: false,
      threadId: context.threadId ?? null,
      instruction: "Confirm the native Codex process tree terminated. Re-authenticate in the selected isolated CODEX_HOME when required; retry only through the existing account and authority gates.",
    };
  }

  /** Certify only the exact native usage-limit fallback contract. */
  accountFallbackPolicy() {
    return CODEX_NATIVE_ACCOUNT_FALLBACK_POLICY;
  }

  /** Execute one finite provider-native Codex CLI Delegate run. */
  async *run(request) {
    this.assertMode(request.mode);
    if (!request.workspace) throw new RequestError("Codex Native Worker Delegate requires an explicit workspace path");
    const binding = this.accountBinding();
    const codexHome = this.config.__threadspanCodexHome;
    if (binding?.isolated !== true || typeof codexHome !== "string" || codexHome.length === 0) {
      throw new RequestError("Codex Native Worker requires a validated isolated codex-home account/profileRef with existing native authentication");
    }

    const workspace = resolve(request.workspace);
    const contract = resolveCodexWorkerContract(request);
    const model = resolveNativeCodexModel(this.config, request);
    await assertWritableWorkspace(workspace);
    const gitBefore = await enforceGitWorkspacePolicy(workspace, {
      requireGit: true,
      requireLinkedWorktree: true,
      requireCleanStart: this.config.delegate?.requireCleanStart !== false,
      denyBranches: this.config.delegate?.denyBranches ?? ["main", "master", "trunk"],
    });
    if (gitBefore.topLevel !== workspace) {
      throw new RequestError(`Codex Native Worker workspace must be the linked worktree root: ${gitBefore.topLevel}`);
    }

    const prompt = renderCodexWorkerPrompt(request, contract, gitBefore);
    const maxPromptChars = this.config.maxPromptChars ?? 64_000;
    if (prompt.length > maxPromptChars) throw new RequestError(`Codex Native Worker task packet exceeds ${maxPromptChars} characters`);
    const args = [
      ...(Array.isArray(this.config.commandArgs) ? this.config.commandArgs.map(String) : []),
      ...buildCodexNativeWorkerArguments(this.config, request, { workspace, model }),
    ];

    yield { type: "status", status: "started" };
    let result;
    try {
      result = await runCapturedProcess({
        command: this.config.command ?? "codex",
        args,
        cwd: workspace,
        env: nativeCodexEnvironment(codexHome),
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
        throw new ProviderError(this.id, `Codex Native Worker process ${error.kind} failure: ${error.message}`, {
          status: error.kind === "timeout" ? 504 : 502,
          retryable: false,
          details: { ...error.details, retryPolicy: "no-automatic-retry" },
          cause: error,
        });
      }
      throw new ProviderError(this.id, `Codex Native Worker execution failed: ${error instanceof Error ? error.message : String(error)}`, {
        retryable: false,
        cause: error,
      });
    }

    let parsed;
    try {
      parsed = parseCodexWorkerJsonl(result.stdout, this.id);
    } catch (error) {
      if (result.exitCode === 0) throw error;
      const stderrUsageLimit = result.stdout.trim().length === 0 ? parseCodexNativeUsageLimit(result.stderr) : undefined;
      if (stderrUsageLimit) throw createCodexNativeUsageLimitError(this.id, stderrUsageLimit, result);
      throw createCodexWorkerExitError(this.id, result, undefined, error);
    }
    const usageLimit = parsed.nativeUsageLimit ?? parseCodexNativeUsageLimit(result.stderr);
    if (usageLimit && !parsed.observedOutput && !parsed.observedToolOrSideEffect) {
      throw createCodexNativeUsageLimitError(this.id, usageLimit, result);
    }
    if (result.exitCode !== 0) throw createCodexWorkerExitError(this.id, result, parsed);
    if (parsed.failure) {
      throw new ProviderError(this.id, `Codex Native Worker reported a failed turn: ${parsed.failure}`, {
        retryable: false,
        details: { retryPolicy: "no-automatic-retry", threadId: parsed.threadId, turnId: parsed.turnId },
      });
    }
    if (!parsed.completed) {
      throw new ProviderError(this.id, "Codex Native Worker JSONL ended without a terminal turn.completed event", {
        retryable: false,
        details: { retryPolicy: "no-automatic-retry", eventCount: parsed.eventCount },
      });
    }

    const gitAfter = await inspectGitWorkspace(workspace).catch(() => undefined);
    const providerMetadata = {
      codexNativeWorker: {
        model,
        codexHomeIsolation: true,
        oneShot: true,
        ephemeral: true,
        authentication: "isolated-provider-native-codex-home",
        integrationAuthority: false,
        independentAcceptanceRequired: true,
        retryPolicy: "no-automatic-retry-except-one-exact-pre-output-native-usage-limit-alternate-account",
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        eventCount: parsed.eventCount,
        process: { pid: result.pid, exitCode: result.exitCode, exitSignal: result.exitSignal, durationMs: result.durationMs },
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
        effectiveSettings: this.effectiveSettings(request),
      },
    };

    if (parsed.text) yield { type: "text-delta", delta: parsed.text };
    if (parsed.usage) yield { type: "usage", usage: parsed.usage };
    yield { type: "done", finishReason: "stop", message: { role: "assistant", content: parsed.text }, usage: parsed.usage, providerMetadata };
  }

  /** Return count-only runtime diagnostics without probing auth or a live process. */
  runtimeStats() {
    return { kind: "codex-native-worker", authentication: "isolated-provider-native-codex-home", retainedWorkers: 0, oneShot: true };
  }
}

/** Build structured Codex argv; the task packet is intentionally supplied on stdin. */
export function buildCodexWorkerArguments(config, request, resolved = {}) {
  const workspace = resolved.workspace ?? resolve(String(request.workspace ?? process.cwd()));
  const profile = resolved.profile ?? resolveCodexProfile(config, request);
  const route = resolved.route ?? resolveIntegratedRoute(config, request);
  const modelProvider = resolved.modelProvider ?? resolveModelProvider(config, request);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--color", "never",
    "--cd", workspace,
    "--profile", profile,
    "--model", route,
    "--config", `model_providers.${tomlKey(modelProvider)}.request_max_retries=0`,
    "--config", `model_providers.${tomlKey(modelProvider)}.stream_max_retries=0`,
  ];
  appendExplicitCodexExecutionArguments(args, config, request);
  args.push("-");
  return args;
}

/** Build provider-native Codex argv while inheriting the selected user's and project's native settings. */
export function buildCodexNativeWorkerArguments(config, request, resolved = {}) {
  const workspace = resolved.workspace ?? resolve(String(request.workspace ?? process.cwd()));
  const model = resolved.model ?? resolveNativeCodexModel(config, request);
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--color", "never",
    "--cd", workspace,
    "--model", model,
  ];
  appendExplicitCodexExecutionArguments(args, config, request);
  args.push("-");
  return args;
}

function resolveApprovalPolicy(value) {
  if (!["never", "on-request", "on-failure", "untrusted"].includes(value)) {
    throw new RequestError(`Codex Worker approvalPolicy '${value}' is unsupported`);
  }
  return value;
}

function appendExplicitCodexExecutionArguments(args, config, request) {
  const reasoningEffort = resolveNativeReasoningEffort(request.metadata?.bridge_reasoning_effort ?? config.reasoningEffort);
  if (config.sandbox !== undefined) args.push("--sandbox", String(config.sandbox));
  if (config.approvalPolicy !== undefined) args.push("--config", `approval_policy=${JSON.stringify(resolveApprovalPolicy(config.approvalPolicy))}`);
  if (config.contextWindow !== undefined) args.push("--config", `model_context_window=${positiveInteger(config.contextWindow, "contextWindow")}`);
  if (reasoningEffort !== undefined) args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  if (config.disableGoals === true) args.push("--disable", "goals");
}

function configuredExecutionDivergences(config, request = {}) {
  const items = [];
  if (config.sandbox !== undefined) items.push(divergence("sandbox", config.sandbox, "provider-config", "worker", "An explicit provider sandbox override was configured."));
  if (config.approvalPolicy !== undefined) items.push(divergence("approval", config.approvalPolicy, "provider-config", "worker", "An explicit native Codex approval-policy override was configured; Threadspan adds no approval system."));
  if (config.contextWindow !== undefined) items.push(divergence("contextWindow", config.contextWindow, "provider-config", "worker", "An explicit model context-window override was configured."));
  const reasoningEffort = request.metadata?.bridge_reasoning_effort ?? config.reasoningEffort;
  if (reasoningEffort !== undefined) items.push(divergence("reasoningEffort", reasoningEffort, request.metadata?.bridge_reasoning_effort ? "request" : "provider-config", "request", "An explicit reasoning-effort override was requested."));
  if (config.disableGoals === true) items.push(divergence("tools.goals", false, "provider-config", "worker", "The native goals feature was explicitly disabled for this worker."));
  return items;
}

function inheritedSettings(config, request = {}) {
  const overridden = new Set(configuredExecutionDivergences(config, request).map((item) => item.setting === "tools.goals" ? "tools" : item.setting));
  return EFFECTIVE_EXECUTION_SETTINGS.filter((setting) => !overridden.has(setting));
}

function divergence(setting, value, source, scope, reason) {
  return { setting, value, source, scope, reason, reversible: true, removeBy: `remove the explicit ${setting} override` };
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
  let nativeUsageLimit;
  let observedOutput = false;
  let observedToolOrSideEffect = false;
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
      nativeUsageLimit ??= parseCodexNativeUsageLimitEvent(event);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      const value = event.item.text ?? event.item.content ?? event.item.message?.content;
      if (value !== undefined && value !== null) {
        messages.push(renderText(value));
        observedOutput = true;
      }
    }
    if (event.type === "response.output_text.delta" || event.type === "text-delta") {
      deltas.push(String(event.delta ?? ""));
      observedOutput = true;
    }
    if (isCodexToolOrSideEffectEvent(event)) observedToolOrSideEffect = true;
    usage = normalizeCodexUsage(event.response?.usage) ?? usage;
  }

  return {
    text: messages.length > 0 ? messages.join("\n") : deltas.join(""),
    usage,
    threadId,
    turnId,
    completed,
    failure,
    nativeUsageLimit,
    observedOutput,
    observedToolOrSideEffect,
    eventCount: lines.length,
  };
}

/** Parse only Codex's native usage-limit error phrase and an optional authoritative reset timestamp. */
export function parseCodexNativeUsageLimit(value) {
  const text = String(value ?? "").trim();
  if (!/(?:^|[\r\n])You've hit your usage limit(?: for [^\r\n.]+)?\.(?:[^\r\n]*)?(?:$|[\r\n])/m.test(text)) return undefined;
  return { message: exactUsageLimitLine(text), resetAt: extractResetTimestamp(text) };
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

function resolveNativeCodexModel(config, request) {
  const model = request.model ?? config.model;
  const configured = (Array.isArray(config.models) ? config.models : [config.model])
    .map((entry) => typeof entry === "string" ? entry : entry?.id)
    .filter(Boolean);
  if (typeof model !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(model) || model.includes("/")) {
    throw new RequestError("Codex Native Worker model must be a configured native Codex catalog slug");
  }
  if (!configured.includes(model)) throw new RequestError(`Codex Native Worker model '${model}' is not in the configured native Codex catalog`);
  return model;
}

function resolveNativeReasoningEffort(value) {
  if (value === undefined) return undefined;
  const effort = value;
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new RequestError(`Codex Native Worker reasoningEffort '${effort}' is unsupported`);
  }
  return effort;
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

function parseCodexNativeUsageLimitEvent(event) {
  const code = event?.error?.code ?? event?.code ?? event?.error_code;
  const message = event?.error?.message ?? event?.message ?? (typeof event?.error === "string" ? event.error : "");
  const parsed = parseCodexNativeUsageLimit(message);
  if (!parsed && code !== "usage_limit_exceeded") return undefined;
  if (!parsed && typeof message === "string" && !message.startsWith("You've hit your usage limit")) return undefined;
  return {
    message: parsed?.message ?? message,
    resetAt: structuredResetTimestamp(event) ?? parsed?.resetAt,
  };
}

function structuredResetTimestamp(event) {
  const value = event?.error?.resetAt
    ?? event?.error?.reset_at
    ?? event?.resetAt
    ?? event?.reset_at
    ?? event?.error?.details?.rate_limits?.primary?.resets_at
    ?? event?.rate_limits?.primary?.resets_at;
  return normalizeResetTimestamp(value);
}

function extractResetTimestamp(text) {
  const iso = String(text).match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})\b/);
  if (iso) return normalizeResetTimestamp(iso[0]);
  const epoch = String(text).match(/\b(?:resets_at|reset_at)[=:]\s*(\d{10,13})\b/i);
  if (epoch) return normalizeResetTimestamp(epoch[1]);
  return undefined;
}

function normalizeResetTimestamp(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function exactUsageLimitLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("You've hit your usage limit"));
}

function isCodexToolOrSideEffectEvent(event) {
  if (["tool-call-delta", "response.function_call_arguments.delta", "response.function_call_arguments.done"].includes(event.type)) return true;
  if (!["item.started", "item.completed"].includes(event.type) || !event.item?.type) return false;
  return !["agent_message", "reasoning"].includes(event.item.type);
}

function createCodexNativeUsageLimitError(providerId, usageLimit, result) {
  const observedAt = new Date().toISOString();
  return new ProviderError(providerId, usageLimit.message ?? "You've hit your usage limit.", {
    status: 429,
    retryable: true,
    details: {
      kind: CODEX_NATIVE_USAGE_LIMIT_KIND,
      resetAt: usageLimit.resetAt ?? null,
      observedAt,
      preOutput: true,
      noSideEffects: true,
      safeToFallbackBeforeOutput: true,
      retryPolicy: "single-next-isolated-account-only",
      exitCode: result.exitCode,
      exitSignal: result.exitSignal,
    },
  });
}

export function nativeCodexEnvironment(codexHome, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment, CODEX_HOME: codexHome };
  for (const key of Object.keys(environment)) {
    if (["OPENAI_BASE_URL", "CHATGPT_BASE_URL", "CODEX_BASE_URL", "CODEX_API_BASE_URL"].includes(key)
      || /^THREADSPAN_/i.test(key)
      || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BEARER_TOKEN|SESSION_TOKEN|SECRET_KEY|PASSWORD)$/i.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RequestError(`Codex Native Worker ${field} must be a positive integer`);
  return value;
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
