/**
 * Provider-neutral external copy-check connector.
 *
 * This is a separate policy from Copy review / Copy Naturalizer. Results are
 * advisory, never averaged into a verdict, never treated as proof of authorship,
 * and never used to accept or reject a rewrite. Network, clipboard, and browser
 * effects stay at zero until an explicit user-started manual or release action.
 */

export const COPY_CHECK_VERSION = "threadspan-copy-check/v1";

/** Required visible qualification for every external adapter result. */
export const COPY_CHECK_DISCLAIMER = "External detector results are advisory and non-probative. They cannot prove authorship and never decide rewrite acceptance.";

export const COPY_CHECK_NO_PARTNERSHIP = "Threadspan has no partnership with, sponsorship from, or endorsement by these vendors. Documented endpoints and trial language can drift.";

export const COPY_CHECK_PERMISSION_MODES = Object.freeze(["off", "ask-every-time", "allow-manual-or-release"]);

/** The only triggers that may start an external check. */
export const COPY_CHECK_TRIGGERS = Object.freeze(["manual", "release"]);

const FORBIDDEN_TRIGGERS = Object.freeze([
  "typing",
  "startup",
  "focus",
  "timer",
  "poll",
  "background",
  "hover",
  "idle",
  "automatic",
  "interval",
]);

const HARD_MAX_INPUT_CHARS = 50_000;
const HARD_MAX_DISPLAY_CHARS = 240;
const HARD_MAX_RESULTS = 8;

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

/**
 * Documented adapter catalog. Runnable adapters are pangram (manual handoff),
 * sapling, and winston. GPTZero and Copyleaks are documented as later/conditional
 * only and are never advertised as working free APIs.
 */
export const COPY_CHECK_ADAPTERS = deepFreeze({
  pangram: {
    id: "pangram",
    label: "Pangram",
    kind: "manual-handoff",
    runnable: true,
    officialUrl: "https://www.pangram.com/",
    destination: "Official Pangram checker page only (clipboard + browser handoff)",
    payload: "Selected plain text copied locally; Threadspan never submits, scrapes, or reads the page",
    retention: "Whatever Pangram's own page and account policy do after the user pastes. Threadspan does not send the text.",
    trial: "Pangram free-scan limits can change; they are not a Threadspan entitlement.",
    partnership: false,
    defaultNetworkEffect: false,
    automatesPage: false,
  },
  sapling: {
    id: "sapling",
    label: "Sapling",
    kind: "api",
    runnable: true,
    destination: "https://api.sapling.ai/api/v1/aidetect",
    method: "POST",
    payload: "JSON { text } plus the environment-only API key. Character limit follows copyCheck.maxInputChars (Sapling documents 200,000).",
    retention: "Sapling stores submitted text and uses it to improve its service. An explicit acknowledgement is required before any submit.",
    trial: "Developer keys are rate-limited (Sapling documents 50,000 characters / 24 hours for developer keys). That is not a permanent free API.",
    partnership: false,
    apiKeyEnvDefault: "SAPLING_API_KEY",
    requiresRetentionAcknowledgement: true,
    scoreMeaning: "0 = more human-like, 1 = more AI-like",
  },
  winston: {
    id: "winston",
    label: "Winston AI",
    kind: "api",
    runnable: true,
    destination: "https://api.gowinston.ai/v1/ai-content-detection",
    method: "POST",
    payload: "JSON { text } with a Bearer token from the environment-only key. Winston documents 300–150,000 characters; texts under 300 are skipped.",
    retention: "Submitted text is sent to Winston AI for scoring. Treat their published privacy/retention policy as authoritative and changeable.",
    trial: "Winston documents a limited 2,000-credit developer trial with no card required. Availability can change; it is not permanently free.",
    partnership: false,
    apiKeyEnvDefault: "WINSTON_API_KEY",
    minInputChars: 300,
    scoreMeaning: "Winston human score 0–100 (low = more AI-like). Normalized AI-likelihood is (100 - humanScore) / 100.",
  },
  gptzero: {
    id: "gptzero",
    label: "GPTZero",
    kind: "unsupported-later",
    runnable: false,
    advertisedAsWorkingFreeApi: false,
    reason: "GPTZero is documented as conditional/later only. Threadspan does not advertise or ship a working free GPTZero API.",
    partnership: false,
  },
  copyleaks: {
    id: "copyleaks",
    label: "Copyleaks",
    kind: "unsupported-later",
    runnable: false,
    advertisedAsWorkingFreeApi: false,
    sandboxNumbersNeverReal: true,
    reason: "Copyleaks is documented as conditional/later only. Sandbox or sample numbers must never appear as real results.",
    partnership: false,
  },
});

