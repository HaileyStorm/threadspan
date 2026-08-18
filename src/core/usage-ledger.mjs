import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const USAGE_LEDGER_SCHEMA_VERSION = 2;
export const LEGACY_USAGE_ACCOUNT_ID = "unknown/default";

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_RECENT_LIMIT = 100;
const DEFAULT_FORECAST_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_ENTITLEMENT_FRESHNESS_MS = 15 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const MAX_DIMENSION_LENGTH = 160;

/** Portable, privacy-minimized JSONL usage ledger with bounded reads and retention. */
export class UsageLedger {
  /**
   * @param {{
   *   path?: string,
   *   enabled?: boolean,
   *   maxFileBytes?: number,
   *   maxEvents?: number,
   *   maxReadBytes?: number,
   *   maxLineBytes?: number,
 *   recentLimit?: number,
 *   forecastWindowMs?: number,
   *   retentionMs?: number,
   *   lockTimeoutMs?: number,
   *   lockRetryMs?: number,
   *   lockRuntime?: {platform?: string, open?: (...args: any[]) => Promise<any>},
   *   now?: () => Date|number|string,
   * }} [options] Ledger options.
   */
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.path = this.enabled ? resolveUsageLedgerPath(options.path) : undefined;
    this.maxFileBytes = positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
    this.maxEvents = positiveInteger(options.maxEvents ?? DEFAULT_MAX_EVENTS, "maxEvents");
    this.maxReadBytes = positiveInteger(options.maxReadBytes ?? this.maxFileBytes, "maxReadBytes");
    this.maxLineBytes = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
    if (this.maxLineBytes > this.maxFileBytes) throw new TypeError("maxLineBytes cannot exceed maxFileBytes");
    this.recentLimit = positiveInteger(options.recentLimit ?? DEFAULT_RECENT_LIMIT, "recentLimit");
    this.forecastWindowMs = positiveInteger(options.forecastWindowMs ?? DEFAULT_FORECAST_WINDOW_MS, "forecastWindowMs");
    this.retentionMs = optionalPositiveInteger(options.retentionMs, "retentionMs");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
    this.lockRuntime = normalizeLockRuntime(options.lockRuntime);
    this.now = options.now ?? (() => new Date());
    if (typeof this.now !== "function") throw new TypeError("now must be a function");
    this.tail = Promise.resolve();
  }

  /**
   * Append one normalized event. Unknown input properties are deliberately discarded.
   * @param {Record<string, any>} input Raw provider usage data.
   * @returns {Promise<Record<string, any>|undefined>} The sanitized event, or undefined when disabled.
   */
  append(input) {
    if (!this.enabled || !this.path) return Promise.resolve(undefined);
    return this.#enqueue(async () => {
      const event = normalizeUsageEvent(input, { now: this.now });
      const line = encodeLine(event, this.maxLineBytes);
      await withFileLock(this.path, this, async () => {
        await appendWithRetention(this.path, event, line, this);
      });
      return event;
    });
  }

  /**
   * Read a bounded set of retained events in chronological order.
   * @param {{limit?: number, maxBytes?: number}} [options] Read limits.
   * @returns {Promise<Array<Record<string, any>>>}
   */
  read(options = {}) {
    if (!this.enabled || !this.path) return Promise.resolve([]);
    const limit = boundedPositiveInteger(options.limit ?? this.maxEvents, this.maxEvents, "limit");
    const maxBytes = boundedPositiveInteger(options.maxBytes ?? this.maxReadBytes, this.maxReadBytes, "maxBytes");
    return this.#enqueue(() => withFileLock(this.path, this, async () => {
      const result = await readBoundedJsonl(this.path, { maxBytes, maxLineBytes: this.maxLineBytes });
      return result.events.slice(-limit);
    }));
  }

  /** Return recent sanitized events in newest-first order. */
  async recent(limit = this.recentLimit) {
    const normalizedLimit = boundedPositiveInteger(limit, this.recentLimit, "limit");
    return (await this.read({ limit: normalizedLimit })).reverse();
  }

  /**
   * Return UTC daily/weekly totals, provider/model aggregates, and recent sanitized events.
   * Weeks start Monday at 00:00 UTC.
   * @param {{now?: Date|number|string, recentLimit?: number, maxBytes?: number, forecastWindowMs?: number, entitlements?: Array<Record<string, any>>}} [options] Summary limits.
   */
  summarize(options = {}) {
    if (!this.enabled || !this.path) return Promise.resolve(emptySummary(toDate(options.now ?? this.now())));
    const reference = toDate(options.now ?? this.now());
    const recentLimit = boundedPositiveInteger(options.recentLimit ?? this.recentLimit, this.recentLimit, "recentLimit");
    const maxBytes = boundedPositiveInteger(options.maxBytes ?? this.maxReadBytes, this.maxReadBytes, "maxBytes");
    return this.#enqueue(() => withFileLock(this.path, this, async () => {
      const result = await readBoundedJsonl(this.path, { maxBytes, maxLineBytes: this.maxLineBytes });
      return aggregateUsageEvents(result.events, {
        now: reference,
        recentLimit,
        forecastWindowMs: positiveInteger(options.forecastWindowMs ?? this.forecastWindowMs, "forecastWindowMs"),
        entitlements: options.entitlements,
        truncated: result.truncated,
        malformedLines: result.malformedLines,
      });
    }));
  }

  /** Alias for callers that prefer aggregate terminology. */
  aggregate(options = {}) {
    return this.summarize(options);
  }

  /** Force retention/repair under the writer lock. */
  compact() {
    if (!this.enabled || !this.path) return Promise.resolve();
    return this.#enqueue(() => withFileLock(this.path, this, async () => {
      const result = await readBoundedJsonl(this.path, {
        maxBytes: this.maxFileBytes,
        maxLineBytes: this.maxLineBytes,
      });
      const events = retainedEvents(result.events, this, toDate(this.now()).getTime());
      await replaceJsonlAtomically(this.path, events);
    }));
  }

  /** Alias for callers that describe bounded compaction as rotation. */
  rotate() {
    return this.compact();
  }

  /** Wait for operations queued through this instance. */
  async flush() {
    await this.tail;
  }

  /** Preserve same-instance ordering while allowing failures not to poison later operations. */
  #enqueue(operation) {
    const execution = this.tail.catch(() => undefined).then(operation);
    this.tail = execution.then(() => undefined, () => undefined);
    return execution;
  }
}

