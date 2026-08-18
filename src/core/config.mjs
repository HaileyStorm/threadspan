import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { ConfigError } from "./errors.mjs";
import { normalizeVoiceConfig } from "./voice-profiles.mjs";

const DEFAULT_CONFIG = Object.freeze({
  server: {
    host: "127.0.0.1",
    port: 8743,
    authTokenEnv: "THREADSPAN_TOKEN",
    authTokenFile: null,
    connectorTokenEnv: "THREADSPAN_CONNECTOR_TOKEN",
    connectorTokenFile: null,
    allowUnauthenticatedLoopback: false,
    maxBodyBytes: 8 * 1024 * 1024,
    requestTimeoutMs: 30 * 60 * 1000,
    maxConcurrentRequests: 4,
    allowedOrigins: [],
  },
  responses: { exposeReasoning: false },
  logging: { level: "info", logBodies: false },
  sessions: { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 500 },
  usageLedger: { enabled: true },
  accounts: { path: null, profileSources: {}, fallback: { enabled: false, maxCandidates: 1 } },
  voice: { selectedProfile: "technical-partner", profiles: [] },
  tips: {
    enabled: false,
    cooldownMs: 24 * 60 * 60 * 1000,
    modelRefinement: {
      enabled: false,
      provider: null,
      model: null,
      privacy: "deny",
      maxCallsPerSession: 1,
      maxOutputTokens: 96,
      maxLatencyMs: 4_000,
      cooldownMs: 24 * 60 * 60 * 1000,
    },
    ask: { enabled: false, maxTurnsPerSession: 3, maxOutputTokens: 192, maxLatencyMs: 8_000 },
  },
  continuity: {
    enabled: true,
    controlEnabled: true,
    statePath: null,
    maxTasks: 200,
    handleTtlMs: 10 * 60 * 1000,
    previewTtlMs: 2 * 60 * 1000,
  },
  automaticTakeover: {
    enabled: false,
    crossProviderEnabled: true,
    externalMonitoringEnabled: true,
    pollIntervalMs: 15_000,
    stallTimeoutMs: 90_000,
    subagentSpacingMs: 1_400,
    maxSubagentsPerTick: 2,
    maxCrossProviderCandidates: 2,
    minimumIntelligenceRatio: 0.9,
    statePath: null,
    requireExactResetEvidence: true,
    preserveExplicitRoutes: true,
  },
  copyNaturalizer: {
    enabled: false,
    profile: "human",
    maxInputChars: 12_000,
    maxPasses: 3,
    useModel: false,
    provider: null,
    model: null,
    maxOutputTokens: 2_048,
    timeoutMs: 180_000,
  },
  copyCheck: {
    permissionMode: "off",
    maxInputChars: 12_000,
    timeoutMs: 15_000,
    releaseScope: {
      localReview: true,
      externalChecks: false,
      adapters: [],
    },
    adapters: {
      pangram: { enabled: false },
      sapling: { enabled: false, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: false },
      winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
    },
  },
  maximumUtilization: {
    enabled: false,
    automaticPollingEnabled: false,
    pollIntervalMs: 60000,
    manualManifestMaxEntries: 32,
    triggerUsedRatio: 0.96,
    fastCanaryUsedRatio: 0.99,
    normalRolloverConsideration: 0.78,
    pressuredRolloverConsideration: 0.75,
    oneManifestPerEpoch: true,
    requireExactNativeQuotaRecovery: true,
  },
  compatibilityWatch: { enabled: false, readOnly: true, applyEnabled: false, pollingEnabled: false, pollIntervalMs: 900000 },
  branching: {
    enabled: true,
    automaticRecognition: true,
    activationReasons: ["independent-evidence", "divergent-ideation", "disjoint-writes"],
    routingFactors: ["capability", "live-availability", "quota", "credit", "privacy", "latency", "diversity-value"],
    maxBranches: 3,
    maxTurnsPerBranch: 8,
    maxCostUsd: null,
    stopOnConvergence: true,
    nativeDefaults: "preserve",
    toolPolicy: "decision-useful-only",
    imageDivergenceTool: "imagegen",
    synthesisOwner: "caller",
  },
  connectionRecovery: {
    maxReconnectAttempts: 1,
    maxRebindAttempts: 1,
    maxHandleAudits: 1,
    preserveResumableState: true,
    detectStaleProcesses: true,
    detectStaleConfig: true,
    auditHandlesOnParentInterruption: true,
    requireAdapterSpecificRecovery: true,
    reroutePolicy: "existing-gates-only",
    reauthPolicy: "provider-native-only",
  },
  selfHeal: {
    enabled: true,
    subsystemOwner: "compatibility-watch",
    maxAnalysisDepth: 2,
    phases: ["repair", "meta", "meta-meta"],
    immediateRecoveryFirst: true,
    stopAfterMetaMeta: true,
    requireConcreteOwner: true,
    requireEvidence: true,
    requireRegression: true,
    requireHostRollout: true,
    requireRollbackOrExpiryWhenRelevant: true,
    updateRecognizerAndProcess: true,
    analyzeRetryChurn: true,
    contributionPolicy: "sanitized-proposal-only",
    proposalDestinations: ["github-issue", "github-pr"],
    requiredProposalEvidence: ["affected-versions-hosts", "evidence", "rollback", "residual-gaps"],
    localMonitorReview: "required",
    localApplyAfterAcceptance: true,
    sanitizeMachineLocalData: true,
    autoMerge: false,
  },
  routing: { providerOrder: {} },
  defaults: { provider: "cursor", mode: "consult", model: "auto" },
  providers: {},
});

const VALID_MODES = new Set(["consult", "integrated", "delegate"]);
const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

/** Resolve the bridge config path from an explicit value, environment, or user home. */
export function resolveConfigPath(explicitPath) {
  return resolve(explicitPath ?? process.env.THREADSPAN_CONFIG ?? process.env.CURSOR_BRIDGE_CONFIG ?? `${homedir()}/.threadspan/config.jsonc`);
}

/**
 * Strip JSON comments and trailing commas while respecting quoted strings.
 * @param {string} source
 */
export function parseJsonc(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += "\n";
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }

  return JSON.parse(removeTrailingCommas(output));
}

/** Remove trailing commas from JSON outside strings. */
function removeTrailingCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(source[lookahead] ?? "")) lookahead += 1;
      if (source[lookahead] === "}" || source[lookahead] === "]") continue;
    }
    output += char;
  }
  return output;
}

/** Recursively expand ${ENV_VAR} references in string values. */
export function expandEnvironment(value, environment = process.env) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name) => environment[name] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => expandEnvironment(item, environment));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnvironment(child, environment)]));
  }
  return value;
}

/** Deep-merge plain objects; arrays and scalar values replace defaults. */
export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function expandHomePath(value) {
  return value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? resolve(homedir(), value.slice(2)) : value;
}

function canonicalKnownLocalPath(value) {
  const absolute = resolve(expandHomePath(value));
  try { return realpathSync.native(absolute); } catch { return absolute; }
}

function profileRootComparisonKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonicalProfileRoot(value, label) {
  const expanded = expandHomePath(value);
  if (!isAbsolute(expanded)) throw new ConfigError(`${label} must be an absolute path`);
  let canonical;
  let stats;
  try {
    canonical = realpathSync.native(expanded);
    stats = statSync(canonical);
  } catch (error) {
    throw new ConfigError(`${label} must resolve to an existing directory`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!stats.isDirectory()) throw new ConfigError(`${label} must resolve to a directory`);
  return canonical;
}

/**
 * Load, expand, merge, and validate bridge configuration.
 * @param {string} [explicitPath]
 * @param {{allowMissing?: boolean, environment?: NodeJS.ProcessEnv}} [options]
 */
export function loadConfig(explicitPath, options = {}) {
  const path = resolveConfigPath(explicitPath);
  const base = structuredClone(DEFAULT_CONFIG);
  const managedVoice = readManagedVoiceConfig(path);
  if (managedVoice) base.voice = managedVoice;
  if (!existsSync(path)) {
    if (options.allowMissing) return validateConfig(base, path);
    throw new ConfigError(`Configuration file not found: ${path}`);
  }

  let parsed;
  try {
    parsed = parseJsonc(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not parse configuration file: ${path}`, { cause: error instanceof Error ? error.message : error });
  }
  const expanded = expandEnvironment(parsed, options.environment ?? process.env);
  return validateConfig(deepMerge(base, expanded), path, { environment: options.environment ?? process.env });
}

/** Read installer-managed Voice only as a lower-precedence layer beneath explicit runtime config. */
function readManagedVoiceConfig(configPath) {
  const path = resolve(dirname(configPath), "threadspan", "components", "voice-profiles.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.schemaVersion !== 1 || parsed?.component !== "voice-profiles") return undefined;
    return normalizeVoiceConfig({ selectedProfile: parsed.selectedProfile, profiles: parsed.profiles ?? [] });
  } catch {
    return undefined;
  }
}

/** Write a starter configuration without overwriting an existing file unless requested. */
export function writeInitialConfig(path, config, options = {}) {
  const resolvedPath = resolveConfigPath(path);
  if (existsSync(resolvedPath) && options.force !== true) {
    throw new ConfigError(`Refusing to overwrite existing configuration: ${resolvedPath}`);
  }
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return resolvedPath;
}

/** Validate configuration invariants required before startup. */
export function validateConfig(config, configPath = "<memory>", options = {}) {
  if (!isPlainObject(config)) throw new ConfigError("Configuration root must be an object");
  if (config.routing === undefined) config = { ...config, routing: { providerOrder: {} } };
  if (config.usageLedger === undefined) config = { ...config, usageLedger: { enabled: false } };
  if (config.accounts === undefined) config = { ...config, accounts: { path: null, profileSources: {}, fallback: { enabled: false, maxCandidates: 1 } } };
  config = { ...config, voice: normalizeVoiceConfig(config.voice ?? {}) };
  config = { ...config, tips: deepMerge(DEFAULT_CONFIG.tips, config.tips ?? {}) };
  config = { ...config, continuity: deepMerge(DEFAULT_CONFIG.continuity, config.continuity ?? {}) };
  config = { ...config, automaticTakeover: deepMerge(DEFAULT_CONFIG.automaticTakeover, config.automaticTakeover ?? {}) };
  config = { ...config, copyNaturalizer: deepMerge(DEFAULT_CONFIG.copyNaturalizer, config.copyNaturalizer ?? {}) };
  config = { ...config, copyCheck: deepMerge(DEFAULT_CONFIG.copyCheck, config.copyCheck ?? {}) };
  config = { ...config, maximumUtilization: deepMerge(DEFAULT_CONFIG.maximumUtilization, config.maximumUtilization ?? {}) };
  if (config.compatibilityWatch === undefined) config = { ...config, compatibilityWatch: { enabled: false, readOnly: true, applyEnabled: false, pollingEnabled: false, pollIntervalMs: 900000 } };
  config = { ...config, branching: deepMerge(DEFAULT_CONFIG.branching, config.branching ?? {}) };
  config = { ...config, connectionRecovery: deepMerge(DEFAULT_CONFIG.connectionRecovery, config.connectionRecovery ?? {}) };
  config = { ...config, selfHeal: deepMerge(DEFAULT_CONFIG.selfHeal, config.selfHeal ?? {}) };
  if (!isPlainObject(config.server)) throw new ConfigError("server must be an object");
  if (typeof config.server.host !== "string" || config.server.host.length === 0) throw new ConfigError("server.host must be a non-empty string");
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) throw new ConfigError("server.port must be an integer from 1 to 65535");
  assertInteger(config.server.maxBodyBytes, "server.maxBodyBytes", { minimum: 1024 });
  assertInteger(config.server.requestTimeoutMs, "server.requestTimeoutMs", { minimum: 1 });
  assertInteger(config.server.maxConcurrentRequests, "server.maxConcurrentRequests", { minimum: 1 });
  assertOptionalString(config.server.authTokenEnv, "server.authTokenEnv");
  assertOptionalString(config.server.authTokenFile, "server.authTokenFile");
  assertOptionalString(config.server.connectorTokenEnv, "server.connectorTokenEnv");
  assertOptionalString(config.server.connectorTokenFile, "server.connectorTokenFile");
  if (config.server.authTokenEnv && config.server.connectorTokenEnv && config.server.authTokenEnv === config.server.connectorTokenEnv) {
    throw new TypeError("server.authTokenEnv and server.connectorTokenEnv must differ");
  }
  if (config.server.authTokenFile && config.server.connectorTokenFile
    && profileRootComparisonKey(canonicalKnownLocalPath(config.server.authTokenFile))
      === profileRootComparisonKey(canonicalKnownLocalPath(config.server.connectorTokenFile))) {
    throw new ConfigError("server.authTokenFile and server.connectorTokenFile must identify distinct files");
  }
  if (typeof config.server.allowUnauthenticatedLoopback !== "boolean") {
    throw new ConfigError("server.allowUnauthenticatedLoopback must be boolean");
  }
  assertStringArray(config.server.allowedOrigins, "server.allowedOrigins", { unique: true });
  for (const origin of config.server.allowedOrigins) validateHttpOrigin(origin, "server.allowedOrigins");

  if (!isPlainObject(config.responses)) throw new ConfigError("responses must be an object");
  if (typeof config.responses.exposeReasoning !== "boolean") throw new ConfigError("responses.exposeReasoning must be boolean");

  if (!isPlainObject(config.logging)) throw new ConfigError("logging must be an object");
  if (!VALID_LOG_LEVELS.has(config.logging.level)) {
    throw new ConfigError(`logging.level must be one of ${[...VALID_LOG_LEVELS].join(", ")}`);
  }
  if (typeof config.logging.logBodies !== "boolean") throw new ConfigError("logging.logBodies must be boolean");

  if (!isPlainObject(config.sessions)) throw new ConfigError("sessions must be an object");
  assertInteger(config.sessions.ttlMs, "sessions.ttlMs", { minimum: 1 });
  assertInteger(config.sessions.maxEntries, "sessions.maxEntries", { minimum: 1 });
  if (!isPlainObject(config.usageLedger)) throw new ConfigError("usageLedger must be an object");
  if (typeof config.usageLedger.enabled !== "boolean") throw new ConfigError("usageLedger.enabled must be boolean");
  if (!isPlainObject(config.accounts)) throw new ConfigError("accounts must be an object");
  assertOptionalString(config.accounts.path, "accounts.path");
  if (!isPlainObject(config.accounts.profileSources)) throw new ConfigError("accounts.profileSources must be an object");
  const profileRoots = new Map();
  const activeEnvironment = options.environment ?? process.env;
  const reservedProfileRoots = new Map([
    ["codex-home", new Set([
      profileRootComparisonKey(canonicalKnownLocalPath(activeEnvironment.CODEX_HOME ?? resolve(homedir(), ".codex"))),
      profileRootComparisonKey(canonicalKnownLocalPath(resolve(homedir(), ".codex"))),
    ])],
    ["claude-config-dir", new Set([
      profileRootComparisonKey(canonicalKnownLocalPath(activeEnvironment.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"))),
      profileRootComparisonKey(canonicalKnownLocalPath(resolve(homedir(), ".claude"))),
    ])],
  ]);
  const canonicalProfileSources = [];
  for (const [reference, source] of Object.entries(config.accounts.profileSources)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reference)) throw new ConfigError(`accounts.profileSources contains invalid reference '${reference}'`);
    if (!isPlainObject(source) || !["codex-home", "claude-config-dir"].includes(source.kind) || typeof source.root !== "string" || source.root.length === 0) {
      throw new ConfigError(`accounts.profileSources.${reference} must use kind 'codex-home' or 'claude-config-dir' with a machine-local profile root`);
    }
    if (Object.keys(source).some((key) => !["kind", "root"].includes(key))) throw new ConfigError(`accounts.profileSources.${reference} contains unsupported fields`);
    const root = canonicalProfileRoot(source.root, `accounts.profileSources.${reference}.root`);
    const rootKey = profileRootComparisonKey(root);
    if (reservedProfileRoots.get(source.kind).has(rootKey)) {
      const product = source.kind === "codex-home" ? "Codex" : "Claude Code";
      throw new ConfigError(`accounts.profileSources.${reference} must not target the current/default ${product} profile root`);
    }
    if (profileRoots.has(rootKey)) throw new ConfigError(`accounts.profileSources.${reference} duplicates profile root used by '${profileRoots.get(rootKey)}'`);
    profileRoots.set(rootKey, reference);
    canonicalProfileSources.push([reference, { ...source, root }]);
  }
  config = { ...config, accounts: { ...config.accounts, profileSources: Object.fromEntries(canonicalProfileSources) } };
  if (!isPlainObject(config.accounts.fallback)) throw new ConfigError("accounts.fallback must be an object");
  if (typeof config.accounts.fallback.enabled !== "boolean") throw new ConfigError("accounts.fallback.enabled must be boolean");
  assertInteger(config.accounts.fallback.maxCandidates, "accounts.fallback.maxCandidates", { minimum: 1, maximum: 16 });
  // Values above one remain parseable for older configuration files, but execution is always
  // normalized to one alternate so no provider adapter can create a longer account cascade.
  config = { ...config, accounts: { ...config.accounts, fallback: { ...config.accounts.fallback, maxCandidates: 1 } } };
  validateTips(config.tips);
  validateContinuity(config.continuity);
  validateAutomaticTakeover(config.automaticTakeover);
  validateCopyNaturalizer(config.copyNaturalizer);
  validateCopyCheck(config.copyCheck);
  validateMaximumUtilization(config.maximumUtilization);
  if (!isPlainObject(config.compatibilityWatch)) throw new ConfigError("compatibilityWatch must be an object");
  for (const key of ["enabled", "readOnly", "applyEnabled", "pollingEnabled"]) {
    if (typeof config.compatibilityWatch[key] !== "boolean") throw new ConfigError(`compatibilityWatch.${key} must be boolean`);
  }
  assertInteger(config.compatibilityWatch.pollIntervalMs, "compatibilityWatch.pollIntervalMs", { minimum: 60000, maximum: 86400000 });
  validateBranchingPolicy(config.branching);
  validateConnectionRecovery(config.connectionRecovery);
  validateSelfHeal(config.selfHeal);

  if (!isPlainObject(config.providers)) throw new ConfigError("providers must be an object");
  if (!isPlainObject(config.routing)) throw new ConfigError("routing must be an object");
  if (!isPlainObject(config.routing.providerOrder)) throw new ConfigError("routing.providerOrder must be an object");
  for (const [mode, order] of Object.entries(config.routing.providerOrder)) {
    if (!VALID_MODES.has(mode)) throw new ConfigError(`routing.providerOrder contains unsupported mode '${mode}'`);
    assertStringArray(order, `routing.providerOrder.${mode}`, { unique: true });
  }
  if (!isPlainObject(config.defaults)) throw new ConfigError("defaults must be an object");
  assertOptionalString(config.defaults.provider, "defaults.provider");
  assertOptionalString(config.defaults.model, "defaults.model");
  assertOptionalString(config.defaults.accountId, "defaults.accountId");
  if (!VALID_MODES.has(config.defaults.mode)) {
    throw new ConfigError(`defaults.mode must be one of ${[...VALID_MODES].join(", ")}`);
  }

  const secretSourcePaths = new Map();
  const normalizedProviders = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) throw new ConfigError(`Invalid provider id '${providerId}'`);
    if (!isPlainObject(provider)) throw new ConfigError(`Provider '${providerId}' must be an object`);
    if (typeof provider.adapter !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(provider.adapter)) {
      throw new ConfigError(`Provider '${providerId}' is missing a valid adapter`);
    }
    if (provider.enabled !== undefined && typeof provider.enabled !== "boolean") throw new ConfigError(`Provider '${providerId}'.enabled must be boolean`);
    assertOptionalString(provider.model, `Provider '${providerId}'.model`);
    assertOptionalString(provider.apiKey, `Provider '${providerId}'.apiKey`);
    assertOptionalString(provider.apiKeyEnv, `Provider '${providerId}'.apiKeyEnv`);
    for (const key of ["officialUrl", "accountUrl", "usageUrl"]) {
      if (provider[key] !== undefined) validateProviderMetadataUrl(provider[key], `Provider '${providerId}'.${key}`);
    }
    if (provider.capabilities !== undefined) {
      assertStringArray(provider.capabilities, `Provider '${providerId}'.capabilities`, { unique: true });
      for (const capability of provider.capabilities) {
        if (!VALID_MODES.has(capability)) {
          throw new ConfigError(`Provider '${providerId}'.capabilities contains unsupported mode '${capability}'`);
        }
      }
    }
    if (provider.models !== undefined) validateProviderModels(providerId, provider.models);
    const accountSources = provider.accountSources === undefined ? undefined : validateAccountSources(providerId, provider.accountSources, secretSourcePaths);
    for (const key of ["timeoutMs", "maxOutputBytes", "maxStderrBytes", "terminationGraceMs", "discoveryTimeoutMs", "modelCacheTtlMs", "maxPromptChars", "versionTimeoutMs", "maxTurnsCeiling"]) {
      if (provider[key] !== undefined) assertInteger(provider[key], `Provider '${providerId}'.${key}`, { minimum: 1 });
    }
    validateProviderCommonOptions(providerId, provider);
    if (provider.adapter === "command" && provider.enabled !== false) validateCommandProvider(providerId, provider);
    if (provider.adapter === "grok-build" && provider.enabled !== false) validateGrokBuildProvider(providerId, provider);
    if (provider.adapter === "claude-code" && provider.enabled !== false) validateClaudeCodeProvider(providerId, provider);
    if (provider.adapter === "codex-native-worker" && provider.enabled !== false) validateCodexNativeWorkerProvider(providerId, provider);
    if (["openai-chat", "deepseek", "nous", "openrouter"].includes(provider.adapter) && provider.enabled !== false) {
      if (provider.adapter === "openai-chat" && (typeof provider.baseUrl !== "string" || provider.baseUrl.length === 0)) {
        throw new ConfigError(`Provider '${providerId}' using adapter 'openai-chat' requires baseUrl`);
      }
      if (provider.baseUrl !== undefined) validateHttpUrl(provider.baseUrl, `Provider '${providerId}'.baseUrl`);
      validateOpenAiCompatibleOptions(providerId, provider);
    }
    validateCursorStyleOptions(providerId, provider);
    normalizedProviders.push([providerId, accountSources === undefined ? provider : { ...provider, accountSources }]);
  }
  config = { ...config, providers: Object.fromEntries(normalizedProviders) };

  if (config.defaults.provider && !["threadspan", "auto"].includes(config.defaults.provider)) {
    const defaultProvider = config.providers[config.defaults.provider];
    if (!defaultProvider || defaultProvider.enabled === false) {
      throw new ConfigError(`defaults.provider references unknown or disabled provider '${config.defaults.provider}'`);
    }
    if (Array.isArray(defaultProvider.capabilities) && !defaultProvider.capabilities.includes(config.defaults.mode)) {
      throw new ConfigError(`defaults.mode '${config.defaults.mode}' is not enabled by defaults.provider '${config.defaults.provider}'`);
    }
  }

  return Object.freeze({ ...config, configPath });
}

/** Validate an integer-valued configuration field. */
function assertInteger(value, path, options = {}) {
  const minimum = options.minimum ?? Number.MIN_SAFE_INTEGER;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER ? `at least ${minimum}` : `from ${minimum} to ${maximum}`;
    throw new ConfigError(`${path} must be a safe integer ${range}`);
  }
}

/** Validate an optional non-empty string. */
function assertOptionalString(value, path) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${path} must be a non-empty string when configured`);
}

/** Validate an array of non-empty strings. */
function assertStringArray(value, path, options = {}) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ConfigError(`${path} must be an array of non-empty strings`);
  }
  if (options.unique && new Set(value).size !== value.length) throw new ConfigError(`${path} must not contain duplicates`);
}