/** Conservative defaults: permission off, no adapter enabled, credentials do not activate anything. */
export const DEFAULT_COPY_CHECK_OPTIONS = deepFreeze({
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
});

/**
 * Resolve and validate the public copy-check policy without reading secret values.
 * Presence of environment keys never enables the feature.
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function resolveCopyCheckPolicy(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("Copy-check options must be an object");
  const permissionMode = options.permissionMode ?? DEFAULT_COPY_CHECK_OPTIONS.permissionMode;
  if (!COPY_CHECK_PERMISSION_MODES.includes(permissionMode)) {
    throw new TypeError("copyCheck.permissionMode must be off, ask-every-time, or allow-manual-or-release");
  }
  const adapters = normalizeAdapterConfig(options.adapters);
  const releaseScope = normalizeReleaseScope(options.releaseScope);
  const signal = options.signal;
  if (signal !== undefined && (typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return {
    version: COPY_CHECK_VERSION,
    permissionMode,
    maxInputChars: boundedInteger(options.maxInputChars, DEFAULT_COPY_CHECK_OPTIONS.maxInputChars, 1, HARD_MAX_INPUT_CHARS, "maxInputChars"),
    timeoutMs: boundedInteger(options.timeoutMs, DEFAULT_COPY_CHECK_OPTIONS.timeoutMs, 250, 120_000, "timeoutMs"),
    releaseScope,
    adapters,
    signal,
    environment: options.environment,
    fetch: options.fetch,
    openUrl: options.openUrl,
    writeClipboard: options.writeClipboard,
    now: options.now,
  };
}

/**
 * Public policy description with destinations, payload size, retention, trial, and no-partnership copy.
 * Never includes keys, source text, or raw provider bodies.
 * @param {Record<string, any>} [options]
 * @returns {Record<string, any>}
 */
export function describeCopyCheck(options = {}) {
  const policy = resolveCopyCheckPolicy(options);
  const records = Array.isArray(options.records) ? options.records.map((item) => sanitizeCopyCheckRecord(item)).filter(Boolean) : [];
  return {
    version: COPY_CHECK_VERSION,
    permissionMode: policy.permissionMode,
    enabled: policy.permissionMode !== "off",
    maxInputChars: policy.maxInputChars,
    timeoutMs: policy.timeoutMs,
    releaseScope: structuredClone(policy.releaseScope),
    disclaimer: COPY_CHECK_DISCLAIMER,
    partnership: false,
    partnershipNote: COPY_CHECK_NO_PARTNERSHIP,
    credentialsEnableFeature: false,
    automaticRuns: false,
    allowedTriggers: [...COPY_CHECK_TRIGGERS],
    adapters: Object.fromEntries(Object.values(COPY_CHECK_ADAPTERS).map((catalog) => {
      const configured = policy.adapters[catalog.id];
      return [catalog.id, {
        id: catalog.id,
        label: catalog.label,
        kind: catalog.kind,
        runnable: catalog.runnable === true && configured?.enabled === true,
        configured: configured?.enabled === true,
        destination: catalog.destination ?? null,
        payload: catalog.payload ?? null,
        retention: catalog.retention ?? null,
        trial: catalog.trial ?? null,
        partnership: false,
        advertisedAsWorkingFreeApi: catalog.advertisedAsWorkingFreeApi === true,
        requiresRetentionAcknowledgement: catalog.requiresRetentionAcknowledgement === true,
        acknowledgedRetention: configured?.acknowledgedRetention === true,
        apiKeyEnv: configured?.apiKeyEnv ?? catalog.apiKeyEnvDefault ?? null,
        officialUrl: catalog.officialUrl ?? null,
        reason: catalog.reason ?? null,
        sandboxNumbersNeverReal: catalog.sandboxNumbersNeverReal === true,
      }];
    })),
    lastResults: records.slice(-HARD_MAX_RESULTS),
  };
}

