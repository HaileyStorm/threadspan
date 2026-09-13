import { OpenAiChatProvider } from "./openai-chat.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProviderError, RequestError } from "../core/errors.mjs";

const MAX_TOOL_CALLS_PER_TURN = 16;
const MAX_REASONING_EFFORTS = 16;
const MAX_REASONING_EFFORT_LENGTH = 64;
const MAX_REASONING_DESCRIPTION_LENGTH = 256;
const DEFAULT_REASONING_EFFORTS = Object.freeze(["max", "high", "low"]);

/**
 * Nous Portal adapter.
 * Direct API-key inference is the portable default. A Hermes subscription proxy remains
 * available by overriding baseUrl and apiKey in machine-local configuration.
 */
export class NousProvider extends OpenAiChatProvider {
  constructor(id, config, context) {
    super(id, {
      baseUrl: "https://inference-api.nousresearch.com/v1",
      apiKeyEnv: "NOUS_API_KEY",
      discoverModels: true,
      retryWithoutStreaming: false,
      reasoningEffort: "max",
      allowedReasoningEfforts: [...DEFAULT_REASONING_EFFORTS],
      ...config,
      extraBody: { reasoning_effort: config.reasoningEffort ?? "max", ...(config.extraBody ?? {}) },
    }, context);
    this.stopMarkerPath = resolve(config.stopMarkerPath ?? join(homedir(), ".threadspan", "state", "nous_provider_stop.json"));
  }

  /** Normalize Nous catalog metadata used by Threadspan and the Codex picker without filtering models. */
  async listModels() {
    return (await super.listModels()).map(normalizeNousModel);
  }

  /** Forward only a configured Nous reasoning effort; max remains the default. */
  buildRequestBody(request) {
    const body = super.buildRequestBody(request);
    const effort = request.reasoningEffort ?? request.metadata?.bridge_reasoning_effort ?? body.reasoning_effort;
    const allowed = this.config.allowedReasoningEfforts ?? DEFAULT_REASONING_EFFORTS;
    if (typeof effort !== "string" || !allowed.includes(effort)) {
      throw new RequestError("Nous reasoning effort is unsupported; choose a value from the provider's configured allowedReasoningEfforts");
    }
    return { ...body, reasoning_effort: effort };
  }

  async *run(request) {
    const events = [];
    const toolCalls = new Set();
    try {
      for await (const event of super.run(request)) {
        if (event.type === "tool-call-delta") {
          toolCalls.add(Number.isInteger(event.index) ? event.index : 0);
          if (toolCalls.size > MAX_TOOL_CALLS_PER_TURN) {
            throw new ProviderError(this.id, `Nous returned more than ${MAX_TOOL_CALLS_PER_TURN} tool calls in one assistant turn`, { retryable: false });
          }
        }
        if (event.type === "done" && (event.message?.toolCalls?.length ?? 0) > MAX_TOOL_CALLS_PER_TURN) {
          throw new ProviderError(this.id, `Nous returned more than ${MAX_TOOL_CALLS_PER_TURN} tool calls in one assistant turn`, { retryable: false });
        }
        events.push(event);
      }
      for (const event of events) yield event;
    } catch (error) {
      if (isPaymentRequired(error)) {
        try {
          writeStopMarker(this.stopMarkerPath);
        } catch {
          // Diagnostic evidence must never replace the terminal provider error.
        }
      }
      throw error;
    }
  }

  capabilities() {
    return { ...super.capabilities(), streaming: false, bufferedProviderTurns: true };
  }

  runtimeStats() {
    return {
      kind: "nous",
      paymentEvidencePresent: existsSync(this.stopMarkerPath),
      stopMarkerPath: this.stopMarkerPath,
      maxToolCallsPerTurn: MAX_TOOL_CALLS_PER_TURN,
      parallelToolCalls: true,
      maxProviderTurns: 17,
    };
  }
}

function isPaymentRequired(error) {
  return error?.status === 402 || /HTTP\s+402\b/.test(String(error?.message ?? error));
}

function writeStopMarker(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const observedAt = new Date().toISOString();
  const contents = `${JSON.stringify({
    schema_version: 1,
    provider: "nous",
    reason: "http_402",
    observed_at: observedAt,
    launch_gate: false,
  }, null, 2)}\n`;
  try {
    writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const occurrencePath = `${path}.occurrence-${observedAt.replaceAll(":", "-")}-${process.pid}-${randomUUID()}.json`;
  writeFileSync(occurrencePath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

function normalizeNousModel(model) {
  const contextWindow = firstPositiveInteger(model.contextWindow, model.context_window, model.context_length, model.top_provider?.context_length);
  const maxCompletionTokens = firstPositiveInteger(model.maxCompletionTokens, model.max_completion_tokens, model.top_provider?.max_completion_tokens);
  const supportedEfforts = normalizeReasoningEfforts(model.supported_reasoning_levels, { allowObjects: true })
    ?? normalizeReasoningEfforts(model.reasoning?.supported_efforts);
  const defaultReasoningLevel = supportedEfforts?.some((entry) => entry.effort === model.default_reasoning_level)
    ? model.default_reasoning_level
    : supportedEfforts?.some((entry) => entry.effort === model.reasoning?.default_effort)
      ? model.reasoning.default_effort
      : undefined;
  const {
    supported_reasoning_levels: _untrustedLevels, default_reasoning_level: _untrustedDefault,
    contextWindow: _untrustedContext, context_window: _untrustedContextAlias,
    maxCompletionTokens: _untrustedOutput, max_completion_tokens: _untrustedOutputAlias,
    ...safeModel
  } = model;
  return {
    ...safeModel,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
    ...(supportedEfforts ? { supported_reasoning_levels: supportedEfforts } : {}),
    ...(typeof defaultReasoningLevel === "string" ? { default_reasoning_level: defaultReasoningLevel } : {}),
  };
}

function firstPositiveInteger(...values) {
  return values.find((value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function normalizeReasoningEfforts(value, options = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REASONING_EFFORTS) return undefined;
  const unique = new Set();
  const normalized = [];
  for (const entry of value) {
    const effort = typeof entry === "string" ? entry : options.allowObjects === true ? entry?.effort : undefined;
    if (typeof effort !== "string" || effort.length === 0 || effort.length > MAX_REASONING_EFFORT_LENGTH || effort.trim() !== effort || unique.has(effort)) {
      return undefined;
    }
    const description = typeof entry === "object" && entry !== null && entry.description !== undefined
      ? entry.description
      : reasoningLabel(effort);
    if (typeof description !== "string" || description.length === 0 || description.length > MAX_REASONING_DESCRIPTION_LENGTH) return undefined;
    unique.add(effort);
    normalized.push({ effort, description });
  }
  return normalized;
}

function reasoningLabel(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}
