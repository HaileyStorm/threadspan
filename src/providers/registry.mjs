import { ConfigError, RequestError } from "../core/errors.mjs";
import { CursorSdkProvider } from "./cursor-sdk.mjs";
import { DeepSeekProvider } from "./deepseek.mjs";
import { MockProvider } from "./mock.mjs";
import { GrokBuildProvider } from "./grok-build.mjs";
import { NousProvider } from "./nous.mjs";
import { OpenAiChatProvider } from "./openai-chat.mjs";
import { CommandProvider } from "./command.mjs";

/** @type {Map<string, new (id: string, config: Record<string, any>, context: {logger: any}) => any>} */
const ADAPTERS = new Map([
  ["cursor-sdk", CursorSdkProvider],
  ["openai-chat", OpenAiChatProvider],
  ["deepseek", DeepSeekProvider],
  ["nous", NousProvider],
  ["command", CommandProvider],
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
   * @param {{logger: any, adapters?: Record<string, any>}} context Registry context.
   */
  constructor(config, context) {
    this.config = config;
    this.logger = context.logger.child("providers");
    this.adapters = new Map(ADAPTERS);
    for (const [name, Adapter] of Object.entries(context.adapters ?? {})) this.adapters.set(name, Adapter);
    /** @type {Map<string, any>} */
    this.providers = new Map();
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
    const provider = this.get(resolvedProvider);
    resolvedModel ||= provider.config.model ?? this.config.defaults?.model ?? "auto";
    provider.assertMode(resolvedMode);
    return { provider, providerId: resolvedProvider, mode: resolvedMode, model: resolvedModel };
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
      } catch (error) {
        modelError = error instanceof Error ? error.message : String(error);
      }
      items.push({ id, adapter: provider.config.adapter, capabilities: provider.capabilities(), models, ...(modelError ? { modelError } : {}) });
    }
    return items;
  }

  /**
   * Return OpenAI-shaped model entries with route-prefixed ids.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async listRoutedModels() {
    const output = [];
    for (const [providerId, provider] of this.providers.entries()) {
      const models = await provider.listModels().catch(() => [{ id: provider.config.model ?? "auto" }]);
      const capabilities = provider.capabilities();
      for (const [mode, entry] of Object.entries(capabilities.modes)) {
        if (!entry.supported) continue;
        for (const model of models) {
          output.push({
            id: `${mode}/${providerId}/${model.id}`,
            object: "model",
            created: 0,
            owned_by: providerId,
            metadata: { bridge_mode: mode, provider: providerId, upstream_model: model.id },
          });
        }
      }
    }
    return output;
  }

  /** Return count-only runtime diagnostics for all configured providers. */
  runtimeStats() {
    return Object.fromEntries([...this.providers.entries()].map(([id, provider]) => [id, provider.runtimeStats?.() ?? { kind: provider.config.adapter }]));
  }

  /** Dispose all adapters. */
  async close() {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.close()));
  }
}