/**
 * Reduce a result to the only fields that may be stored or reported.
 * @param {unknown} value
 * @returns {{adapter: string, status: string, score: number | null, checkedAt: string, displayText: string} | null}
 */
export function sanitizeCopyCheckRecord(value) {
  if (!isPlainObject(value)) return null;
  const adapter = typeof value.adapter === "string" && ADAPTER_ID_PATTERN.test(value.adapter) ? value.adapter : null;
  if (!adapter) return null;
  const status = normalizeStatus(value.status);
  if (!status) return null;
  const score = normalizeScore(value.score);
  if (adapter === "copyleaks" && (score !== null || ["ok", "recorded", "handoff"].includes(status))) return null;
  const checkedAt = typeof value.checkedAt === "string" && isIsoTimestamp(value.checkedAt) ? value.checkedAt : null;
  if (!checkedAt) return null;
  const displayText = sanitizeDisplayText(value.displayText);
  if (!displayText) return null;
  if (mentionsCopyleaksSandbox(displayText, adapter) && (score !== null || ["ok", "recorded"].includes(status))) return null;
  return { adapter, status, score, checkedAt, displayText };
}

/**
 * Run enabled adapters for one explicit user-started manual or release check.
 * @param {string} value Plain text. Never persisted by this function.
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function checkCopy(value, options = {}) {
  const policy = resolveCopyCheckPolicy(options);
  const trigger = normalizeTrigger(options.trigger);
  const action = options.action ?? "check";
  if (!["check", "pangram-handoff", "pangram-record"].includes(action)) {
    throw new TypeError("action must be check, pangram-handoff, or pangram-record");
  }
  if (policy.permissionMode === "off") {
    return emptyCheckResult(policy, trigger, action, "disabled", "External copy check is off. Permission mode stays off until an explicit user setting enables it.");
  }
  if (trigger === "release" && policy.releaseScope.externalChecks !== true) {
    return emptyCheckResult(policy, trigger, action, "skipped", "Saved release scope does not permit external checks.");
  }
  if (policy.permissionMode === "ask-every-time" && options.confirmed !== true) {
    return emptyCheckResult(policy, trigger, action, "skipped", "Permission mode is ask-every-time; this check needs an explicit confirmation.");
  }

  const requested = normalizeRequestedAdapters(options.requestedAdapters, policy, trigger, action);
  const checkedAt = isoNow(policy.now);
  const results = [];

  if (action === "pangram-record") {
    if (policy.adapters.pangram.enabled !== true) {
      results.push(makeRecord("pangram", "skipped", null, checkedAt, "Pangram is not enabled. Credentials or a pasted value do not enable it."));
    } else {
      results.push(recordPangramResult(options.pangramResult ?? options.displayText ?? options.result, { checkedAt, adapter: "pangram" }));
    }
    return finalizeCheck(policy, trigger, action, results);
  }

  let text;
  try {
    text = action === "pangram-handoff" || requested.includes("pangram") || requested.some((id) => COPY_CHECK_ADAPTERS[id]?.kind === "api")
      ? validatePlainText(value, policy.maxInputChars)
      : "";
  } catch (error) {
    return emptyCheckResult(policy, trigger, action, "error", error instanceof Error ? error.message : String(error));
  }

  for (const id of requested) {
    const catalog = COPY_CHECK_ADAPTERS[id];
    if (!catalog || catalog.runnable !== true) {
      results.push(makeRecord(id, "unsupported", null, checkedAt, catalog?.reason ?? "This adapter is not a working Threadspan integration."));
      continue;
    }
    if (id === "pangram") {
      if (policy.adapters.pangram.enabled !== true) {
        results.push(makeRecord("pangram", "skipped", null, checkedAt, "Pangram is not enabled. A button click still requires the adapter to be turned on."));
      } else if (action === "pangram-handoff" || action === "check") {
        results.push(await startPangramHandoff(text, { ...policy, checkedAt }));
      }
      continue;
    }
    if (action === "pangram-handoff") continue;
    results.push(await runApiAdapter(id, text, policy, checkedAt, options));
  }

  return finalizeCheck(policy, trigger, action, results);
}

/**
 * Copy selected text and open the official Pangram checker. Never submits or scrapes the page.
 * @param {string} value
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function startPangramHandoff(value, options = {}) {
  const policy = options.permissionMode ? options : resolveCopyCheckPolicy(options);
  const checkedAt = options.checkedAt ?? isoNow(policy.now);
  const text = typeof value === "string" ? value : "";
  if (text.length > (policy.maxInputChars ?? DEFAULT_COPY_CHECK_OPTIONS.maxInputChars)) {
    return makeRecord("pangram", "error", null, checkedAt, `Pangram handoff exceeds the ${policy.maxInputChars}-character payload limit.`);
  }
  let copied = false;
  let opened = false;
  if (typeof policy.openUrl === "function") {
    await policy.openUrl(COPY_CHECK_ADAPTERS.pangram.officialUrl);
    opened = true;
  }
  if (typeof policy.writeClipboard === "function") {
    await policy.writeClipboard(text);
    copied = true;
  }
  const display = copied || opened
    ? "Pangram manual handoff started: selected text was copied and/or the official checker was opened. Paste a short result back. Threadspan does not submit or read the page."
    : "Pangram is a manual handoff. Copy the selected text, open the official checker, then paste a short result back. Threadspan does not submit or read the page.";
  return makeRecord("pangram", "handoff", null, checkedAt, display);
}

/**
 * Accept a user-pasted Pangram result. Never treats Copyleaks sandbox numbers as real.
 * @param {unknown} value
 * @param {{checkedAt?: string, adapter?: string}} [options]
 * @returns {Record<string, any>}
 */