/** Resolve an explicit, home-relative, or default usage ledger path. */
export function resolveUsageLedgerPath(configuredPath) {
  if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
    return resolve(expandHomePath(configuredPath.trim()));
  }
  return join(homedir(), ".threadspan", "usage", "usage.jsonl");
}

/**
 * Build the closed persisted schema. Arbitrary metadata is never copied.
 * @param {Record<string, any>} input Candidate event.
 * @param {{now?: () => Date|number|string}} [options] Clock override.
 */
export function normalizeUsageEvent(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Usage event must be an object");
  const usage = input.usage && typeof input.usage === "object" && !Array.isArray(input.usage) ? input.usage : {};
  const timestamp = toDate(input.timestamp ?? (options.now ? options.now() : new Date())).toISOString();
  const inputTokens = firstDefined(
    input.inputTokens, input.input_tokens, usage.inputTokens, usage.input_tokens,
    usage.promptTokens, usage.prompt_tokens,
  );
  const outputTokens = firstDefined(
    input.outputTokens, input.output_tokens, usage.outputTokens, usage.output_tokens,
    usage.completionTokens, usage.completion_tokens,
  );
  const cachedInputTokens = firstDefined(
    input.cachedInputTokens, input.cached_input_tokens, input.cacheReadTokens,
    usage.cachedInputTokens, usage.cached_input_tokens, usage.cacheReadTokens,
    usage.cache_read_tokens, usage.cache_read_input_tokens,
  );
  const reasoningTokens = firstDefined(
    input.reasoningTokens, input.reasoning_tokens, usage.reasoningTokens, usage.reasoning_tokens,
  );
  const event = {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    timestamp,
    provider: dimension(input.provider ?? input.providerId, "provider"),
    accountId: dimension(input.accountId ?? input.account_id ?? LEGACY_USAGE_ACCOUNT_ID, "accountId"),
    model: dimension(input.model ?? input.modelId, "model"),
    mode: dimension(input.mode, "mode"),
    status: dimension(input.status, "status"),
    durationMs: counter(input.durationMs ?? input.duration_ms ?? input.duration ?? 0, "durationMs"),
    inputTokens: counter(inputTokens ?? 0, "inputTokens"),
    outputTokens: counter(outputTokens ?? 0, "outputTokens"),
    cachedInputTokens: counter(cachedInputTokens ?? 0, "cachedInputTokens"),
    reasoningTokens: counter(reasoningTokens ?? 0, "reasoningTokens"),
    evidenceClass: dimension(input.evidenceClass ?? input.evidence_class, "evidenceClass"),
  };
  const costTicks = firstDefined(
    input.costTicks, input.cost_ticks, input.costInUsdTicks, input.cost_in_usd_ticks,
    usage.costTicks, usage.cost_ticks, usage.costInUsdTicks, usage.cost_in_usd_ticks,
  );
  const processCount = firstDefined(input.processCount, input.process_count, input.processes, usage.processCount, usage.process_count);
  const turnCount = firstDefined(
    input.turnCount, input.turn_count, input.turns, input.modelCalls, input.model_calls,
    usage.turnCount, usage.turn_count, usage.turns, usage.modelCalls, usage.model_calls,
  );
  event.observedMetrics = [
    ...(inputTokens === undefined || inputTokens === null ? [] : ["inputTokens"]),
    ...(outputTokens === undefined || outputTokens === null ? [] : ["outputTokens"]),
    ...(cachedInputTokens === undefined || cachedInputTokens === null ? [] : ["cachedInputTokens"]),
    ...(reasoningTokens === undefined || reasoningTokens === null ? [] : ["reasoningTokens"]),
    ...(costTicks === undefined || costTicks === null ? [] : ["costTicks"]),
    ...(processCount === undefined || processCount === null ? [] : ["processCount"]),
    ...(turnCount === undefined || turnCount === null ? [] : ["turnCount"]),
  ];
  if (costTicks !== undefined && costTicks !== null) event.costTicks = counter(costTicks, "costTicks");
  if (processCount !== undefined && processCount !== null) event.processCount = counter(processCount, "processCount");
  if (turnCount !== undefined && turnCount !== null) event.turnCount = counter(turnCount, "turnCount");
  for (const [key, value] of [["attemptId", input.attemptId], ["attemptGroupId", input.attemptGroupId], ["fallbackFromAccountId", input.fallbackFromAccountId]]) {
    if (value !== undefined && value !== null) event[key] = dimension(value, key);
  }
  if (input.attemptOrdinal !== undefined && input.attemptOrdinal !== null) event.attemptOrdinal = counter(input.attemptOrdinal, "attemptOrdinal");
  return event;
}

