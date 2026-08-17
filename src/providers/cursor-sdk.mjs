import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AsyncQueue } from "../core/async-queue.mjs";
import { CapabilityError, ProviderError, RequestError } from "../core/errors.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { createWorkspaceSnapshot } from "../workspace/snapshot.mjs";
import { ProviderAdapter, resolveApiKey } from "./base.mjs";

/**
 * Cursor SDK provider.
 *
 * Cursor's SDK exposes an agent harness rather than a raw model endpoint. The adapter therefore
 * implements Consult by running `plan` mode in a disposable workspace snapshot and implements
 * Delegate with an `agent` mode bound to the live workspace. Integrated mode is intentionally
 * rejected rather than masquerading an agent-owned tool loop as a model-owned response stream.
 */
export class CursorSdkProvider extends ProviderAdapter {
  /** @param {string} id @param {Record<string, any>} config @param {{logger: any}} context */
  constructor(id, config, context) {
    super(id, config, context);
    /** @type {Map<string, CursorDelegateEntry>} */
    this.delegateAgents = new Map();
    /** @type {Map<string, Promise<CursorDelegateEntry>>} */
    this.delegateAgentCreations = new Map();
    this.loadCursorSdk = context.cursorSdkLoader ?? loadCursorSdk;
    this.nextSweepAt = 0;
    this.closed = false;
  }

  /** Return Cursor-specific capability metadata with the SDK limitations made explicit. */
  capabilities() {
    const configured = new Set(Array.isArray(this.config.capabilities) ? this.config.capabilities : ["consult", "delegate"]);
    return {
      modes: {
        consult: {
          supported: configured.has("consult"),
          reason: configured.has("consult") ? undefined : "not enabled in provider configuration",
          readOnlyBoundary: "disposable-workspace-snapshot",
        },
        integrated: {
          supported: false,
          reason: "@cursor/sdk exposes Cursor's agent harness, not a raw model endpoint whose tool loop can be owned by the caller",
        },
        delegate: {
          supported: configured.has("delegate"),
          reason: configured.has("delegate") ? undefined : "not enabled in provider configuration",
          mutationBoundary: "live-workspace",
        },
      },
      streaming: true,
      tools: false,
      images: false,
      durableThreads: true,
      providerOwnsTools: true,
      localRuntime: true,
      hardReadOnlyAskMode: false,
    };
  }

  /**
   * Discover models visible to the configured Cursor account.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listModels() {
    const configured = Array.isArray(this.config.models) ? this.config.models : undefined;
    if (configured) return super.listModels();
    const apiKey = this.#requireApiKey();
    try {
      const sdk = await this.loadCursorSdk();
      const result = await sdk.Cursor.models.list({ apiKey });
      const models = Array.isArray(result) ? result : result?.models ?? result?.data ?? [];
      if (models.length === 0) return [{ id: this.config.model ?? "auto" }];
      return models.map((model) => ({
        id: String(model.id ?? model.model ?? model.name),
        ...(model.name ? { name: model.name } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      }));
    } catch (error) {
      this.logger.warn("Cursor model discovery failed; using configured fallback", { error: error instanceof Error ? error.message : String(error) });
      return [{ id: this.config.model ?? "auto" }];
    }
  }

  /**
   * Execute a Cursor-backed consultation or delegated task.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {AsyncIterable<Record<string, any>>}
   */
  async *run(request) {
    if (this.closed) throw new ProviderError(this.id, "Cursor provider is closed", { status: 503 });
    this.assertMode(request.mode);
    if (request.mode === "integrated") {
      throw new CapabilityError(this.id, "integrated", this.capabilities().modes.integrated.reason);
    }
    if (request.mode === "consult") {
      yield* this.#runConsult(request);
      return;
    }
    yield* this.#runDelegate(request);
  }

  /** Return count-only retained-agent state for shared-daemon monitoring. */
  runtimeStats() {
    return {
      kind: "cursor-sdk",
      closed: this.closed,
      retainedDelegateAgents: this.delegateAgents.size,
      pendingDelegateAgentCreations: this.delegateAgentCreations.size,
      maxDelegateAgents: this.config.delegate?.maxAgents ?? 16,
      delegateAgentTtlMs: this.config.delegate?.agentTtlMs ?? 60 * 60 * 1000,
    };
  }