export function recordPangramResult(value, options = {}) {
  const checkedAt = options.checkedAt ?? isoNow();
  const adapter = options.adapter ?? "pangram";
  if (adapter !== "pangram") {
    return makeRecord(adapter, "unsupported", null, checkedAt, "Only a Pangram handoff result can be recorded this way.");
  }
  const parsed = parseUserPastedResult(value);
  if (parsed.status === "error") {
    return makeRecord("pangram", "error", null, checkedAt, parsed.displayText);
  }
  return makeRecord("pangram", "recorded", parsed.score, checkedAt, parsed.displayText);
}

function normalizeAdapterConfig(value) {
  const source = value === undefined ? {} : value;
  if (!isPlainObject(source)) throw new TypeError("copyCheck.adapters must be an object");
  const unknown = Object.keys(source).filter((key) => !["pangram", "sapling", "winston"].includes(key));
  if (unknown.length > 0) throw new TypeError(`copyCheck.adapters contains unsupported fields: ${unknown.join(", ")}`);
  return {
    pangram: normalizePangramConfig(source.pangram),
    sapling: normalizeSaplingConfig(source.sapling),
    winston: normalizeWinstonConfig(source.winston),
  };
}

function normalizePangramConfig(value) {
  const source = value ?? DEFAULT_COPY_CHECK_OPTIONS.adapters.pangram;
  if (!isPlainObject(source)) throw new TypeError("copyCheck.adapters.pangram must be an object");
  const unknown = Object.keys(source).filter((key) => key !== "enabled");
  if (unknown.length > 0) throw new TypeError(`copyCheck.adapters.pangram contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof source.enabled !== "boolean") throw new TypeError("copyCheck.adapters.pangram.enabled must be a boolean");
  return { enabled: source.enabled };
}

function normalizeSaplingConfig(value) {
  const source = value ?? DEFAULT_COPY_CHECK_OPTIONS.adapters.sapling;
  if (!isPlainObject(source)) throw new TypeError("copyCheck.adapters.sapling must be an object");
  const unknown = Object.keys(source).filter((key) => !["enabled", "apiKeyEnv", "acknowledgedRetention"].includes(key));
  if (unknown.length > 0) throw new TypeError(`copyCheck.adapters.sapling contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof source.enabled !== "boolean") throw new TypeError("copyCheck.adapters.sapling.enabled must be a boolean");
  if (typeof source.acknowledgedRetention !== "boolean") throw new TypeError("copyCheck.adapters.sapling.acknowledgedRetention must be a boolean");
  const apiKeyEnv = source.apiKeyEnv ?? DEFAULT_COPY_CHECK_OPTIONS.adapters.sapling.apiKeyEnv;
  if (typeof apiKeyEnv !== "string" || !ENV_NAME_PATTERN.test(apiKeyEnv)) throw new TypeError("copyCheck.adapters.sapling.apiKeyEnv must be an environment variable name");
  return { enabled: source.enabled, apiKeyEnv, acknowledgedRetention: source.acknowledgedRetention };
}