/** Aggregate sanitized events without retaining caller-controlled raw data. */
export function aggregateUsageEvents(events, options = {}) {
  const now = toDate(options.now ?? new Date());
  const nowMs = now.getTime();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStartDate = new Date(dayStart);
  weekStartDate.setUTCDate(weekStartDate.getUTCDate() - ((weekStartDate.getUTCDay() + 6) % 7));
  const weekStart = weekStartDate.getTime();
  const retained = events.filter(isSanitizedEvent).map(upgradeUsageEvent);
  const quality = { truncated: options.truncated === true, malformedLines: counter(options.malformedLines ?? 0, "malformedLines") };
  return {
    combined: totals(retained),
    daily: totals(retained.filter((event) => Date.parse(event.timestamp) >= dayStart && Date.parse(event.timestamp) <= nowMs)),
    weekly: totals(retained.filter((event) => Date.parse(event.timestamp) >= weekStart && Date.parse(event.timestamp) <= nowMs)),
    providers: groupedTotals(retained, "provider"),
    accounts: groupedTotals(retained, "accountId"),
    models: groupedTotals(retained, "model"),
    recentEvents: retained.slice(-Math.max(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT)).reverse(),
    scannedEvents: retained.length,
    forecasts: forecastRecentBurn(retained, {
      now,
      windowMs: options.forecastWindowMs ?? DEFAULT_FORECAST_WINDOW_MS,
      entitlements: options.entitlements,
      ...quality,
    }),
    truncated: quality.truncated,
    malformedLines: quality.malformedLines,
    dayStart: new Date(dayStart).toISOString(),
    weekStart: new Date(weekStart).toISOString(),
  };
}

/**
 * Derive local recent-burn forecasts from the closed sanitized ledger schema.
 * Authoritative allowance/reset facts are copied as evidence and never inferred.
 * @param {Array<Record<string, any>>} events Sanitized usage events.
 * @param {{now?: Date|number|string, windowMs?: number, entitlements?: Array<Record<string, any>>, truncated?: boolean, malformedLines?: number}} [options]
 */
export function forecastRecentBurn(events, options = {}) {
  const now = toDate(options.now ?? new Date());
  const windowMs = positiveInteger(options.windowMs ?? DEFAULT_FORECAST_WINDOW_MS, "windowMs");
  const quality = { truncated: options.truncated === true, malformedLines: counter(options.malformedLines ?? 0, "malformedLines") };
  const retained = events.filter(isSanitizedEvent).map(upgradeUsageEvent);
  const entitlements = normalizeEntitlements(options.entitlements, windowMs);
  const scopes = new Map();
  for (const event of retained) {
    const key = forecastAccountKey(event.provider, event.accountId);
    const scope = scopes.get(key) ?? { provider: event.provider, accountId: event.accountId, events: [] };
    scope.events.push(event);
    scopes.set(key, scope);
  }
  for (const entitlement of entitlements.values()) {
    const key = forecastAccountKey(entitlement.provider, entitlement.accountId);
    if (!scopes.has(key)) scopes.set(key, { provider: entitlement.provider, accountId: entitlement.accountId, events: [] });
  }
  const accounts = [...scopes.values()]
    .sort((left, right) => forecastAccountKey(left.provider, left.accountId).localeCompare(forecastAccountKey(right.provider, right.accountId)))
    .map((scope) => buildForecast(scope.events, {
      now,
      windowMs,
      quality,
      entitlement: entitlements.get(forecastAccountKey(scope.provider, scope.accountId)),
      scope: { type: "account", provider: scope.provider, accountId: scope.accountId, accountIds: [scope.accountId] },
    }));
  const providerGroups = {};
  for (const provider of [...new Set(accounts.map((forecast) => forecast.scope.provider))].sort()) {
    providerGroups[provider] = compatibleForecastGroups(accounts.filter((forecast) => forecast.scope.provider === provider), retained, {
      now, windowMs, quality, scopeType: "provider", provider,
    });
  }
  return {
    source: "sanitized-usage-ledger",
    observedAt: now.toISOString(),
    cutoff: new Date(now.getTime() - windowMs).toISOString(),
    windowMs,
    quality,
    accounts,
    providers: providerGroups,
    combined: compatibleForecastGroups(accounts, retained, { now, windowMs, quality, scopeType: "combined" }),
  };
}

