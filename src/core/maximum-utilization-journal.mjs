import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";

const JOURNAL_VERSION = 1;
const CLAIM_RETRIES = 25;
const CLAIM_RETRY_MS = 4;

/**
 * Durable private state and claimed outbox for maximum-utilization decisions.
 *
 * Reducer transitions and host-effect claims are serialized through one
 * process-shared lock file. A claimed effect is never replayed after expiry:
 * dispatch uncertainty is recorded explicitly for owner review.
 */
export class MaximumUtilizationJournal {
  /** @param {{path: string, now?: () => string}} options */
  constructor(options) {
    if (!options?.path) throw new TypeError("maximum-utilization journal path is required");
    this.path = options.path;
    this.claimPath = `${options.path}.claim`;
    this.now = options.now ?? (() => new Date().toISOString());
    this.ownerId = nonEmpty(options.ownerId) ?? randomUUID();
    this.document = null;
    this.queue = Promise.resolve();
  }

  /** Read an existing journal without creating its file or parent directory. */
  async loadExisting() {
    return this.#serialized(async () => {
      try {
        this.document = normalizeDocument(JSON.parse(await readFile(this.path, "utf8")));
        return structuredClone(this.document);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    });
  }

  /** Load or initialize the private journal under the process-shared claim. */
  async initialize() {
    return this.#serialized(() => this.#mutate(async (document, created) => ({ changed: created, value: structuredClone(document) })));
  }

  /** Return a current clone so stale in-process state cannot hide another writer. */
  async snapshot() {
    await this.initializeIfNeeded();
    return this.#serialized(async () => {
      this.document = normalizeDocument(JSON.parse(await readFile(this.path, "utf8")));
      return structuredClone(this.document);
    });
  }

  /**
   * Atomically persist reducer state and deduplicated actions. A state digest
   * prevents a second daemon from committing a transition reduced from stale state.
   */
  async commit(transition) {
    return this.#serialized(() => this.#mutate(async (document) => {
      if (document.state !== null && transition.expectedStateDigest
        && digest(document.state) !== transition.expectedStateDigest) {
        const conflict = new Error("Maximum-utilization journal state changed in another process; commit refused");
        conflict.code = "MAXIMUM_UTILIZATION_STATE_CONFLICT";
        throw conflict;
      }
      const committedAt = this.now();
      const cancelledActionKeys = [];
      for (const entry of document.outbox) {
        if (!["pending", "unsupported", "claimed"].includes(entry.status)) continue;
        const cancellation = (transition.cancellations ?? []).find((candidate) => cancellationMatches(candidate, entry.action));
        if (!cancellation) continue;
        entry.status = entry.status === "claimed" ? "indeterminate" : "cancelled";
        entry.updatedAt = committedAt;
        entry.lastError = entry.status === "indeterminate" ? "cancelled while dispatch claim was in flight" : null;
        entry.cancelReason = String(cancellation.reason ?? "obsolete").slice(0, 120);
        entry.claim = null;
        entry.version += 1;
        cancelledActionKeys.push(entry.idempotencyKey);
      }
      const known = new Set(document.outbox.map((entry) => entry.idempotencyKey));
      const inserted = [];
      for (const action of transition.actions ?? []) {
        if (known.has(action.idempotencyKey)) continue;
        known.add(action.idempotencyKey);
        const entry = {
          idempotencyKey: action.idempotencyKey,
          action: structuredClone(action),
          status: "pending",
          attempts: 0,
          version: 1,
          claim: null,
          createdAt: committedAt,
          updatedAt: committedAt,
          lastError: null,
          dispatchReceiptDigest: null,
        };
        document.outbox.push(entry);
        inserted.push(structuredClone(entry));
      }
      document.state = structuredClone(transition.state);
      document.transitions.push({
        sequence: document.nextSequence++,
        committedAt,
        event: structuredClone(transition.event),
        actionKeys: inserted.map((entry) => entry.idempotencyKey),
        cancelledActionKeys,
      });
      return { changed: true, value: inserted };
    }));
  }

  /** Return effects eligible for a first dispatch claim; expired claims become indeterminate. */
  async replayableOutbox() {
    return this.#serialized(() => this.#mutate(async (document) => {
      const nowMs = Date.parse(this.now());
      let changed = false;
      for (const entry of document.outbox) {
        if (entry.status !== "claimed" || !entry.claim || Date.parse(entry.claim.leaseExpiresAt) > nowMs) continue;
        entry.status = "indeterminate";
        entry.updatedAt = this.now();
        entry.lastError = "dispatch lease expired without a host receipt";
        entry.claim = null;
        entry.version += 1;
        changed = true;
      }
      return {
        changed,
        value: document.outbox
          .filter((entry) => ["pending", "unsupported"].includes(entry.status))
          .map((entry) => structuredClone(entry)),
      };
    }));
  }

  /** Claim one effect before invocation. A null result means another actor won or cancelled it. */
  async claimDispatch(idempotencyKey, options) {
    const dispatcherId = nonEmpty(options?.dispatcherId);
    const leaseMs = Number(options?.leaseMs);
    if (!dispatcherId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError("Dispatch claim requires dispatcherId and positive leaseMs");
    return this.#serialized(() => this.#mutate(async (document) => {
      const entry = document.outbox.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!entry || !["pending", "unsupported"].includes(entry.status)) return { changed: false, value: null };
      const claimedAt = this.now();
      const claim = {
        id: randomUUID(),
        dispatcherId,
        entryVersion: entry.version,
        claimedAt,
        leaseExpiresAt: new Date(Date.parse(claimedAt) + leaseMs).toISOString(),
      };
      entry.status = "claimed";
      entry.claim = claim;
      entry.attempts += 1;
      entry.updatedAt = claimedAt;
      entry.lastError = null;
      entry.version += 1;
      return { changed: true, value: { entry: structuredClone(entry), claimToken: { idempotencyKey, ...claim } } };
    }));
  }

  /** Invoke synchronously while the exact claim is locked, closing the pre-invocation cancellation race. */
  async invokeClaimedDispatch(token, invoke) {
    if (typeof invoke !== "function") throw new TypeError("Claimed dispatch invocation callback is required");
    return this.#serialized(() => this.#mutate(async (document) => {
      const entry = document.outbox.find((candidate) => candidate.idempotencyKey === token?.idempotencyKey);
      const owned = entry?.status === "claimed" && entry.claim?.id === token?.id
        && entry.claim?.dispatcherId === token?.dispatcherId
        && entry.claim?.entryVersion === token?.entryVersion
        && entry.version === token.entryVersion + 1;
      if (owned && Date.parse(entry.claim.leaseExpiresAt) <= Date.parse(this.now())) {
        entry.status = "indeterminate";
        entry.updatedAt = this.now();
        entry.lastError = "dispatch lease expired before host invocation";
        entry.claim = null;
        entry.version += 1;
        return { changed: true, value: { invoked: false, result: null } };
      }
      if (!owned) return { changed: false, value: { invoked: false, result: null } };
      let result;
      try {
        result = Promise.resolve(invoke()).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
      } catch (error) {
        result = Promise.resolve({ ok: false, error });
      }
      return { changed: false, value: { invoked: true, result } };
    }));
  }

  /** Complete only the exact current claim; late outcomes cannot resurrect cancelled work. */
  async completeDispatch(token, result) {
    return this.#serialized(() => this.#mutate(async (document) => {
      const entry = document.outbox.find((candidate) => candidate.idempotencyKey === token?.idempotencyKey);
      if (!entry || entry.status !== "claimed" || entry.claim?.id !== token?.id
        || entry.claim?.dispatcherId !== token?.dispatcherId
        || entry.claim?.entryVersion !== token?.entryVersion
        || entry.version !== token.entryVersion + 1) {
        return { changed: false, value: { accepted: false, entry: entry ? structuredClone(entry) : null } };
      }
      if (!["executed", "unsupported", "indeterminate"].includes(result?.status)) {
        throw new TypeError("Invalid maximum-utilization dispatch completion status");
      }
      if (Date.parse(entry.claim.leaseExpiresAt) <= Date.parse(this.now())) {
        entry.status = "indeterminate";
        entry.updatedAt = this.now();
        entry.lastError = "host result arrived after dispatch lease expiry";
        entry.dispatchReceiptDigest = null;
        entry.claim = null;
        entry.version += 1;
        return { changed: true, value: { accepted: false, entry: structuredClone(entry) } };
      }
      if (result.status === "executed" && !hexDigest(result.receiptDigest)) {
        throw new TypeError("Executed maximum-utilization dispatch requires a receipt digest");
      }
      entry.status = result.status;
      entry.updatedAt = this.now();
      entry.lastError = result.error ? String(result.error).slice(0, 500) : null;
      entry.dispatchReceiptDigest = result.status === "executed" ? result.receiptDigest : null;
      entry.claim = null;
      entry.version += 1;
      return { changed: true, value: { accepted: true, entry: structuredClone(entry) } };
    }));
  }

  /** Change an entry that was not invoked, such as absent capability or disabled replay. */
  async recordUndispatched(idempotencyKey, result) {
    return this.#serialized(() => this.#mutate(async (document) => {
      const entry = document.outbox.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!entry) throw new Error(`Unknown maximum-utilization outbox action '${idempotencyKey}'`);
      if (!["pending", "unsupported"].includes(entry.status)) return { changed: false, value: structuredClone(entry) };
      if (!["unsupported", "cancelled"].includes(result?.status)) throw new TypeError("Invalid undispatched outbox status");
      entry.status = result.status;
      entry.updatedAt = this.now();
      entry.lastError = result.error ? String(result.error).slice(0, 500) : null;
      entry.claim = null;
      entry.version += 1;
      return { changed: true, value: structuredClone(entry) };
    }));
  }

  /** Count-only status suitable for a separately sanitized HUD model. */
  async statusCounts() {
    const document = await this.snapshot();
    const counts = { pending: 0, unsupported: 0, claimed: 0, executed: 0, cancelled: 0, indeterminate: 0 };
    for (const entry of document.outbox) if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
    return counts;
  }

  async initializeIfNeeded() {
    if (!this.document) await this.initialize();
  }

  async #serialized(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async #mutate(operation) {
    return this.#withFileClaim(async () => {
      let document;
      let created = false;
      try {
        document = normalizeDocument(JSON.parse(await readFile(this.path, "utf8")));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        document = emptyDocument();
        created = true;
      }
      const outcome = await operation(document, created);
      if (outcome.changed) {
        document.revision += 1;
        await this.#persist(document);
      }
      this.document = document;
      return outcome.value;
    });
  }

  async #withFileClaim(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt += 1) {
      try {
        handle = await open(this.claimPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt === CLAIM_RETRIES - 1) {
          throw new Error("Maximum-utilization journal cross-process claim is unavailable; automatic mutation refused");
        }
        await delay(CLAIM_RETRY_MS);
      }
    }
    try {
      await handle.writeFile(`${JSON.stringify({
        id: randomUUID(),
        ownerId: this.ownerId,
        processId: process.pid,
        host: hostname(),
        createdAt: this.now(),
      })}\n`);
      return await operation();
    } finally {
      await handle?.close();
      await unlink(this.claimPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  async #persist(document) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function cancellationMatches(cancellation, action) {
  if (!cancellation || !Array.isArray(cancellation.actionTypes)) return false;
  const epochMatches = cancellation.epoch === action?.epoch
    || (Number.isSafeInteger(cancellation.throughEpoch) && action?.epoch <= cancellation.throughEpoch);
  return epochMatches && cancellation.actionTypes.includes(action.type);
}

function emptyDocument() {
  return { schemaVersion: JOURNAL_VERSION, revision: 0, nextSequence: 1, state: null, transitions: [], outbox: [] };
}

function normalizeDocument(value) {
  if (!value || value.schemaVersion !== JOURNAL_VERSION || !Array.isArray(value.transitions) || !Array.isArray(value.outbox)) {
    throw new Error("Unsupported or malformed maximum-utilization journal");
  }
  return {
    schemaVersion: JOURNAL_VERSION,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    nextSequence: Number.isSafeInteger(value.nextSequence) && value.nextSequence > 0 ? value.nextSequence : value.transitions.length + 1,
    state: value.state && typeof value.state === "object" ? value.state : null,
    transitions: value.transitions,
    outbox: value.outbox.map(normalizeOutboxEntry),
  };
}

function normalizeOutboxEntry(entry) {
  const action = entry?.action;
  const expectedKey = Number.isSafeInteger(action?.epoch) && action.epoch >= 0 && nonEmpty(action?.type)
    && nonEmpty(action?.capability) && action?.prerequisites && typeof action.prerequisites === "object" && !Array.isArray(action.prerequisites)
    && hexDigest(action?.prerequisitesDigest) && action.prerequisitesDigest === digest(action.prerequisites)
    ? `${action.epoch}/${action.type}/${action.prerequisitesDigest}`
    : null;
  const statuses = new Set(["pending", "unsupported", "claimed", "executed", "cancelled", "indeterminate"]);
  if (!expectedKey || entry?.idempotencyKey !== expectedKey || action.idempotencyKey !== expectedKey || !statuses.has(entry?.status)) {
    throw new Error("Malformed maximum-utilization outbox entry");
  }
  const version = Number.isSafeInteger(entry.version) && entry.version > 0 ? entry.version : 1;
  const claim = entry.claim && typeof entry.claim === "object" ? entry.claim : null;
  if (entry.status === "claimed" && (!claim || !nonEmpty(claim.id) || !nonEmpty(claim.dispatcherId)
    || !Number.isSafeInteger(claim.entryVersion) || claim.entryVersion < 1
    || claim.entryVersion + 1 !== version || !nonEmpty(claim.claimedAt) || !nonEmpty(claim.leaseExpiresAt)
    || !Number.isFinite(Date.parse(claim.claimedAt)) || !Number.isFinite(Date.parse(claim.leaseExpiresAt)))) {
    throw new Error("Malformed maximum-utilization outbox claim");
  }
  if (entry.status !== "claimed" && claim) throw new Error("Malformed maximum-utilization outbox claim state");
  const legacyUnverifiedExecution = entry.status === "executed" && !hexDigest(entry.dispatchReceiptDigest);
  return {
    ...entry,
    status: legacyUnverifiedExecution ? "indeterminate" : entry.status,
    attempts: Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
    version,
    claim,
    lastError: legacyUnverifiedExecution ? "executed entry lacks a source-bound host receipt" : entry.lastError ?? null,
    dispatchReceiptDigest: legacyUnverifiedExecution ? null : (hexDigest(entry.dispatchReceiptDigest) ? entry.dispatchReceiptDigest : null),
  };
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function hexDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