function normalizeWinstonConfig(value) {
  const source = value ?? DEFAULT_COPY_CHECK_OPTIONS.adapters.winston;
  if (!isPlainObject(source)) throw new TypeError("copyCheck.adapters.winston must be an object");
  const unknown = Object.keys(source).filter((key) => !["enabled", "apiKeyEnv"].includes(key));
  if (unknown.length > 0) throw new TypeError(`copyCheck.adapters.winston contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof source.enabled !== "boolean") throw new TypeError("copyCheck.adapters.winston.enabled must be a boolean");
  const apiKeyEnv = source.apiKeyEnv ?? DEFAULT_COPY_CHECK_OPTIONS.adapters.winston.apiKeyEnv;
  if (typeof apiKeyEnv !== "string" || !ENV_NAME_PATTERN.test(apiKeyEnv)) throw new TypeError("copyCheck.adapters.winston.apiKeyEnv must be an environment variable name");
  return { enabled: source.enabled, apiKeyEnv };
}

function normalizeReleaseScope(value) {
  const source = value ?? DEFAULT_COPY_CHECK_OPTIONS.releaseScope;
  if (!isPlainObject(source)) throw new TypeError("copyCheck.releaseScope must be an object");
  const unknown = Object.keys(source).filter((key) => !["localReview", "externalChecks", "adapters"].includes(key));
  if (unknown.length > 0) throw new TypeError(`copyCheck.releaseScope contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof source.localReview !== "boolean") throw new TypeError("copyCheck.releaseScope.localReview must be a boolean");
  if (typeof source.externalChecks !== "boolean") throw new TypeError("copyCheck.releaseScope.externalChecks must be a boolean");
  if (!Array.isArray(source.adapters) || source.adapters.some((item) => typeof item !== "string" || !ADAPTER_ID_PATTERN.test(item))) {
    throw new TypeError("copyCheck.releaseScope.adapters must be an array of adapter ids");
  }
  if (source.adapters.some((item) => !COPY_CHECK_ADAPTERS[item])) {
    throw new TypeError("copyCheck.releaseScope.adapters contains an unknown adapter");
  }
  return {
    localReview: source.localReview,
    externalChecks: source.externalChecks,
    adapters: [...new Set(source.adapters)],
  };
}