/** Append directly when safe; otherwise atomically compact to the configured limits. */
async function appendWithRetention(path, event, line, options) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const current = await readBoundedJsonl(path, {
    maxBytes: options.maxFileBytes,
    maxLineBytes: options.maxLineBytes,
  });
  const currentSize = await fileSize(path);
  const nowMs = toDate(options.now()).getTime();
  const cutoff = options.retentionMs === undefined ? Number.NEGATIVE_INFINITY : nowMs - options.retentionMs;
  const hasExpired = current.events.some((entry) => Date.parse(entry.timestamp) < cutoff);
  const newEventExpired = Date.parse(event.timestamp) < cutoff;
  const canAppend = !current.truncated
    && current.malformedLines === 0
    && current.endsWithNewline
    && current.events.length + 1 <= options.maxEvents
    && currentSize + Buffer.byteLength(line) <= options.maxFileBytes
    && !hasExpired
    && !newEventExpired;
  if (canAppend) {
    await appendLine(path, line);
    return;
  }
  const events = retainedEvents([...current.events, event], options, nowMs);
  await replaceJsonlAtomically(path, events);
}

/** Keep the newest events fitting age, count, and byte limits. */
function retainedEvents(events, options, nowMs) {
  const cutoff = options.retentionMs === undefined ? Number.NEGATIVE_INFINITY : nowMs - options.retentionMs;
  const retained = events.filter((event) => Date.parse(event.timestamp) >= cutoff).slice(-options.maxEvents);
  let bytes = retained.reduce((total, event) => total + Buffer.byteLength(`${JSON.stringify(event)}\n`), 0);
  while (retained.length > 0 && bytes > options.maxFileBytes) {
    bytes -= Buffer.byteLength(`${JSON.stringify(retained.shift())}\n`);
  }
  return retained;
}

/** Read at most maxBytes from the tail and validate each JSONL record independently. */
async function readBoundedJsonl(path, options) {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], truncated: false, malformedLines: 0, endsWithNewline: true };
    throw error;
  }
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, options.maxBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    let truncated = start > 0;
    let malformedLines = 0;
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline < 0) return { events: [], truncated: true, malformedLines: 1, endsWithNewline: false };
      text = text.slice(firstNewline + 1);
    }
    const endsWithNewline = info.size === 0 || text.endsWith("\n");
    const events = [];
    for (const rawLine of text.split("\n")) {
      if (rawLine.length === 0) continue;
      if (Buffer.byteLength(rawLine) > options.maxLineBytes) {
        malformedLines += 1;
        continue;
      }
      try {
        const event = JSON.parse(rawLine);
        if (isSanitizedEvent(event)) events.push(upgradeUsageEvent(event));
        else malformedLines += 1;
      } catch {
        malformedLines += 1;
      }
    }
    if (malformedLines > 0 && start > 0) truncated = true;
    return { events, truncated, malformedLines, endsWithNewline };
  } finally {
    await handle.close();
  }
}