/** Validate common optional provider fields shared across adapters. */
function validateProviderCommonOptions(providerId, provider) {
  for (const key of ["streaming", "retryWithoutStreaming", "discoverModels", "developerAsSystem", "images", "tools", "durableThreads", "stdin", "shell", "inheritEnv", "killTree", "killProcessTree", "noAutoUpdate", "allowSubagents", "noSubagents", "noMemory", "allowWebSearch", "disableWebSearch", "useJsonSchema"]) {
    if (provider[key] !== undefined && typeof provider[key] !== "boolean") {
      throw new ConfigError(`Provider '${providerId}'.${key} must be boolean`);
    }
  }
  if (provider.allowSubagents !== undefined && provider.noSubagents !== undefined && provider.allowSubagents === provider.noSubagents) {
    throw new ConfigError(`Provider '${providerId}' has conflicting allowSubagents/noSubagents values`);
  }
  if (provider.allowWebSearch !== undefined && provider.disableWebSearch !== undefined && provider.allowWebSearch === provider.disableWebSearch) {
    throw new ConfigError(`Provider '${providerId}' has conflicting allowWebSearch/disableWebSearch values`);
  }
  assertOptionalString(provider.reasoningEffort, `Provider '${providerId}'.reasoningEffort`);
  assertOptionalString(provider.executable, `Provider '${providerId}'.executable`);
  assertOptionalString(provider.executableEnv, `Provider '${providerId}'.executableEnv`);
  for (const key of ["envAllowlist", "commandArgs", "versionArgs", "modelListArgs", "preArgs", "postArgs", "rules", "allowedEfforts", "allowedReasoningEfforts", "grokTools", "disallowedTools", "allow", "deny"]) {
    if (provider[key] !== undefined) assertStringArray(provider[key], `Provider '${providerId}'.${key}`, { unique: key === "envAllowlist" || key === "allowedEfforts" });
  }
  if (provider.headers !== undefined && !isPlainObject(provider.headers)) throw new ConfigError(`Provider '${providerId}'.headers must be an object`);
  if (provider.extraBody !== undefined && !isPlainObject(provider.extraBody)) throw new ConfigError(`Provider '${providerId}'.extraBody must be an object`);
  if (provider.thinking !== undefined && !isPlainObject(provider.thinking)) throw new ConfigError(`Provider '${providerId}'.thinking must be an object`);
  if (provider.mcpServers !== undefined && !isPlainObject(provider.mcpServers)) throw new ConfigError(`Provider '${providerId}'.mcpServers must be an object`);
}

/** Validate the command adapter's process and output contract. */
function validateCommandProvider(providerId, provider) {
  if (typeof provider.command !== "string" || provider.command.length === 0) {
    throw new ConfigError(`Provider '${providerId}' using adapter 'command' requires a non-empty command`);
  }
  if (provider.args !== undefined && (!Array.isArray(provider.args) || provider.args.some((value) => typeof value !== "string"))) {
    throw new ConfigError(`Provider '${providerId}'.args must be an array of strings`);
  }
  if (provider.env !== undefined) validateCommandEnvironment(providerId, provider.env);
  assertOptionalString(provider.cwd, `Provider '${providerId}'.cwd`);
  if (provider.outputFormat !== undefined && !["text", "json", "jsonl"].includes(provider.outputFormat)) {
    throw new ConfigError(`Provider '${providerId}'.outputFormat must be text, json, or jsonl`);
  }
}

/** Validate the opt-in, local-only tip display contract. */
function validateTips(value) {
  if (!isPlainObject(value)) throw new ConfigError("tips must be an object");
  const unknown = Object.keys(value).filter((key) => !["enabled", "cooldownMs", "modelRefinement", "ask"].includes(key));
  if (unknown.length > 0) throw new ConfigError(`tips contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.enabled !== "boolean") throw new ConfigError("tips.enabled must be boolean");
  assertInteger(value.cooldownMs, "tips.cooldownMs", { minimum: 60_000, maximum: 30 * 24 * 60 * 60 * 1000 });
  if (!isPlainObject(value.modelRefinement)) throw new ConfigError("tips.modelRefinement must be an object");
  const modelUnknown = Object.keys(value.modelRefinement).filter((key) => !["enabled", "provider", "model", "privacy", "maxCallsPerSession", "maxOutputTokens", "maxLatencyMs", "cooldownMs"].includes(key));
  if (modelUnknown.length > 0) throw new ConfigError(`tips.modelRefinement contains unsupported fields: ${modelUnknown.join(", ")}`);
  if (typeof value.modelRefinement.enabled !== "boolean") throw new ConfigError("tips.modelRefinement.enabled must be boolean");
  assertOptionalString(value.modelRefinement.provider, "tips.modelRefinement.provider");
  assertOptionalString(value.modelRefinement.model, "tips.modelRefinement.model");
  if (![
    "deny",
    "sanitized-tip-context-only",
  ].includes(value.modelRefinement.privacy)) throw new ConfigError("tips.modelRefinement.privacy must be deny or sanitized-tip-context-only");
  assertInteger(value.modelRefinement.maxCallsPerSession, "tips.modelRefinement.maxCallsPerSession", { minimum: 1, maximum: 1 });
  assertInteger(value.modelRefinement.maxOutputTokens, "tips.modelRefinement.maxOutputTokens", { minimum: 32, maximum: 128 });
  assertInteger(value.modelRefinement.maxLatencyMs, "tips.modelRefinement.maxLatencyMs", { minimum: 1_000, maximum: 10_000 });
  assertInteger(value.modelRefinement.cooldownMs, "tips.modelRefinement.cooldownMs", { minimum: 60_000, maximum: 30 * 24 * 60 * 60 * 1000 });
  if (!isPlainObject(value.ask)) throw new ConfigError("tips.ask must be an object");
  const askUnknown = Object.keys(value.ask).filter((key) => !["enabled", "maxTurnsPerSession", "maxOutputTokens", "maxLatencyMs"].includes(key));
  if (askUnknown.length > 0) throw new ConfigError(`tips.ask contains unsupported fields: ${askUnknown.join(", ")}`);
  if (typeof value.ask.enabled !== "boolean") throw new ConfigError("tips.ask.enabled must be boolean");
  assertInteger(value.ask.maxTurnsPerSession, "tips.ask.maxTurnsPerSession", { minimum: 1, maximum: 4 });
  assertInteger(value.ask.maxOutputTokens, "tips.ask.maxOutputTokens", { minimum: 32, maximum: 256 });
  assertInteger(value.ask.maxLatencyMs, "tips.ask.maxLatencyMs", { minimum: 1_000, maximum: 15_000 });
}

/** Validate the owner-local native Continuity task and control surface. */
function validateContinuity(value) {
  if (!isPlainObject(value)) throw new ConfigError("continuity must be an object");
  const allowed = new Set(["enabled", "controlEnabled", "statePath", "maxTasks", "handleTtlMs", "previewTtlMs"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`continuity contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["enabled", "controlEnabled"]) if (typeof value[key] !== "boolean") throw new ConfigError(`continuity.${key} must be boolean`);
  assertOptionalString(value.statePath, "continuity.statePath");
  assertInteger(value.maxTasks, "continuity.maxTasks", { minimum: 1, maximum: 1000 });
  assertInteger(value.handleTtlMs, "continuity.handleTtlMs", { minimum: 60_000, maximum: 60 * 60 * 1000 });
  assertInteger(value.previewTtlMs, "continuity.previewTtlMs", { minimum: 10_000, maximum: 10 * 60 * 1000 });
  if (!value.enabled && value.controlEnabled) throw new ConfigError("continuity.controlEnabled requires continuity.enabled");
}