function normalizeTrigger(value) {
  if (FORBIDDEN_TRIGGERS.includes(value)) {
    throw new TypeError("External copy checks cannot run from typing, startup, focus, timer, poll, or background activity");
  }
  if (!COPY_CHECK_TRIGGERS.includes(value)) {
    throw new TypeError("trigger must be manual or release");
  }
  return value;
}

function normalizeRequestedAdapters(requested, policy, trigger, action) {
  if (action === "pangram-handoff" || action === "pangram-record") return ["pangram"];
  const configuredEnabled = Object.keys(policy.adapters).filter((id) => policy.adapters[id].enabled === true);
  const allowed = trigger === "release"
    ? policy.releaseScope.adapters.filter((id) => configuredEnabled.includes(id) || COPY_CHECK_ADAPTERS[id]?.runnable !== true)
    : configuredEnabled;
  if (requested === undefined) return allowed;
  const selected = Array.isArray(requested) ? requested : [requested];
  if (selected.some((id) => typeof id !== "string")) throw new TypeError("requestedAdapters must be adapter ids");
  const unique = [...new Set(selected)];
  if (unique.length > HARD_MAX_RESULTS) throw new TypeError(`at most ${HARD_MAX_RESULTS} adapters can run`);
  if (trigger === "release") {
    const scoped = new Set(policy.releaseScope.adapters);
    return unique.filter((id) => scoped.has(id));
  }
  return unique;
}

async function runApiAdapter(id, text, policy, checkedAt, request) {
  const catalog = COPY_CHECK_ADAPTERS[id];
  const configured = policy.adapters[id];
  if (!configured?.enabled) {
    return makeRecord(id, "skipped", null, checkedAt, `${catalog.label} is not enabled. Credentials existing do not enable it.`);
  }
  if (id === "sapling") {
    const acknowledged = configured.acknowledgedRetention === true || request.acknowledgeRetention === true;
    if (!acknowledged) {
      return makeRecord(id, "skipped", null, checkedAt, "Sapling requires an explicit acknowledgement that submitted text is stored and used to improve its service.");
    }
  }
  if (id === "winston" && text.length < COPY_CHECK_ADAPTERS.winston.minInputChars) {
    return makeRecord(id, "skipped", null, checkedAt, `Winston skips texts shorter than ${COPY_CHECK_ADAPTERS.winston.minInputChars} characters. Trial access is limited and expiring, not permanently free.`);
  }
  const environment = policy.environment ?? {};
  const apiKey = typeof environment[configured.apiKeyEnv] === "string" ? environment[configured.apiKeyEnv] : "";
  if (!apiKey) {
    return makeRecord(id, "skipped", null, checkedAt, `${catalog.label} key is not set in ${configured.apiKeyEnv}. Existing empty names do not enable a check.`);
  }
  const fetchImpl = policy.fetch;
  if (typeof fetchImpl !== "function") {
    return makeRecord(id, "skipped", null, checkedAt, `${catalog.label} was not given an injected fetch. Default network effect stays zero.`);
  }
  try {
    if (id === "sapling") return await runSapling(text, apiKey, fetchImpl, policy, checkedAt);
    if (id === "winston") return await runWinston(text, apiKey, fetchImpl, policy, checkedAt);
    return makeRecord(id, "unsupported", null, checkedAt, catalog.reason ?? "Unsupported adapter.");
  } catch (error) {
    if (policy.signal?.aborted) throw abortReason(policy.signal);
    const status = error?.name === "TimeoutError" || error?.code === "timeout" || /timeout/i.test(error instanceof Error ? error.message : "")
      ? "timeout"
      : "error";
    return makeRecord(id, status, null, checkedAt, `${catalog.label} ${status === "timeout" ? "timed out" : "failed"}. External failure cannot fail a release.`);
  }
}