/** Write one complete UTF-8 line and flush it before releasing the process lock. */
async function appendLine(path, line) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replace a compacted ledger through a same-directory temporary file. */
async function replaceJsonlAtomically(path, events) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const contents = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Serialize append/read/retention across processes using portable exclusive file creation. */
async function withFileLock(path, options, operation) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + options.lockTimeoutMs;
  while (true) {
    try {
      const handle = await options.lockRuntime.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" && !await isConfirmedWindowsLockContention(error, lockPath, options.lockRuntime)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring usage ledger lock: ${lockPath}`);
      await delay(options.lockRetryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

/**
 * Windows can report CreateFileW(CREATE_NEW) contention as EPERM instead of
 * EEXIST. Retry only when the failure names this exact lock and its persisted
 * owner token confirms that another ledger writer created a regular lock file.
 */
async function isConfirmedWindowsLockContention(error, lockPath, runtime) {
  if (runtime.platform !== "win32" || error?.code !== "EPERM" || error?.syscall !== "open" || error?.path !== lockPath) return false;
  try {
    const info = await lstat(lockPath);
    if (!info.isFile()) return false;
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    return typeof owner?.token === "string" && owner.token.length > 0;
  } catch {
    return false;
  }
}

/** Resolve the production lock runtime or a deterministic test injection. */
function normalizeLockRuntime(candidate) {
  if (candidate !== undefined && (!candidate || typeof candidate !== "object" || Array.isArray(candidate))) {
    throw new TypeError("lockRuntime must be an object");
  }
  const runtime = {
    platform: candidate?.platform ?? process.platform,
    open: candidate?.open ?? open,
  };
  if (typeof runtime.platform !== "string" || runtime.platform.length === 0) throw new TypeError("lockRuntime.platform must be a non-empty string");
  if (typeof runtime.open !== "function") throw new TypeError("lockRuntime.open must be a function");
  return runtime;
}

/** Remove only the lock token created by this caller. */
async function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (owner?.token === token) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Validate a parsed event against the exact persisted schema. */
function isSanitizedEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const commonRequired = [
    "schemaVersion", "timestamp", "provider", "model", "mode", "status", "durationMs",
    "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "evidenceClass",
  ];
  const required = event.schemaVersion === 1 ? commonRequired : [...commonRequired, "accountId"];
  const optional = event.schemaVersion === 1
    ? ["costTicks", "processCount", "turnCount"]
    : ["costTicks", "processCount", "turnCount", "attemptId", "attemptGroupId", "attemptOrdinal", "fallbackFromAccountId", "observedMetrics", "schemaProvenance"];
  if (![1, USAGE_LEDGER_SCHEMA_VERSION].includes(event.schemaVersion)) return false;
  if (Object.keys(event).some((key) => !required.includes(key) && !optional.includes(key)) || required.some((key) => !(key in event))) return false;
  try {
    toDate(event.timestamp);
    for (const key of ["provider", "model", "mode", "status", "evidenceClass", ...(event.schemaVersion === 1 ? [] : ["accountId"])]) dimension(event[key], key);
    for (const key of ["durationMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]) counter(event[key], key);
    for (const key of ["costTicks", "processCount", "turnCount", "attemptOrdinal"]) if (event[key] !== undefined) counter(event[key], key);
    for (const key of ["attemptId", "attemptGroupId", "fallbackFromAccountId"]) if (event[key] !== undefined) dimension(event[key], key);
    if (event.observedMetrics !== undefined) {
      if (!Array.isArray(event.observedMetrics) || new Set(event.observedMetrics).size !== event.observedMetrics.length
        || event.observedMetrics.some((metric) => !OBSERVED_METRICS.has(metric))) return false;
    }
    if (event.schemaProvenance !== undefined && event.schemaProvenance !== "schema-v1-unknown-default") return false;
    return true;
  } catch {
    return false;
  }
}

/** Upgrade a readable schema-v1 row in memory without losing its legacy provenance. */
function upgradeUsageEvent(event) {
  return event.schemaVersion === 1
    ? { ...event, schemaVersion: USAGE_LEDGER_SCHEMA_VERSION, accountId: LEGACY_USAGE_ACCOUNT_ID, schemaProvenance: "schema-v1-unknown-default" }
    : event;
}

const OBSERVED_METRICS = new Set(["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costTicks", "processCount", "turnCount"]);
const FORECAST_UNITS = new Set(["tokens", "input-tokens", "output-tokens", "turns", "requests", "cost-ticks", "processes"]);

/** Normalize caller-supplied authoritative quota facts without inventing unknown values. */
function normalizeEntitlements(inputs, defaultWindowMs) {
  const output = new Map();
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (!input || typeof input !== "object" || Array.isArray(input)) continue;
    let provider;
    let accountId;
    try {
      provider = dimension(input.provider ?? input.providerId, "entitlement.provider");
      accountId = dimension(input.accountId, "entitlement.accountId");
    } catch {
      continue;
    }
    const quota = input.quota && typeof input.quota === "object" && !Array.isArray(input.quota) ? input.quota : input;
    const unit = normalizeForecastUnit(quota.unit ?? quota.allowanceUnit);
    const entitlementWindowMs = optionalForecastWindow(quota.windowMs ?? quota.entitlementWindowMs) ?? defaultWindowMs;
    const identity = optionalSafeDimension(quota.entitlementIdentity ?? quota.entitlementId ?? quota.identity);
    output.set(forecastAccountKey(provider, accountId), {
      provider,
      accountId,
      identity,
      compatibilityIdentity: identity ?? `account:${provider}:${accountId}`,
      unit,
      windowMs: entitlementWindowMs,
      windowKind: optionalSafeDimension(quota.windowKind ?? quota.windowSemantics) ?? "unspecified",
      allowance: optionalNonNegativeNumber(quota.allowance ?? quota.limit),
      remaining: optionalNonNegativeNumber(quota.remaining),
      resetAt: optionalTimestamp(quota.resetAt),
      renewalAt: optionalTimestamp(quota.renewalAt),
      source: optionalSafeDimension(quota.source) ?? "not-observed",
      observedAt: optionalTimestamp(quota.observedAt),
    });
  }
  return output;
}

/** Combine only forecasts that carry the same entitlement identity, metric unit, and window semantics. */
function compatibleForecastGroups(forecasts, allEvents, context) {
  const groups = new Map();
  for (const forecast of forecasts) {
    const key = forecast.compatibilityKey;
    const group = groups.get(key) ?? [];
    group.push(forecast);
    groups.set(key, group);
  }
  return [...groups.values()].map((members) => {
    const accountKeys = new Set(members.map((member) => forecastAccountKey(member.scope.provider, member.scope.accountId)));
    const events = allEvents.filter((event) => accountKeys.has(forecastAccountKey(event.provider, event.accountId)));
    const first = members[0];
    const accountIds = [...new Set(members.flatMap((member) => member.scope.accountIds))].sort();
    const providers = [...new Set(members.map((member) => member.scope.provider))].sort();
    const memberEntitlements = members.map((member) => member.entitlement);
    const entitlementEvidence = memberEntitlements.find((member) => member.freshness.status !== "fresh")
      ?? memberEntitlements.reduce((oldest, member) => Date.parse(member.observedAt) < Date.parse(oldest.observedAt) ? member : oldest);
    const entitlement = {
      ...entitlementEvidence,
      compatibilityIdentity: first.compatibilityKey.split("\u0000")[0],
      remaining: identicalNullableNumber(members.map((member) => member.entitlement.remaining)),
      allowance: identicalNullableNumber(members.map((member) => member.entitlement.allowance)),
    };
    return buildForecast(events, {
      ...context,
      entitlement,
      scope: {
        type: context.scopeType,
        provider: context.provider ?? (providers.length === 1 ? providers[0] : null),
        accountId: accountIds.length === 1 ? accountIds[0] : null,
        providers,
        accountIds,
      },
    });
  }).sort((left, right) => left.compatibilityKey.localeCompare(right.compatibilityKey));
}

/** Build one account or compatible entitlement-group forecast. */
function buildForecast(events, context) {
  const entitlement = context.entitlement ?? defaultEntitlement(context.scope, context.windowMs, events);
  const unit = entitlement.unit ?? preferredUnit(events);
  const cutoffMs = context.now.getTime() - context.windowMs;
  const candidates = events
    .filter((event) => {
      const timestamp = Date.parse(event.timestamp);
      return timestamp >= cutoffMs && timestamp <= context.now.getTime();
    })
    .map((event) => ({ event, value: metricValue(event, unit) }))
    .filter((sample) => sample.value !== null)
    .sort((left, right) => Date.parse(left.event.timestamp) - Date.parse(right.event.timestamp));
  const newestAny = events
    .filter((event) => Date.parse(event.timestamp) <= context.now.getTime())
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)).at(-1);
  const newest = candidates.at(-1)?.event ?? newestAny;
  const oldest = candidates[0]?.event;
  const sampledDurationMs = oldest && newest ? Math.max(0, Date.parse(newest.timestamp) - Date.parse(oldest.timestamp)) : 0;
  const coverageRatio = Math.min(1, sampledDurationMs / context.windowMs);
  const ageMs = newest ? Math.max(0, context.now.getTime() - Date.parse(newest.timestamp)) : null;
  const freshness = !newest ? "unknown" : ageMs > context.windowMs ? "stale" : ageMs > context.windowMs / 2 ? "aging" : "fresh";
  const confidence = forecastConfidence({ candidates, coverageRatio, freshness, quality: context.quality });
  const burn = candidates.reduce((sum, sample) => sum + sample.value, 0);
  const exactRate = candidates.length > 0 ? burn / (context.windowMs / 3_600_000) : null;
  const rate = exactRate === null ? null : roundedRate(exactRate);
  const limitKnown = entitlement.remaining !== null || entitlement.allowance !== null;
  const entitlementFreshness = quotaSnapshotFreshness(context.now, entitlement, Math.max(1, Math.min(
    DEFAULT_ENTITLEMENT_FRESHNESS_MS,
    Math.floor(context.windowMs / 2),
  )));
  const projectionEligible = entitlement.unit !== null && entitlement.remaining !== null && entitlementFreshness.status === "fresh";
  let status = candidates.length === 0 ? (newest ? "stale-or-missing-metric" : "no-data") : burn === 0 ? "zero-burn" : projectionEligible ? "projected" : "rate-only";
  if (context.quality.truncated || context.quality.malformedLines > 0 || freshness === "stale") status = "unknown";
  const exhaustion = status === "projected" && entitlement.remaining !== null && exactRate > 0 && candidates.length >= 2
    ? exhaustionRange(context.now, entitlement.remaining, exactRate, confidence.level, entitlement)
    : null;
  if (status === "projected" && !exhaustion) status = "rate-only";
  const evidenceClasses = [...new Set(candidates.map((sample) => sample.event.evidenceClass))].sort();
  const entitlementOutput = {
    identity: entitlement.identity,
    unit: entitlement.unit,
    windowMs: entitlement.windowMs,
    windowKind: entitlement.windowKind,
    allowance: entitlement.allowance,
    remaining: entitlement.remaining,
    resetAt: entitlement.resetAt,
    renewalAt: entitlement.renewalAt,
    source: entitlement.source,
    observedAt: entitlement.observedAt,
    freshness: entitlementFreshness,
  };
  return {
    scope: context.scope,
    status,
    source: "sanitized-usage-ledger",
    evidenceClass: evidenceClasses.length === 1 ? evidenceClasses[0] : evidenceClasses.length > 1 ? "mixed" : null,
    evidenceClasses,
    observedAt: newest?.timestamp ?? null,
    cutoff: new Date(cutoffMs).toISOString(),
    windowMs: context.windowMs,
    sampleInterval: { start: oldest?.timestamp ?? null, end: candidates.at(-1)?.event.timestamp ?? null, durationMs: sampledDurationMs },
    coverage: { ratio: roundedRatio(coverageRatio), eventCount: candidates.length, scannedEventCount: events.length },
    freshness: { status: freshness, ageMs },
    confidence,
    burn: { unit, amount: candidates.length > 0 ? burn : null, ratePerHour: rate, rateLabel: rate === null ? "rate unknown" : `${formatRate(rate)} ${unit}/hour` },
    limitKnown,
    limitLabel: limitKnown ? "authoritative limit snapshot" : "limit unknown",
    entitlement: entitlementOutput,
    exhaustion,
    compatibilityKey: `${entitlement.compatibilityIdentity}\u0000${unit}\u0000${entitlement.windowMs}\u0000${entitlement.windowKind}`,
  };
}

function defaultEntitlement(scope, windowMs, events) {
  const provider = scope.provider ?? events[0]?.provider ?? "unknown";
  const accountId = scope.accountId ?? scope.accountIds?.[0] ?? LEGACY_USAGE_ACCOUNT_ID;
  return {
    identity: null,
    compatibilityIdentity: `account:${provider}:${accountId}`,
    unit: null,
    windowMs,
    windowKind: "recent-local-window",
    allowance: null,
    remaining: null,
    resetAt: null,
    renewalAt: null,
    source: "not-observed",
    observedAt: null,
  };
}

function forecastConfidence({ candidates, coverageRatio, freshness, quality }) {
  if (quality.malformedLines > 0) return { level: "unknown", reason: "malformed ledger rows make the sample incomplete" };
  if (quality.truncated) return { level: "unknown", reason: "bounded ledger read was truncated" };
  if (freshness === "stale") return { level: "unknown", reason: "newest usable sample is stale" };
  if (candidates.length === 0) return { level: "unknown", reason: "no usable samples for this metric" };
  if (candidates.length < 2) return { level: "low", reason: "only one usable sample" };
  if (coverageRatio < 0.1) return { level: "low", reason: "samples cover less than 10% of the recent window" };
  if (candidates.length < 4 || coverageRatio < 0.5 || freshness === "aging") return { level: "medium", reason: "recent samples have partial temporal coverage" };
  return { level: "high", reason: "recent samples span at least half the window" };
}

/** Decide whether an authoritative remaining snapshot is current enough for projection. */
function quotaSnapshotFreshness(now, entitlement, thresholdMs) {
  if (entitlement.source === "not-observed") {
    return { status: "unknown", ageMs: null, thresholdMs, reason: "authoritative entitlement source was not observed" };
  }
  const observedMs = Date.parse(entitlement.observedAt);
  if (!Number.isFinite(observedMs)) {
    return { status: "unknown", ageMs: null, thresholdMs, reason: "authoritative entitlement observation time is unknown" };
  }
  const nowMs = now.getTime();
  const ageMs = nowMs - observedMs;
  if (ageMs < 0) {
    return { status: "invalid", ageMs, thresholdMs, reason: "authoritative entitlement observation is future-dated" };
  }
  const elapsedBoundary = [entitlement.resetAt, entitlement.renewalAt]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value) && value > observedMs && value <= nowMs)
    .sort((left, right) => left - right)[0];
  if (elapsedBoundary !== undefined) {
    return { status: "stale", ageMs, thresholdMs, reason: "reset or renewal elapsed after the entitlement observation" };
  }
  if (ageMs > thresholdMs) {
    return { status: "stale", ageMs, thresholdMs, reason: "authoritative entitlement observation exceeds the projection freshness threshold" };
  }
  return { status: "fresh", ageMs, thresholdMs, reason: "authoritative entitlement observation is within the projection freshness threshold" };
}

