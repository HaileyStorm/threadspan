import { createId } from "../core/ids.mjs";

/**
 * Incrementally translates provider-neutral events into OpenAI Responses API objects and SSE events.
 */
export class ResponsesAssembler {
  /**
   * @param {Record<string, any>} request Original Responses request.
   * @param {{providerId: string, mode: string, model: string, threadId: string, exposeReasoning?: boolean}} route Resolved bridge route.
   */
  constructor(request, route) {
    this.request = request;
    this.route = route;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.sequenceNumber = 0;
    this.responseId = createId("resp");
    this.text = "";
    this.reasoning = "";
    this.usage = undefined;
    this.finishReason = undefined;
    this.providerMetadata = undefined;
    this.messageItem = undefined;
    this.reasoningItem = undefined;
    /** @type {Map<number, Record<string, any>>} */
    this.toolCalls = new Map();
    /** @type {Array<Record<string, any>>} */
    this.output = [];
    this.started = false;
    this.finalized = false;
    this.response = this.#buildResponse("in_progress");
  }

  /**
   * Return initial `response.created` and `response.in_progress` events.
   * @returns {Array<Record<string, any>>}
   */
  begin() {
    if (this.started) return [];
    this.started = true;
    return [
      this.#event("response.created", { response: this.#snapshotResponse("in_progress") }),
      this.#event("response.in_progress", { response: this.#snapshotResponse("in_progress") }),
    ];
  }

  /**
   * Consume one provider-neutral event and return zero or more Responses API stream events.
   * @param {Record<string, any>} providerEvent Provider event.
   * @returns {Array<Record<string, any>>}
   */
  accept(providerEvent) {
    if (this.finalized) return [];
    switch (providerEvent.type) {
      case "text-delta":
        return this.#acceptTextDelta(String(providerEvent.delta ?? ""));
      case "reasoning-delta":
        return this.#acceptReasoningDelta(String(providerEvent.delta ?? ""));
      case "tool-call-delta":
        return this.#acceptToolCallDelta(providerEvent);
      case "usage":
        this.usage = normalizeUsage(providerEvent.usage);
        return [];
      case "done":
        return this.#acceptDone(providerEvent);
      default:
        return [];
    }
  }