async function runSapling(text, apiKey, fetchImpl, policy, checkedAt) {
  const payload = await postJson(fetchImpl, COPY_CHECK_ADAPTERS.sapling.destination, {
    body: { key: apiKey, text, sent_scores: false, score_string: false },
    timeoutMs: policy.timeoutMs,
    signal: policy.signal,
  });
  if (!payload.ok) return makeRecord("sapling", "error", null, checkedAt, "Sapling returned an error. External failure cannot fail a release.");
  const score = normalizeScore(payload.json?.score);
  if (score === null) return makeRecord("sapling", "error", null, checkedAt, "Sapling returned no usable score. Raw provider bodies are discarded.");
  return makeRecord("sapling", "ok", score, checkedAt, `Sapling advisory AI-likelihood ${formatScore(score)}. Advisory only; cannot prove authorship.`);
}

async function runWinston(text, apiKey, fetchImpl, policy, checkedAt) {
  const payload = await postJson(fetchImpl, COPY_CHECK_ADAPTERS.winston.destination, {
    headers: { authorization: `Bearer ${apiKey}` },
    body: { text, sentences: false },
    timeoutMs: policy.timeoutMs,
    signal: policy.signal,
  });
  if (!payload.ok) return makeRecord("winston", "error", null, checkedAt, "Winston returned an error. Trial access is limited and expiring, not permanently free.");
  const human = normalizeHumanScore(payload.json?.score);
  if (human === null) return makeRecord("winston", "error", null, checkedAt, "Winston returned no usable score. Raw provider bodies are discarded.");
  const score = Number(((100 - human) / 100).toFixed(4));
  return makeRecord("winston", "ok", score, checkedAt, `Winston advisory human score ${human}/100 (AI-likelihood ${formatScore(score)}). Trial is limited and expiring, not permanently free.`);
}

async function postJson(fetchImpl, url, options) {
  if (options.signal?.aborted) throw abortReason(options.signal);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("timeout");
    error.code = "timeout";
    error.name = "TimeoutError";
    controller.abort(error);
  }, options.timeoutMs);
  const onAbort = () => controller.abort(options.signal.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.headers ?? {}) },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { ok: response.ok === true, json };
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      const timeout = new Error("timeout");
      timeout.code = "timeout";
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function parseUserPastedResult(value) {
  if (value === undefined || value === null) {
    return { status: "error", score: null, displayText: "No Pangram result was pasted." };
  }
  if (isPlainObject(value) && mentionsCopyleaksSandbox(String(value.displayText ?? value.result ?? ""), value.adapter)) {
    return { status: "error", score: null, displayText: "Copyleaks sandbox numbers cannot be recorded as real results." };
  }
  const raw = typeof value === "string" ? value : isPlainObject(value) ? String(value.displayText ?? value.result ?? value.score ?? "") : String(value);
  if (mentionsCopyleaksSandbox(raw, typeof value === "object" && value ? value.adapter : undefined)) {
    return { status: "error", score: null, displayText: "Copyleaks sandbox numbers cannot be recorded as real results." };
  }
  const cleaned = sanitizeDisplayText(raw);
  if (!cleaned) return { status: "error", score: null, displayText: "Pasted Pangram result was empty or not safe to store." };
  const percent = cleaned.match(/(?<!\d)(\d{1,3}(?:\.\d+)?)[ ]?%/u);
  if (percent) {
    const percentage = Number(percent[1]);
    if (percentage >= 0 && percentage <= 100) {
      const humanLabel = /\b(?:human(?:-written)?|real)\b/iu.test(cleaned);
      const aiLabel = /\b(?:ai|machine|synthetic)\b/iu.test(cleaned);
      const score = humanLabel && !aiLabel
        ? Number(((100 - percentage) / 100).toFixed(4))
        : aiLabel && !humanLabel
          ? Number((percentage / 100).toFixed(4))
          : null;
      if (score === null) {
        return { status: "recorded", score: null, displayText: "Pangram recorded an unlabeled percentage. Advisory only; no AI-likelihood was inferred." };
      }
      return { status: "recorded", score, displayText: `Pangram recorded ${formatScore(score)} from pasted result. Advisory only; cannot prove authorship.` };
    }
  }
  const decimal = cleaned.match(/(?<!\d)(0(?:\.\d+)?|1(?:\.0+)?)(?!\d)/u);
  if (decimal && /ai|human|score|likelihood/i.test(cleaned)) {
    const rawScore = Number(decimal[1]);
    const humanLabel = /\b(?:human(?:-written)?|real)\b/iu.test(cleaned);
    const aiLabel = /\b(?:ai|machine|synthetic)\b/iu.test(cleaned);
    const score = humanLabel && !aiLabel ? Number((1 - rawScore).toFixed(4)) : aiLabel && !humanLabel ? Number(rawScore.toFixed(4)) : null;
    if (score === null) return { status: "recorded", score: null, displayText: "Pangram recorded an unlabeled decimal score. Advisory only; no AI-likelihood was inferred." };
    return { status: "recorded", score, displayText: `Pangram recorded ${formatScore(score)} from pasted result. Advisory only; cannot prove authorship.` };
  }
  return { status: "recorded", score: null, displayText: `Pangram recorded: ${cleaned}. Advisory only; cannot prove authorship.` };
}