function exhaustionRange(now, remaining, exactRate, confidenceLevel, entitlement) {
  if (remaining === 0) return { earliestAt: now.toISOString(), latestAt: now.toISOString(), label: "exhausted now", relation: resetRelation(now, now, entitlement) };
  const spread = confidenceLevel === "high" ? [0.85, 1.15] : confidenceLevel === "medium" ? [0.7, 1.35] : [0.5, 1.5];
  const roundingMs = 15 * 60 * 1000;
  const exactEarliestMs = now.getTime() + (remaining / (exactRate * spread[1])) * 3_600_000;
  const exactLatestMs = now.getTime() + (remaining / (exactRate * spread[0])) * 3_600_000;
  const earliestMs = Math.max(now.getTime(), Math.floor(exactEarliestMs / roundingMs) * roundingMs);
  const latestMs = Math.ceil(exactLatestMs / roundingMs) * roundingMs;
  const earliest = new Date(earliestMs);
  const latest = new Date(latestMs);
  return {
    earliestAt: earliest.toISOString(),
    latestAt: latest.toISOString(),
    label: `${formatDuration(earliestMs - now.getTime())}–${formatDuration(latestMs - now.getTime())}`,
    relation: resetRelation(earliest, latest, entitlement),
  };
}

function resetRelation(earliest, latest, entitlement) {
  const candidates = [entitlement.resetAt, entitlement.renewalAt].filter(Boolean).map((value) => Date.parse(value)).filter(Number.isFinite);
  if (candidates.length === 0) return "reset-or-renewal-unknown";
  const boundaryMs = Math.min(...candidates);
  if (earliest.getTime() < boundaryMs && boundaryMs < latest.getTime()) return "straddles-reset-or-renewal";
  return latest.getTime() <= boundaryMs ? "before-reset-or-renewal" : "after-reset-or-renewal";
}

