import { resolveApiKey } from "./base.mjs";
import { OpenAiChatProvider } from "./openai-chat.mjs";
import { ProviderError } from "../core/errors.mjs";

/** OpenRouter Chat Completions adapter with live catalog and optional credit telemetry. */
export class OpenRouterProvider extends OpenAiChatProvider {
  constructor(id, config, context) {
    super(id, {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      discoverModels: true,
      retryWithoutStreaming: false,
      ...config,
    }, context);
  }

  capabilities() {
    return {
      ...super.capabilities(),
      catalog: true,
      accountCredits: true,
      generationAccounting: true,
    };
  }

  async listModels() {
    const models = await super.listModels();
    return models.map((model) => ({ ...model, free: isFreeModel(model) }));
  }

  /** Read account credit totals without exposing the management key or response body. */
  async readAccountUsage() {
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) return { available: false, reason: "missing_api_key" };
    const response = await fetch(this.config.creditsUrl ?? "https://openrouter.ai/api/v1/credits", {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new ProviderError(this.id, `credit lookup failed: HTTP ${response.status}`, {
        status: response.status === 401 || response.status === 403 ? 502 : response.status,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    const payload = await response.json();
    const data = payload?.data ?? payload;
    const totalCredits = finiteNumber(data?.total_credits);
    const totalUsage = finiteNumber(data?.total_usage);
    return {
      available: true,
      totalCredits,
      totalUsage,
      remainingCredits: totalCredits !== undefined && totalUsage !== undefined
        ? Math.max(0, totalCredits - totalUsage)
        : undefined,
    };
  }
}

function isFreeModel(model) {
  if (String(model?.id ?? "").endsWith(":free")) return true;
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
