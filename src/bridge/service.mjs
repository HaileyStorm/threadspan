import { applyModePolicy } from "../core/policies.mjs";
import { asBridgeError, RequestError } from "../core/errors.mjs";
import { createId, createTraceId } from "../core/ids.mjs";
import { normalizeConsultInput, normalizeResponsesInput, toBridgeResponsesInput } from "../core/input-normalizer.mjs";
import { KeyedSerialQueue } from "../core/keyed-serial-queue.mjs";
import { Logger } from "../core/logger.mjs";
import { boundedRedactedJson } from "../core/redact.mjs";
import { SessionStore } from "../core/session-store.mjs";
import { ProviderRegistry } from "../providers/registry.mjs";
import { ResponsesAssembler } from "./responses.mjs";

/**
 * Core bridge orchestrator shared by HTTP, MCP, and CLI surfaces.
 */
export class BridgeService {
  /**
   * @param {Record<string, any>} config Validated bridge configuration.
   * @param {{logger?: Logger, registry?: ProviderRegistry, sessions?: SessionStore}} [dependencies] Injectable dependencies.
   */
  constructor(config, dependencies = {}) {
    this.config = config;
    this.logger = dependencies.logger ?? new Logger({ level: config.logging?.level ?? "info" });
    this.sessions = dependencies.sessions ?? new SessionStore(config.sessions);
    this.registry = dependencies.registry ?? new ProviderRegistry(config, { logger: this.logger });
    this.convenienceThreads = dependencies.convenienceThreads ?? new KeyedSerialQueue();
    this.closed = false;
  }