function preferredUnit(events) {
  if (events.some((event) => metricValue(event, "turns") !== null)) return "turns";
  if (events.some((event) => metricValue(event, "tokens") !== null)) return "tokens";
  return "requests";
}

function metricValue(event, unit) {
  const observed = new Set(event.observedMetrics ?? []);
  if (unit === "requests") return 1;
  if (unit === "tokens") return observed.has("inputTokens") && observed.has("outputTokens") ? event.inputTokens + event.outputTokens : null;
  if (unit === "input-tokens") return observed.has("inputTokens") ? event.inputTokens : null;
  if (unit === "output-tokens") return observed.has("outputTokens") ? event.outputTokens : null;
  if (unit === "turns") return observed.has("turnCount") ? event.turnCount : null;
  if (unit === "cost-ticks") return observed.has("costTicks") ? event.costTicks : null;
  if (unit === "processes") return observed.has("processCount") ? event.processCount : null;
  return null;
}

function normalizeForecastUnit(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  return FORECAST_UNITS.has(normalized) ? normalized : null;
}

function optionalForecastWindow(value) {
  if (value === undefined || value === null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function optionalNonNegativeNumber(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalSafeDimension(value) {
  if (value === undefined || value === null) return null;
  try { return dimension(value, "value"); } catch { return null; }
}

function optionalTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  try { return toDate(value).toISOString(); } catch { return null; }
}

function forecastAccountKey(provider, accountId) {
  return `${provider}\u0000${accountId}`;
}

function identicalNullableNumber(values) {
  const first = values[0] ?? null;
  return values.every((value) => (value ?? null) === first) ? first : null;
}

function roundedRate(value) {
  if (value >= 1000) return Math.round(value / 100) * 100;
  if (value >= 100) return Math.round(value / 10) * 10;
  if (value >= 10) return Math.round(value);
  if (value >= 1) return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}

function roundedRatio(value) {
  return Math.round(value * 100) / 100;
}

function formatRate(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 2 : 1).replace(/\.0$/, "");
}

function formatDuration(milliseconds) {
  const hours = milliseconds / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.max(1, Math.round(hours))}h`;
  return `${Math.max(2, Math.round(hours / 24))}d`;
}

/** Sum normalized numeric fields and status counts. */
function totals(events) {
  const output = {
    eventCount: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costTicks: 0,
    processCount: 0,
    turnCount: 0,
  };
  const statuses = new Map();
  for (const event of events) {
    output.eventCount += 1;
    for (const key of ["durationMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costTicks", "processCount", "turnCount"]) {
      output[key] += event[key] ?? 0;
    }
    statuses.set(event.status, (statuses.get(event.status) ?? 0) + 1);
  }
  return { ...output, statuses: Object.fromEntries(statuses) };
}

/** Aggregate by one bounded persisted dimension. */
function groupedTotals(events, key) {
  const groups = new Map();
  for (const event of events) {
    const value = event[key];
    const group = groups.get(value) ?? [];
    group.push(event);
    groups.set(value, group);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([value, group]) => [value, totals(group)]));
}

/** Return the deterministic disabled summary. */
function emptySummary(now) {
  return aggregateUsageEvents([], { now, recentLimit: 0 });
}

/** Render a single bounded JSONL record. */
function encodeLine(event, maxLineBytes) {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > maxLineBytes) throw new RangeError(`Usage ledger event exceeds ${maxLineBytes} bytes`);
  return line;
}

/** Resolve a current file size without treating a missing ledger as an error. */
async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

/** Expand only the current user's portable home shorthand. */
function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Require a short, printable, single-line aggregate dimension. */
function dimension(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_DIMENSION_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} must be a non-empty printable string of at most ${MAX_DIMENSION_LENGTH} characters`);
  }
  return normalized;
}

/** Normalize exact usage counters to non-negative safe integers. */
function counter(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return numeric;
}

/** Validate a positive integer option. */
function positiveInteger(value, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return numeric;
}

/** Validate an optional positive integer option. */
function optionalPositiveInteger(value, label) {
  return value === undefined || value === null ? undefined : positiveInteger(value, label);
}

/** Clamp caller read/output limits to configured bounds. */
function boundedPositiveInteger(value, maximum, label) {
  return Math.min(positiveInteger(value, label), maximum);
}

/** Convert a timestamp-like value to a valid Date. */
function toDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("timestamp must be a valid date");
  return date;
}

/** Return the first explicitly supplied value. */
function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

/** Portable async retry delay. */
function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