  /** Release retained delegate agents and their local stores/processes. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.delegateAgentCreations.values()]);
    this.delegateAgentCreations.clear();
    const entries = [...this.delegateAgents.values()];
    this.delegateAgents.clear();
    await Promise.allSettled(entries.map((entry) => disposeAgent(entry.agent)));
  }

  /**
   * Run Consult in an isolated copy, making any accidental SDK write harmless to the source tree.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {AsyncIterable<Record<string, any>>}
   */
  async *#runConsult(request) {
    const sdk = await this.loadCursorSdk();
    const apiKey = this.#requireApiKey();
    const workspaceStrategy = this.config.consult?.workspaceStrategy ?? "snapshot";
    let snapshot;
    let emptyWorkspace;
    let workspace;

    try {
      if (request.workspace && workspaceStrategy === "snapshot") {
        snapshot = await createWorkspaceSnapshot(request.workspace, {
          root: this.config.consult?.snapshotRoot,
          exclude: this.config.consult?.exclude,
          maxBytes: this.config.consult?.snapshotMaxBytes,
          maxFiles: this.config.consult?.snapshotMaxFiles,
          copyInternalSymlinks: this.config.consult?.copyInternalSymlinks === true,
          logger: this.logger,
        });
        workspace = snapshot.path;
        this.logger.debug("Created Consult workspace snapshot", {
          source: request.workspace,
          snapshot: workspace,
          bytes: snapshot.bytesCopied,
          files: snapshot.filesCopied,
          skipped: snapshot.skipped.length,
        });
      } else if (workspaceStrategy === "none" || !request.workspace) {
        emptyWorkspace = await mkdtemp(join(tmpdir(), "cursor-bridge-consult-empty-"));
        workspace = emptyWorkspace;
      } else {
        throw new RequestError(`Unsupported Cursor Consult workspaceStrategy '${workspaceStrategy}'`);
      }

      const agent = await createCursorAgent(sdk, {
        apiKey,
        model: request.model,
        mode: this.config.consult?.agentMode ?? "plan",
        cwd: workspace,
        local: this.config.local,
        mcpServers: this.config.consult?.mcpServers ?? this.config.mcpServers,
      });
      try {
        const prompt = this.#renderCursorPrompt(request, {
          header: "The workspace is a disposable snapshot. Inspect it as needed, but return advisory analysis only. Do not edit files as an intended outcome.",
          snapshot,
        });
        yield* streamCursorRun(this.id, agent, prompt, {
          mode: this.config.consult?.agentMode ?? "plan",
          model: request.model,
          signal: request.signal,
          includeToolStatus: this.config.consult?.includeToolStatus === true,
        });
      } finally {
        await disposeAgent(agent);
      }
    } finally {
      await snapshot?.dispose();
      if (emptyWorkspace) await rm(emptyWorkspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Run Delegate against the live workspace, retaining one serial agent per bridge thread/model/workspace.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {AsyncIterable<Record<string, any>>}
   */
  async *#runDelegate(request) {
    if (!request.workspace) throw new RequestError("Cursor Delegate requires a workspace path");
    const entry = await this.#acquireDelegateAgent(request);
    const release = await entry.lock.acquire(request.signal);
    try {
      entry.lastUsedAt = Date.now();
      const prompt = this.#renderCursorPrompt(request, {
        header: "Work directly in the live workspace. Complete the delegated subtask, validate it, and report exact evidence to the primary agent.",
      });
      yield* streamCursorRun(this.id, entry.agent, prompt, {
        mode: this.config.delegate?.agentMode ?? "agent",
        model: request.model,
        signal: request.signal,
        includeToolStatus: this.config.delegate?.includeToolStatus === true,
      });
    } catch (error) {
      if (isLikelyDeadCursorAgent(error)) {
        this.delegateAgents.delete(entry.key);
        await disposeAgent(entry.agent).catch(() => undefined);
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Acquire or create a durable delegate agent for a thread.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {Promise<CursorDelegateEntry>}
   */
  async #acquireDelegateAgent(request) {
    if (this.closed) throw new ProviderError(this.id, "Cursor provider is closed", { status: 503 });
    await this.#sweepDelegateAgents();
    const cwd = resolve(request.workspace);
    const key = [request.threadId ?? "stateless", request.model, cwd].join("\0");
    const current = this.delegateAgents.get(key);
    if (current) return current;

    const pending = this.delegateAgentCreations.get(key);
    if (pending) return pending;

    const creating = this.#createDelegateAgent(request, key, cwd);
    this.delegateAgentCreations.set(key, creating);
    try {
      return await creating;
    } finally {
      if (this.delegateAgentCreations.get(key) === creating) {
        this.delegateAgentCreations.delete(key);
      }
    }
  }

  /**
   * Create exactly one retained delegate agent for a pool key.
   * @param {Record<string, any>} request Provider-neutral request.
   * @param {string} key Delegate pool key.
   * @param {string} cwd Resolved live workspace.
   * @returns {Promise<CursorDelegateEntry>}
   */
  async #createDelegateAgent(request, key, cwd) {
    const sdk = await this.loadCursorSdk();
    const apiKey = this.#requireApiKey();
    const agent = await createCursorAgent(sdk, {
      apiKey,
      model: request.model,
      mode: this.config.delegate?.agentMode ?? "agent",
      cwd,
      local: this.config.local,
      mcpServers: this.config.delegate?.mcpServers ?? this.config.mcpServers,
    });

    if (this.closed) {
      await disposeAgent(agent).catch(() => undefined);
      throw new ProviderError(this.id, "Cursor provider closed while creating a delegate agent", { status: 503 });
    }

    const entry = {
      key,
      agent,
      lock: new AsyncLock(),
      lastUsedAt: Date.now(),
    };
    this.delegateAgents.set(key, entry);
    await this.#enforceDelegateLimit();
    return entry;
  }

  /**
   * Dispose idle delegate agents at a bounded cadence.
   * @returns {Promise<void>}
   */
  async #sweepDelegateAgents() {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + 60_000;
    const ttlMs = this.config.delegate?.agentTtlMs ?? 60 * 60 * 1000;
    const expired = [...this.delegateAgents.values()].filter((entry) => now - entry.lastUsedAt > ttlMs && !entry.lock.locked);
    for (const entry of expired) {
      this.delegateAgents.delete(entry.key);
      await disposeAgent(entry.agent).catch(() => undefined);
    }
  }

  /**
   * Enforce a maximum retained delegate-agent count by disposing least-recently-used idle entries.
   * @returns {Promise<void>}
   */
  async #enforceDelegateLimit() {
    const maxAgents = this.config.delegate?.maxAgents ?? 16;
    if (this.delegateAgents.size <= maxAgents) return;
    const candidates = [...this.delegateAgents.values()].filter((entry) => !entry.lock.locked).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.delegateAgents.size > maxAgents && candidates.length > 0) {
      const entry = candidates.shift();
      this.delegateAgents.delete(entry.key);
      await disposeAgent(entry.agent).catch(() => undefined);
    }
  }

  /**
   * Render a Cursor-agent prompt containing the normalized transcript and execution boundary.
   * @param {Record<string, any>} request Provider-neutral request.
   * @param {{header: string, snapshot?: import("../workspace/snapshot.mjs").WorkspaceSnapshot}} context Prompt context.
   * @returns {string}
   */
  #renderCursorPrompt(request, context) {
    const snapshotNote = context.snapshot
      ? `\nSnapshot statistics: ${context.snapshot.filesCopied} files, ${context.snapshot.bytesCopied} bytes; ${context.snapshot.skipped.length} entries skipped by policy.`
      : "";
    return `${context.header}${snapshotNote}\n\nBRIDGE THREAD: ${request.threadId ?? "stateless"}\nUPSTREAM MODEL: ${request.model}\n\n${renderMessagesForAgent(request.messages)}`;
  }

  /**
   * Resolve and validate the Cursor API key.
   * @returns {string}
   */
  #requireApiKey() {
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) throw new ProviderError(this.id, `Cursor API key is missing; set ${this.config.apiKeyEnv ?? "CURSOR_API_KEY"}`, { status: 500 });
    return apiKey;
  }
}