function mentionsCopyleaksSandbox(text, adapter) {
  if (adapter === "copyleaks") return true;
  return /copyleaks/i.test(String(text ?? "")) && /sandbox/i.test(String(text ?? ""));
}

function emptyCheckResult(policy, trigger, action, status, displayText) {
  return finalizeCheck(policy, trigger, action, [
    makeRecord("copy-check", status, null, isoNow(policy.now), displayText),
  ]);
}

function finalizeCheck(policy, trigger, action, results) {
  const sanitized = results.map((item) => sanitizeCopyCheckRecord(item)).filter(Boolean);
  return {
    version: COPY_CHECK_VERSION,
    trigger,
    action,
    permissionMode: policy.permissionMode,
    advisoryOnly: true,
    averaged: false,
    provesAuthorship: false,
    controlsRewrite: false,
    failsRelease: false,
    disclaimer: COPY_CHECK_DISCLAIMER,
    partnership: false,
    results: sanitized,
  };
}

function makeRecord(adapter, status, score, checkedAt, displayText) {
  return sanitizeCopyCheckRecord({
    adapter,
    status,
    score,
    checkedAt,
    displayText,
  }) ?? {
    adapter: ADAPTER_ID_PATTERN.test(adapter) ? adapter : "copy-check",
    status: normalizeStatus(status) ?? "error",
    score: null,
    checkedAt: isIsoTimestamp(checkedAt) ? checkedAt : new Date().toISOString(),
    displayText: sanitizeDisplayText(displayText) || "External check produced no safe display text.",
  };
}

function normalizeStatus(value) {
  return ["ok", "skipped", "timeout", "error", "handoff", "recorded", "unsupported", "disabled"].includes(value) ? value : null;
}

function normalizeScore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Number(value.toFixed(4));
}

function normalizeHumanScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Number(value.toFixed(2));
}

function formatScore(score) {
  return score.toFixed(2);
}

function sanitizeDisplayText(value) {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (!compact || compact.length > HARD_MAX_DISPLAY_CHARS) return compact ? compact.slice(0, HARD_MAX_DISPLAY_CHARS) : null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(compact)) return null;
  if (/https?:\/\//i.test(compact) || /[?&](?:key|token|auth|api[_-]?key)=/i.test(compact)) return null;
  return compact;
}

function validatePlainText(value, maximum) {
  if (typeof value !== "string") throw new TypeError("Copy must be plain text");
  if (value.length > maximum) throw new RangeError(`Copy exceeds the ${maximum}-character payload limit`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError("Copy contains unsupported control characters");
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
}

function isoNow(now) {
  if (typeof now === "string" && isIsoTimestamp(now)) return now;
  if (typeof now === "number" && Number.isFinite(now)) return new Date(now).toISOString();
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  return new Date().toISOString();
}

function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The copy-check operation was aborted");
  error.name = "AbortError";
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
