import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const JOURNAL_VERSION = 1;

/**
 * Durable private state and outbox for maximum-utilization decisions.
 *
 * Transitions and their requested host effects are committed together before
 * any adapter is allowed to dispatch an effect.
 */
export class MaximumUtilizationJournal {
  /** @param {{path: string, now?: () => string}} options */
  constructor(options) {
    if (!options?.path) throw new TypeError("maximum-utilization journal path is required");
    this.path = options.path;
    this.now = options.now ?? (() => new Date().toISOString());
    this.document = null;
    this.queue = Promise.resolve();
  }

  /** Read an existing journal without creating its file or parent directory. */
  async loadExisting() {
    return this.#serialized(async () => {
      if (this.document) return structuredClone(this.document);
      try {
        this.document = normalizeDocument(JSON.parse(await readFile(this.path, "utf8")));
        return structuredClone(this.document);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    });
  }

  /** Load or initialize the private journal. */
  async initialize() {
    await this.#serialized(async () => {
      if (this.document) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8"));
        this.document = normalizeDocument(parsed);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        this.document = emptyDocument();
        await this.#persist();
      }
    });
    return this.snapshot();
  }

  /** Return a clone so callers cannot mutate journal state without a commit. */
  async snapshot() {
    await this.initializeIfNeeded();
    return structuredClone(this.document);
  }

  /**
   * Atomically persist the reducer state and deduplicated outbox actions.
   * @param {{event: Record<string, any>, state: Record<string, any>, actions: Record<string, any>[], cancellations?: Record<string, any>[]}} transition
   */
  async commit(transition) {
    return this.#serialized(async () => {
      await this.#loadIfNeeded();
      const committedAt = this.now();
      const cancelledActionKeys = [];
      for (const entry of this.document.outbox) {
        if (!["pending", "unsupported"].includes(entry.status)) continue;
        const cancellation = (transition.cancellations ?? []).find((candidate) => cancellationMatches(candidate, entry.action));
        if (!cancellation) continue;
        entry.status = "cancelled";
        entry.updatedAt = committedAt;
        entry.lastError = null;
        entry.cancelReason = String(cancellation.reason ?? "obsolete").slice(0, 120);
        cancelledActionKeys.push(entry.idempotencyKey);
      }
      const known = new Set(this.document.outbox.map((entry) => entry.idempotencyKey));
      const inserted = [];
      for (const action of transition.actions ?? []) {
        if (known.has(action.idempotencyKey)) continue;
        known.add(action.idempotencyKey);
        const entry = {
          idempotencyKey: action.idempotencyKey,
          action: structuredClone(action),
          status: "pending",
          attempts: 0,
          createdAt: committedAt,
          updatedAt: committedAt,
          lastError: null,
        };
        this.document.outbox.push(entry);
        inserted.push(structuredClone(entry));
      }
      this.document.state = structuredClone(transition.state);
      this.document.transitions.push({
        sequence: this.document.nextSequence++,
        committedAt,
        event: structuredClone(transition.event),
        actionKeys: inserted.map((entry) => entry.idempotencyKey),
        cancelledActionKeys,
      });
      await this.#persist();
      return inserted;
    });
  }

  /** Return effects that have not been proved executed. */
  async replayableOutbox() {
    await this.initializeIfNeeded();
    return this.document.outbox
      .filter((entry) => ["pending", "unsupported"].includes(entry.status))
      .map((entry) => structuredClone(entry));
  }

  /** Record execution evidence without ever treating unsupported as executed. */
  async recordDispatch(idempotencyKey, result) {
    return this.#serialized(async () => {
      await this.#loadIfNeeded();
      const entry = this.document.outbox.find((candidate) => candidate.idempotencyKey === idempotencyKey);
      if (!entry) throw new Error(`Unknown maximum-utilization outbox action '${idempotencyKey}'`);
      entry.attempts += 1;
      entry.updatedAt = this.now();
      entry.status = result.status;
      entry.lastError = result.error ? String(result.error).slice(0, 500) : null;
      await this.#persist();
      return structuredClone(entry);
    });
  }

  /** Count-only status suitable for composing a separately sanitized HUD model. */
  async statusCounts() {
    await this.initializeIfNeeded();
    const counts = { pending: 0, unsupported: 0, executed: 0, cancelled: 0 };
    for (const entry of this.document.outbox) {
      if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
    }
    return counts;
  }

  async initializeIfNeeded() {
    if (!this.document) await this.initialize();
  }

  async #loadIfNeeded() {
    if (this.document) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.document = normalizeDocument(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.document = emptyDocument();
      await this.#persist();
    }
  }

  async #serialized(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async #persist() {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

function cancellationMatches(cancellation, action) {
  if (!cancellation || !Array.isArray(cancellation.actionTypes)) return false;
  const epochMatches = cancellation.epoch === action?.epoch
    || (Number.isSafeInteger(cancellation.throughEpoch) && action?.epoch <= cancellation.throughEpoch);
  if (!epochMatches) return false;
  return cancellation.actionTypes.includes(action.type);
}

function emptyDocument() {
  return { schemaVersion: JOURNAL_VERSION, nextSequence: 1, state: null, transitions: [], outbox: [] };
}

function normalizeDocument(value) {
  if (!value || value.schemaVersion !== JOURNAL_VERSION || !Array.isArray(value.transitions) || !Array.isArray(value.outbox)) {
    throw new Error("Unsupported or malformed maximum-utilization journal");
  }
  const nextSequence = Number.isSafeInteger(value.nextSequence) && value.nextSequence > 0
    ? value.nextSequence
    : value.transitions.length + 1;
  return {
    schemaVersion: JOURNAL_VERSION,
    nextSequence,
    state: value.state && typeof value.state === "object" ? value.state : null,
    transitions: value.transitions,
    outbox: value.outbox,
  };
}