/** @typedef {{key: string, agent: any, lock: AsyncLock, lastUsedAt: number}} CursorDelegateEntry */

/**
 * Minimal FIFO async mutex used to serialize sends through one durable Cursor agent.
 */
class AsyncLock {
  constructor() {
    this.tail = Promise.resolve();
    this.pendingCount = 0;
  }

  /** Whether a holder or queued waiter still depends on the protected agent. */
  get locked() {
    return this.pendingCount > 0;
  }

  /**
   * Acquire the lock and return a release callback.
   * @param {AbortSignal} [signal] Abort signal while waiting for the turn.
   * @returns {Promise<() => void>}
   */
  async acquire(signal) {
    this.pendingCount += 1;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const previous = this.tail;
    this.tail = previous.catch(() => undefined).then(() => gate);
    try {
      await waitForLockTurn(previous, signal);
    } catch (error) {
      previous.finally(() => {
        this.pendingCount -= 1;
        releaseGate();
      }).catch(() => undefined);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingCount -= 1;
      releaseGate();
    };
  }
}

/** Wait for a mutex turn while permitting a queued caller to cancel immediately. */
function waitForLockTurn(previous, signal) {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Cursor delegate wait aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Cursor delegate wait aborted"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    previous.then(
      () => { cleanup(); resolve(); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

/**
 * Dynamically import the optional Cursor SDK and return a precise installation error when absent.
 * @returns {Promise<any>}
 */
async function loadCursorSdk() {
  try {
    return await import("@cursor/sdk");
  } catch (error) {
    throw new ProviderError("cursor-sdk", "Optional dependency '@cursor/sdk' is not installed. Run 'npm install @cursor/sdk@^1.0.23'.", {
      status: 500,
      details: error instanceof Error ? error.message : String(error),
      cause: error,
    });
  }
}

/**
 * Create a local Cursor SDK agent while keeping SDK version differences isolated to one function.
 * @param {any} sdk Cursor SDK module.
 * @param {{apiKey: string, model: string, mode: string, cwd: string, local?: Record<string, any>, mcpServers?: Record<string, any>}} options Agent options.
 * @returns {Promise<any>}
 */
async function createCursorAgent(sdk, options) {
  const localConfig = options.local ?? {};
  const agentOptions = {
    apiKey: options.apiKey,
    model: { id: options.model || "auto" },
    mode: options.mode,
    local: {
      cwd: options.cwd,
      ...(Array.isArray(localConfig.settingSources) ? { settingSources: localConfig.settingSources } : {}),
      ...(localConfig.autoReview === true ? { autoReview: true } : {}),
      ...(localConfig.sandboxEnabled === true ? { sandboxOptions: { enabled: true } } : {}),
    },
    ...(options.mcpServers && typeof options.mcpServers === "object" ? { mcpServers: options.mcpServers } : {}),
  };
  try {
    return await Promise.resolve(sdk.Agent.create(agentOptions));
  } catch (error) {
    throw normalizeCursorError(error, "Cursor agent creation failed");
  }
}

/**
 * Stream one Cursor SDK run into provider-neutral events and always wait for terminal status.
 * @param {string} providerId Provider id.
 * @param {any} agent Cursor SDK agent.
 * @param {string} prompt Rendered prompt.
 * @param {{mode: string, model: string, signal?: AbortSignal, includeToolStatus?: boolean}} options Run options.
 * @returns {AsyncIterable<Record<string, any>>}
 */
async function* streamCursorRun(providerId, agent, prompt, options) {
  yield { type: "status", status: "started" };
  let run;
  let abortListener;
  try {
    run = await agent.send(prompt, { mode: options.mode, model: { id: options.model || "auto" } });
    abortListener = () => {
      if (run?.supports?.("cancel") !== false) Promise.resolve(run.cancel?.()).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) abortListener();

    let text = "";
    let reasoningContent = "";
    let sawStreamText = false;
    if (run.supports?.("stream") !== false && typeof run.stream === "function") {
      for await (const event of run.stream()) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("Cursor run aborted");
        if (event?.type === "assistant") {
          for (const block of event.message?.content ?? []) {
            if (block?.type === "text" && block.text) {
              sawStreamText = true;
              text += block.text;
              yield { type: "text-delta", delta: block.text };
            }
          }
        } else if (event?.type === "thinking" && event.text) {
          reasoningContent += event.text;
          yield { type: "reasoning-delta", delta: event.text };
        } else if (event?.type === "task" && event.text) {
          yield { type: "status", status: "progress", message: event.text };
        } else if (event?.type === "tool_call" && options.includeToolStatus) {
          yield {
            type: "status",
            status: "tool",
            message: `${event.name ?? "tool"}: ${String(event.status ?? "unknown").toLowerCase()}`,
          };
        }
      }
    }

    const result = await run.wait();
    if (result?.status === "error" || result?.status === "failed") {
      throw new ProviderError(providerId, `Cursor run failed${result.id ? ` (${result.id})` : ""}`, { details: result });
    }
    if (result?.status === "cancelled" || result?.status === "canceled") {
      throw new ProviderError(providerId, "Cursor run was cancelled", { status: 499, details: result });
    }
    const resultText = extractCursorResultText(result);
    if (!sawStreamText && resultText) {
      text = resultText;
      yield { type: "text-delta", delta: resultText };
    } else if (!text && resultText) {
      text = resultText;
    }
    const usage = normalizeCursorUsage(result?.usage);
    if (usage) yield { type: "usage", usage };
    yield {
      type: "done",
      finishReason: "stop",
      message: {
        role: "assistant",
        content: text,
        ...(reasoningContent ? { reasoningContent } : {}),
      },
      usage,
      providerMetadata: {
        agentId: agent.agentId,
        runId: run.id,
        status: result?.status,
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw normalizeCursorError(error, "Cursor run failed");
  } finally {
    if (abortListener) options.signal?.removeEventListener("abort", abortListener);
  }
}

/**
 * Extract terminal assistant text across known Cursor SDK result shapes.
 * @param {any} result Cursor SDK run result.
 * @returns {string}
 */
function extractCursorResultText(result) {
  const candidates = [result?.result, result?.output_text, result?.response?.output_text, result?.message?.content];
  for (const candidate of candidates) {
    if (typeof candidate === "string") return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate.map((part) => part?.text ?? (typeof part === "string" ? part : "")).join("");
      if (text) return text;
    }
  }
  return "";
}

/**
 * Normalize Cursor SDK usage fields to bridge accounting.
 * @param {any} usage Cursor usage.
 * @returns {Record<string, number>|undefined}
 */
function normalizeCursorUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? usage.total_tokens ?? inputTokens + outputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? usage.cached_input_tokens ?? 0,
  };
}

