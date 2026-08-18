import { ConfigError, RequestError } from "../core/errors.mjs";
import { AccountStore, UNKNOWN_ACCOUNT_ID } from "../core/account-store.mjs";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { CursorSdkProvider } from "./cursor-sdk.mjs";
import { CursorCliProvider } from "./cursor-cli.mjs";
import { DeepSeekProvider } from "./deepseek.mjs";
import { MockProvider } from "./mock.mjs";
import { GrokBuildProvider } from "./grok-build.mjs";
import { NousProvider } from "./nous.mjs";
import { OPENAI_ACCOUNT_FALLBACK_POLICY, OpenAiChatProvider } from "./openai-chat.mjs";
import { OpenRouterProvider } from "./openrouter.mjs";
import { CommandProvider } from "./command.mjs";
import { CODEX_NATIVE_ACCOUNT_FALLBACK_POLICY, CodexNativeWorkerProvider, CodexWorkerProvider } from "./codex-worker.mjs";
import { ClaudeCodeProvider } from "./claude-code.mjs";
import { wrapCommandForEnvironment } from "./base.mjs";

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
  ["codex-native-worker", CodexNativeWorkerProvider],
  ["grok-build", GrokBuildProvider],
  ["claude-code", ClaudeCodeProvider],
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
   * @param {{logger: any, adapters?: Record<string, any>, usageLedger?: any, accountStore?: AccountStore}} context Registry context.
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
    this.accountStore = context.accountStore ?? new AccountStore(config.accounts);
    /** @type {Map<string, any>} */
    this.accountProviders = new Map();
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
  get(providerId, accountId) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new RequestError(`Unknown or disabled provider '${providerId}'`);
    if (!accountId || accountId === UNKNOWN_ACCOUNT_ID) {
      if (provider.config.adapter === "codex-native-worker") return this.#providerForAccount(providerId, this.accountStore.resolve(providerId));
      return provider;
    }
    return this.#providerForAccount(providerId, this.accountStore.resolve(providerId, accountId));
  }

  /** Validate a new account's configured isolation references before persistence. */
  validateAccountDescriptor(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new RequestError("Account descriptor must be an object");
    const providerId = String(input.providerId ?? input.provider ?? "").trim();
    if (!this.providers.has(providerId)) throw new RequestError(`Unknown or disabled provider '${providerId}'`);
    this.#validateAccountIsolation(providerId, input, RequestError);
    return true;
  }

  /**
   * Resolve provider/mode/model from explicit metadata or route-like model ids.
   * @param {{model?: string, mode?: string, providerId?: string, accountId?: string}} input Route input.
   * @returns {{provider: any, providerId: string, mode: string, model: string}}
   */
  resolveRoute({ model, mode, providerId, accountId }) {
    let resolvedMode = mode;
    let resolvedProvider = providerId;
    let resolvedModel = model;
    let resolvedAccount = accountId;
    const segments = typeof model === "string" ? model.split("/").filter(Boolean) : [];

    if (segments.length >= 3 && ["consult", "integrated", "delegate"].includes(segments[0])) {
      const routedMode = segments.shift();
      const routedProvider = segments.shift();
      resolvedMode ??= routedMode;
      resolvedProvider ??= routedProvider;
      if (segments[0]?.startsWith("@")) {
        const routedAccount = segments.shift().slice(1);
        if (resolvedAccount && resolvedAccount !== routedAccount) throw new RequestError("Route account conflicts with explicit accountId");
        resolvedAccount = routedAccount;
      }
      resolvedModel = segments.join("/");
    } else if (segments.length >= 2 && this.providers.has(segments[0])) {
      const routedProvider = segments.shift();
      resolvedProvider ??= routedProvider;
      if (segments[0]?.startsWith("@")) {
        const routedAccount = segments.shift().slice(1);
        if (resolvedAccount && resolvedAccount !== routedAccount) throw new RequestError("Route account conflicts with explicit accountId");
        resolvedAccount = routedAccount;
      }
      resolvedModel = segments.join("/");
    }

    resolvedMode ??= this.config.defaults?.mode ?? "consult";
    resolvedProvider ??= this.config.defaults?.provider;
    if (!resolvedProvider) throw new RequestError("No provider selected and no defaults.provider configured");
    if (["threadspan", "auto"].includes(resolvedProvider)) {
      return this.#selectSmartRoute(resolvedMode, resolvedModel, resolvedAccount);
    }
    const account = this.accountStore.resolve(resolvedProvider, resolvedAccount ?? this.config.defaults?.accountId);
    const provider = this.#providerForAccount(resolvedProvider, account);
    resolvedModel ||= provider.config.model ?? this.config.defaults?.model ?? "auto";
    provider.assertMode(resolvedMode);
    return { provider, providerId: resolvedProvider, accountId: account.id, account, mode: resolvedMode, model: resolvedModel, smart: false };
  }

  /**
   * List all provider capabilities and models, retaining model-discovery errors as data.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async describe() {
    const items = [];
    for (const [id] of this.providers.entries()) {
      const account = this.accountStore.resolve(id, this.config.defaults?.provider === id ? this.config.defaults?.accountId : undefined);
      const base = this.providers.get(id);
      if (account.id === UNKNOWN_ACCOUNT_ID && base.config.adapter === "codex-native-worker") {
        const message = "Setup required: add and select a validated isolated Codex account/profileRef";
        this.#markAccountUnavailable(id, account.id, new Error(message));
        items.push({
          id,
          accountId: account.id,
          accounts: [],
          adapter: base.config.adapter,
          capabilities: base.capabilities(),
          models: [],
          health: { ...this.#health(id, account.id), status: "unavailable", setupRequired: true },
          modelError: message,
          setupRequired: true,
        });
        continue;
      }
      const provider = this.#providerForAccount(id, account);
      let models = [];
      let modelError;
      try {
        models = await provider.listModels();
        this.#markCatalog(id, account.id, true);
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
        this.#markCatalog(id, account.id, false, modelError);
      }
      items.push({ id, accountId: account.id, accounts: this.accountStore.list({ providerId: id }), adapter: provider.config.adapter, capabilities: provider.capabilities(), models, health: this.#health(id, account.id), ...(modelError ? { modelError } : {}) });
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
          eligible_accounts: this.#eligibleProviders(mode).map(([, , account]) => account.id),
        },
      }));
    for (const [providerId] of this.providers.entries()) {
      const configuredAccounts = this.accountStore.list({ providerId });
      if (configuredAccounts.length === 0 && this.providers.get(providerId)?.config.adapter === "codex-native-worker") continue;
      const accounts = configuredAccounts.length > 0 ? configuredAccounts.map((account) => this.accountStore.get(account.id)) : [this.accountStore.resolve(providerId)];
      for (const account of accounts) {
        let provider;
        try {
          provider = this.#providerForAccount(providerId, account);
        } catch (error) {
          if (account.id === UNKNOWN_ACCOUNT_ID) throw error;
          this.#markAccountUnavailable(providerId, account.id, error);
          continue;
        }
        let degraded = false;
        const models = await provider.listModels().then((items) => {
          this.#markCatalog(providerId, account.id, true);
          return items;
        }).catch((error) => {
          degraded = true;
          this.#markCatalog(providerId, account.id, false, error instanceof Error ? error.message : String(error));
          return [{ id: provider.config.model ?? "auto", configuredFallback: true }];
        });
        const capabilities = provider.capabilities();
        for (const [mode, entry] of Object.entries(capabilities.modes)) {
          if (!entry.supported) continue;
          for (const model of models) {
            const accountSegment = account.id === UNKNOWN_ACCOUNT_ID ? "" : `@${account.id}/`;
            output.push({
              id: `${mode}/${providerId}/${accountSegment}${model.id}`,
              object: "model",
              created: 0,
              owned_by: providerId,
              metadata: {
                bridge_mode: mode,
                provider: providerId,
                account_id: account.id,
                upstream_model: model.id,
                availability: this.#health(providerId, account.id).status,
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
    }
    return output;
  }

  /** Return count-only runtime diagnostics for all configured providers. */
  runtimeStats() {
    return Object.fromEntries([...this.providers.entries()].map(([id]) => {
      const account = this.accountStore.resolve(id);
      const base = this.providers.get(id);
      if (account.id === UNKNOWN_ACCOUNT_ID && base.config.adapter === "codex-native-worker") {
        return [id, {
          ...(base.runtimeStats?.() ?? { kind: base.config.adapter }),
          accountId: account.id,
          setupRequired: true,
          health: { ...this.#health(id, account.id), status: "unavailable" },
          usage: this.usage.get(accountKey(id, account.id)) ?? emptyUsage(),
          accounts: {},
        }];
      }
      const provider = this.#providerForAccount(id, account);
      const accounts = this.accountStore.list({ providerId: id });
      return [id, {
        ...(provider.runtimeStats?.() ?? { kind: provider.config.adapter }),
        accountId: account.id,
        health: this.#health(id, account.id),
        usage: this.usage.get(accountKey(id, account.id)) ?? emptyUsage(),
        accounts: Object.fromEntries(accounts.map((item) => [item.id, {
          active: item.active,
          health: this.#health(id, item.id),
          usage: this.usage.get(accountKey(id, item.id)) ?? emptyUsage(),
        }])),
      }];
    }));
  }

  /** Return a privacy-minimized provider/model graph for the local operator UI. */
  async routeMap(descriptions) {
    const providers = descriptions ?? await this.describe();
    const persisted = await this.usageSummary();
    const nodes = providers.map((item) => {
      const profile = this.config.routing?.providerProfiles?.[item.id] ?? {};
      const live = this.usage.get(accountKey(item.id, item.accountId ?? UNKNOWN_ACCOUNT_ID)) ?? emptyUsage();
      const historical = persisted.accounts?.[item.accountId ?? UNKNOWN_ACCOUNT_ID];
      const usage = historical ? { ...live, requests: historical.eventCount, failures: historical.statuses?.failed ?? live.failures, inputTokens: historical.inputTokens, outputTokens: historical.outputTokens, totalTokens: historical.inputTokens + historical.outputTokens } : live;
      return {
        id: item.id,
        accountId: item.accountId ?? UNKNOWN_ACCOUNT_ID,
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
    const accountId = route.accountId ?? UNKNOWN_ACCOUNT_ID;
    const key = accountKey(id, accountId);
    this.health.set(key, { ...this.#health(id, accountId), status: "available", lastSuccessAt: Date.now(), lastError: undefined });
    const current = this.usage.get(key) ?? emptyUsage();
    this.usage.set(key, {
      requests: current.requests + 1,
      failures: current.failures,
      inputTokens: current.inputTokens + numberOrZero(usage.inputTokens),
      outputTokens: current.outputTokens + numberOrZero(usage.outputTokens),
      totalTokens: current.totalTokens + numberOrZero(usage.totalTokens),
    });
    await this.usageLedger?.append({ provider: id, accountId, model: route.model, mode: route.mode, status: "completed", durationMs: details.durationMs ?? 0, usage, evidenceClass: details.evidenceClass ?? "live-provider", costTicks: details.costTicks, processCount: details.processCount, turnCount: details.turnCount, attemptId: details.attemptId, attemptGroupId: details.attemptGroupId, attemptOrdinal: details.attemptOrdinal, fallbackFromAccountId: details.fallbackFromAccountId });
  }

  /** Record a provider failure without silently retrying an explicit route. */
  async recordFailure(route, error, details = {}) {
    const id = route.providerId;
    const accountId = route.accountId ?? UNKNOWN_ACCOUNT_ID;
    const key = accountKey(id, accountId);
    const current = this.usage.get(key) ?? emptyUsage();
    this.usage.set(key, { ...current, requests: current.requests + 1, failures: current.failures + 1 });
    this.health.set(key, {
      ...this.#health(id, accountId),
      status: "unavailable",
      lastFailureAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    await this.usageLedger?.append({ provider: id, accountId, model: route.model, mode: route.mode, status: details.partial === true ? "partial" : "failed", durationMs: details.durationMs ?? 0, usage: details.usage ?? {}, evidenceClass: details.evidenceClass ?? "live-provider", attemptId: details.attemptId, attemptGroupId: details.attemptGroupId, attemptOrdinal: details.attemptOrdinal, fallbackFromAccountId: details.fallbackFromAccountId });
  }

  async usageSummary(options = {}) {
    return this.usageLedger?.summarize(options) ?? { daily: {}, weekly: {}, providers: {}, models: {}, recentEvents: [], scannedEvents: 0, truncated: false, malformedLines: 0 };
  }

  /** Return privacy-minimized account descriptors plus account-bound runtime telemetry. */
  async describeAccounts() {
    const listedAccounts = this.accountStore.list();
    const summary = await this.usageSummary({
      recentLimit: 20,
      entitlements: listedAccounts.map((account) => ({ provider: account.providerId, accountId: account.id, quota: account.quota })),
    });
    return {
      descriptors: this.accountStore.creationDescriptors(),
      accounts: listedAccounts.map((account) => {
        let isolated = false;
        try {
          isolated = this.#providerForAccount(account.providerId, this.accountStore.get(account.id)).accountBinding?.()?.isolated === true;
        } catch (error) {
          this.#markAccountUnavailable(account.providerId, account.id, error);
        }
        return {
          ...account,
          isolatedExecution: isolated,
          health: this.#health(account.providerId, account.id),
          usage: summary.accounts?.[account.id] ?? emptyUsage(),
          forecast: summary.forecasts?.accounts?.find((forecast) => forecast.scope.provider === account.providerId && forecast.scope.accountId === account.id) ?? null,
        };
      }),
      combined: summary.combined ?? summary.weekly,
      forecasts: summary.forecasts ? {
        source: summary.forecasts.source,
        observedAt: summary.forecasts.observedAt,
        cutoff: summary.forecasts.cutoff,
        windowMs: summary.forecasts.windowMs,
        quality: summary.forecasts.quality,
        providers: summary.forecasts.providers,
        combined: summary.forecasts.combined,
      } : null,
    };
  }

  /** Build at most one same-provider, same-model alternate for one opt-in safe fallback. */
  fallbackRoutes(route, maximum = 1) {
    if (!route?.providerId || !route?.accountId) return [];
    if (!certifiesSafeAccountFallback(route.provider)) return [];
    const limit = Math.min(1, maximum);
    return this.accountStore.fallbackCandidates(route.providerId, route.accountId).flatMap((account) => {
      try {
        const provider = this.#providerForAccount(route.providerId, account);
        if (provider.accountBinding?.()?.isolated !== true || !certifiesSafeAccountFallback(provider)) return [];
        provider.assertMode(route.mode);
        return [{ ...route, provider, account, accountId: account.id, smart: route.smart, fallbackFromAccountId: route.accountId }];
      } catch (error) {
        this.#markAccountUnavailable(route.providerId, account.id, error);
        return [];
      }
    }).slice(0, limit);
  }

  /** Dispose a removed account's isolated adapter without disturbing the provider default. */
  async releaseAccount(accountId) {
    const provider = this.accountProviders.get(accountId);
    this.accountProviders.delete(accountId);
    await Promise.resolve(provider?.close?.()).catch(() => undefined);
  }

  #selectSmartRoute(mode, requestedModel, requestedAccountId) {
    if (requestedAccountId) {
      const account = this.accountStore.get(requestedAccountId);
      if (!account || account.id === UNKNOWN_ACCOUNT_ID) throw new RequestError(`Unknown account '${requestedAccountId}'`);
      const provider = this.#providerForAccount(account.providerId, account);
      provider.assertMode(mode);
      const model = !requestedModel || requestedModel === "auto" ? provider.config.model ?? "auto" : requestedModel;
      return { provider, providerId: account.providerId, accountId: account.id, account, mode, model, smart: true, requestedProviderId: "threadspan" };
    }
    const candidates = this.#eligibleProviders(mode);
    if (candidates.length === 0) throw new RequestError(`No currently eligible Threadspan provider supports '${mode}' mode`);
    const [providerId, provider, account] = candidates[0];
    const model = !requestedModel || requestedModel === "auto" ? provider.config.model ?? "auto" : requestedModel;
    provider.assertMode(mode);
    return { provider, providerId, accountId: account.id, account, mode, model, smart: true, requestedProviderId: "threadspan" };
  }

  #eligibleProviders(mode) {
    const preferred = this.config.routing?.providerOrder?.[mode] ?? [];
    const rank = new Map(preferred.map((id, index) => [id, index]));
    return [...this.providers.entries()].flatMap(([id]) => {
      try {
        const account = this.accountStore.resolve(id);
        return [[id, this.#providerForAccount(id, account), account]];
      } catch (error) {
        this.#markAccountUnavailable(id, UNKNOWN_ACCOUNT_ID, error);
        return [];
      }
    })
      .filter(([id, provider, account]) => provider.capabilities().modes?.[mode]?.supported && this.#health(id, account.id).status !== "unavailable")
      .sort(([left], [right]) => this.#routeScore(left, mode, rank.get(left)) - this.#routeScore(right, mode, rank.get(right)));
  }

  #routeScore(id, mode, preferredRank) {
    const profile = this.config.routing?.providerProfiles?.[id] ?? {};
    const account = this.accountStore.resolve(id);
    const usage = this.usage.get(accountKey(id, account.id)) ?? emptyUsage();
    const health = this.#health(id, account.id).status;
    const preference = Number.isSafeInteger(preferredRank) ? preferredRank * 100 : 10_000;
    const healthPenalty = health === "available" ? 0 : health === "unknown" ? 15 : 40;
    const failurePenalty = usage.requests > 0 ? Math.round((usage.failures / usage.requests) * 60) : 0;
    const balancePenalty = Math.min(50, Math.floor(usage.requests / 4));
    const modeBias = Number(profile.modeWeights?.[mode] ?? 0);
    return preference + healthPenalty + failurePenalty + balancePenalty - (Number.isFinite(modeBias) ? modeBias : 0);
  }

  #markCatalog(id, accountId, available, error) {
    const key = accountKey(id, accountId);
    this.health.set(key, {
      ...this.#health(id, accountId),
      status: available ? "available" : "degraded",
      catalogCheckedAt: Date.now(),
      ...(error ? { catalogError: error } : { catalogError: undefined }),
    });
  }

  #health(id, accountId = UNKNOWN_ACCOUNT_ID) {
    return this.health.get(accountKey(id, accountId)) ?? { status: "unknown" };
  }

  #markAccountUnavailable(providerId, accountId, error) {
    this.health.set(accountKey(providerId, accountId), {
      ...this.#health(providerId, accountId),
      status: "unavailable",
      lastError: error instanceof Error ? error.message : String(error),
      lastFailureAt: Date.now(),
    });
  }

  /** Return an account-isolated adapter without modifying the default process environment/profile. */
  #providerForAccount(providerId, account) {
    const base = this.providers.get(providerId);
    if (!base) throw new RequestError(`Unknown or disabled provider '${providerId}'`);
    if (!account || account.id === UNKNOWN_ACCOUNT_ID) {
      if (base.config.adapter === "codex-native-worker") {
        throw new ConfigError(`Provider '${providerId}' using codex-native-worker requires an explicit validated isolated account/profileRef; refusing the default Codex home`);
      }
      return base;
    }
    this.#validateAccountIsolation(providerId, account, ConfigError);
    const cached = this.accountProviders.get(account.id);
    if (cached) return cached;
    const providerConfig = this.config.providers[providerId];
    let effective = { ...providerConfig };
    let isolated = false;

    if (account.authKind === "api-key-env") {
      if (!["openai-chat", "openrouter", "deepseek", "nous", "cursor-sdk"].includes(providerConfig.adapter)) {
        throw new ConfigError(`Provider '${providerId}' adapter '${providerConfig.adapter}' does not support isolated API-key environment accounts`);
      }
      effective = { ...effective, apiKey: undefined, apiKeyFile: undefined, apiKeyEnv: account.authSourceRef };
      isolated = true;
    } else if (account.authKind === "secret-file-ref") {
      if (!["openai-chat", "openrouter", "deepseek", "nous", "cursor-sdk"].includes(providerConfig.adapter)) {
        throw new ConfigError(`Provider '${providerId}' adapter '${providerConfig.adapter}' does not support isolated secret-file accounts`);
      }
      const source = providerConfig.accountSources[account.authSourceRef];
      effective = { ...effective, apiKey: undefined, apiKeyEnv: undefined, apiKeyFile: source.path };
      isolated = true;
    }

    if (account.profileRef) {
      const source = this.config.accounts.profileSources[account.profileRef];
      if (source.kind === "codex-home" && providerConfig.adapter === "codex-worker") {
        effective = wrapCommandForEnvironment({ ...effective, command: effective.command ?? "codex" }, { CODEX_HOME: source.root });
      } else if (source.kind === "codex-home" && providerConfig.adapter === "codex-native-worker") {
        assertCodexNativeAuth(source.root, account.id, ConfigError);
        effective = { ...effective, __threadspanCodexHome: source.root };
      } else if (source.kind === "claude-config-dir" && providerConfig.adapter === "claude-code") {
        effective = { ...effective, __threadspanClaudeConfigDir: source.root };
      } else {
        throw new ConfigError(`Provider '${providerId}' does not support isolated profile source '${account.profileRef}'`);
      }
      isolated = true;
    }

    if (!isolated) throw new ConfigError(`Account '${account.id}' does not provide validated isolated credentials or a profile root`);

    effective.__threadspanAccount = { id: account.id, authKind: account.authKind, isolated: true };
    const Adapter = this.adapters.get(providerConfig.adapter);
    if (!Adapter) throw new ConfigError(`Unknown adapter '${providerConfig.adapter}' for provider '${providerId}'`);
    const provider = new Adapter(providerId, effective, { logger: this.logger });
    this.accountProviders.set(account.id, provider);
    return provider;
  }

  /** Enforce that every persisted account resolves to a configured isolated credential/profile source. */
  #validateAccountIsolation(providerId, account, ErrorType) {
    const providerConfig = this.config.providers[providerId];
    if (!providerConfig) throw new ErrorType(`Unknown or disabled provider '${providerId}'`);
    const nativeLogin = ["cli-login", "native-oauth", "device-login"].includes(account.authKind);
    if (nativeLogin && !account.profileRef) {
      throw new ErrorType(`Account '${account.id ?? account.label ?? "new"}' uses ${account.authKind} and requires a validated isolated profileRef; refusing the provider default profile`);
    }
    if (account.profileRef) {
      const source = this.config.accounts?.profileSources?.[account.profileRef];
      if (!source) throw new ErrorType(`Account '${account.id ?? account.label ?? "new"}' references unavailable profile '${account.profileRef}'`);
      const supported = (source.kind === "codex-home" && ["codex-worker", "codex-native-worker"].includes(providerConfig.adapter))
        || (source.kind === "claude-config-dir" && providerConfig.adapter === "claude-code");
      if (!supported) throw new ErrorType(`Provider '${providerId}' does not support isolated profile source '${account.profileRef}'`);
      if (source.kind === "codex-home" && providerConfig.adapter === "codex-native-worker") {
        assertCodexNativeAuth(source.root, account.id ?? account.label ?? "new", ErrorType);
      }
    }
    if (account.authKind === "api-key-env") {
      if (!["openai-chat", "openrouter", "deepseek", "nous", "cursor-sdk"].includes(providerConfig.adapter)) {
        throw new ErrorType(`Provider '${providerId}' adapter '${providerConfig.adapter}' does not support isolated API-key environment accounts`);
      }
      if (!account.authSourceRef || !Object.prototype.hasOwnProperty.call(process.env, account.authSourceRef)) {
        throw new ErrorType(`Account '${account.id ?? account.label ?? "new"}' references unavailable environment credential '${account.authSourceRef ?? ""}'`);
      }
    }
    if (account.authKind === "secret-file-ref") {
      if (!["openai-chat", "openrouter", "deepseek", "nous", "cursor-sdk"].includes(providerConfig.adapter)) {
        throw new ErrorType(`Provider '${providerId}' adapter '${providerConfig.adapter}' does not support isolated secret-file accounts`);
      }
      const source = providerConfig.accountSources?.[account.authSourceRef];
      if (!source || source.kind !== "secret-file") {
        throw new ErrorType(`Account '${account.id ?? account.label ?? "new"}' references unavailable secret-file source '${account.authSourceRef ?? ""}'`);
      }
    }
  }

  /** Dispose all adapters. */
  async close() {
    await Promise.allSettled([...new Set([...this.providers.values(), ...this.accountProviders.values()])].map((provider) => provider.close()));
  }
}

function accountKey(providerId, accountId) {
  return `${providerId}\u0000${accountId ?? UNKNOWN_ACCOUNT_ID}`;
}

function certifiesSafeAccountFallback(provider) {
  try {
    return (provider instanceof OpenAiChatProvider && provider.accountFallbackPolicy?.() === OPENAI_ACCOUNT_FALLBACK_POLICY)
      || (provider instanceof CodexNativeWorkerProvider && provider.accountFallbackPolicy?.() === CODEX_NATIVE_ACCOUNT_FALLBACK_POLICY);
  } catch {
    return false;
  }
}

function assertCodexNativeAuth(root, accountId, ErrorType) {
  const authPath = join(root, "auth.json");
  try {
    const canonical = realpathSync.native(authPath);
    const contained = relative(root, canonical);
    const stats = statSync(canonical);
    if (isAbsolute(contained) || contained === ".." || contained.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !stats.isFile() || stats.size === 0) {
      throw new Error("auth.json is not a non-empty regular file inside the isolated Codex home");
    }
  } catch (error) {
    throw new ErrorType(`Account '${accountId}' requires existing provider-native Codex authentication at its isolated profileRef`, {
      cause: error instanceof Error ? error.message : String(error),
    });
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