  /**
   * Execute an OpenAI Responses-style request.
   *
   * `onEvent` is awaited to provide backpressure to an SSE writer. The method returns the exact
   * terminal response object used in `response.completed`, so buffered and streaming paths share one implementation.
   *
   * @param {Record<string, any>} request Responses request.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async executeResponse(request, options = {}) {
    this.#assertOpen();
    validateResponseRequest(request);
    const traceId = createTraceId();
    const previousRecord = request.previous_response_id ? this.sessions.getResponse(request.previous_response_id) : undefined;
    if (request.previous_response_id && !previousRecord) {
      throw new RequestError(`Unknown or expired previous_response_id '${request.previous_response_id}'`);
    }

    const route = this.registry.resolveRoute({
      model: request.model,
      mode: request.metadata?.bridge_mode,
      providerId: request.metadata?.bridge_provider,
    });
    const threadId = String(request.metadata?.bridge_thread_id ?? previousRecord?.threadId ?? createId("thread"));
    const suppressDefaultWorkspace = metadataBoolean(request.metadata?.bridge_no_default_workspace);
    const workspace = request.metadata?.bridge_workspace ?? request.metadata?.cwd ?? (suppressDefaultWorkspace ? undefined : process.cwd());
    const normalizedMessages = normalizeResponsesInput(request, previousRecord);
    const messages = applyModePolicy(normalizedMessages, route.mode);
    const assembler = new ResponsesAssembler(request, {
      ...route,
      threadId,
      exposeReasoning: request.metadata?.bridge_expose_reasoning === true || request.metadata?.bridge_expose_reasoning === "true" || this.config.responses?.exposeReasoning === true,
    });

    this.logger.info("Starting response", {
      traceId,
      responseId: assembler.responseId,
      threadId,
      provider: route.providerId,
      mode: route.mode,
      model: route.model,
      stream: request.stream === true,
    });
    if (this.config.logging?.logBodies === true) {
      this.logger.info("Response request body", {
        traceId,
        responseId: assembler.responseId,
        body: boundedRedactedJson(request),
      });
    }

    try {
      await emitAll(assembler.begin(), options.onEvent);
      let terminal;
      const providerRequest = {
        mode: route.mode,
        model: route.model,
        messages,
        tools: route.mode === "integrated" ? request.tools : undefined,
        toolChoice: route.mode === "integrated" ? request.tool_choice : undefined,
        temperature: request.temperature,
        maxOutputTokens: request.max_output_tokens,
        signal: options.signal,
        threadId,
        workspace: workspace ? String(workspace) : undefined,
        timeoutMs: numberFromMetadata(request.metadata?.bridge_timeout_ms),
        metadata: request.metadata ?? {},
      };

      for await (const providerEvent of route.provider.run(providerRequest)) {
        if (options.signal?.aborted) throw options.signal.reason ?? new Error("Request aborted");
        if (providerEvent.type === "done") terminal = providerEvent;
        await emitAll(assembler.accept(providerEvent), options.onEvent);
      }
      await emitAll(assembler.finish(terminal), options.onEvent);

      const assistant = assembler.assistantMessage();
      const storedMessages = [...messages, assistant];
      const thread = this.sessions.getOrCreateThread(threadId, {
        providerId: route.providerId,
        mode: route.mode,
        model: route.model,
        workspace: workspace ? String(workspace) : undefined,
      });
      thread.messages = structuredClone(storedMessages);
      thread.providerId = route.providerId;
      thread.mode = route.mode;
      thread.model = route.model;
      thread.workspace = workspace ? String(workspace) : undefined;
      thread.updatedAt = Date.now();
      this.sessions.putResponse(assembler.response, {
        threadId,
        messages: storedMessages,
        providerId: route.providerId,
        mode: route.mode,
        model: route.model,
      });

      this.logger.info("Completed response", {
        traceId,
        responseId: assembler.responseId,
        threadId,
        provider: route.providerId,
        mode: route.mode,
        model: route.model,
        finishReason: assembler.finishReason,
        usage: assembler.usage,
      });
      if (this.config.logging?.logBodies === true) {
        this.logger.info("Response result body", {
          traceId,
          responseId: assembler.responseId,
          body: boundedRedactedJson(assembler.response),
        });
      }
      return assembler.response;
    } catch (error) {
      const bridgeError = asBridgeError(error);
      await emitAll(assembler.fail({ code: bridgeError.code, message: bridgeError.message }), options.onEvent).catch(() => undefined);
      this.logger.error("Response failed", {
        traceId,
        responseId: assembler.responseId,
        threadId,
        code: bridgeError.code,
        message: bridgeError.message,
      });
      throw bridgeError;
    }
  }

  /**
   * Invoke Consult as an in-thread advisory call suitable for MCP and CLI consumers.
   * @param {{
   *   question: string,
   *   context?: string,
   *   artifacts?: Array<{label?: string, path?: string, content?: string}>,
   *   system?: string,
   *   provider?: string,
   *   model?: string,
   *   threadId?: string,
   *   workspace?: string,
   *   timeoutMs?: number,
   *   profile?: string,
   *   reasoningEffort?: string,
   *   maxTurns?: number,
   *   noPlan?: boolean,
   *   expectedTurns?: number,
   *   acceptanceCommands?: string[],
   *   allowSubagents?: boolean,
   *   allowWebSearch?: boolean,
   *   coordinatorId?: string,
   *   workerGroup?: string,
   *   metadata?: Record<string, any>,
   * }} input Consult input.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async consult(input, options = {}) {
    return this.#runConvenienceMode("consult", input, options);
  }

  /**
   * Invoke Delegate as a bounded execution handoff suitable for MCP and CLI consumers.
   * @param {Record<string, any>} input Delegate input.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async delegate(input, options = {}) {
    return this.#runConvenienceMode("delegate", input, options);
  }

  /** Return provider capabilities and discovered/configured models. */
  async describeProviders() {
    this.#assertOpen();
    return this.registry.describe();
  }

  /** Return OpenAI-shaped routed model entries. */
  async listModels() {
    this.#assertOpen();
    return this.registry.listRoutedModels();
  }

  /** Return count-only service diagnostics. */
  stats() {
    return {
      status: this.closed ? "closed" : "ok",
      sessions: this.sessions.stats(),
      providers: this.registry.providers.size,
      providerRuntime: this.registry.runtimeStats(),
      configPath: this.config.configPath,
    };
  }