/**
 * Dispose a Cursor SDK agent without allowing cleanup failure to mask the primary outcome.
 * @param {any} agent Cursor SDK agent.
 * @returns {Promise<void>}
 */
async function disposeAgent(agent) {
  if (!agent) return;
  if (typeof agent[Symbol.asyncDispose] === "function") {
    await Promise.resolve(agent[Symbol.asyncDispose]());
  } else if (typeof agent.dispose === "function") {
    await Promise.resolve(agent.dispose());
  }
}

/**
 * Convert Cursor SDK startup and transport failures to a stable bridge error.
 * @param {unknown} error Raw error.
 * @param {string} prefix Context prefix.
 * @returns {ProviderError}
 */
function normalizeCursorError(error, prefix) {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const retryable = Boolean(error?.isRetryable) || /timeout|temporar|rate.?limit|unavailable|connection/i.test(message);
  return new ProviderError("cursor-sdk", `${prefix}: ${message}`, {
    retryable,
    details: {
      name: error?.name,
      code: error?.code,
      isRetryable: error?.isRetryable,
    },
    cause: error,
  });
}

/**
 * Detect transport failures that should invalidate a retained delegate agent.
 * @param {unknown} error Error.
 * @returns {boolean}
 */
function isLikelyDeadCursorAgent(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /transport|socket|closed|broken pipe|ECONNRESET|executor.*dead/i.test(message);
}
