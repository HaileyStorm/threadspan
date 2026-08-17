import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const USAGE_LEDGER_SCHEMA_VERSION = 1;

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024;
const DEFAULT_RECENT_LIMIT = 100;
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
   *   retentionMs?: number,
   *   lockTimeoutMs?: number,
   *   lockRetryMs?: number,
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
    this.retentionMs = optionalPositiveInteger(options.retentionMs, "retentionMs");
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
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
   * @param {{now?: Date|number|string, recentLimit?: number, maxBytes?: number}} [options] Summary limits.
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
  const event = {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    timestamp,
    provider: dimension(input.provider ?? input.providerId, "provider"),
    model: dimension(input.model ?? input.modelId, "model"),
    mode: dimension(input.mode, "mode"),
    status: dimension(input.status, "status"),
    durationMs: counter(input.durationMs ?? input.duration_ms ?? input.duration ?? 0, "durationMs"),
    inputTokens: counter(firstDefined(
      input.inputTokens, input.input_tokens, usage.inputTokens, usage.input_tokens,
      usage.promptTokens, usage.prompt_tokens,
    ) ?? 0, "inputTokens"),
    outputTokens: counter(firstDefined(
      input.outputTokens, input.output_tokens, usage.outputTokens, usage.output_tokens,
      usage.completionTokens, usage.completion_tokens,
    ) ?? 0, "outputTokens"),
    cachedInputTokens: counter(firstDefined(
      input.cachedInputTokens, input.cached_input_tokens, input.cacheReadTokens,
      usage.cachedInputTokens, usage.cached_input_tokens, usage.cacheReadTokens,
      usage.cache_read_tokens, usage.cache_read_input_tokens,
    ) ?? 0, "cachedInputTokens"),
    reasoningTokens: counter(firstDefined(
      input.reasoningTokens, input.reasoning_tokens, usage.reasoningTokens, usage.reasoning_tokens,
    ) ?? 0, "reasoningTokens"),
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
  if (costTicks !== undefined && costTicks !== null) event.costTicks = counter(costTicks, "costTicks");
  if (processCount !== undefined && processCount !== null) event.processCount = counter(processCount, "processCount");
  if (turnCount !== undefined && turnCount !== null) event.turnCount = counter(turnCount, "turnCount");
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
  const retained = events.filter(isSanitizedEvent);
  return {
    daily: totals(retained.filter((event) => Date.parse(event.timestamp) >= dayStart && Date.parse(event.timestamp) <= nowMs)),
    weekly: totals(retained.filter((event) => Date.parse(event.timestamp) >= weekStart && Date.parse(event.timestamp) <= nowMs)),
    providers: groupedTotals(retained, "provider"),
    models: groupedTotals(retained, "model"),
    recentEvents: retained.slice(-Math.max(0, options.recentLimit ?? DEFAULT_RECENT_LIMIT)).reverse(),
    scannedEvents: retained.length,
    truncated: options.truncated === true,
    malformedLines: counter(options.malformedLines ?? 0, "malformedLines"),
    dayStart: new Date(dayStart).toISOString(),
    weekStart: new Date(weekStart).toISOString(),
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
        if (isSanitizedEvent(event)) events.push(event);
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
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ token }), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
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
  const required = [
    "schemaVersion", "timestamp", "provider", "model", "mode", "status", "durationMs",
    "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "evidenceClass",
  ];
  const optional = ["costTicks", "processCount", "turnCount"];
  if (Object.keys(event).some((key) => !required.includes(key) && !optional.includes(key))) return false;
  if (event.schemaVersion !== USAGE_LEDGER_SCHEMA_VERSION) return false;
  try {
    toDate(event.timestamp);
    for (const key of ["provider", "model", "mode", "status", "evidenceClass"]) dimension(event[key], key);
    for (const key of ["durationMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"]) counter(event[key], key);
    for (const key of optional) if (event[key] !== undefined) counter(event[key], key);
    return true;
  } catch {
    return false;
  }
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
