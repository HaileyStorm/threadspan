import { ConfigError, RequestError } from "../core/errors.mjs";
import { CursorSdkProvider } from "./cursor-sdk.mjs";
import { CursorCliProvider } from "./cursor-cli.mjs";
import { DeepSeekProvider } from "./deepseek.mjs";
import { MockProvider } from "./mock.mjs";
import { GrokBuildProvider } from "./grok-build.mjs";
import { NousProvider } from "./nous.mjs";
import { OpenAiChatProvider } from "./openai-chat.mjs";
import { OpenRouterProvider } from "./openrouter.mjs";
import { CommandProvider } from "./command.mjs";
import { CodexWorkerProvider } from "./codex-worker.mjs";

/** @type {Map<string, new (id: string, config: Record<string, any>, context: {logger: any}) => any>} */
const ADAPTERS = new Map([
  ["cursor-sdk", CursorSdkProvider],
  ["cursor-cli", CursorCliProvider],
  ["openai-chat", OpenAiChatProvider],
  ["openrouter", OpenRouterProvider],
  ["deepseek", DeepSeekProvider],
  ["nous", NousProvider],
  ["command", CommandProvider],
  ["codex-worker", CodexWorkerProvider],
  ["grok-build", GrokBuildProvider],
  ["mock", MockProvider],
]);

/**
 * Register a provider adapter for embedding applications without modifying the bridge core.
 *
 * Configuration-only integrations can usually use `openai-chat` or `command`. This hook is for
 * providers that need custom wire semantics, authentication, or lifecycle management.
 *
 * @param {string} name Adapter name used by provider configuration.
 * @param {new (id: string, config: Record<string, any>, context: {logger: any}) => any} Adapter Adapter class.
 * @param {{replace?: boolean}} [options] Registration options.
 */
export function registerProviderAdapter(name, Adapter, options = {}) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new ConfigError(`Invalid adapter name '${name}'`);
  if (typeof Adapter !== "function") throw new ConfigError(`Adapter '${name}' must be a class or constructor`);
  if (ADAPTERS.has(name) && options.replace !== true) throw new ConfigError(`Adapter '${name}' is already registered`);
  ADAPTERS.set(name, Adapter);
}

/** Provider registry and model-route resolver. */
export class ProviderRegistry {
  /**
   * @param {Record<string, any>} config Bridge configuration.
   * @param {{logger: any, adapters?: Record<string, any>, usageLedger?: any}} context Registry context.
   */
  constructor(config, context) {
    this.config = config;
    this.logger = context.logger.child("providers");
    this.adapters = new Map(ADAPTERS);
    for (const [name, Adapter] of Object.entries(context.adapters ?? {})) this.adapters.set(name, Adapter);
    /** @type {Map<string, any>} */
    this.providers = new Map();
    /** @type {Map<string, Record<string, any>>} */
    this.health = new Map();
    /** @type {Map<string, Record<string, number>>} */
    this.usage = new Map();
    this.usageLedger = context.usageLedger;
    this.#initialize();
  }

