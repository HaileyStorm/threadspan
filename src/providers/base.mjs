import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CapabilityError } from "../core/errors.mjs";

export const BRIDGE_MODES = Object.freeze(["consult", "integrated", "delegate"]);
export const EFFECTIVE_EXECUTION_SETTINGS = Object.freeze(["sandbox", "approval", "tools", "web", "memory", "user", "project"]);

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
      userFacingProsePolicy: false,
      settingsOwnership: "host",
    };
  }

  /**
   * Attach a transient, style-only user-facing prose policy when an adapter has a dedicated hook.
   * Unsupported adapters return the request unchanged and must not emulate support through prompts.
   */
  attachUserFacingProsePolicy(request, _policy) {
    return request;
  }

  /**
   * Describe which side owns execution settings without pretending the bridge can inspect host-native values.
   * Raw inference adapters inherit the caller's tool loop, approvals, and project/user policy.
   */
  effectiveSettings(_request = {}) {
    const providerOwnsTools = this.capabilities().providerOwnsTools === true;
    const binding = this.accountBinding();
    return createEffectiveSettingsReport({
      owner: providerOwnsTools ? "provider" : "host",
      inheritance: providerOwnsTools ? "provider-native" : "native-host-project",
      authentication: authenticationOwnership(binding),
      preserved: providerOwnsTools ? ["user", "project"] : EFFECTIVE_EXECUTION_SETTINGS,
      divergences: [],
      exclusions: [],
    });
  }

  /** Return portable lifecycle semantics without claiming an unperformed reconnect or login. */
  connectionLifecycle(context = {}) {
    const binding = this.accountBinding();
    return createConnectionLifecycleReport({
      adapter: this.config.adapter ?? "custom",
      providerId: this.id,
      accountId: binding?.accountId ?? context.accountId ?? "unknown/default",
      providerHealth: context.health?.status ?? context.providerHealth ?? "unknown",
      accountHealth: context.accountHealth ?? "unknown",
      transportHealth: context.transportHealth ?? "not-probed",
      lastFailure: context.lastFailure,
      recovery: {
        reconnect: "adapter-specific-bounded",
        rebind: "same-provider-account-only",
        reauthenticate: "provider-native-outside-threadspan",
        reroute: "existing-privacy-account-authority-gates-only",
        staleProcessDetection: true,
        staleConfigDetection: true,
        preserveResumableState: true,
        parentInterruptionHandleAudit: "required",
      },
    });
  }

  /** Audit a parent interruption without pretending a generic adapter has a resumable handle. */
  async auditRecovery(_context = {}) {
    return {
      adapter: this.config.adapter ?? "custom",
      status: "adapter-specific-audit-required",
      resumable: "unknown",
      orphaned: "unknown",
      instruction: "Inspect the provider-native handle or transport before retrying; do not silently abandon or duplicate the turn.",
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

  /** Return only explicitly configured, validated public provider web links. */
  providerWebMetadata() {
    return Object.fromEntries(["officialUrl", "accountUrl", "usageUrl"]
      .filter((key) => typeof this.config[key] === "string")
      .map((key) => [key, this.config[key]]));
  }

  /** Return the account isolation applied to this adapter instance. */
  accountBinding() {
    const binding = this.config.__threadspanAccount;
    return binding ? { accountId: binding.id, authKind: binding.authKind, isolated: binding.isolated === true } : undefined;
  }

  /** Release provider-wide resources. */
  async close() {}
}

function authenticationOwnership(binding) {
  if (binding?.isolated !== true) return "provider-configured";
  if (binding.authKind === "api-key-env") return "isolated-api-key-environment";
  if (binding.authKind === "secret-file-ref") return "isolated-secret-file-reference";
  if (["native-oauth", "device-login", "cli-login"].includes(binding.authKind)) return "isolated-provider-profile";
  return "isolated-account-source";
}

/**
 * Create a stable, digest-bound public settings report.
 * Divergences must carry their removal path so a bridge-required override is visibly reversible.
 */
export function createEffectiveSettingsReport(input) {
  const divergences = (input.divergences ?? []).map((item) => ({
    setting: String(item.setting),
    value: item.value,
    source: item.source ?? "bridge",
    scope: item.scope ?? "request",
    reason: String(item.reason),
    reversible: item.reversible !== false,
    removeBy: item.removeBy ?? "remove the explicit Threadspan override",
  }));
  const exclusions = (input.exclusions ?? []).map((item) => ({
    setting: String(item.setting),
    reason: String(item.reason),
    visible: true,
  }));
  const payload = {
    schemaVersion: 1,
    owner: input.owner,
    inheritance: input.inheritance,
    authentication: input.authentication,
    preserved: [...new Set(input.preserved ?? [])],
    divergences,
    exclusions,
    reversible: divergences.every((item) => item.reversible),
  };
  return deepFreeze({
    ...payload,
    digest: createHash("sha256").update(stableStringify(payload)).digest("hex"),
  });
}

/** Build a digest-bound provider/account/transport lifecycle report. */
export function createConnectionLifecycleReport(input) {
  const payload = {
    schemaVersion: 1,
    adapter: input.adapter,
    providerId: input.providerId,
    accountId: input.accountId,
    health: {
      provider: input.providerHealth,
      account: input.accountHealth,
      transport: input.transportHealth,
    },
    failure: input.lastFailure ?? null,
    recovery: input.recovery,
  };
  return deepFreeze({
    ...payload,
    digest: createHash("sha256").update(stableStringify(payload)).digest("hex"),
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Resolve an API key from an explicit value or environment-variable name. */
export function resolveApiKey(config, environment = process.env) {
  if (typeof config.apiKey === "string" && config.apiKey.length > 0) return config.apiKey;
  if (typeof config.apiKeyEnv === "string" && config.apiKeyEnv.length > 0) return environment[config.apiKeyEnv];
  if (typeof config.apiKeyFile === "string" && config.apiKeyFile.length > 0) {
    try {
      const value = readFileSync(config.apiKeyFile, "utf8").trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Wrap a command in a tiny Node launcher that overlays only the supplied child environment.
 * The parent process environment and provider-native default profile remain byte-for-byte unchanged.
 */
export function wrapCommandForEnvironment(config, environmentOverlay) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TypeError("config must be an object");
  const originalCommand = String(config.command ?? "");
  if (!originalCommand) throw new TypeError("config.command is required for an isolated environment wrapper");
  const overlay = {};
  for (const [key, value] of Object.entries(environmentOverlay ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length === 0) throw new TypeError("environment overlay must contain non-empty string values under valid variable names");
    overlay[key] = value;
  }
  const launcher = [
    'import { spawnSync } from "node:child_process";',
    'const [command, encoded, ...args] = process.argv.slice(1);',
    'const result = spawnSync(command, args, { env: { ...process.env, ...JSON.parse(encoded) }, stdio: "inherit", windowsHide: true });',
    'if (result.error) { console.error(result.error.message); process.exit(1); }',
    'if (result.signal) process.kill(process.pid, result.signal);',
    'process.exit(result.status ?? 1);',
  ].join("");
  return {
    ...config,
    command: process.execPath,
    commandArgs: ["--input-type=module", "--eval", launcher, originalCommand, JSON.stringify(overlay), ...(config.commandArgs ?? []).map(String)],
  };
}