/** Validate externally supervised account-first and provider-fallback policy. */
function validateAutomaticTakeover(value) {
  if (!isPlainObject(value)) throw new ConfigError("automaticTakeover must be an object");
  const allowed = new Set(["enabled", "crossProviderEnabled", "externalMonitoringEnabled", "pollIntervalMs", "stallTimeoutMs", "subagentSpacingMs", "maxSubagentsPerTick", "maxCrossProviderCandidates", "minimumIntelligenceRatio", "statePath", "requireExactResetEvidence", "preserveExplicitRoutes"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`automaticTakeover contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["enabled", "crossProviderEnabled", "externalMonitoringEnabled", "requireExactResetEvidence", "preserveExplicitRoutes"]) {
    if (typeof value[key] !== "boolean") throw new ConfigError(`automaticTakeover.${key} must be boolean`);
  }
  assertInteger(value.pollIntervalMs, "automaticTakeover.pollIntervalMs", { minimum: 1_000, maximum: 3_600_000 });
  assertInteger(value.stallTimeoutMs, "automaticTakeover.stallTimeoutMs", { minimum: 10_000, maximum: 24 * 60 * 60 * 1000 });
  assertInteger(value.subagentSpacingMs, "automaticTakeover.subagentSpacingMs", { minimum: 250, maximum: 60_000 });
  assertInteger(value.maxSubagentsPerTick, "automaticTakeover.maxSubagentsPerTick", { minimum: 1, maximum: 32 });
  assertInteger(value.maxCrossProviderCandidates, "automaticTakeover.maxCrossProviderCandidates", { minimum: 1, maximum: 8 });
  if (typeof value.minimumIntelligenceRatio !== "number" || !Number.isFinite(value.minimumIntelligenceRatio) || value.minimumIntelligenceRatio < 0.5 || value.minimumIntelligenceRatio > 1) throw new ConfigError("automaticTakeover.minimumIntelligenceRatio must be between 0.5 and 1");
  assertOptionalString(value.statePath, "automaticTakeover.statePath");
  if (value.requireExactResetEvidence !== true) throw new ConfigError("automaticTakeover.requireExactResetEvidence must remain true");
  if (value.preserveExplicitRoutes !== true) throw new ConfigError("automaticTakeover.preserveExplicitRoutes must remain true");
}

function validateCopyNaturalizer(value) {
  if (!isPlainObject(value)) throw new ConfigError("copyNaturalizer must be an object");
  const allowed = new Set(["enabled", "profile", "maxInputChars", "maxPasses", "useModel", "provider", "model", "maxOutputTokens", "timeoutMs"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`copyNaturalizer contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["enabled", "useModel"]) if (typeof value[key] !== "boolean") throw new ConfigError(`copyNaturalizer.${key} must be boolean`);
  if (!["human", "technical", "concise"].includes(value.profile)) throw new ConfigError("copyNaturalizer.profile must be human, technical, or concise");
  assertInteger(value.maxInputChars, "copyNaturalizer.maxInputChars", { minimum: 1, maximum: 50_000 });
  assertInteger(value.maxPasses, "copyNaturalizer.maxPasses", { minimum: 1, maximum: 5 });
  assertInteger(value.maxOutputTokens, "copyNaturalizer.maxOutputTokens", { minimum: 64, maximum: 8_192 });
  assertInteger(value.timeoutMs, "copyNaturalizer.timeoutMs", { minimum: 1_000, maximum: 600_000 });
  for (const key of ["provider", "model"]) if (value[key] !== null) assertOptionalString(value[key], `copyNaturalizer.${key}`);
  if (value.useModel && (!value.provider || !value.model)) throw new ConfigError("copyNaturalizer.useModel requires provider and model");
  if (value.useModel && value.timeoutMs < 30_000) throw new ConfigError("copyNaturalizer model rewriting requires timeoutMs of at least 30000");
}

/** Validate the separate external copy-check policy. Credentials never enable it. */
function validateCopyCheck(value) {
  if (!isPlainObject(value)) throw new ConfigError("copyCheck must be an object");
  const allowed = new Set(["permissionMode", "maxInputChars", "timeoutMs", "releaseScope", "adapters"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`copyCheck contains unsupported fields: ${unknown.join(", ")}`);
  if (!["off", "ask-every-time", "allow-manual-or-release"].includes(value.permissionMode)) {
    throw new ConfigError("copyCheck.permissionMode must be off, ask-every-time, or allow-manual-or-release");
  }
  assertInteger(value.maxInputChars, "copyCheck.maxInputChars", { minimum: 1, maximum: 50_000 });
  assertInteger(value.timeoutMs, "copyCheck.timeoutMs", { minimum: 250, maximum: 120_000 });
  if (!isPlainObject(value.releaseScope)) throw new ConfigError("copyCheck.releaseScope must be an object");
  const releaseAllowed = new Set(["localReview", "externalChecks", "adapters"]);
  const releaseUnknown = Object.keys(value.releaseScope).filter((key) => !releaseAllowed.has(key));
  if (releaseUnknown.length > 0) throw new ConfigError(`copyCheck.releaseScope contains unsupported fields: ${releaseUnknown.join(", ")}`);
  for (const key of ["localReview", "externalChecks"]) {
    if (typeof value.releaseScope[key] !== "boolean") throw new ConfigError(`copyCheck.releaseScope.${key} must be boolean`);
  }
  assertStringArray(value.releaseScope.adapters, "copyCheck.releaseScope.adapters", { unique: true });
  const knownAdapters = new Set(["pangram", "sapling", "winston", "gptzero", "copyleaks"]);
  for (const adapter of value.releaseScope.adapters) {
    if (!knownAdapters.has(adapter)) throw new ConfigError(`copyCheck.releaseScope.adapters contains unknown adapter '${adapter}'`);
  }
  if (!isPlainObject(value.adapters)) throw new ConfigError("copyCheck.adapters must be an object");
  const adapterUnknown = Object.keys(value.adapters).filter((key) => !["pangram", "sapling", "winston"].includes(key));
  if (adapterUnknown.length > 0) throw new ConfigError(`copyCheck.adapters contains unsupported fields: ${adapterUnknown.join(", ")}`);
  validateCopyCheckPangram(value.adapters.pangram);
  validateCopyCheckSapling(value.adapters.sapling);
  validateCopyCheckWinston(value.adapters.winston);
}

function validateCopyCheckPangram(value) {
  if (!isPlainObject(value)) throw new ConfigError("copyCheck.adapters.pangram must be an object");
  const unknown = Object.keys(value).filter((key) => key !== "enabled");
  if (unknown.length > 0) throw new ConfigError(`copyCheck.adapters.pangram contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.enabled !== "boolean") throw new ConfigError("copyCheck.adapters.pangram.enabled must be boolean");
}

function validateCopyCheckSapling(value) {
  if (!isPlainObject(value)) throw new ConfigError("copyCheck.adapters.sapling must be an object");
  const unknown = Object.keys(value).filter((key) => !["enabled", "apiKeyEnv", "acknowledgedRetention"].includes(key));
  if (unknown.length > 0) throw new ConfigError(`copyCheck.adapters.sapling contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.enabled !== "boolean") throw new ConfigError("copyCheck.adapters.sapling.enabled must be boolean");
  if (typeof value.acknowledgedRetention !== "boolean") throw new ConfigError("copyCheck.adapters.sapling.acknowledgedRetention must be boolean");
  assertOptionalString(value.apiKeyEnv, "copyCheck.adapters.sapling.apiKeyEnv");
  if (value.apiKeyEnv && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.apiKeyEnv)) {
    throw new ConfigError("copyCheck.adapters.sapling.apiKeyEnv must be an environment variable name");
  }
}

function validateCopyCheckWinston(value) {
  if (!isPlainObject(value)) throw new ConfigError("copyCheck.adapters.winston must be an object");
  const unknown = Object.keys(value).filter((key) => !["enabled", "apiKeyEnv"].includes(key));
  if (unknown.length > 0) throw new ConfigError(`copyCheck.adapters.winston contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.enabled !== "boolean") throw new ConfigError("copyCheck.adapters.winston.enabled must be boolean");
  assertOptionalString(value.apiKeyEnv, "copyCheck.adapters.winston.apiKeyEnv");
  if (value.apiKeyEnv && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.apiKeyEnv)) {
    throw new ConfigError("copyCheck.adapters.winston.apiKeyEnv must be an environment variable name");
  }
}

/** Validate the inert maximum-utilization controller composition contract. */
function validateMaximumUtilization(value) {
  if (!isPlainObject(value)) throw new ConfigError("maximumUtilization must be an object");
  const allowed = new Set(["enabled", "automaticPollingEnabled", "pollIntervalMs", "manualManifestMaxEntries", "triggerUsedRatio", "fastCanaryUsedRatio", "normalRolloverConsideration", "pressuredRolloverConsideration", "oneManifestPerEpoch", "requireExactNativeQuotaRecovery"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`maximumUtilization contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["enabled", "automaticPollingEnabled", "oneManifestPerEpoch", "requireExactNativeQuotaRecovery"]) {
    if (typeof value[key] !== "boolean") throw new ConfigError(`maximumUtilization.${key} must be boolean`);
  }
  assertInteger(value.pollIntervalMs, "maximumUtilization.pollIntervalMs", { minimum: 30000, maximum: 3600000 });
  assertInteger(value.manualManifestMaxEntries, "maximumUtilization.manualManifestMaxEntries", { minimum: 1, maximum: 128 });
  for (const key of ["triggerUsedRatio", "fastCanaryUsedRatio", "normalRolloverConsideration", "pressuredRolloverConsideration"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] <= 0 || value[key] > 1) {
      throw new ConfigError(`maximumUtilization.${key} must be a finite ratio greater than 0 and at most 1`);
    }
  }
  if (value.fastCanaryUsedRatio < value.triggerUsedRatio) throw new ConfigError("maximumUtilization.fastCanaryUsedRatio must be at least triggerUsedRatio");
  if (value.pressuredRolloverConsideration > value.normalRolloverConsideration) {
    throw new ConfigError("maximumUtilization.pressuredRolloverConsideration must be at most normalRolloverConsideration");
  }
  if (value.oneManifestPerEpoch !== true) throw new ConfigError("maximumUtilization.oneManifestPerEpoch must remain true");
  if (value.requireExactNativeQuotaRecovery !== true) throw new ConfigError("maximumUtilization.requireExactNativeQuotaRecovery must remain true");
}