  /** Dispose provider resources. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.registry.close();
  }

  /**
   * Execute one convenience mode by mapping it through the same Responses implementation.
   * @param {"consult"|"delegate"} mode Convenience mode.
   * @param {Record<string, any>} input Input object.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} options Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async #runConvenienceMode(mode, input, options) {
    if (!input || typeof input !== "object") throw new RequestError(`${mode} input must be an object`);
    if (typeof input.question !== "string" || input.question.trim().length === 0) {
      throw new RequestError(`${mode} requires a non-empty question`);
    }
    const provider = input.provider ?? this.config.defaults?.provider;
    if (!provider) throw new RequestError(`No provider supplied and no defaults.provider configured`);
    const providerAdapter = this.registry.get(provider);
    const model = input.model ?? providerAdapter.config.model ?? this.config.defaults?.model ?? "auto";
    const threadId = input.threadId ?? createId("thread");
    return this.convenienceThreads.run(threadId, options.signal, async () => {
      const priorThread = input.threadId ? this.sessions.getThread(input.threadId) : undefined;
      const newMessages = normalizeConsultInput(input);
      const messages = priorThread?.messages?.length
        ? [...structuredClone(priorThread.messages), ...newMessages]
        : newMessages;
      const responseRequest = {
        model: `${mode}/${provider}/${model}`,
        input: toBridgeResponsesInput(messages),
        stream: false,
        store: false,
        metadata: {
          ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
          ...(input.profile ? { bridge_profile: String(input.profile) } : {}),
          ...(input.reasoningEffort ? { bridge_reasoning_effort: String(input.reasoningEffort) } : {}),
          ...(input.maxTurns ? { bridge_max_turns: String(input.maxTurns) } : {}),
          ...(input.expectedTurns ? { bridge_expected_turns: String(input.expectedTurns) } : {}),
          ...(input.noPlan !== undefined ? { bridge_no_plan: input.noPlan === true } : {}),
          ...(input.allowSubagents !== undefined ? { bridge_allow_subagents: input.allowSubagents === true } : {}),
          ...(input.allowWebSearch !== undefined ? { bridge_allow_web_search: input.allowWebSearch === true } : {}),
          ...(input.coordinatorId ? { bridge_coordinator_id: String(input.coordinatorId) } : {}),
          ...(input.workerGroup ? { bridge_worker_group: String(input.workerGroup) } : {}),
          ...(Array.isArray(input.acceptanceCommands) && input.acceptanceCommands.length > 0
            ? { bridge_acceptance_commands: input.acceptanceCommands.map(String) }
            : {}),
          bridge_mode: mode,
          bridge_provider: provider,
          bridge_thread_id: threadId,
          ...(input.workspace
            ? { bridge_workspace: input.workspace }
            : { bridge_no_default_workspace: true }),
          ...(input.timeoutMs ? { bridge_timeout_ms: String(input.timeoutMs) } : {}),
        },
      };
      const response = await this.executeResponse(responseRequest, options);
      return {
        responseId: response.id,
        threadId,
        provider,
        mode,
        model,
        text: response.output_text ?? extractOutputText(response.output),
        usage: response.usage,
        ...(response.bridge_provider_metadata ? { providerMetadata: response.bridge_provider_metadata } : {}),
        response,
      };
    });
  }

  /** Throw when a caller uses a closed service. */
  #assertOpen() {
    if (this.closed) throw new Error("BridgeService is closed");
  }
}

/**
 * Validate the subset of Responses request fields required by this bridge.
 * @param {Record<string, any>} request Request.
 */
function validateResponseRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new RequestError("Request body must be an object");
  if (request.model !== undefined && typeof request.model !== "string") throw new RequestError("model must be a string");
  if (request.stream !== undefined && typeof request.stream !== "boolean") throw new RequestError("stream must be boolean");
  if (request.metadata !== undefined && (!request.metadata || typeof request.metadata !== "object" || Array.isArray(request.metadata))) {
    throw new RequestError("metadata must be an object");
  }
}

/**
 * Emit an event list sequentially to preserve stream ordering and backpressure.
 * @param {Array<Record<string, any>>} events Events.
 * @param {((event: Record<string, any>) => void|Promise<void>)|undefined} onEvent Event sink.
 * @returns {Promise<void>}
 */
async function emitAll(events, onEvent) {
  if (!onEvent) return;
  for (const event of events) await onEvent(event);
}

/**
 * Extract assistant text from final Responses output items.
 * @param {Array<Record<string, any>>} output Response output.
 * @returns {string}
 */
function extractOutputText(output) {
  return (output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
}

/**
 * Parse an optional timeout metadata value.
 * @param {unknown} value Metadata value.
 * @returns {number|undefined}
 */
function numberFromMetadata(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Parse a permissive boolean metadata value. */
function metadataBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