  /** Instantiate configured providers. */
  #initialize() {
    for (const [id, providerConfig] of Object.entries(this.config.providers ?? {})) {
      if (providerConfig.enabled === false) continue;
      const Adapter = this.adapters.get(providerConfig.adapter);
      if (!Adapter) throw new ConfigError(`Unknown adapter '${providerConfig.adapter}' for provider '${id}'`);
      this.providers.set(id, new Adapter(id, providerConfig, { logger: this.logger }));
    }
  }

  /**
   * Fetch a provider by id.
   * @param {string} providerId Provider id.
   * @returns {any}
   */
  get(providerId) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new RequestError(`Unknown or disabled provider '${providerId}'`);
    return provider;
  }

  /**
   * Resolve provider/mode/model from explicit metadata or route-like model ids.
   * @param {{model?: string, mode?: string, providerId?: string}} input Route input.
   * @returns {{provider: any, providerId: string, mode: string, model: string}}
   */
  resolveRoute({ model, mode, providerId }) {
    let resolvedMode = mode;
    let resolvedProvider = providerId;
    let resolvedModel = model;
    const segments = typeof model === "string" ? model.split("/").filter(Boolean) : [];

    if (segments.length >= 3 && ["consult", "integrated", "delegate"].includes(segments[0])) {
      const routedMode = segments.shift();
      const routedProvider = segments.shift();
      resolvedMode ??= routedMode;
      resolvedProvider ??= routedProvider;
      resolvedModel = segments.join("/");
    } else if (segments.length >= 2 && this.providers.has(segments[0])) {
      const routedProvider = segments.shift();
      resolvedProvider ??= routedProvider;
      resolvedModel = segments.join("/");
    }

    resolvedMode ??= this.config.defaults?.mode ?? "consult";
    resolvedProvider ??= this.config.defaults?.provider;
    if (!resolvedProvider) throw new RequestError("No provider selected and no defaults.provider configured");
    if (["threadspan", "auto"].includes(resolvedProvider)) {
      return this.#selectSmartRoute(resolvedMode, resolvedModel);
    }
    const provider = this.get(resolvedProvider);
    resolvedModel ||= provider.config.model ?? this.config.defaults?.model ?? "auto";
    provider.assertMode(resolvedMode);
    return { provider, providerId: resolvedProvider, mode: resolvedMode, model: resolvedModel, smart: false };
  }

  /**
   * List all provider capabilities and models, retaining model-discovery errors as data.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async describe() {
    const items = [];
    for (const [id, provider] of this.providers.entries()) {
      let models = [];
      let modelError;
      try {
        models = await provider.listModels();
        this.#markCatalog(id, true);
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
        this.#markCatalog(id, false, modelError);
      }
      items.push({ id, adapter: provider.config.adapter, capabilities: provider.capabilities(), models, health: this.#health(id), ...(modelError ? { modelError } : {}) });
    }
    return items;
  }

  /**
   * Return OpenAI-shaped model entries with route-prefixed ids.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listRoutedModels() {
    const output = ["consult", "integrated", "delegate"]
      .filter((mode) => this.#eligibleProviders(mode).length > 0)
      .map((mode) => ({
        id: `${mode}/threadspan/auto`,
        object: "model",
        created: 0,
        owned_by: "threadspan",
        metadata: {
          bridge_mode: mode,
          provider: "threadspan",
          upstream_model: "auto",
          threadspan_smart: true,
          eligible_providers: this.#eligibleProviders(mode).map(([id]) => id),
        },
      }));
    for (const [providerId, provider] of this.providers.entries()) {
      let degraded = false;
      const models = await provider.listModels().then((items) => {
        this.#markCatalog(providerId, true);
        return items;
      }).catch((error) => {
        degraded = true;
        this.#markCatalog(providerId, false, error instanceof Error ? error.message : String(error));
        return [{ id: provider.config.model ?? "auto", configuredFallback: true }];
      });
      const capabilities = provider.capabilities();
      for (const [mode, entry] of Object.entries(capabilities.modes)) {
        if (!entry.supported) continue;
        for (const model of models) {
          output.push({
            id: `${mode}/${providerId}/${model.id}`,
            object: "model",
            created: 0,
            owned_by: providerId,
            metadata: {
              bridge_mode: mode,
              provider: providerId,
              upstream_model: model.id,
              availability: this.#health(providerId).status,
              catalog_degraded: degraded,
              configured_fallback: model.configuredFallback === true,
              ...(model.free === true ? { free: true } : {}),
              ...(model.contextWindow ?? model.context_window ? { context_window: model.contextWindow ?? model.context_window } : {}),
              ...(model.supported_reasoning_levels ? { supported_reasoning_levels: model.supported_reasoning_levels } : {}),
              ...(model.default_reasoning_level ? { default_reasoning_level: model.default_reasoning_level } : {}),
              ...(capabilities.images === true ? { images: true } : {}),
            },
          });
        }
      }
    }
    return output;
  }

  /** Return count-only runtime diagnostics for all configured providers. */
  runtimeStats() {
    return Object.fromEntries([...this.providers.entries()].map(([id, provider]) => [id, {
      ...(provider.runtimeStats?.() ?? { kind: provider.config.adapter }),
      health: this.#health(id),
      usage: this.usage.get(id) ?? emptyUsage(),
    }]));
  }

  /** Return a privacy-minimized provider/model graph for the local operator UI. */
  async routeMap(descriptions) {
    const providers = descriptions ?? await this.describe();
    const persisted = await this.usageSummary();
    const nodes = providers.map((item) => {
      const profile = this.config.routing?.providerProfiles?.[item.id] ?? {};
      const live = this.usage.get(item.id) ?? emptyUsage();
      const historical = persisted.providers?.[item.id];
      const usage = historical ? { ...live, requests: historical.eventCount, failures: historical.statuses?.failed ?? live.failures, inputTokens: historical.inputTokens, outputTokens: historical.outputTokens, totalTokens: historical.inputTokens + historical.outputTokens } : live;
      return {
        id: item.id,
        adapter: item.adapter,
        label: profile.label ?? item.id,
        intelligence: boundedWeight(profile.intelligence, defaultIntelligence(item.adapter)),
        specialties: Array.isArray(profile.specialties) ? profile.specialties.map(String).slice(0, 6) : defaultSpecialties(item.adapter),
        modes: Object.entries(item.capabilities?.modes ?? {}).filter(([, entry]) => entry?.supported).map(([mode]) => mode),
        availability: item.health?.status ?? "unknown",
        models: (item.models ?? []).map((model) => model.id).filter(Boolean).slice(0, 12),
        usage,
      };
    });
    const edges = [];
    for (const mode of ["consult", "integrated", "delegate"]) {
      const eligible = this.#eligibleProviders(mode);
      eligible.forEach(([id], index) => {
        const node = nodes.find((candidate) => candidate.id === id);
        edges.push({ mode, provider: id, priority: index + 1, weight: this.#routeScore(id, mode, index), intelligence: node?.intelligence ?? 50 });
      });
    }
    return { nodes, edges };
  }

  /** Record a successful provider turn for live routing and utilization displays. */
  async recordSuccess(route, usage = {}, details = {}) {
    const id = route.providerId;
    this.health.set(id, { ...this.#health(id), status: "available", lastSuccessAt: Date.now(), lastError: undefined });
    const current = this.usage.get(id) ?? emptyUsage();
    this.usage.set(id, {
      requests: current.requests + 1,
      failures: current.failures,
      inputTokens: current.inputTokens + numberOrZero(usage.inputTokens),
      outputTokens: current.outputTokens + numberOrZero(usage.outputTokens),
      totalTokens: current.totalTokens + numberOrZero(usage.totalTokens),
    });
    await this.usageLedger?.append({ provider: id, model: route.model, mode: route.mode, status: "completed", durationMs: details.durationMs ?? 0, usage, evidenceClass: details.evidenceClass ?? "live-provider", costTicks: details.costTicks, processCount: details.processCount, turnCount: details.turnCount });
  }

  /** Record a provider failure without silently retrying an explicit route. */
  async recordFailure(route, error, details = {}) {
    const id = route.providerId;
    const current = this.usage.get(id) ?? emptyUsage();
    this.usage.set(id, { ...current, requests: current.requests + 1, failures: current.failures + 1 });
    this.health.set(id, {
      ...this.#health(id),
      status: "unavailable",
      lastFailureAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    await this.usageLedger?.append({ provider: id, model: route.model, mode: route.mode, status: details.partial === true ? "partial" : "failed", durationMs: details.durationMs ?? 0, usage: details.usage ?? {}, evidenceClass: details.evidenceClass ?? "live-provider" });
  }

  async usageSummary(options = {}) {
    return this.usageLedger?.summarize(options) ?? { daily: {}, weekly: {}, providers: {}, models: {}, recentEvents: [], scannedEvents: 0, truncated: false, malformedLines: 0 };
  }

  #selectSmartRoute(mode, requestedModel) {
    const candidates = this.#eligibleProviders(mode);
    if (candidates.length === 0) throw new RequestError(`No currently eligible Threadspan provider supports '${mode}' mode`);
    const [providerId, provider] = candidates[0];
    const model = !requestedModel || requestedModel === "auto" ? provider.config.model ?? "auto" : requestedModel;
    provider.assertMode(mode);
    return { provider, providerId, mode, model, smart: true, requestedProviderId: "threadspan" };
  }

  #eligibleProviders(mode) {
    const preferred = this.config.routing?.providerOrder?.[mode] ?? [];
    const rank = new Map(preferred.map((id, index) => [id, index]));
    return [...this.providers.entries()]
      .filter(([id, provider]) => provider.capabilities().modes?.[mode]?.supported && this.#health(id).status !== "unavailable")
      .sort(([left], [right]) => this.#routeScore(left, mode, rank.get(left)) - this.#routeScore(right, mode, rank.get(right)));
  }

  #routeScore(id, mode, preferredRank) {
    const profile = this.config.routing?.providerProfiles?.[id] ?? {};
    const usage = this.usage.get(id) ?? emptyUsage();
    const health = this.#health(id).status;
    const preference = Number.isSafeInteger(preferredRank) ? preferredRank * 100 : 10_000;
    const healthPenalty = health === "available" ? 0 : health === "unknown" ? 15 : 40;
    const failurePenalty = usage.requests > 0 ? Math.round((usage.failures / usage.requests) * 60) : 0;
    const balancePenalty = Math.min(50, Math.floor(usage.requests / 4));
    const modeBias = Number(profile.modeWeights?.[mode] ?? 0);
    return preference + healthPenalty + failurePenalty + balancePenalty - (Number.isFinite(modeBias) ? modeBias : 0);
  }

  #markCatalog(id, available, error) {
    this.health.set(id, {
      ...this.#health(id),
      status: available ? "available" : "degraded",
      catalogCheckedAt: Date.now(),
      ...(error ? { catalogError: error } : { catalogError: undefined }),
    });
  }

  #health(id) {
    return this.health.get(id) ?? { status: "unknown" };
  }

  /** Dispose all adapters. */
  async close() {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.close()));
  }
}

function emptyUsage() {
  return { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function boundedWeight(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(100, Math.round(numeric))) : fallback;
}

function defaultIntelligence(adapter) {
  return ({ "grok-build": 92, "cursor-cli": 90, "cursor-sdk": 90, nous: 86, "openai-chat": 88, openrouter: 78, deepseek: 84, command: 70 })[adapter] ?? 65;
}

function defaultSpecialties(adapter) {
  return ({
    "grok-build": ["coding", "research", "delegation"],
    "cursor-cli": ["coding", "repository", "delegation"],
    "cursor-sdk": ["coding", "repository", "delegation"],
    nous: ["reasoning", "coding", "integrated"],
    "openai-chat": ["reasoning", "analysis", "integrated"],
    openrouter: ["breadth", "free-models", "integrated"],
    deepseek: ["reasoning", "coding", "integrated"],
    command: ["custom"],
  })[adapter] ?? ["general"];
}