/** Validate provider-neutral fan-out policy without selecting or enabling any provider. */
function validateBranchingPolicy(value) {
  if (!isPlainObject(value)) throw new ConfigError("branching must be an object");
  const allowed = new Set(["enabled", "automaticRecognition", "activationReasons", "routingFactors", "maxBranches", "maxTurnsPerBranch", "maxCostUsd", "stopOnConvergence", "nativeDefaults", "toolPolicy", "imageDivergenceTool", "synthesisOwner"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`branching contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["enabled", "automaticRecognition", "stopOnConvergence"]) {
    if (typeof value[key] !== "boolean") throw new ConfigError(`branching.${key} must be boolean`);
  }
  assertInteger(value.maxBranches, "branching.maxBranches", { minimum: 1, maximum: 16 });
  assertInteger(value.maxTurnsPerBranch, "branching.maxTurnsPerBranch", { minimum: 1, maximum: 128 });
  if (value.maxCostUsd !== null && (typeof value.maxCostUsd !== "number" || !Number.isFinite(value.maxCostUsd) || value.maxCostUsd < 0)) {
    throw new ConfigError("branching.maxCostUsd must be null or a finite non-negative number");
  }
  assertStringArray(value.activationReasons, "branching.activationReasons", { unique: true });
  const reasons = new Set(["independent-evidence", "divergent-ideation", "disjoint-writes"]);
  if (value.activationReasons.length === 0 || value.activationReasons.some((item) => !reasons.has(item))) {
    throw new ConfigError("branching.activationReasons may contain only independent-evidence, divergent-ideation, and disjoint-writes");
  }
  assertStringArray(value.routingFactors, "branching.routingFactors", { unique: true });
  const requiredFactors = ["capability", "live-availability", "quota", "credit", "privacy", "latency", "diversity-value"];
  if (requiredFactors.some((item) => !value.routingFactors.includes(item))) {
    throw new ConfigError(`branching.routingFactors must include ${requiredFactors.join(", ")}`);
  }
  if (value.stopOnConvergence !== true) throw new ConfigError("branching.stopOnConvergence must remain true");
  if (value.nativeDefaults !== "preserve") throw new ConfigError("branching.nativeDefaults must be 'preserve'");
  if (value.toolPolicy !== "decision-useful-only") throw new ConfigError("branching.toolPolicy must be 'decision-useful-only'");
  if (value.imageDivergenceTool !== "imagegen") throw new ConfigError("branching.imageDivergenceTool must be 'imagegen'");
  if (value.synthesisOwner !== "caller") throw new ConfigError("branching.synthesisOwner must remain 'caller'");
}

/** Validate bounded, adapter-specific connection recovery scaffolding. */
function validateConnectionRecovery(value) {
  if (!isPlainObject(value)) throw new ConfigError("connectionRecovery must be an object");
  const allowed = new Set(["maxReconnectAttempts", "maxRebindAttempts", "maxHandleAudits", "preserveResumableState", "detectStaleProcesses", "detectStaleConfig", "auditHandlesOnParentInterruption", "requireAdapterSpecificRecovery", "reroutePolicy", "reauthPolicy"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`connectionRecovery contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["maxReconnectAttempts", "maxRebindAttempts", "maxHandleAudits"]) {
    assertInteger(value[key], `connectionRecovery.${key}`, { minimum: 0, maximum: 8 });
  }
  for (const key of ["preserveResumableState", "detectStaleProcesses", "detectStaleConfig", "auditHandlesOnParentInterruption", "requireAdapterSpecificRecovery"]) {
    if (value[key] !== true) throw new ConfigError(`connectionRecovery.${key} must remain true`);
  }
  if (value.reroutePolicy !== "existing-gates-only") throw new ConfigError("connectionRecovery.reroutePolicy must be 'existing-gates-only'");
  if (value.reauthPolicy !== "provider-native-only") throw new ConfigError("connectionRecovery.reauthPolicy must be 'provider-native-only'");
}

/** Enforce depth-two self-heal closure without recursive analysis theater. */
function validateSelfHeal(value) {
  if (!isPlainObject(value)) throw new ConfigError("selfHeal must be an object");
  const allowed = new Set(["enabled", "subsystemOwner", "maxAnalysisDepth", "phases", "immediateRecoveryFirst", "stopAfterMetaMeta", "requireConcreteOwner", "requireEvidence", "requireRegression", "requireHostRollout", "requireRollbackOrExpiryWhenRelevant", "updateRecognizerAndProcess", "analyzeRetryChurn", "contributionPolicy", "proposalDestinations", "requiredProposalEvidence", "localMonitorReview", "localApplyAfterAcceptance", "sanitizeMachineLocalData", "autoMerge"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ConfigError(`selfHeal contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.enabled !== "boolean") throw new ConfigError("selfHeal.enabled must be boolean");
  if (value.subsystemOwner !== "compatibility-watch") throw new ConfigError("selfHeal.subsystemOwner must be 'compatibility-watch'");
  if (value.maxAnalysisDepth !== 2) throw new ConfigError("selfHeal.maxAnalysisDepth must remain 2");
  if (JSON.stringify(value.phases) !== JSON.stringify(["repair", "meta", "meta-meta"])) {
    throw new ConfigError("selfHeal.phases must be repair, meta, meta-meta in order");
  }
  for (const key of ["immediateRecoveryFirst", "stopAfterMetaMeta", "requireConcreteOwner", "requireEvidence", "requireRegression", "requireHostRollout", "requireRollbackOrExpiryWhenRelevant", "updateRecognizerAndProcess", "analyzeRetryChurn"]) {
    if (value[key] !== true) throw new ConfigError(`selfHeal.${key} must remain true`);
  }
  if (value.contributionPolicy !== "sanitized-proposal-only") throw new ConfigError("selfHeal.contributionPolicy must be 'sanitized-proposal-only'");
  if (JSON.stringify(value.proposalDestinations) !== JSON.stringify(["github-issue", "github-pr"])) throw new ConfigError("selfHeal.proposalDestinations must be github-issue and github-pr");
  if (JSON.stringify(value.requiredProposalEvidence) !== JSON.stringify(["affected-versions-hosts", "evidence", "rollback", "residual-gaps"])) throw new ConfigError("selfHeal.requiredProposalEvidence is incomplete");
  if (value.localMonitorReview !== "required") throw new ConfigError("selfHeal.localMonitorReview must be 'required'");
  if (value.localApplyAfterAcceptance !== true || value.sanitizeMachineLocalData !== true || value.autoMerge !== false) {
    throw new ConfigError("selfHeal contribution coordination requires accepted local apply, machine-local sanitization, and autoMerge:false");
  }
}

/** Validate a provider-native Codex account worker without accepting bridge/provider overrides. */
function validateCodexNativeWorkerProvider(providerId, provider) {
  if (!Array.isArray(provider.capabilities) || provider.capabilities.length !== 1 || provider.capabilities[0] !== "delegate") {
    throw new ConfigError(`Provider '${providerId}' using adapter 'codex-native-worker' must enable Delegate only`);
  }
  assertOptionalString(provider.command, `Provider '${providerId}'.command`);
  if (provider.contextWindow !== undefined) assertInteger(provider.contextWindow, `Provider '${providerId}'.contextWindow`, { minimum: 1 });
  if (typeof provider.model !== "string" || !nativeCodexSlug(provider.model)) {
    throw new ConfigError(`Provider '${providerId}'.model must be a native Codex catalog slug without route separators`);
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new ConfigError(`Provider '${providerId}'.models must explicitly list native Codex catalog slugs`);
  }
  const models = provider.models.map((model) => typeof model === "string" ? model : model?.id);
  if (models.some((model) => !nativeCodexSlug(model)) || !models.includes(provider.model)) {
    throw new ConfigError(`Provider '${providerId}'.models must contain only native Codex catalog slugs and include the default model`);
  }
  if (!["low", "medium", "high", "xhigh", "max"].includes(provider.reasoningEffort ?? "high")) {
    throw new ConfigError(`Provider '${providerId}'.reasoningEffort is unsupported for codex-native-worker`);
  }
  if (!["read-only", "workspace-write", "danger-full-access"].includes(provider.sandbox ?? "workspace-write")) {
    throw new ConfigError(`Provider '${providerId}'.sandbox is unsupported for codex-native-worker`);
  }
  if (!["never", "on-request", "on-failure", "untrusted"].includes(provider.approvalPolicy ?? "never")) {
    throw new ConfigError(`Provider '${providerId}'.approvalPolicy is unsupported for codex-native-worker`);
  }
  for (const key of ["profile", "integratedRoute", "modelProvider", "baseUrl", "openaiBaseUrl", "chatgptBaseUrl"]) {
    if (provider[key] !== undefined) throw new ConfigError(`Provider '${providerId}'.${key} is forbidden for codex-native-worker`);
  }
  const forbiddenArgument = (provider.commandArgs ?? []).find((argument) => /(?:^|[.=])(?:profile|model_provider|model_providers|openai_base_url|chatgpt_base_url|approval_policy|model_context_window|model_reasoning_effort)(?:$|[.=])/i.test(argument)
    || /^(?:--(?:profile|ignore-user-config|sandbox|ask-for-approval|approve-for-me|dangerously-bypass-approvals-and-sandbox|search|disable|enable|config|model|local-provider|oss|cd|add-dir)(?:=|$)|-[pcmaC]$)/i.test(argument));
  if (forbiddenArgument) throw new ConfigError(`Provider '${providerId}'.commandArgs contains a hidden profile, provider, base, or execution-settings override`);
}

function nativeCodexSlug(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.includes("/");
}


/** Validate Grok Build CLI pinning, safety, admission, and finite-run controls. */
function validateGrokBuildProvider(providerId, provider) {
  if (provider.capabilities?.includes("integrated")) {
    throw new ConfigError(`Provider '${providerId}' using adapter 'grok-build' cannot enable Integrated mode; configure direct xAI API access through openai-chat instead`);
  }
  assertOptionalString(provider.command, `Provider '${providerId}'.command`);
  assertOptionalString(provider.executable, `Provider '${providerId}'.executable`);
  assertOptionalString(provider.versionPattern, `Provider '${providerId}'.versionPattern`);
  assertOptionalString(provider.permissionMode, `Provider '${providerId}'.permissionMode`);
  assertOptionalString(provider.sandbox, `Provider '${providerId}'.sandbox`);
  assertOptionalString(provider.executableSha256, `Provider '${providerId}'.executableSha256`);
  if (provider.executableSha256 !== undefined) validateSha256(provider.executableSha256, `Provider '${providerId}'.executableSha256`);
  if (provider.versionPattern !== undefined) validateRegularExpression(provider.versionPattern, `Provider '${providerId}'.versionPattern`);

  for (const key of ["requireAbsoluteCommand", "skipVersionCheck", "verifyOnEveryRun", "strictModelList", "useJsonSchema"]) {
    if (provider[key] !== undefined && typeof provider[key] !== "boolean") {
      throw new ConfigError(`Provider '${providerId}'.${key} must be boolean`);
    }
  }
  for (const key of ["allowedEfforts", "allowedReasoningEfforts", "allow", "deny"]) {
    if (provider[key] !== undefined) assertStringArray(provider[key], `Provider '${providerId}'.${key}`, { unique: true });
  }
  for (const effort of provider.allowedEfforts ?? provider.allowedReasoningEfforts ?? []) {
    if (!["low", "medium", "high"].includes(effort)) {
      throw new ConfigError(`Provider '${providerId}' effort list contains unsupported value '${effort}'`);
    }
  }
  if (provider.env !== undefined) validateCommandEnvironment(providerId, provider.env);

  if (provider.pin !== undefined) {
    if (!isPlainObject(provider.pin)) throw new ConfigError(`Provider '${providerId}'.pin must be an object`);
    assertOptionalString(provider.pin.version, `Provider '${providerId}'.pin.version`);
    assertOptionalString(provider.pin.sha256, `Provider '${providerId}'.pin.sha256`);
    if (provider.pin.sha256 !== undefined) validateSha256(provider.pin.sha256, `Provider '${providerId}'.pin.sha256`);
    if (provider.pin.recordSha256 !== undefined && typeof provider.pin.recordSha256 !== "boolean") {
      throw new ConfigError(`Provider '${providerId}'.pin.recordSha256 must be boolean`);
    }
  }

  if (provider.permissions !== undefined) {
    if (!isPlainObject(provider.permissions)) throw new ConfigError(`Provider '${providerId}'.permissions must be an object`);
    for (const key of ["allow", "deny"]) {
      if (provider.permissions[key] !== undefined) {
        assertStringArray(provider.permissions[key], `Provider '${providerId}'.permissions.${key}`, { unique: true });
      }
    }
  }

  if (provider.admission !== undefined) {
    if (!isPlainObject(provider.admission)) throw new ConfigError(`Provider '${providerId}'.admission must be an object`);
    for (const key of ["maxActive", "windowMs", "maxStartsPerWindow", "maxUnitsPerWindow", "maxTurnsPerWindow", "maxQueue"]) {
      if (provider.admission[key] !== undefined) assertInteger(provider.admission[key], `Provider '${providerId}'.admission.${key}`, { minimum: 1 });
    }
    if (provider.admission.minStartIntervalMs !== undefined) {
      assertInteger(provider.admission.minStartIntervalMs, `Provider '${providerId}'.admission.minStartIntervalMs`, { minimum: 0 });
    }
  }

  if (provider.ledger !== undefined) {
    if (!isPlainObject(provider.ledger)) throw new ConfigError(`Provider '${providerId}'.ledger must be an object`);
    for (const key of ["enabled", "required", "includeOutput"]) {
      if (provider.ledger[key] !== undefined && typeof provider.ledger[key] !== "boolean") {
        throw new ConfigError(`Provider '${providerId}'.ledger.${key} must be boolean`);
      }
    }
    for (const key of ["path", "evidenceDirectory"]) {
      assertOptionalString(provider.ledger[key], `Provider '${providerId}'.ledger.${key}`);
    }
  }

  if (provider.profiles !== undefined) {
    if (!isPlainObject(provider.profiles)) throw new ConfigError(`Provider '${providerId}'.profiles must be an object`);
    for (const [profileName, profile] of Object.entries(provider.profiles)) {
      if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !isPlainObject(profile)) {
        throw new ConfigError(`Provider '${providerId}'.profiles.${profileName} must be a named object`);
      }
      validateGrokProfile(providerId, profileName, profile, provider.maxTurnsCeiling ?? 100);
    }
  }

  validateGrokModeOptions(providerId, "consult", provider.consult, provider.maxTurnsCeiling ?? 100);
  validateGrokModeOptions(providerId, "delegate", provider.delegate, provider.maxTurnsCeiling ?? 100);
}

/** Validate the shell-free, provider-native-session Claude Code Preview boundary. */
function validateClaudeCodeProvider(providerId, provider) {
  if (provider.capabilities?.includes("integrated")) {
    throw new ConfigError(`Provider '${providerId}' using adapter 'claude-code' cannot enable Integrated mode because Claude Code owns its tool loop`);
  }
  if (typeof provider.command !== "string" || provider.command.length === 0) {
    throw new ConfigError(`Provider '${providerId}' using adapter 'claude-code' requires a non-empty command`);
  }
  if (typeof provider.model !== "string" || !provider.model || provider.model === "auto") {
    throw new ConfigError(`Provider '${providerId}' using adapter 'claude-code' requires an explicit model or model alias`);
  }
  for (const key of ["apiKey", "apiKeyEnv", "apiKeyFile", "authToken", "authTokenEnv", "authTokenFile", "env", "environment", "claudeConfigDir", "mcpServers", "plugins", "hooks", "commandArgs"]) {
    if (provider[key] !== undefined) throw new ConfigError(`Provider '${providerId}'.${key} is forbidden for the Claude Code Preview adapter`);
  }
  if (provider.shell === true) throw new ConfigError(`Provider '${providerId}' using adapter 'claude-code' requires shell:false`);
  if (provider.inheritEnv === true) throw new ConfigError(`Provider '${providerId}' using adapter 'claude-code' cannot inherit the bridge credential environment`);
  if (provider.gateway !== undefined) validateClaudeGateway(providerId, provider);
  for (const key of ["maxSessions", "sessionTtlMs"]) {
    if (provider[key] !== undefined) assertInteger(provider[key], `Provider '${providerId}'.${key}`, { minimum: 1 });
  }

  const ceiling = provider.maxTurnsCeiling ?? 24;
  validateClaudeMode(providerId, "consult", provider.consult, ceiling);
  validateClaudeMode(providerId, "delegate", provider.delegate, ceiling);
}

function validateClaudeGateway(providerId, provider) {
  const gateway = provider.gateway;
  if (!isPlainObject(gateway)) throw new ConfigError(`Provider '${providerId}'.gateway must be an object`);
  const unknown = Object.keys(gateway).filter((key) => !["baseUrl", "apiKeyEnv", "model", "provider"].includes(key));
  if (unknown.length > 0) throw new ConfigError(`Provider '${providerId}'.gateway contains unsupported fields: ${unknown.join(", ")}`);
  for (const key of ["baseUrl", "apiKeyEnv", "model", "provider"]) {
    if (typeof gateway[key] !== "string" || gateway[key].length === 0) {
      throw new ConfigError(`Provider '${providerId}'.gateway.${key} must be a non-empty string`);
    }
  }
  validateHttpUrl(gateway.baseUrl, `Provider '${providerId}'.gateway.baseUrl`);
  const parsed = new URL(gateway.baseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ConfigError(`Provider '${providerId}'.gateway.baseUrl must be an HTTPS URL without credentials`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(gateway.apiKeyEnv)) {
    throw new ConfigError(`Provider '${providerId}'.gateway.apiKeyEnv must be an environment variable name`);
  }
  if (gateway.model !== provider.model) {
    throw new ConfigError(`Provider '${providerId}'.gateway.model must match the provider model`);
  }
}

function validateClaudeMode(providerId, mode, options, ceiling) {
  if (options === undefined) return;
  if (!isPlainObject(options)) throw new ConfigError(`Provider '${providerId}'.${mode} must be an object`);
  if (options.maxTurns !== undefined) {
    assertInteger(options.maxTurns, `Provider '${providerId}'.${mode}.maxTurns`, { minimum: 1, maximum: ceiling });
  }
  if (options.permissionMode !== undefined) {
    const allowed = mode === "consult" ? ["plan"] : ["acceptEdits", "dontAsk", "default", "manual"];
    if (!allowed.includes(options.permissionMode)) {
      throw new ConfigError(`Provider '${providerId}'.${mode}.permissionMode cannot bypass Claude Code permissions`);
    }
  }
  const toolAllowlist = mode === "consult"
    ? ["Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
  if (options.tools !== undefined) {
    assertStringArray(options.tools, `Provider '${providerId}'.${mode}.tools`, { unique: true });
    if (options.tools.length === 0 || options.tools.some((tool) => !toolAllowlist.includes(tool))) {
      throw new ConfigError(`Provider '${providerId}'.${mode}.tools exceeds the Claude Code Preview allowlist`);
    }
  }
  if (options.allowedTools !== undefined) {
    if (mode !== "delegate") throw new ConfigError(`Provider '${providerId}'.consult.allowedTools is not permitted`);
    assertStringArray(options.allowedTools, `Provider '${providerId}'.delegate.allowedTools`, { unique: true });
    if (options.allowedTools.some((tool) => /^(?:Agent|WebFetch|WebSearch|mcp__)/i.test(tool))) {
      throw new ConfigError(`Provider '${providerId}'.delegate.allowedTools cannot enable subagents, web tools, or MCP`);
    }
  }
  if (mode === "consult" && options.workspaceStrategy !== undefined && options.workspaceStrategy !== "snapshot") {
    throw new ConfigError(`Provider '${providerId}'.consult.workspaceStrategy must be snapshot`);
  }
  if (mode === "delegate") {
    for (const key of ["requireGit", "requireLinkedWorktree", "requireCleanStart"]) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") {
        throw new ConfigError(`Provider '${providerId}'.delegate.${key} must be boolean`);
      }
    }
    if (options.denyBranches !== undefined) assertStringArray(options.denyBranches, `Provider '${providerId}'.delegate.denyBranches`, { unique: true });
  }
}

/** Validate one reusable Grok task profile. */
function validateGrokProfile(providerId, profileName, profile, ceiling) {
  assertOptionalString(profile.reasoningEffort, `Provider '${providerId}'.profiles.${profileName}.reasoningEffort`);
  if (profile.reasoningEffort !== undefined && !["low", "medium", "high"].includes(profile.reasoningEffort)) {
    throw new ConfigError(`Provider '${providerId}'.profiles.${profileName}.reasoningEffort must be low, medium, or high`);
  }
  for (const key of ["maxTurns", "expectedTurns"]) {
    if (profile[key] !== undefined) assertInteger(profile[key], `Provider '${providerId}'.profiles.${profileName}.${key}`, { minimum: 1, maximum: ceiling });
  }
  if (profile.maxTurns !== undefined && profile.expectedTurns !== undefined && profile.expectedTurns > profile.maxTurns) {
    throw new ConfigError(`Provider '${providerId}'.profiles.${profileName}.expectedTurns cannot exceed maxTurns`);
  }
  if (profile.noPlan !== undefined && typeof profile.noPlan !== "boolean") {
    throw new ConfigError(`Provider '${providerId}'.profiles.${profileName}.noPlan must be boolean`);
  }
}

/** Validate one Grok Consult/Delegate policy object. */
function validateGrokModeOptions(providerId, mode, options, ceiling) {
  if (options === undefined) return;
  if (!isPlainObject(options)) throw new ConfigError(`Provider '${providerId}'.${mode} must be an object`);
  for (const key of ["profile", "reasoningEffort", "permissionMode", "sandbox", "workspaceStrategy", "snapshotRoot"]) {
    assertOptionalString(options[key], `Provider '${providerId}'.${mode}.${key}`);
  }
  if (options.reasoningEffort !== undefined && !["low", "medium", "high"].includes(options.reasoningEffort)) {
    throw new ConfigError(`Provider '${providerId}'.${mode}.reasoningEffort must be low, medium, or high`);
  }
  if (mode === "consult" && options.workspaceStrategy !== undefined && !["snapshot", "none"].includes(options.workspaceStrategy)) {
    throw new ConfigError(`Provider '${providerId}'.consult.workspaceStrategy must be snapshot or none`);
  }
  for (const key of ["maxTurns", "expectedTurns"]) {
    if (options[key] !== undefined) assertInteger(options[key], `Provider '${providerId}'.${mode}.${key}`, { minimum: 1, maximum: ceiling });
  }
  if (options.maxTurns !== undefined && options.expectedTurns !== undefined && options.expectedTurns > options.maxTurns) {
    throw new ConfigError(`Provider '${providerId}'.${mode}.expectedTurns cannot exceed maxTurns`);
  }
  for (const key of ["maxPromptChars", "timeoutMs", "maxOutputBytes", "snapshotMaxBytes", "snapshotMaxFiles"]) {
    if (options[key] !== undefined) assertInteger(options[key], `Provider '${providerId}'.${mode}.${key}`, { minimum: 1 });
  }
  for (const key of [
    "allowSubagents",
    "noSubagents",
    "noMemory",
    "allowWebSearch",
    "disableWebSearch",
    "noPlan",
    "useJsonSchema",
    "requireGit",
    "requireLinkedWorktree",
    "requireCleanStart",
    "copyInternalSymlinks",
  ]) {
    if (options[key] !== undefined && typeof options[key] !== "boolean") {
      throw new ConfigError(`Provider '${providerId}'.${mode}.${key} must be boolean`);
    }
  }
  if (options.allowSubagents !== undefined && options.noSubagents !== undefined && options.allowSubagents === options.noSubagents) {
    throw new ConfigError(`Provider '${providerId}'.${mode} has conflicting allowSubagents/noSubagents values`);
  }
  if (options.allowWebSearch !== undefined && options.disableWebSearch !== undefined && options.allowWebSearch === options.disableWebSearch) {
    throw new ConfigError(`Provider '${providerId}'.${mode} has conflicting allowWebSearch/disableWebSearch values`);
  }
  for (const key of ["tools", "disallowedTools", "allow", "deny", "allowRules", "denyRules", "denyBranches", "rules", "exclude"]) {
    if (options[key] !== undefined) assertStringArray(options[key], `Provider '${providerId}'.${mode}.${key}`, { unique: true });
  }
  for (const key of ["resultSchema", "jsonSchema"]) {
    if (options[key] !== undefined && typeof options[key] !== "string" && !isPlainObject(options[key])) {
      throw new ConfigError(`Provider '${providerId}'.${mode}.${key} must be a JSON object or non-empty string`);
    }
  }
}

/** Validate a SHA-256 hexadecimal digest. */
function validateSha256(value, path) {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new ConfigError(`${path} must be a 64-character SHA-256 hex digest`);
}

/** Validate a configured regular expression at configuration load time. */
function validateRegularExpression(value, path) {
  try { new RegExp(value); } catch (error) {
    throw new ConfigError(`${path} must be a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate fields used by OpenAI-compatible Chat Completions adapters. */
function validateOpenAiCompatibleOptions(providerId, provider) {
  if (provider.headers !== undefined) {
    for (const [key, value] of Object.entries(provider.headers)) {
      if (typeof value !== "string") throw new ConfigError(`Provider '${providerId}'.headers.${key} must be a string`);
    }
  }
}

/** Validate Cursor/agent lifecycle and snapshot options when present. */
function validateCursorStyleOptions(providerId, provider) {
  if (provider.consult !== undefined && !isPlainObject(provider.consult)) throw new ConfigError(`Provider '${providerId}'.consult must be an object`);
  if (provider.delegate !== undefined && !isPlainObject(provider.delegate)) throw new ConfigError(`Provider '${providerId}'.delegate must be an object`);
  if (provider.local !== undefined && !isPlainObject(provider.local)) throw new ConfigError(`Provider '${providerId}'.local must be an object`);

  const consult = provider.consult;
  if (consult) {
    assertOptionalString(consult.agentMode, `Provider '${providerId}'.consult.agentMode`);
    assertOptionalString(consult.snapshotRoot, `Provider '${providerId}'.consult.snapshotRoot`);
    if (consult.workspaceStrategy !== undefined && !["snapshot", "none"].includes(consult.workspaceStrategy)) {
      throw new ConfigError(`Provider '${providerId}'.consult.workspaceStrategy must be snapshot or none`);
    }
    if (consult.snapshotMaxBytes !== undefined) assertInteger(consult.snapshotMaxBytes, `Provider '${providerId}'.consult.snapshotMaxBytes`, { minimum: 1 });
    if (consult.snapshotMaxFiles !== undefined) assertInteger(consult.snapshotMaxFiles, `Provider '${providerId}'.consult.snapshotMaxFiles`, { minimum: 1 });
    for (const key of ["copyInternalSymlinks", "includeToolStatus"]) {
      if (consult[key] !== undefined && typeof consult[key] !== "boolean") {
        throw new ConfigError(`Provider '${providerId}'.consult.${key} must be boolean`);
      }
    }
    if (consult.exclude !== undefined) assertStringArray(consult.exclude, `Provider '${providerId}'.consult.exclude`, { unique: true });
    if (consult.mcpServers !== undefined && !isPlainObject(consult.mcpServers)) throw new ConfigError(`Provider '${providerId}'.consult.mcpServers must be an object`);
  }

  const delegate = provider.delegate;
  if (delegate) {
    assertOptionalString(delegate.agentMode, `Provider '${providerId}'.delegate.agentMode`);
    if (delegate.agentTtlMs !== undefined) assertInteger(delegate.agentTtlMs, `Provider '${providerId}'.delegate.agentTtlMs`, { minimum: 1 });
    if (delegate.maxAgents !== undefined) assertInteger(delegate.maxAgents, `Provider '${providerId}'.delegate.maxAgents`, { minimum: 1 });
    if (delegate.includeToolStatus !== undefined && typeof delegate.includeToolStatus !== "boolean") {
      throw new ConfigError(`Provider '${providerId}'.delegate.includeToolStatus must be boolean`);
    }
    if (delegate.mcpServers !== undefined && !isPlainObject(delegate.mcpServers)) throw new ConfigError(`Provider '${providerId}'.delegate.mcpServers must be an object`);
  }

  const local = provider.local;
  if (local) {
    for (const key of ["sandboxEnabled", "autoReview"]) {
      if (local[key] !== undefined && typeof local[key] !== "boolean") {
        throw new ConfigError(`Provider '${providerId}'.local.${key} must be boolean`);
      }
    }
    if (local.settingSources !== undefined) assertStringArray(local.settingSources, `Provider '${providerId}'.local.settingSources`, { unique: true });
  }
}

/** Validate an HTTP(S) endpoint URL. */
function validateHttpUrl(value, path) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError(`${path} must be a valid absolute URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new ConfigError(`${path} must use http or https`);
}

/** Validate an optional public provider link without accepting embedded request or identity data. */
function validateProviderMetadataUrl(value, path) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value !== value.trim()
    || !/^https:\/\/[^/]/i.test(value) || value.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new ConfigError(`${path} must be a non-empty bounded HTTPS URL`);
  }
  let url;
  try { url = new URL(value); } catch { throw new ConfigError(`${path} must be a valid absolute HTTPS URL`); }
  if (url.protocol !== "https:" || !url.hostname) throw new ConfigError(`${path} must use HTTPS with a hostname`);
  const authority = value.match(/^https:\/\/([^/]+)/i)?.[1] ?? "";
  if (url.username || url.password || authority.includes("@")) throw new ConfigError(`${path} must not contain credentials`);
  if (value.includes("?") || value.includes("#") || url.search || url.hash) {
    throw new ConfigError(`${path} must not contain a query string or fragment`);
  }
}

/** Validate an exact browser origin with no path, query, fragment, or credentials. */
function validateHttpOrigin(value, path) {
  let url;
  try { url = new URL(value); } catch { throw new ConfigError(`${path} contains invalid origin '${value}'`); }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value || url.username || url.password) {
    throw new ConfigError(`${path} must contain exact http(s) origins such as 'http://127.0.0.1:3000'`);
  }
}

/** Validate configured model-list entries without constraining provider-specific metadata. */
function validateProviderModels(providerId, models) {
  if (!Array.isArray(models) || models.length === 0) throw new ConfigError(`Provider '${providerId}'.models must be a non-empty array`);
  const ids = [];
  for (const [index, model] of models.entries()) {
    if (typeof model === "string" && model.length > 0) { ids.push(model); continue; }
    if (isPlainObject(model) && typeof model.id === "string" && model.id.length > 0) { ids.push(model.id); continue; }
    throw new ConfigError(`Provider '${providerId}'.models[${index}] must be a non-empty string or an object with a non-empty id`);
  }
  if (new Set(ids).size !== ids.length) throw new ConfigError(`Provider '${providerId}'.models must not contain duplicate ids`);
}

/** Validate opaque account-source bindings kept only in machine-local configuration. */
function validateAccountSources(providerId, sources, usedPaths = new Map()) {
  if (!isPlainObject(sources)) throw new ConfigError(`Provider '${providerId}'.accountSources must be an object`);
  const normalized = [];
  for (const [reference, source] of Object.entries(sources)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reference)) {
      throw new ConfigError(`Provider '${providerId}'.accountSources contains invalid reference '${reference}'`);
    }
    if (!isPlainObject(source) || source.kind !== "secret-file" || typeof source.path !== "string" || source.path.length === 0) {
      throw new ConfigError(`Provider '${providerId}'.accountSources.${reference} must be { kind: 'secret-file', path: '<machine-local path>' }`);
    }
    const unknown = Object.keys(source).filter((key) => !["kind", "path"].includes(key));
    if (unknown.length > 0) throw new ConfigError(`Provider '${providerId}'.accountSources.${reference} contains unsupported fields`);
    const expanded = expandHomePath(source.path);
    if (!isAbsolute(expanded)) throw new ConfigError(`Provider '${providerId}'.accountSources.${reference}.path must be absolute`);
    const path = canonicalKnownLocalPath(expanded);
    const pathKey = profileRootComparisonKey(path);
    if (usedPaths.has(pathKey)) throw new ConfigError(`Provider '${providerId}'.accountSources.${reference} duplicates secret-file path used by '${usedPaths.get(pathKey)}'`);
    usedPaths.set(pathKey, `${providerId}.${reference}`);
    normalized.push([reference, { ...source, path }]);
  }
  return Object.fromEntries(normalized);
}

/** Validate command-provider environment overrides. */
function validateCommandEnvironment(providerId, environment) {
  if (!isPlainObject(environment)) throw new ConfigError(`Provider '${providerId}'.env must be an object`);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new ConfigError(`Provider '${providerId}'.env contains invalid variable name '${key}'`);
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new ConfigError(`Provider '${providerId}'.env.${key} must be a string, number, or boolean`);
    }
  }
}

/** Return a conservative cross-platform environment allowlist for Grok Build and its local tools. */
function defaultGrokEnvironmentAllowlist() {
  return [
    "HOME",
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ];
}

/** Return a ready-to-edit starter configuration. */
export function createExampleConfig() {
  return {
    server: {
      host: "127.0.0.1",
      port: 8743,
      authTokenEnv: "THREADSPAN_TOKEN",
      authTokenFile: null,
      connectorTokenEnv: "THREADSPAN_CONNECTOR_TOKEN",
      connectorTokenFile: null,
      allowUnauthenticatedLoopback: false,
      maxBodyBytes: 8388608,
      requestTimeoutMs: 1800000,
      maxConcurrentRequests: 4,
      allowedOrigins: [],
    },
    responses: { exposeReasoning: false },
    logging: { level: "info", logBodies: false },
    sessions: { ttlMs: 86400000, maxEntries: 500 },
    usageLedger: { enabled: true },
    accounts: { path: null, profileSources: {}, fallback: { enabled: false, maxCandidates: 1 } },
    continuity: structuredClone(DEFAULT_CONFIG.continuity),
    automaticTakeover: structuredClone(DEFAULT_CONFIG.automaticTakeover),
    copyNaturalizer: structuredClone(DEFAULT_CONFIG.copyNaturalizer),
    copyCheck: structuredClone(DEFAULT_CONFIG.copyCheck),
    maximumUtilization: {
      enabled: false,
      automaticPollingEnabled: false,
      pollIntervalMs: 60000,
      manualManifestMaxEntries: 32,
      triggerUsedRatio: 0.96,
      fastCanaryUsedRatio: 0.99,
      normalRolloverConsideration: 0.78,
      pressuredRolloverConsideration: 0.75,
      oneManifestPerEpoch: true,
      requireExactNativeQuotaRecovery: true,
    },
    compatibilityWatch: { enabled: false, readOnly: true, applyEnabled: false, pollingEnabled: false, pollIntervalMs: 900000 },
    branching: structuredClone(DEFAULT_CONFIG.branching),
    connectionRecovery: structuredClone(DEFAULT_CONFIG.connectionRecovery),
    selfHeal: structuredClone(DEFAULT_CONFIG.selfHeal),
    routing: {
      providerOrder: {
        consult: ["cursor", "cursor-ultra", "grok-build", "nous", "openrouter"],
        integrated: ["nous", "openrouter", "xai-api"],
        delegate: ["grok-build", "openai-codex", "cursor", "cursor-ultra", "nous-worker"],
      },
      providerProfiles: {
        "openai-codex": { label: "OpenAI Codex account worker", intelligence: 95, specialties: ["coding", "repository-work", "provider-native"], modeWeights: { delegate: 20 } },
      },
    },
    defaults: { provider: "cursor", mode: "consult", model: "auto" },
    providers: {
      cursor: {
        adapter: "cursor-cli",
        command: "cursor-agent",
        model: "auto",
        capabilities: ["consult", "delegate"],
        maxPromptChars: 24000,
        sandbox: "disabled",
        consult: {
          workspaceStrategy: "snapshot",
          agentMode: "plan",
          snapshotMaxBytes: 536870912,
          snapshotMaxFiles: 100000,
          copyInternalSymlinks: false,
          exclude: [".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "target", "coverage", ".cache"],
        },
        delegate: {
          requireGit: true,
          requireLinkedWorktree: true,
          requireCleanStart: true,
          denyBranches: ["main", "master", "trunk"],
          force: false,
        },
      },
      "cursor-ultra": {
        enabled: false,
        adapter: "cursor-sdk",
        apiKeyEnv: "CURSOR_API_KEY",
        model: "auto",
        capabilities: ["consult", "delegate"],
        consult: {
          workspaceStrategy: "snapshot",
          agentMode: "plan",
          snapshotMaxBytes: 536870912,
          snapshotMaxFiles: 100000,
          copyInternalSymlinks: false,
          exclude: [
            ".git",
            "node_modules",
            ".venv",
            "venv",
            "dist",
            "build",
            ".next",
            "target",
            "coverage",
            ".cache",
          ],
        },
        delegate: {
          agentMode: "agent",
          agentTtlMs: 1800000,
          maxAgents: 8,
          includeToolStatus: false,
        },
        local: { settingSources: [], sandboxEnabled: true, autoReview: false },
      },
      "grok-build": {
        enabled: false,
        adapter: "grok-build",
        command: "~/.grok/bin/grok",
        requireAbsoluteCommand: true,
        versionPattern: "^grok\\s",
        pin: { recordSha256: true },
        model: "grok-4.6",
        discoverModels: true,
        strictModelList: true,
        capabilities: ["consult", "delegate"],
        allowedEfforts: ["low", "medium", "high"],
        maxTurnsCeiling: 24,
        noAutoUpdate: true,
        allowSubagents: true,
        noMemory: true,
        allowWebSearch: true,
        inheritEnv: false,
        envAllowlist: defaultGrokEnvironmentAllowlist(),
        permissionMode: "dontAsk",
        sandbox: "strict",
        admission: {
          maxActive: 6,
          minStartIntervalMs: 1400,
          windowMs: 60000,
          maxUnitsPerWindow: 18,
          maxQueue: 100,
        },
        ledger: {
          enabled: true,
          required: false,
          includeOutput: false,
        },
        consult: {
          workspaceStrategy: "snapshot",
          profile: "diagnose",
          reasoningEffort: "medium",
          maxTurns: 8,
          expectedTurns: 2,
          noPlan: true,
          useJsonSchema: false,
          allow: [],
          deny: [],
          snapshotMaxBytes: 536870912,
          snapshotMaxFiles: 100000,
          copyInternalSymlinks: false,
          exclude: [".git", "node_modules", ".venv", "venv", "dist", "build", ".next", "target", "coverage", ".cache"],
        },
        delegate: {
          profile: "balanced",
          reasoningEffort: "medium",
          maxTurns: 16,
          expectedTurns: 4,
          noPlan: true,
          permissionMode: "bypassPermissions",
          requireGit: true,
          requireLinkedWorktree: true,
          requireCleanStart: true,
          denyBranches: ["main", "master", "trunk"],
          useJsonSchema: false,
          allow: [],
          deny: [],
        },
      },
      "agentrouter-claude": {
        enabled: false,
        adapter: "claude-code",
        officialUrl: "https://agentrouter.org",
        accountUrl: "https://agentrouter.org/console",
        usageUrl: "https://agentrouter.org/console/log",
        command: "claude",
        model: "claude-opus-4-8",
        models: ["claude-opus-4-8"],
        capabilities: ["consult", "delegate"],
        gateway: {
          baseUrl: "https://agentrouter.org",
          apiKeyEnv: "AGENTROUTER_API_KEY",
          model: "claude-opus-4-8",
          provider: "agentrouter",
        },
        maxTurnsCeiling: 24,
        consult: { workspaceStrategy: "snapshot", maxTurns: 4 },
        delegate: {
          maxTurns: 12,
          permissionMode: "acceptEdits",
          requireGit: true,
          requireLinkedWorktree: true,
          requireCleanStart: true,
          denyBranches: ["main", "master", "trunk"],
        },
      },
      "xai-api": {
        enabled: false,
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        apiKeyEnv: "XAI_API_KEY",
        model: "grok-4.6",
        models: ["grok-4.6"],
        extraBody: { reasoning_effort: "high" },
        retryWithoutStreaming: false,
        capabilities: ["consult", "integrated"],
      },
      nous: {
        adapter: "nous",
        enabled: false,
        baseUrl: "https://inference-api.nousresearch.com/v1",
        apiKeyEnv: "NOUS_API_KEY",
        model: "deepseek/deepseek-v4-flash-0731",
        discoverModels: true,
        retryWithoutStreaming: false,
        capabilities: ["consult", "integrated"],
      },
      "nous-worker": {
        enabled: false,
        adapter: "codex-worker",
        command: "codex",
        profile: "threadspan_integrated",
        modelProvider: "threadspan_bridge",
        model: "deepseek/deepseek-v4-flash-0731",
        integratedRoute: "integrated/nous/deepseek/deepseek-v4-flash-0731",
        capabilities: ["delegate"],
        sandbox: "workspace-write",
        approvalPolicy: "never",
        disableGoals: true,
        delegate: { requireCleanStart: true, denyBranches: ["main", "master", "trunk"] },
      },
      "openai-codex": {
        enabled: true,
        adapter: "codex-native-worker",
        command: "codex",
        model: "gpt-5.6-sol",
        models: ["gpt-5.6-sol"],
        capabilities: ["delegate"],
        delegate: { requireCleanStart: true, denyBranches: ["main", "master", "trunk"] },
      },
      openrouter: {
        enabled: false,
        adapter: "openrouter",
        officialUrl: "https://openrouter.ai",
        accountUrl: "https://openrouter.ai/settings/credits",
        usageUrl: "https://openrouter.ai/activity",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: "auto",
        discoverModels: true,
        retryWithoutStreaming: false,
        capabilities: ["consult", "integrated"],
        headers: { "HTTP-Referer": "https://github.com/HaileyStorm/threadspan", "X-Title": "Threadspan" },
      },
      deepseek: {
        enabled: false,
        adapter: "deepseek",
        baseUrl: "https://api.deepseek.com",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        model: "deepseek-v4-pro",
        models: ["deepseek-v4-pro", "deepseek-v4-flash"],
        thinking: { type: "enabled" },
        reasoningEffort: "high",
        capabilities: ["consult", "integrated"],
      },
    },
  };
}