  /**
   * Finalize any open output items and return the terminal response event.
   * @param {{message?: Record<string, any>, usage?: Record<string, any>, finishReason?: string, providerMetadata?: Record<string, any>}} [terminal] Terminal provider state.
   * @returns {Array<Record<string, any>>}
   */
  finish(terminal = {}) {
    if (this.finalized) return [];
    const events = [];
    if (terminal.message) events.push(...this.#syncTerminalMessage(terminal.message));
    if (terminal.usage) this.usage = normalizeUsage(terminal.usage);
    if (terminal.finishReason) this.finishReason = terminal.finishReason;
    if (terminal.providerMetadata) this.providerMetadata = terminal.providerMetadata;

    if (this.reasoningItem) {
      const outputIndex = this.output.indexOf(this.reasoningItem);
      events.push(this.#event("response.reasoning_summary_text.done", {
        item_id: this.reasoningItem.id,
        output_index: outputIndex,
        summary_index: 0,
        text: this.reasoning,
      }));
      events.push(this.#event("response.reasoning_summary_part.done", {
        item_id: this.reasoningItem.id,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: this.reasoning },
      }));
      this.reasoningItem.status = "completed";
      events.push(this.#event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(this.reasoningItem),
      }));
    }

    if (this.messageItem) {
      const outputIndex = this.output.indexOf(this.messageItem);
      events.push(this.#event("response.output_text.done", {
        item_id: this.messageItem.id,
        output_index: outputIndex,
        content_index: 0,
        text: this.text,
        logprobs: [],
      }));
      events.push(this.#event("response.content_part.done", {
        item_id: this.messageItem.id,
        output_index: outputIndex,
        content_index: 0,
        part: structuredClone(this.messageItem.content[0]),
      }));
      this.messageItem.status = "completed";
      events.push(this.#event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(this.messageItem),
      }));
    }

    for (const [index, call] of [...this.toolCalls.entries()].sort(([left], [right]) => left - right)) {
      this.#ensureToolCallOutputItem(index, call, events);
      call.item.arguments = call.argumentsText || "{}";
      call.item.name = call.name || "unknown_tool";
      call.item.status = "completed";
      const outputIndex = this.output.indexOf(call.item);
      events.push(this.#event("response.function_call_arguments.done", {
        item_id: call.item.id,
        output_index: outputIndex,
        arguments: call.item.arguments,
      }));
      events.push(this.#event("response.output_item.done", {
        output_index: outputIndex,
        item: structuredClone(call.item),
      }));
    }

    this.finalized = true;
    this.response = this.#buildResponse("completed");
    events.push(this.#event("response.completed", { response: structuredClone(this.response) }));
    return events;
  }

  /**
   * Mark the response failed and return a terminal failure event.
   * @param {{code?: string, message: string}} error Public failure details.
   * @returns {Array<Record<string, any>>}
   */
  fail(error) {
    if (this.finalized) return [];
    this.finalized = true;
    this.response = {
      ...this.#buildResponse("failed"),
      error: { code: error.code ?? "bridge_error", message: error.message },
    };
    return [this.#event("response.failed", { response: structuredClone(this.response) })];
  }

  /**
   * Return the provider-neutral assistant message needed for later tool/result round trips.
   * @returns {Record<string, any>}
   */
  assistantMessage() {
    const calls = [...this.toolCalls.entries()].sort(([left], [right]) => left - right).map(([, call], index) => ({
      id: call.callId || `call_${index + 1}`,
      name: call.name || "unknown_tool",
      argumentsText: call.argumentsText || "{}",
      arguments: parseArguments(call.argumentsText || "{}"),
    }));
    return {
      role: "assistant",
      content: this.text,
      ...(this.reasoning ? { reasoningContent: this.reasoning } : {}),
      ...(Array.isArray(this.reasoningDetails) ? { reasoningDetails: structuredClone(this.reasoningDetails) } : {}),
      ...(calls.length > 0 ? { toolCalls: calls } : {}),
    };
  }

  /**
   * Return a compact terminal result for MCP/CLI consumers.
   * @returns {Record<string, any>}
   */
  compactResult() {
    return {
      responseId: this.responseId,
      threadId: this.route.threadId,
      provider: this.route.providerId,
      mode: this.route.mode,
      model: this.route.model,
      text: this.text,
      finishReason: this.finishReason ?? "stop",
      usage: this.usage,
      ...(this.providerMetadata ? { providerMetadata: this.providerMetadata } : {}),
    };
  }

  /**
   * Append a text delta and create the assistant message item on first output.
   * @param {string} delta Text delta.
   * @returns {Array<Record<string, any>>}
   */
  #acceptTextDelta(delta) {
    if (!delta) return [];
    const events = [];
    this.#ensureMessageItem(events);
    this.text += delta;
    this.messageItem.content[0].text = this.text;
    const outputIndex = this.output.indexOf(this.messageItem);
    events.push(this.#event("response.output_text.delta", {
      item_id: this.messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    }));
    return events;
  }

  /**
   * Append reasoning content. It is retained for provider round trips and emitted only when configured.
   * @param {string} delta Reasoning delta.
   * @returns {Array<Record<string, any>>}
   */
  #acceptReasoningDelta(delta) {
    if (!delta) return [];
    this.reasoning += delta;
    if (!this.route.exposeReasoning) return [];
    const events = [];
    this.#ensureReasoningItem(events);
    this.reasoningItem.summary[0].text = this.reasoning;
    const outputIndex = this.output.indexOf(this.reasoningItem);
    events.push(this.#event("response.reasoning_summary_text.delta", {
      item_id: this.reasoningItem.id,
      output_index: outputIndex,
      summary_index: 0,
      delta,
    }));
    return events;
  }

  /**
   * Accumulate a streamed function call and emit argument deltas once an output item can be identified.
   * @param {Record<string, any>} providerEvent Provider tool-call delta.
   * @returns {Array<Record<string, any>>}
   */
  #acceptToolCallDelta(providerEvent) {
    const index = Number.isInteger(providerEvent.index) ? providerEvent.index : 0;
    const call = this.toolCalls.get(index) ?? {
      callId: "",
      name: "",
      argumentsText: "",
      item: undefined,
      pendingArguments: "",
    };
    if (providerEvent.id) call.callId = String(providerEvent.id);
    if (providerEvent.nameDelta) call.name += String(providerEvent.nameDelta);
    if (providerEvent.argumentsDelta) {
      call.argumentsText += String(providerEvent.argumentsDelta);
      call.pendingArguments += String(providerEvent.argumentsDelta);
    }
    this.toolCalls.set(index, call);

    const events = [];
    if (call.name || call.item) this.#ensureToolCallOutputItem(index, call, events);
    if (call.item && call.pendingArguments) {
      const outputIndex = this.output.indexOf(call.item);
      events.push(this.#event("response.function_call_arguments.delta", {
        item_id: call.item.id,
        output_index: outputIndex,
        delta: call.pendingArguments,
      }));
      call.pendingArguments = "";
    }
    return events;
  }

  /**
   * Apply a provider terminal event without finalizing stream framing yet.
   * @param {Record<string, any>} providerEvent Provider done event.
   * @returns {Array<Record<string, any>>}
   */
  #acceptDone(providerEvent) {
    const events = this.#syncTerminalMessage(providerEvent.message ?? {});
    this.finishReason = providerEvent.finishReason ?? this.finishReason;
    this.usage = normalizeUsage(providerEvent.usage ?? this.usage);
    this.providerMetadata = providerEvent.providerMetadata ?? this.providerMetadata;
    return events;
  }

  /**
   * Reconcile terminal provider content with deltas already observed.
   * @param {Record<string, any>} message Provider-neutral assistant message.
   * @returns {Array<Record<string, any>>}
   */
  #syncTerminalMessage(message) {
    const events = [];
    const terminalText = String(message.content ?? "");
    if (terminalText && terminalText !== this.text) {
      const delta = terminalText.startsWith(this.text) ? terminalText.slice(this.text.length) : terminalText;
      if (!terminalText.startsWith(this.text)) this.text = "";
      events.push(...this.#acceptTextDelta(delta));
    }
    if (message.reasoningContent && String(message.reasoningContent) !== this.reasoning) {
      const terminalReasoning = String(message.reasoningContent);
      const delta = terminalReasoning.startsWith(this.reasoning) ? terminalReasoning.slice(this.reasoning.length) : terminalReasoning;
      if (!terminalReasoning.startsWith(this.reasoning)) this.reasoning = "";
      events.push(...this.#acceptReasoningDelta(delta));
    }
    if (Array.isArray(message.reasoningDetails)) {
      this.reasoningDetails = structuredClone(message.reasoningDetails);
    }
    for (const [index, terminalCall] of (message.toolCalls ?? []).entries()) {
      const current = this.toolCalls.get(index) ?? {
        callId: "",
        name: "",
        argumentsText: "",
        item: undefined,
        pendingArguments: "",
      };
      current.callId ||= terminalCall.id ?? terminalCall.callId ?? "";
      current.name ||= terminalCall.name ?? "";
      const terminalArguments = terminalCall.argumentsText ?? (typeof terminalCall.arguments === "string" ? terminalCall.arguments : JSON.stringify(terminalCall.arguments ?? {}));
      if (terminalArguments && terminalArguments !== current.argumentsText) {
        current.pendingArguments += terminalArguments.startsWith(current.argumentsText)
          ? terminalArguments.slice(current.argumentsText.length)
          : terminalArguments;
        current.argumentsText = terminalArguments;
      }
      this.toolCalls.set(index, current);
      this.#ensureToolCallOutputItem(index, current, events);
      if (current.pendingArguments) {
        const outputIndex = this.output.indexOf(current.item);
        events.push(this.#event("response.function_call_arguments.delta", {
          item_id: current.item.id,
          output_index: outputIndex,
          delta: current.pendingArguments,
        }));
        current.pendingArguments = "";
      }
    }
    return events;
  }

  /**
   * Create the assistant message output item and its first content part.
   * @param {Array<Record<string, any>>} events Event accumulator.
   */
  #ensureMessageItem(events) {
    if (this.messageItem) return;
    this.messageItem = {
      id: createId("msg"),
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
    };
    this.output.push(this.messageItem);
    const outputIndex = this.output.length - 1;
    events.push(this.#event("response.output_item.added", {
      output_index: outputIndex,
      item: structuredClone(this.messageItem),
    }));
    events.push(this.#event("response.content_part.added", {
      item_id: this.messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: structuredClone(this.messageItem.content[0]),
    }));
  }

  /**
   * Create a visible reasoning-summary item when reasoning exposure is enabled.
   * @param {Array<Record<string, any>>} events Event accumulator.
   */
  #ensureReasoningItem(events) {
    if (this.reasoningItem) return;
    this.reasoningItem = {
      id: createId("rs"),
      type: "reasoning",
      status: "in_progress",
      summary: [{ type: "summary_text", text: "" }],
    };
    this.output.push(this.reasoningItem);
    const outputIndex = this.output.length - 1;
    events.push(this.#event("response.output_item.added", {
      output_index: outputIndex,
      item: structuredClone(this.reasoningItem),
    }));
    events.push(this.#event("response.reasoning_summary_part.added", {
      item_id: this.reasoningItem.id,
      output_index: outputIndex,
      summary_index: 0,
      part: structuredClone(this.reasoningItem.summary[0]),
    }));
  }

  /**
   * Create a function-call output item and flush any arguments accumulated before its name arrived.
   * @param {number} index Provider tool-call index.
   * @param {Record<string, any>} call Mutable call state.
   * @param {Array<Record<string, any>>} events Event accumulator.
   */
  #ensureToolCallOutputItem(index, call, events) {
    if (!call.item) {
      call.item = {
        id: createId("fc"),
        type: "function_call",
        status: "in_progress",
        arguments: "",
        call_id: call.callId || createId("call"),
        name: call.name || "unknown_tool",
      };
      this.output.push(call.item);
      events.push(this.#event("response.output_item.added", {
        output_index: this.output.length - 1,
        item: structuredClone(call.item),
      }));
    }
    call.item.call_id = call.callId || call.item.call_id;
    call.item.name = call.name || call.item.name;
    call.item.arguments = call.argumentsText;
    this.toolCalls.set(index, call);
  }

  /**
   * Build the current top-level Responses object.
   * @param {"in_progress"|"completed"|"failed"} status Response status.
   * @returns {Record<string, any>}
   */
  #buildResponse(status) {
    const usage = this.usage ? {
      input_tokens: this.usage.inputTokens,
      input_tokens_details: { cached_tokens: this.usage.cachedInputTokens ?? 0 },
      output_tokens: this.usage.outputTokens,
      output_tokens_details: { reasoning_tokens: this.usage.reasoningTokens ?? 0 },
      total_tokens: this.usage.totalTokens,
    } : null;
    return {
      id: this.responseId,
      object: "response",
      created_at: this.createdAt,
      status,
      background: false,
      billing: { payer: "developer" },
      error: null,
      incomplete_details: null,
      instructions: this.request.instructions ?? null,
      max_output_tokens: this.request.max_output_tokens ?? null,
      max_tool_calls: this.request.max_tool_calls ?? null,
      model: this.request.model ?? `${this.route.mode}/${this.route.providerId}/${this.route.model}`,
      output: structuredClone(this.output),
      parallel_tool_calls: this.request.parallel_tool_calls ?? true,
      previous_response_id: this.request.previous_response_id ?? null,
      prompt_cache_key: this.request.prompt_cache_key ?? null,
      reasoning: this.request.reasoning ?? null,
      safety_identifier: this.request.safety_identifier ?? null,
      service_tier: this.request.service_tier ?? "default",
      store: this.request.store ?? false,
      temperature: this.request.temperature ?? null,
      text: this.request.text ?? { format: { type: "text" } },
      tool_choice: this.request.tool_choice ?? "auto",
      tools: Array.isArray(this.request.tools) ? structuredClone(this.request.tools) : [],
      top_logprobs: this.request.top_logprobs ?? 0,
      top_p: this.request.top_p ?? null,
      truncation: this.request.truncation ?? "disabled",
      usage,
      user: this.request.user ?? null,
      metadata: {
        ...(this.request.metadata ?? {}),
        bridge_provider: this.route.providerId,
        bridge_mode: this.route.mode,
        bridge_upstream_model: this.route.model,
        bridge_thread_id: this.route.threadId,
        ...(this.finishReason ? { bridge_finish_reason: this.finishReason } : {}),
      },
      output_text: this.text,
      ...(this.providerMetadata ? { bridge_provider_metadata: structuredClone(this.providerMetadata) } : {}),
    };
  }

  /**
   * Snapshot the response after refreshing mutable output fields.
   * @param {"in_progress"|"completed"|"failed"} status Response status.
   * @returns {Record<string, any>}
   */
  #snapshotResponse(status) {
    this.response = this.#buildResponse(status);
    return structuredClone(this.response);
  }

  /**
   * Create one stream event with a monotonically increasing sequence number.
   * @param {string} type Event type.
   * @param {Record<string, any>} fields Event fields.
   * @returns {Record<string, any>}
   */
  #event(type, fields) {
    const event = { type, sequence_number: this.sequenceNumber, ...fields };
    this.sequenceNumber += 1;
    return event;
  }
}

/**
 * Normalize provider token usage to non-negative numeric fields.
 * @param {any} usage Provider usage.
 * @returns {Record<string, number>|undefined}
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = numberOrZero(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberOrZero(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: numberOrZero(usage.totalTokens ?? usage.total_tokens) || inputTokens + outputTokens,
    cachedInputTokens: numberOrZero(usage.cachedInputTokens ?? usage.cached_input_tokens),
    reasoningTokens: numberOrZero(usage.reasoningTokens ?? usage.reasoning_tokens),
  };
}

/**
 * Convert a value to a finite non-negative number.
 * @param {unknown} value Candidate value.
 * @returns {number}
 */
function numberOrZero(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Parse a JSON arguments string while retaining malformed strings for diagnostics.
 * @param {string} value Arguments text.
 * @returns {unknown}
 */
function parseArguments(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return value;
  }
}
