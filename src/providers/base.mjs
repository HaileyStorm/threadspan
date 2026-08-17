import { CapabilityError } from "../core/errors.mjs";

export const BRIDGE_MODES = Object.freeze(["consult", "integrated", "delegate"]);

/**
 * Abstract provider contract. Adapters yield normalized ProviderEvent objects.
 */
export class ProviderAdapter {
  /** @param {string} id @param {Record<string, any>} config @param {{logger: any}} context */
  constructor(id, config, context) {
    this.id = id;
    this.config = config;
    this.logger = context.logger.child(id);
  }

  /** Return stable capability metadata. */
  capabilities() {
    const configured = Array.isArray(this.config.capabilities) ? this.config.capabilities : [];
    return {
      modes: Object.fromEntries(BRIDGE_MODES.map((mode) => [mode, {
        supported: configured.includes(mode),
        reason: configured.includes(mode) ? undefined : "not enabled in provider configuration",
      }])),
      streaming: true,
      tools: false,
      images: false,
      durableThreads: false,
    };
  }

  /** Assert that this provider supports the requested bridge mode. */
  assertMode(mode) {
    const entry = this.capabilities().modes[mode];
    if (!entry?.supported) throw new CapabilityError(this.id, mode, entry?.reason);
  }

  /** List models exposed by this provider. */
  async listModels() {
    const configured = Array.isArray(this.config.models)
      ? this.config.models
      : [this.config.model ?? "auto"];
    return configured.map((model) => ({ id: typeof model === "string" ? model : model.id, ...((typeof model === "object" && model) || {}) }));
  }

  /**
   * Execute a normalized turn.
   * @param {any} _request
   * @returns {AsyncIterable<any>}
   */
  async *run(_request) {
    throw new Error(`Provider '${this.id}' did not implement run()`);
  }

  /** Return count-only runtime diagnostics. */
  runtimeStats() {
    return { kind: this.config.adapter ?? "custom" };
  }

  /** Release provider-wide resources. */
  async close() {}
}

/** Resolve an API key from an explicit value or environment-variable name. */
export function resolveApiKey(config, environment = process.env) {
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
  if (typeof config.apiKeyEnv === "string" && config.apiKeyEnv.length > 0) return environment[config.apiKeyEnv];
  return undefined;
}
