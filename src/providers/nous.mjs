import { OpenAiChatProvider } from "./openai-chat.mjs";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ProviderError } from "../core/errors.mjs";

const MAX_TOOL_CALLS_PER_TURN = 16;

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
      extraBody: { reasoning_effort: "max" },
      ...config,
      extraBody: { reasoning_effort: "max", ...(config.extraBody ?? {}) },
    }, context);
    this.stopMarkerPath = resolve(config.stopMarkerPath ?? join(homedir(), ".threadspan", "state", "nous_provider_stop.json"));
  }

  async *run(request) {
    if (existsSync(this.stopMarkerPath)) {
      throw new ProviderError(this.id, `Nous provider is stopped by ${this.stopMarkerPath}; owner-authorized credit recheck is required`, {
        status: 402,
        retryable: false,
      });
    }
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
      if (isPaymentRequired(error)) writeStopMarker(this.stopMarkerPath);
      throw error;
    }
  }

  capabilities() {
    return { ...super.capabilities(), streaming: false, bufferedProviderTurns: true };
  }

  runtimeStats() {
    return {
      kind: "nous",
      stopped: existsSync(this.stopMarkerPath),
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
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({
    schema_version: 1,
    provider: "nous",
    reason: "http_402",
    observed_at: new Date().toISOString(),
    owner_clear_required: true,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
