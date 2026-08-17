import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { ConfigError } from "./errors.mjs";

const DEFAULT_CONFIG = Object.freeze({
  server: {
    host: "127.0.0.1",
    port: 8743,
    authTokenEnv: "CURSOR_BRIDGE_TOKEN",
    allowUnauthenticatedLoopback: true,
    maxBodyBytes: 8 * 1024 * 1024,
    requestTimeoutMs: 30 * 60 * 1000,
    maxConcurrentRequests: 4,
    allowedOrigins: [],
  },
  responses: { exposeReasoning: false },
  logging: { level: "info", logBodies: false },
  sessions: { ttlMs: 24 * 60 * 60 * 1000, maxEntries: 500 },
  defaults: { provider: "cursor-ultra", mode: "consult", model: "auto" },
  providers: {},
});

const VALID_MODES = new Set(["consult", "integrated", "delegate"]);
const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

/** Resolve the bridge config path from an explicit value, environment, or user home. */
export function resolveConfigPath(explicitPath) {
  return resolve(explicitPath ?? process.env.CURSOR_BRIDGE_CONFIG ?? `${homedir()}/.cursor-codex-bridge/config.jsonc`);
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

/**
 * Load, expand, merge, and validate bridge configuration.
 * @param {string} [explicitPath]
 * @param {{allowMissing?: boolean, environment?: NodeJS.ProcessEnv}} [options]
 */
export function loadConfig(explicitPath, options = {}) {
  const path = resolveConfigPath(explicitPath);
  if (!existsSync(path)) {
    if (options.allowMissing) return validateConfig(structuredClone(DEFAULT_CONFIG), path);
    throw new ConfigError(`Configuration file not found: ${path}`);
  }

  let parsed;
  try {
    parsed = parseJsonc(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not parse configuration file: ${path}`, { cause: error instanceof Error ? error.message : error });
  }
  const expanded = expandEnvironment(parsed, options.environment ?? process.env);
  return validateConfig(deepMerge(structuredClone(DEFAULT_CONFIG), expanded), path);
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
export function validateConfig(config, configPath = "<memory>") {
  if (!isPlainObject(config)) throw new ConfigError("Configuration root must be an object");
  if (!isPlainObject(config.server)) throw new ConfigError("server must be an object");
  if (typeof config.server.host !== "string" || config.server.host.length === 0) throw new ConfigError("server.host must be a non-empty string");
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65535) throw new ConfigError("server.port must be an integer from 1 to 65535");
  assertInteger(config.server.maxBodyBytes, "server.maxBodyBytes", { minimum: 1024 });
  assertInteger(config.server.requestTimeoutMs, "server.requestTimeoutMs", { minimum: 1 });
  assertInteger(config.server.maxConcurrentRequests, "server.maxConcurrentRequests", { minimum: 1 });
  assertOptionalString(config.server.authTokenEnv, "server.authTokenEnv");
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

  if (!isPlainObject(config.providers)) throw new ConfigError("providers must be an object");
  if (!isPlainObject(config.defaults)) throw new ConfigError("defaults must be an object");
  assertOptionalString(config.defaults.provider, "defaults.provider");
  assertOptionalString(config.defaults.model, "defaults.model");
  if (!VALID_MODES.has(config.defaults.mode)) {
    throw new ConfigError(`defaults.mode must be one of ${[...VALID_MODES].join(", ")}`);
  }

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
    if (provider.capabilities !== undefined) {
      assertStringArray(provider.capabilities, `Provider '${providerId}'.capabilities`, { unique: true });
      for (const capability of provider.capabilities) {
        if (!VALID_MODES.has(capability)) {
          throw new ConfigError(`Provider '${providerId}'.capabilities contains unsupported mode '${capability}'`);
        }
      }
    }
    if (provider.models !== undefined) validateProviderModels(providerId, provider.models);
    for (const key of ["timeoutMs", "maxOutputBytes", "maxStderrBytes", "terminationGraceMs", "discoveryTimeoutMs", "modelCacheTtlMs", "maxPromptChars", "versionTimeoutMs", "maxTurnsCeiling"]) {
      if (provider[key] !== undefined) assertInteger(provider[key], `Provider '${providerId}'.${key}`, { minimum: 1 });
    }
    validateProviderCommonOptions(providerId, provider);
    if (provider.adapter === "command" && provider.enabled !== false) validateCommandProvider(providerId, provider);
    if (provider.adapter === "grok-build" && provider.enabled !== false) validateGrokBuildProvider(providerId, provider);
    if (["openai-chat", "deepseek", "nous"].includes(provider.adapter) && provider.enabled !== false) {
      if (provider.adapter === "openai-chat" && (typeof provider.baseUrl !== "string" || provider.baseUrl.length === 0)) {
        throw new ConfigError(`Provider '${providerId}' using adapter 'openai-chat' requires baseUrl`);
      }
      if (provider.baseUrl !== undefined) validateHttpUrl(provider.baseUrl, `Provider '${providerId}'.baseUrl`);
      validateOpenAiCompatibleOptions(providerId, provider);
    }
    validateCursorStyleOptions(providerId, provider);
  }

  if (config.defaults.provider) {
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
      authTokenEnv: "CURSOR_BRIDGE_TOKEN",
      allowUnauthenticatedLoopback: true,
      maxBodyBytes: 8388608,
      requestTimeoutMs: 1800000,
      maxConcurrentRequests: 4,
      allowedOrigins: [],
    },
    responses: { exposeReasoning: false },
    logging: { level: "info", logBodies: false },
    sessions: { ttlMs: 86400000, maxEntries: 500 },
    defaults: { provider: "cursor-ultra", mode: "consult", model: "auto" },
    providers: {
      "cursor-ultra": {
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
          requireGit: true,
          requireLinkedWorktree: true,
          requireCleanStart: true,
          denyBranches: ["main", "master", "trunk"],
          useJsonSchema: false,
          allow: [],
          deny: [],
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
        baseUrl: "http://127.0.0.1:8645/v1",
        apiKey: "unused-proxy-attaches-real-creds",
        model: "Hermes-4-70B",
        models: ["Hermes-4-70B", "Hermes-4.3-36B", "Hermes-4-405B"],
        capabilities: ["consult", "integrated"],
      },
      deepseek: {
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
