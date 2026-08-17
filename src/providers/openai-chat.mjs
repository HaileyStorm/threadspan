import { ProviderAdapter, resolveApiKey } from "./base.mjs";
import { ProviderError } from "../core/errors.mjs";
import { toOpenAiChatMessages, toOpenAiChatTools } from "../core/input-normalizer.mjs";

/** OpenAI-compatible Chat Completions adapter with streaming and tool-call translation. */
export class OpenAiChatProvider extends ProviderAdapter {
  capabilities() {
    const base = super.capabilities();
    return {
      ...base,
      tools: true,
      images: this.config.images === true,
      durableThreads: false,
    };
  }

  async listModels() {
    if (Array.isArray(this.config.models) || this.config.model) return super.listModels();
    if (this.config.discoverModels !== true) return [{ id: "auto" }];
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const headers = this.#headers();
    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) throw await this.#httpError(response, "model discovery failed");
    const body = await response.json();
    return Array.isArray(body.data) ? body.data.map((item) => ({ id: item.id, ...item })) : [];
  }

  /** @param {any} request */
  async *run(request) {
    this.assertMode(request.mode);
    const body = this.buildRequestBody(request);
    const streamEnabled = this.config.streaming !== false;
    if (!streamEnabled) {
      yield* this.#runNonStreaming(body, request.signal);
      return;
    }

    let emittedMeaningfulEvent = false;
    try {
      for await (const event of this.#runStreaming(body, request.signal)) {
        if (!["status", "warning"].includes(event.type)) emittedMeaningfulEvent = true;
        yield event;
      }
    } catch (error) {
      if (emittedMeaningfulEvent || this.config.retryWithoutStreaming === false) throw error;
      this.logger.warn("Streaming request failed before output; retrying without upstream streaming", {
        error: error instanceof Error ? error.message : String(error),
      });
      yield { type: "warning", message: "Upstream streaming failed; retried as a buffered request." };
      yield* this.#runNonStreaming({ ...body, stream: false }, request.signal);
    }
  }

  /** Build the provider-specific Chat Completions request body. */
  buildRequestBody(request) {
    const tools = request.mode === "integrated" ? toOpenAiChatTools(request.tools) : undefined;
    const body = {
      model: request.model,
      messages: toOpenAiChatMessages(request.messages, { developerAsSystem: this.config.developerAsSystem === true }),
      stream: this.config.streaming !== false,
      ...(tools ? { tools } : {}),
      ...(request.toolChoice && tools ? { tool_choice: normalizeToolChoice(request.toolChoice) } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(this.config.extraBody && typeof this.config.extraBody === "object" ? this.config.extraBody : {}),
    };
    if (body.stream) body.stream_options = { include_usage: true };
    return body;
  }

  async *#runStreaming(body, signal) {
    yield { type: "status", status: "started" };
    const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal,
    });
    if (!response.ok) throw await this.#httpError(response, "chat completion failed");
    if (!response.body) throw new ProviderError(this.id, "Upstream returned no response body");

    const toolCalls = new Map();
    let text = "";
    let reasoningContent = "";
    let usage;
    let finishReason;
    let providerMetadata;

    for await (const data of parseSseData(response.body)) {
      if (data === "[DONE]") break;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) throw new ProviderError(this.id, chunk.error.message ?? "Upstream stream error", { details: chunk.error });
      providerMetadata = mergeProviderMetadata(providerMetadata, extractProviderMetadata(chunk));
      if (chunk.usage) {
        usage = normalizeUsage(chunk.usage);
        yield { type: "usage", usage };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      finishReason ??= choice.finish_reason ?? undefined;
      const delta = choice.delta ?? {};
      const reasoningDelta = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
      if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
        reasoningContent += reasoningDelta;
        yield { type: "reasoning-delta", delta: reasoningDelta };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { type: "text-delta", delta: delta.content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const partial of delta.tool_calls) {
          const index = partial.index ?? 0;
          const current = toolCalls.get(index) ?? { id: "", name: "", argumentsText: "" };
          if (partial.id) current.id = partial.id;
          if (partial.function?.name) current.name += partial.function.name;
          if (partial.function?.arguments) current.argumentsText += partial.function.arguments;
          toolCalls.set(index, current);
          yield {
            type: "tool-call-delta",
            index,
            id: partial.id,
            nameDelta: partial.function?.name,
            argumentsDelta: partial.function?.arguments,
          };
        }
      }
    }

    const completedToolCalls = [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call], index) => ({
      id: call.id || `call_${index + 1}`,
      name: call.name || "unknown_tool",
      arguments: parseToolArguments(call.argumentsText),
      argumentsText: call.argumentsText || "{}",
    }));
    yield {
      type: "done",
      finishReason: finishReason ?? (completedToolCalls.length > 0 ? "tool_calls" : "stop"),
      message: {
        role: "assistant",
        content: text,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(completedToolCalls.length > 0 ? { toolCalls: completedToolCalls } : {}),
      },
      usage,
      ...(providerMetadata ? { providerMetadata } : {}),
    };
  }

  async *#runNonStreaming(body, signal) {
    yield { type: "status", status: "started" };
    const response = await fetch(`${normalizeBaseUrl(this.config.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({ ...body, stream: false, stream_options: undefined }),
      signal,
    });
    if (!response.ok) throw await this.#httpError(response, "chat completion failed");
    const payload = await response.json();
    if (payload.error) throw new ProviderError(this.id, payload.error.message ?? "Upstream error", { details: payload.error });
    const choice = payload.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const reasoningContent = message.reasoning_content ?? message.reasoning ?? message.thinking;
    const text = typeof message.content === "string" ? message.content : renderNonStringContent(message.content);
    if (reasoningContent) yield { type: "reasoning-delta", delta: String(reasoningContent) };
    if (text) yield { type: "text-delta", delta: text };
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call, index) => ({
      id: call.id ?? `call_${index + 1}`,
      name: call.function?.name ?? "unknown_tool",
      argumentsText: call.function?.arguments ?? "{}",
      arguments: parseToolArguments(call.function?.arguments ?? "{}"),
    })) : [];
    const usage = normalizeUsage(payload.usage);
    if (usage) yield { type: "usage", usage };
    yield {
      type: "done",
      finishReason: choice.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      message: {
        role: "assistant",
        content: text,
        ...(reasoningContent ? { reasoningContent: String(reasoningContent) } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      },
      usage,
      ...(extractProviderMetadata(payload) ? { providerMetadata: extractProviderMetadata(payload) } : {}),
    };
  }

  #headers() {
    const apiKey = resolveApiKey(this.config);
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(this.config.headers && typeof this.config.headers === "object" ? this.config.headers : {}),
    };
  }

  async #httpError(response, prefix) {
    const text = await response.text().catch(() => "");
    let details = text;
    try { details = text ? JSON.parse(text) : undefined; } catch {}
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    return new ProviderError(this.id, `${prefix}: HTTP ${response.status}${text ? ` — ${truncate(text, 800)}` : ""}`, {
      status: response.status === 401 || response.status === 403 ? 502 : response.status,
      retryable,
      details,
    });
  }
}

function normalizeBaseUrl(value) {
  const url = String(value ?? "").replace(/\/+$/, "");
  if (!url) throw new ProviderError("unknown", "Provider baseUrl is not configured");
  return url.endsWith("/v1") || /\/beta$/.test(url) ? url : `${url}/v1`;
}

function normalizeToolChoice(choice) {
  if (typeof choice === "string") return choice;
  if (choice?.type === "function") return { type: "function", function: { name: choice.name ?? choice.function?.name } };
  return choice;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = finiteNumber(usage.prompt_tokens ?? usage.input_tokens) ?? 0;
  const outputTokens = finiteNumber(usage.completion_tokens ?? usage.output_tokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: finiteNumber(usage.total_tokens) ?? inputTokens + outputTokens,
    cachedInputTokens: finiteNumber(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0,
    reasoningTokens: finiteNumber(
      usage.completion_tokens_details?.reasoning_tokens
      ?? usage.output_tokens_details?.reasoning_tokens
      ?? usage.reasoning_tokens,
    ) ?? 0,
  };
}

/** Preserve non-sensitive upstream accounting/identity metadata without pretending it is standardized usage. */
function extractProviderMetadata(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const costInUsdTicks = payload.cost_in_usd_ticks ?? payload.usage?.cost_in_usd_ticks;
  const upstream = {
    ...(payload.id ? { id: String(payload.id) } : {}),
    ...(payload.model ? { model: String(payload.model) } : {}),
    ...(payload.system_fingerprint ? { systemFingerprint: String(payload.system_fingerprint) } : {}),
    ...(costInUsdTicks !== undefined ? { costInUsdTicks: finiteNumber(costInUsdTicks) ?? String(costInUsdTicks) } : {}),
  };
  return Object.keys(upstream).length > 0 ? { upstream } : undefined;
}

/** Merge shallow upstream metadata accumulated across streaming chunks. */
function mergeProviderMetadata(current, update) {
  if (!update) return current;
  return { ...current, ...update, upstream: { ...(current?.upstream ?? {}), ...(update.upstream ?? {}) } };
}

/** Convert a numeric provider field while rejecting NaN and infinities. */
function finiteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseToolArguments(text) {
  try { return JSON.parse(text || "{}"); } catch { return text; }
}

function renderNonStringContent(content) {
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content.map((part) => part?.text ?? "").join("");
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Parse data fields from an SSE byte stream. */
export async function* parseSseData(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer = `${buffer}${decoder.decode(chunk, { stream: true })}`.replaceAll("\r\n", "\n");
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = block.split("\n").filter((line) => line.startsWith("data:"));
      if (dataLines.length > 0) yield dataLines.map((line) => line.slice(5).trimStart()).join("\n");
    }
  }
  buffer = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n");
  if (buffer.trim()) {
    const dataLines = buffer.split("\n").filter((line) => line.startsWith("data:"));
    if (dataLines.length > 0) yield dataLines.map((line) => line.slice(5).trimStart()).join("\n");
  }
}
