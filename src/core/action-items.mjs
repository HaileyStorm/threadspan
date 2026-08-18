import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "./errors.mjs";

export const ACTION_ITEM_SCHEMA_VERSION = 1;
export const ACTION_ITEM_STATUSES = Object.freeze(["open", "completed", "stale", "closed"]);

/** Derive the canonical same-directory lock name without changing the intended state path. */
export function actionItemLockPath(statePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : { basename, dirname, join };
  const stateName = pathApi.basename(statePath);
  const lockName = platform === "win32" ? stateName.toLocaleLowerCase("en-US") : stateName;
  return pathApi.join(pathApi.dirname(statePath), `${lockName}.lock`);
}

/** Classify only platform-verified lock contention codes; existence is checked separately. */
export function isActionItemLockContentionCode(code, platform = process.platform) {
  return code === "EEXIST" || (platform === "win32" && WINDOWS_LOCK_CONTENTION.has(code));
}

const ROOT_KEYS = new Set(["schemaVersion", "nextSequence", "items", "events", "outbox"]);
const UPSERT_KEYS = new Set([
  "ownerRef", "nativeId", "sourceRevision", "projectKey", "projectLabel", "title", "summary", "status",
]);
const READ_KEYS = new Set(["scope", "projectKey", "status", "filter", "sort", "limit"]);
const COMPLETE_KEYS = new Set(["revision", "note"]);
const CLAIM_KEYS = new Set(["limit", "leaseMs"]);
const ACK_KEYS = new Set(["claimToken", "deliveryRef"]);
const FAIL_KEYS = new Set(["claimToken", "error"]);
const REPLAY_KEYS = new Set(["limit"]);
const ITEM_KEYS = new Set([
  "handle", "ownerRef", "nativeId", "sourceRevision", "projectKey", "projectLabel", "title", "summary",
  "status", "revision", "createdAt", "updatedAt",
]);
const EVENT_KEYS = new Set([
  "sequence", "eventId", "type", "handle", "ownerRef", "nativeId", "revision", "occurredAt", "note",
]);
const OUTBOX_KEYS = new Set([
  "idempotencyKey", "eventId", "type", "ownerRef", "nativeId", "handle", "revision", "note", "status",
  "attempts", "createdAt", "updatedAt", "claimToken", "claimUntil", "lastError", "deliveryRef", "deliveredAt",
]);
const OUTBOX_STATUSES = new Set(["pending", "claimed", "failed", "delivered"]);
const SORTS = new Set(["updated-desc", "updated-asc", "created-desc", "created-asc", "title-asc", "title-desc"]);
const SCOPES = new Set(["all", "global", "project"]);
const PUBLIC_PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const OPAQUE_HANDLE = /^act_[0-9a-f]{32}$/;
const OPAQUE_EVENT = /^aevt_[0-9a-f]{32}$/;
const OPAQUE_CLAIM = /^aclaim_[0-9a-f]{32}$/;
const OUTBOX_KEY = /^action-item-completion\/aevt_[0-9a-f]{32}$/;
const PRIVATE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ABSOLUTE_PATH = /(?:^|[\s('"`=])(?:~[\\/]|\/[A-Za-z0-9._-]|[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-])/u;
const RELATIVE_TRAVERSAL = /\.\.[\\/]/u;
const PROMPT_PAYLOAD = /(?:<\/?(?:system|developer|assistant|user)>|\[(?:INST|SYSTEM)\]|\b(?:system|developer)\s+(?:prompt|message)\b|\b(?:system|developer|assistant|user|prompt|instructions?)\s*:|\b(?:begin|end)\s+prompt\b|\bignore\s+(?:all\s+)?previous\s+instructions\b)/iu;
const SECRET_PAYLOAD = /(?:\b(?:api[_ -]?key|access[_ -]?token|token|auth(?:orization)?|password|secret)\s*[:=]|\bbearer\s+[A-Za-z0-9._~-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{12,}|\bxox[a-z]-[A-Za-z0-9-]{12,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.)/iu;
const CALLBACK_SECRET = /(?:https?:\/\/\S*[?&](?:code|token|key|secret|state|signature)=|\b(?:callback|redirect)[_-]?url\s*[:=]\s*https?:\/\/\S*\?)/iu;
const NATIVE_IDENTIFIER = /(?:\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b(?:task|goal|thread|turn|session)[_:-][A-Za-z0-9_-]{12,}\b)/iu;
const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  maxItems: 1_000,
  maxEvents: 5_000,
  maxOutbox: 2_000,
  maxTitle: 240,
  maxSummary: 2_000,
  maxNote: 500,
  maxError: 500,
  maxReadLimit: 500,
  maxClaimLimit: 100,
});
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const WINDOWS_LOCK_CONTENTION = new Set(["EACCES", "EBUSY", "EPERM"]);

/** Invalid action-item input or persisted state. */
export class ActionItemValidationError extends BridgeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: "action_item_invalid", status: 400, details });
    this.name = "ActionItemValidationError";
  }
}

/** A caller attempted to mutate a different action-item revision. */
export class ActionItemConflictError extends BridgeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: "action_item_revision_conflict", status: 409, details });
    this.name = "ActionItemConflictError";
  }
}

/** An action-item owner is no longer eligible for completion. */
export class ActionItemTerminalError extends BridgeError {
  /** @param {string} handle @param {string} status */
  constructor(handle, status) {
    super(`Action item is ${status} and cannot be completed`, {
      code: "action_item_terminal",
      status: 409,
      details: { lookupDigest: lookupDigest(handle), itemStatus: status },
    });
    this.name = "ActionItemTerminalError";
  }
}

/** An opaque action-item or outbox handle does not exist. */
export class ActionItemNotFoundError extends BridgeError {
  /** @param {string} kind @param {string} handle */
  constructor(kind, handle) {
    const safeKind = kind === "handle" ? "handle" : "outbox entry";
    super(`Unknown action-item ${safeKind}`, {
      code: "action_item_not_found",
      status: 404,
      details: { kind: safeKind, lookupDigest: lookupDigest(handle) },
    });
    this.name = "ActionItemNotFoundError";
  }
}

/** A stale or invalid outbox claim attempted to alter delivery state. */
export class ActionItemOutboxConflictError extends BridgeError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: "action_item_outbox_conflict", status: 409, details });
    this.name = "ActionItemOutboxConflictError";
  }
}

/** Another exact-path owner currently holds or abandoned the durable-state lock. */
export class ActionItemBusyError extends BridgeError {
  /** @param {string} message */
  constructor(message = "Action-item state is busy; explicit lock-owner recovery may be required") {
    super(message, { code: "action_item_busy", status: 409 });
    this.name = "ActionItemBusyError";
  }
}

/** A durable write crossed atomic rename but later evidence was inconclusive. */
export class ActionItemCommitAmbiguousError extends BridgeError {
  /** @param {string} message @param {unknown} [cause] */
  constructor(message = "Action-item commit outcome is ambiguous and must be reloaded", cause) {
    super(message, { code: "action_item_commit_ambiguous", status: 503, cause });
    this.name = "ActionItemCommitAmbiguousError";
  }
}

/** Durable retention capacity is exhausted and requires operator action. */
export class ActionItemCapacityError extends BridgeError {
  /** @param {string} message */
  constructor(message = "Action-item durable retention capacity is exhausted") {
    super(message, { code: "action_item_capacity", status: 507 });
    this.name = "ActionItemCapacityError";
  }
}

/**
 * Owner-private durable action-item state with atomic completion and delivery outbox transitions.
 *
 * Mutations reload under a canonical-path, exact-owner file lock. Delivered outbox records remain
 * durable and consume hard capacity, so integration must alert and apply an independently reviewed
 * retention policy before limits are reached. `readModel()` is the only public projection.
 */
export class ActionItemStore {
  /**
   * @param {{
   *   path: string,
   *   now?: () => Date|number|string,
   *   limits?: Partial<typeof DEFAULT_LIMITS>,
   *   renameFile?: typeof rename,
   *   afterRename?: () => Promise<void>|void,
   *   lockTimeoutMs?: number,
   *   lockRetryMs?: number,
   *   platform?: string,
   * }} options
   */
  constructor(options) {
    if (!isObject(options) || typeof options.path !== "string" || !options.path.trim()) {
      throw new TypeError("action-item state path is required");
    }
    this.path = resolve(options.path);
    this.now = options.now ?? (() => new Date());
    this.limits = normalizeLimits(options.limits);
    this.renameFile = options.renameFile ?? rename;
    this.afterRename = options.afterRename;
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs", TypeError);
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs", TypeError);
    this.platform = options.platform ?? process.platform;
    this.canonicalLocationPromise = null;
    this.document = null;
    this.tail = Promise.resolve();
  }

  /** Load or create the private action-item state document. */
  async initialize() {
    await this.#serialized(async () => {
      const location = await this.#canonicalLocation();
      await withStateLock(location, this, async () => {
        this.document = await loadDocument(location.statePath, this.limits, true, this.renameFile, this.afterRename);
      });
    });
    return this.stats();
  }

  /** Return count-only private-store diagnostics. */
  async stats() {
    await this.#refresh();
    return {
      items: this.document.items.length,
      events: this.document.events.length,
      outbox: this.document.outbox.length,
      pendingOutbox: this.document.outbox.filter((entry) => entry.status !== "delivered").length,
    };
  }

  /**
   * Publish a new source action or advance an existing source revision.
   * Equal source revisions are idempotent only when every supplied field is unchanged.
   *
   * @param {{
   *   ownerRef: string,
   *   nativeId: string,
   *   sourceRevision: number,
   *   projectKey?: string|null,
   *   projectLabel?: string|null,
   *   title: string,
   *   summary?: string|null,
   *   status?: "open"|"stale"|"closed",
   * }} input
   * @returns {Promise<Record<string, unknown>>}
   */
  async upsert(input) {
    const normalized = normalizeUpsert(input, this.limits);
    return this.#mutate((candidate) => {
      const existing = candidate.items.find((item) => item.ownerRef === normalized.ownerRef && item.nativeId === normalized.nativeId);
      if (!existing) {
        assertCapacity(candidate, this.limits, { items: 1 });
        assertProjectBinding(candidate, normalized);
        const committedAt = nextTimestamp(candidate, this.now);
        const item = {
          handle: opaqueId("act"),
          ...normalized,
          revision: 1,
          createdAt: committedAt,
          updatedAt: committedAt,
        };
        candidate.items.push(item);
        return transaction(publicItem(item), true);
      }
      if (existing.status === "completed") throw new ActionItemTerminalError(existing.handle, existing.status);
      if (normalized.sourceRevision < existing.sourceRevision) {
        throw new ActionItemConflictError(`Source revision ${normalized.sourceRevision} is older than ${existing.sourceRevision}`, {
          lookupDigest: lookupDigest(existing.handle),
          expectedSourceRevision: existing.sourceRevision,
          actualSourceRevision: normalized.sourceRevision,
        });
      }
      if (normalized.sourceRevision === existing.sourceRevision) {
        if (!samePublishedFields(existing, normalized)) {
          throw new ActionItemConflictError(`Source revision ${normalized.sourceRevision} was reused with different content`, {
            lookupDigest: lookupDigest(existing.handle),
            actualSourceRevision: normalized.sourceRevision,
          });
        }
        return transaction(publicItem(existing), false);
      }
      if (existing.projectKey === normalized.projectKey && existing.projectLabel !== normalized.projectLabel) {
        throw new ActionItemValidationError("projectKey is already bound to a different public label");
      }
      assertProjectBinding(candidate, normalized, existing.handle);
      const committedAt = nextTimestamp(candidate, this.now);
      Object.assign(existing, normalized, { revision: existing.revision + 1, updatedAt: committedAt });
      return transaction(publicItem(existing), true);
    });
  }

  /** Alias emphasizing that a source revision is being published. */
  async publish(input) {
    return this.upsert(input);
  }

  /**
   * Return the only public action-item projection, grouped into global and project sections.
   * @param {{
   *   scope?: "all"|"global"|"project",
   *   projectKey?: string,
   *   status?: string|string[],
   *   filter?: string,
   *   sort?: "updated-desc"|"updated-asc"|"created-desc"|"created-asc"|"title-asc"|"title-desc",
   *   limit?: number,
   * }} [options]
   */
  async readModel(options = {}) {
    const query = normalizeReadOptions(options, this.limits);
    await this.#refresh();
    let items = this.document.items.filter((item) => {
      if (query.scope === "global" && item.projectKey !== null) return false;
      if (query.scope === "project" && item.projectKey === null) return false;
      if (query.projectKey && item.projectKey !== query.projectKey) return false;
      if (query.status && !query.status.has(item.status)) return false;
      if (query.filter) {
        const haystack = `${item.title}\n${item.summary ?? ""}\n${item.projectLabel ?? ""}`.toLocaleLowerCase("en-US");
        if (!haystack.includes(query.filter)) return false;
      }
      return true;
    });
    items = items.sort(sortItems(query.sort)).slice(0, query.limit);
    const globalItems = items.filter((item) => item.projectKey === null).map(publicItem);
    const projectMap = new Map();
    for (const item of items) {
      if (item.projectKey === null) continue;
      let project = projectMap.get(item.projectKey);
      if (!project) {
        project = { key: item.projectKey, label: item.projectLabel, count: 0, items: [] };
        projectMap.set(item.projectKey, project);
      }
      project.items.push(publicItem(item));
      project.count += 1;
    }
    return {
      schemaVersion: ACTION_ITEM_SCHEMA_VERSION,
      total: items.length,
      global: { count: globalItems.length, items: globalItems },
      projects: [...projectMap.values()].sort((left, right) => compareText(left.label, right.label) || compareText(left.key, right.key)),
    };
  }

  /**
   * Complete an open item and atomically enqueue exactly one exact-owner delivery.
   * @param {string} handle Opaque public action-item handle.
   * @param {{revision: number, note?: string|null}} input Optimistic revision and optional bounded note.
   */
  async complete(handle, input) {
    const normalizedHandle = actionHandle(handle);
    const completion = normalizeCompletion(input, this.limits);
    return this.#mutate((candidate) => {
      const item = candidate.items.find((entry) => entry.handle === normalizedHandle);
      if (!item) throw new ActionItemNotFoundError("handle", normalizedHandle);
      if (completion.note !== null) assertNoPrivateReferences(completion.note, "note", [item.ownerRef, item.nativeId]);
      if (item.status === "completed") return transaction(receiptFor(completionEventFor(candidate, item)), false);
      if (item.status === "stale" || item.status === "closed") throw new ActionItemTerminalError(item.handle, item.status);
      if (item.revision !== completion.revision) {
        throw new ActionItemConflictError("Action-item revision changed", {
          lookupDigest: lookupDigest(item.handle),
          expectedRevision: item.revision,
          actualRevision: completion.revision,
        });
      }
      assertCapacity(candidate, this.limits, { events: 1, outbox: 1 });
      const committedAt = nextTimestamp(candidate, this.now);
      item.status = "completed";
      item.revision += 1;
      item.updatedAt = committedAt;
      const event = appendCompletionEvent(candidate, item, committedAt, completion.note);
      const receipt = receiptFor(event);
      candidate.outbox.push({
        idempotencyKey: completionIdempotencyKey(event),
        eventId: event.eventId,
        type: "action-item.completed",
        ownerRef: item.ownerRef,
        nativeId: item.nativeId,
        handle: item.handle,
        revision: item.revision,
        note: completion.note,
        status: "pending",
        attempts: 0,
        createdAt: committedAt,
        updatedAt: committedAt,
        claimToken: null,
        claimUntil: null,
        lastError: null,
        deliveryRef: null,
        deliveredAt: null,
      });
      return transaction(receipt, true);
    });
  }

  /** Claim replayable owner deliveries for a bounded lease. */
  async claimOutbox(options = {}) {
    const claim = normalizeClaimOptions(options, this.limits);
    return this.#mutate((candidate) => {
      const committedAt = nextTimestamp(candidate, this.now);
      const eligible = candidate.outbox
        .filter((entry) => isReplayable(entry, committedAt))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey))
        .slice(0, claim.limit);
      if (eligible.length === 0) return transaction([], false);
      for (const entry of eligible) {
        entry.status = "claimed";
        entry.attempts += 1;
        entry.updatedAt = committedAt;
        entry.claimToken = opaqueId("aclaim");
        entry.claimUntil = new Date(Date.parse(committedAt) + claim.leaseMs).toISOString();
        entry.lastError = null;
      }
      return transaction(eligible.map(privateOutboxEntry), true);
    });
  }

  /** Mark one claimed delivery as acknowledged by the exact-owner adapter. */
  async ackOutbox(idempotencyKey, input) {
    const key = outboxKey(idempotencyKey);
    const ack = normalizeAck(input);
    return this.#mutate((candidate) => {
      const entry = candidate.outbox.find((item) => item.idempotencyKey === key);
      if (!entry) throw new ActionItemNotFoundError("outbox entry", key);
      if (entry.status === "delivered") return transaction(privateOutboxEntry(entry), false);
      assertActiveClaim(entry, ack.claimToken);
      const committedAt = nextTimestamp(candidate, this.now);
      entry.status = "delivered";
      entry.updatedAt = committedAt;
      entry.claimToken = null;
      entry.claimUntil = null;
      entry.lastError = null;
      entry.deliveryRef = ack.deliveryRef;
      entry.deliveredAt = committedAt;
      return transaction(privateOutboxEntry(entry), true);
    });
  }

  /** Release one claimed delivery for later replay while preserving bounded failure evidence. */
  async failOutbox(idempotencyKey, input) {
    const key = outboxKey(idempotencyKey);
    const failure = normalizeFailure(input, this.limits);
    return this.#mutate((candidate) => {
      const entry = candidate.outbox.find((item) => item.idempotencyKey === key);
      if (!entry) throw new ActionItemNotFoundError("outbox entry", key);
      if (entry.status === "delivered") {
        throw new ActionItemOutboxConflictError("Outbox entry is already delivered", { lookupDigest: lookupDigest(key) });
      }
      assertActiveClaim(entry, failure.claimToken);
      const committedAt = nextTimestamp(candidate, this.now);
      entry.status = "failed";
      entry.updatedAt = committedAt;
      entry.claimToken = null;
      entry.claimUntil = null;
      entry.lastError = failure.error;
      return transaction(privateOutboxEntry(entry), true);
    });
  }

  /** Return pending, failed, or lease-expired owner deliveries without mutating them. */
  async replayOutbox(options = {}) {
    const replay = normalizeReplayOptions(options, this.limits);
    await this.#refresh();
    const observedAt = clockTimestamp(this.now(), "now");
    return this.document.outbox
      .filter((entry) => isReplayable(entry, observedAt))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.idempotencyKey.localeCompare(right.idempotencyKey))
      .slice(0, replay.limit)
      .map(privateOutboxEntry);
  }

  async #canonicalLocation() {
    this.canonicalLocationPromise ??= canonicalStateLocation(this.path, this.platform);
    return this.canonicalLocationPromise;
  }

  async #refresh() {
    return this.#serialized(async () => {
      const location = await this.#canonicalLocation();
      try {
        this.document = await loadDocument(location.statePath, this.limits, false, this.renameFile, this.afterRename);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await withStateLock(location, this, async () => {
          this.document = await loadDocument(location.statePath, this.limits, true, this.renameFile, this.afterRename);
        });
      }
    });
  }

  #serialized(operation) {
    const execution = this.tail.catch(() => undefined).then(operation);
    this.tail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  #mutate(operation) {
    return this.#serialized(async () => {
      const location = await this.#canonicalLocation();
      return withStateLock(location, this, async () => {
        const current = await loadDocument(location.statePath, this.limits, true, this.renameFile, this.afterRename);
        const candidate = structuredClone(current);
        const outcome = operation(candidate);
        if (!isTransaction(outcome)) throw new TypeError("Action-item mutation returned an invalid transaction result");
        if (!outcome.commit) {
          this.document = current;
          return structuredClone(outcome.result);
        }
        validateDocument(candidate, this.limits);
        try {
          await persistDocument(location.statePath, candidate, this.limits, this.renameFile, this.afterRename);
          this.document = candidate;
        } catch (error) {
          this.document = null;
          throw error;
        }
        return structuredClone(outcome.result);
      });
    });
  }
}

function normalizeUpsert(input, limits) {
  assertClosedObject(input, UPSERT_KEYS, "Action-item source");
  const ownerRef = privateReference(input.ownerRef, "ownerRef");
  const nativeId = privateReference(input.nativeId, "nativeId");
  const sourceRevision = positiveInteger(input.sourceRevision, "sourceRevision");
  const privateReferences = [ownerRef, nativeId];
  const hasProjectKey = input.projectKey !== undefined && input.projectKey !== null;
  const hasProjectLabel = input.projectLabel !== undefined && input.projectLabel !== null;
  if (hasProjectKey !== hasProjectLabel) throw new ActionItemValidationError("projectKey and projectLabel must be supplied together");
  const projectKey = hasProjectKey ? publicProjectKey(input.projectKey, privateReferences) : null;
  const projectLabel = hasProjectLabel ? publicProjectLabel(input.projectLabel, privateReferences) : null;
  const title = boundDisplayText(input.title, "title", limits.maxTitle, privateReferences);
  const summary = input.summary === undefined || input.summary === null
    ? null
    : boundDisplayText(input.summary, "summary", limits.maxSummary, privateReferences);
  const status = input.status ?? "open";
  if (!["open", "stale", "closed"].includes(status)) {
    throw new ActionItemValidationError("Published action-item status must be open, stale, or closed");
  }
  return { ownerRef, nativeId, sourceRevision, projectKey, projectLabel, title, summary, status };
}

function normalizeReadOptions(input, limits) {
  assertClosedObject(input, READ_KEYS, "Action-item read options");
  const scope = input.scope ?? "all";
  if (!SCOPES.has(scope)) throw new ActionItemValidationError("Unsupported action-item scope");
  const projectKey = input.projectKey === undefined ? null : publicProjectKey(input.projectKey);
  if (scope === "global" && projectKey) throw new ActionItemValidationError("Global scope cannot include projectKey");
  if (scope === "project" && !projectKey) throw new ActionItemValidationError("Project scope requires projectKey");
  let status = null;
  if (input.status !== undefined) {
    const values = Array.isArray(input.status) ? input.status : [input.status];
    if (values.length === 0 || values.some((value) => !ACTION_ITEM_STATUSES.includes(value))) {
      throw new ActionItemValidationError("status filter contains an unsupported status");
    }
    status = new Set(values);
  }
  const filter = input.filter === undefined ? null : displayText(input.filter, "filter", 160).toLocaleLowerCase("en-US");
  const sort = input.sort ?? "updated-desc";
  if (!SORTS.has(sort)) throw new ActionItemValidationError("Unsupported action-item sort");
  const limit = input.limit === undefined ? limits.maxReadLimit : boundedInteger(input.limit, "limit", 1, limits.maxReadLimit);
  return { scope, projectKey, status, filter, sort, limit };
}

function normalizeCompletion(input, limits) {
  assertClosedObject(input, COMPLETE_KEYS, "Action-item completion");
  return {
    revision: positiveInteger(input.revision, "revision"),
    note: input.note === undefined || input.note === null ? null : displayText(input.note, "note", limits.maxNote),
  };
}

function normalizeClaimOptions(input, limits) {
  assertClosedObject(input, CLAIM_KEYS, "Action-item outbox claim options");
  return {
    limit: input.limit === undefined ? Math.min(20, limits.maxClaimLimit) : boundedInteger(input.limit, "limit", 1, limits.maxClaimLimit),
    leaseMs: input.leaseMs === undefined ? 30_000 : boundedInteger(input.leaseMs, "leaseMs", 1_000, 900_000),
  };
}

function normalizeAck(input) {
  assertClosedObject(input, ACK_KEYS, "Action-item outbox acknowledgement");
  return {
    claimToken: claimToken(input.claimToken),
    deliveryRef: input.deliveryRef === undefined || input.deliveryRef === null
      ? null
      : privateReference(input.deliveryRef, "deliveryRef"),
  };
}

function normalizeFailure(input, limits) {
  assertClosedObject(input, FAIL_KEYS, "Action-item outbox failure");
  return {
    claimToken: claimToken(input.claimToken),
    error: displayText(input.error, "error", limits.maxError),
  };
}

function normalizeReplayOptions(input, limits) {
  assertClosedObject(input, REPLAY_KEYS, "Action-item outbox replay options");
  return { limit: input.limit === undefined ? limits.maxClaimLimit : boundedInteger(input.limit, "limit", 1, limits.maxClaimLimit) };
}

function normalizeLimits(input = {}) {
  if (!isObject(input)) throw new TypeError("action-item limits must be an object");
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key));
  if (unknown.length > 0) throw new TypeError("Unsupported action-item limits");
  const result = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    result[key] = positiveInteger(value, `limits.${key}`, TypeError);
    if (result[key] > DEFAULT_LIMITS[key]) throw new TypeError(`limits.${key} cannot exceed the hard maximum ${DEFAULT_LIMITS[key]}`);
  }
  return Object.freeze(result);
}

/** Resolve path aliases before deriving the same-directory transaction lock. */
async function canonicalStateLocation(path, platform) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const statePath = join(await realpath(dirname(path)), basename(path));
  return { statePath, lockPath: actionItemLockPath(statePath, { platform }) };
}

/** Run one reload-and-mutate transaction while holding an exact canonical-path lock. */
async function withStateLock(location, options, operation) {
  const { lockPath } = location;
  const token = randomUUID();
  const deadline = Date.now() + options.lockTimeoutMs;
  while (true) {
    try {
      await createOwnedLock(lockPath, token);
      break;
    } catch (error) {
      if (!isActionItemLockContentionCode(error?.code, options.platform)) throw error;
      const lockExists = await assertExistingLockSafe(lockPath);
      if (!lockExists) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      if (Date.now() >= deadline) throw new ActionItemBusyError();
      await delay(options.lockRetryMs);
    }
  }

  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }
  try {
    await releaseOwnedLock(lockPath, token);
  } catch (error) {
    if (!operationError) throw new ActionItemCommitAmbiguousError("Action-item lock release failed; durable state must be reloaded", error);
  }
  if (operationError) throw operationError;
  return result;
}

/** Create and flush a private, single-link lock record owned by one random token. */
async function createOwnedLock(lockPath, token) {
  let handle;
  let metadata;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new ActionItemBusyError("Action-item lock is not a private single-link file");
    await handle.chmod(0o600);
  } catch (error) {
    if (handle) {
      metadata ??= await handle.stat().catch(() => undefined);
      await handle.close().catch(() => undefined);
      handle = undefined;
      const current = await lstat(lockPath).catch(() => undefined);
      if (metadata && current && current.dev === metadata.dev && current.ino === metadata.ino) {
        await unlink(lockPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reject unsafe, linked, or malformed blockers without ever clearing them automatically. */
async function assertExistingLockSafe(lockPath) {
  try {
    const metadata = await lstat(lockPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
      throw new ActionItemBusyError("Action-item lock requires explicit owner recovery");
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Remove only the same inode and exact token created by this transaction. */
async function releaseOwnedLock(lockPath, token) {
  let handle;
  try {
    handle = await open(lockPath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new ActionItemBusyError("Action-item lock is not an exact private file");
    const owner = JSON.parse(await handle.readFile("utf8"));
    const current = await lstat(lockPath);
    const sameFile = current.isFile() && !current.isSymbolicLink()
      && current.dev === metadata.dev && current.ino === metadata.ino && current.nlink === 1;
    if (!sameFile || owner?.token !== token) throw new ActionItemBusyError("Action-item lock ownership changed during release");
    await unlink(lockPath);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadDocument(path, limits, create, renameFile, afterRename) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new ActionItemValidationError("Action-item state path must be a private single-link regular file");
    }
    if (metadata.size > limits.maxBytes) throw new ActionItemCapacityError(`Action-item durable state exceeds ${limits.maxBytes} bytes`);
    const source = await readFile(path, "utf8");
    if (Buffer.byteLength(source, "utf8") > limits.maxBytes) {
      throw new ActionItemCapacityError(`Action-item durable state exceeds ${limits.maxBytes} bytes`);
    }
    const document = JSON.parse(source);
    validateDocument(document, limits);
    await chmod(path, 0o600);
    return document;
  } catch (error) {
    if (error?.code === "ENOENT" && create) {
      const document = emptyDocument();
      await persistDocument(path, document, limits, renameFile, afterRename);
      return document;
    }
    if (error instanceof SyntaxError) throw new ActionItemValidationError("Action-item state is not valid JSON", { cause: error.message });
    throw error;
  }
}

function validateDocument(document, limits) {
  assertClosedObject(document, ROOT_KEYS, "Action-item state");
  if (document.schemaVersion !== ACTION_ITEM_SCHEMA_VERSION) throw new ActionItemValidationError("Unsupported action-item schema version");
  positiveInteger(document.nextSequence, "nextSequence");
  if (!Array.isArray(document.items) || !Array.isArray(document.events) || !Array.isArray(document.outbox)) {
    throw new ActionItemValidationError("Action-item state arrays are malformed");
  }
  if (document.items.length > limits.maxItems || document.events.length > limits.maxEvents || document.outbox.length > limits.maxOutbox) {
    throw new ActionItemCapacityError("Action-item durable state exceeds configured count capacity");
  }
  document.items.forEach((item) => validateStoredItem(item, limits));
  document.events.forEach((event) => validateStoredEvent(event, limits));
  document.outbox.forEach((entry) => validateStoredOutbox(entry, limits));
  assertUnique(document.items.map((item) => item.handle), "action-item handles");
  assertUnique(document.items.map((item) => `${item.ownerRef}\u0000${item.nativeId}`), "action-item source identities");
  const projectLabels = new Map();
  for (const item of document.items) {
    if (item.projectKey === null) continue;
    const known = projectLabels.get(item.projectKey);
    if (known !== undefined && known !== item.projectLabel) throw new ActionItemValidationError("One project key has conflicting public labels");
    projectLabels.set(item.projectKey, item.projectLabel);
  }
  assertUnique(document.events.map((event) => event.eventId), "action-item event ids");
  assertUnique(document.events.map((event) => event.sequence), "action-item event sequences");
  assertUnique(document.outbox.map((entry) => entry.idempotencyKey), "action-item outbox keys");
  assertUnique(document.events.map((event) => receiptFor(event).receiptId), "action-item completion receipt ids");
  for (let index = 1; index < document.events.length; index += 1) {
    const previous = document.events[index - 1];
    const current = document.events[index];
    if (current.sequence <= previous.sequence || Date.parse(current.occurredAt) < Date.parse(previous.occurredAt)) {
      throw new ActionItemValidationError("Action-item events must have monotonic sequences and timestamps");
    }
  }
  const revisionsByHandle = new Map();
  for (const event of document.events) {
    const previousRevision = revisionsByHandle.get(event.handle) ?? 0;
    if (event.revision <= previousRevision) throw new ActionItemValidationError("Action-item event revisions must be monotonic");
    revisionsByHandle.set(event.handle, event.revision);
  }
  const maxSequence = document.events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
  if (document.nextSequence <= maxSequence) throw new ActionItemValidationError("nextSequence must exceed every event sequence");
  const completionEvents = new Map(document.events.filter((event) => event.type === "completed").map((event) => [event.eventId, event]));
  const itemsByHandle = new Map(document.items.map((item) => [item.handle, item]));
  for (const event of document.events) {
    const item = itemsByHandle.get(event.handle);
    if (!item || event.ownerRef !== item.ownerRef || event.nativeId !== item.nativeId || event.revision > item.revision) {
      throw new ActionItemValidationError("Action-item event does not match its durable item");
    }
  }
  for (const entry of document.outbox) {
    const event = completionEvents.get(entry.eventId);
    if (!event || entry.idempotencyKey !== completionIdempotencyKey(event) || event.handle !== entry.handle
      || event.ownerRef !== entry.ownerRef || event.nativeId !== entry.nativeId
      || event.revision !== entry.revision || event.note !== entry.note) {
      throw new ActionItemValidationError("Action-item outbox entry has no matching completion event");
    }
  }
  for (const item of document.items) {
    const completions = document.events.filter((event) => event.handle === item.handle && event.type === "completed");
    const deliveries = document.outbox.filter((entry) => entry.handle === item.handle);
    if (item.status === "completed") {
      if (completions.length !== 1 || deliveries.length !== 1
        || completions[0].revision !== item.revision
        || item.updatedAt !== completions[0].occurredAt) {
        throw new ActionItemValidationError("Completed action item must have exactly one matching completion event and delivery");
      }
    } else if (completions.length !== 0 || deliveries.length !== 0) {
      throw new ActionItemValidationError("Non-completed action item cannot have completion records");
    }
  }
}

function validateStoredItem(item, limits) {
  assertClosedObject(item, ITEM_KEYS, "Stored action item");
  actionHandle(item.handle);
  privateReference(item.ownerRef, "item.ownerRef");
  privateReference(item.nativeId, "item.nativeId");
  positiveInteger(item.sourceRevision, "item.sourceRevision");
  if ((item.projectKey === null) !== (item.projectLabel === null)) throw new ActionItemValidationError("Stored project fields must both be null or present");
  const privateReferences = [item.ownerRef, item.nativeId];
  if (item.projectKey !== null) publicProjectKey(item.projectKey, privateReferences);
  if (item.projectLabel !== null) publicProjectLabel(item.projectLabel, privateReferences);
  boundDisplayText(item.title, "item.title", limits.maxTitle, privateReferences);
  if (item.summary !== null) boundDisplayText(item.summary, "item.summary", limits.maxSummary, privateReferences);
  if (!ACTION_ITEM_STATUSES.includes(item.status)) throw new ActionItemValidationError("Stored action item has unsupported status");
  positiveInteger(item.revision, "item.revision");
  const createdAt = canonicalTimestamp(item.createdAt, "item.createdAt");
  const updatedAt = canonicalTimestamp(item.updatedAt, "item.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new ActionItemValidationError("Stored action-item timestamps are not monotonic");
}

function validateStoredEvent(event, limits) {
  assertClosedObject(event, EVENT_KEYS, "Stored action-item event");
  positiveInteger(event.sequence, "event.sequence");
  if (!OPAQUE_EVENT.test(event.eventId)) throw new ActionItemValidationError("Action-item event id is malformed");
  if (event.type !== "completed") throw new ActionItemValidationError("Action-item event type is malformed");
  actionHandle(event.handle);
  privateReference(event.ownerRef, "event.ownerRef");
  privateReference(event.nativeId, "event.nativeId");
  positiveInteger(event.revision, "event.revision");
  canonicalTimestamp(event.occurredAt, "event.occurredAt");
  if (event.note !== null) boundDisplayText(event.note, "event.note", limits.maxNote, [event.ownerRef, event.nativeId]);
}

function validateStoredOutbox(entry, limits) {
  assertClosedObject(entry, OUTBOX_KEYS, "Stored action-item outbox entry");
  outboxKey(entry.idempotencyKey);
  if (!OPAQUE_EVENT.test(entry.eventId) || entry.type !== "action-item.completed") throw new ActionItemValidationError("Stored action-item outbox identity is malformed");
  privateReference(entry.ownerRef, "outbox.ownerRef");
  privateReference(entry.nativeId, "outbox.nativeId");
  actionHandle(entry.handle);
  positiveInteger(entry.revision, "outbox.revision");
  if (entry.note !== null) boundDisplayText(entry.note, "outbox.note", limits.maxNote, [entry.ownerRef, entry.nativeId]);
  if (!OUTBOX_STATUSES.has(entry.status)) throw new ActionItemValidationError("Stored action-item outbox status is malformed");
  boundedInteger(entry.attempts, "outbox.attempts", 0, Number.MAX_SAFE_INTEGER);
  const createdAt = canonicalTimestamp(entry.createdAt, "outbox.createdAt");
  const updatedAt = canonicalTimestamp(entry.updatedAt, "outbox.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new ActionItemValidationError("Stored outbox timestamps are not monotonic");
  if (entry.status === "claimed") {
    claimToken(entry.claimToken);
    const claimUntil = canonicalTimestamp(entry.claimUntil, "outbox.claimUntil");
    if (Date.parse(claimUntil) <= Date.parse(updatedAt)) throw new ActionItemValidationError("Outbox claim lease must end after its update timestamp");
  } else if (entry.claimToken !== null || entry.claimUntil !== null) {
    throw new ActionItemValidationError("Only claimed outbox entries may contain claim state");
  }
  if (entry.lastError !== null) displayText(entry.lastError, "outbox.lastError", limits.maxError);
  if (entry.deliveryRef !== null) privateReference(entry.deliveryRef, "outbox.deliveryRef");
  if (entry.status === "delivered") {
    const deliveredAt = canonicalTimestamp(entry.deliveredAt, "outbox.deliveredAt");
    if (deliveredAt !== updatedAt) throw new ActionItemValidationError("Delivered outbox timestamp must match its terminal update");
  }
  else if (entry.deliveredAt !== null || entry.deliveryRef !== null) throw new ActionItemValidationError("Only delivered outbox entries may contain delivery evidence");
}

async function persistDocument(path, document, limits, renameFile, afterRename) {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > limits.maxBytes) {
    throw new ActionItemCapacityError(`Action-item durable state exceeds ${limits.maxBytes} bytes`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await renameFile(temporary, path);
    renamed = true;
    await afterRename?.();
    await syncDirectory(dirname(path));
  } catch (error) {
    if (renamed) throw new ActionItemCommitAmbiguousError(undefined, error);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function emptyDocument() {
  return { schemaVersion: ACTION_ITEM_SCHEMA_VERSION, nextSequence: 1, items: [], events: [], outbox: [] };
}

function appendCompletionEvent(document, item, occurredAt, note) {
  const event = {
    sequence: document.nextSequence++,
    eventId: opaqueId("aevt"),
    type: "completed",
    handle: item.handle,
    ownerRef: item.ownerRef,
    nativeId: item.nativeId,
    revision: item.revision,
    occurredAt,
    note,
  };
  document.events.push(event);
  return event;
}

function assertCapacity(document, limits, additions) {
  if (document.items.length + (additions.items ?? 0) > limits.maxItems
    || document.events.length + (additions.events ?? 0) > limits.maxEvents
    || document.outbox.length + (additions.outbox ?? 0) > limits.maxOutbox) {
    throw new ActionItemCapacityError("Action-item durable retention has reached its configured count capacity");
  }
}

function assertProjectBinding(document, input, excludedHandle) {
  if (input.projectKey === null) return;
  const conflict = document.items.find((item) => item.handle !== excludedHandle
    && item.projectKey === input.projectKey
    && item.projectLabel !== input.projectLabel);
  if (conflict) throw new ActionItemValidationError("projectKey is already bound to a different public label");
}

function publicItem(item) {
  return {
    handle: item.handle,
    projectKey: item.projectKey,
    projectLabel: item.projectLabel,
    title: item.title,
    summary: item.summary,
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.status === "completed" ? item.updatedAt : null,
  };
}

function completionEventFor(document, item) {
  const event = document.events.find((candidate) => candidate.handle === item.handle && candidate.type === "completed");
  if (!event) throw new ActionItemValidationError("Completed action item is missing its completion event");
  return event;
}

function receiptFor(event) {
  return {
    receiptId: `arcpt_${event.eventId.slice("aevt_".length)}`,
    handle: event.handle,
    status: "completed",
    revision: event.revision,
    completedAt: event.occurredAt,
  };
}

function completionIdempotencyKey(event) {
  return `action-item-completion/${event.eventId}`;
}

function privateOutboxEntry(entry) {
  return structuredClone(entry);
}

function samePublishedFields(item, input) {
  return ["ownerRef", "nativeId", "sourceRevision", "projectKey", "projectLabel", "title", "summary", "status"]
    .every((key) => item[key] === input[key]);
}

function sortItems(sort) {
  const [field, direction] = sort.split("-");
  const key = field === "title" ? "title" : `${field}At`;
  const multiplier = direction === "desc" ? -1 : 1;
  return (left, right) => multiplier * compareText(left[key], right[key]) || compareText(left.handle, right.handle);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right), "en-US", { sensitivity: "base" });
}

function nextTimestamp(document, now) {
  const proposed = Date.parse(clockTimestamp(now(), "now"));
  let latest = 0;
  for (const item of document.items) latest = Math.max(latest, Date.parse(item.updatedAt));
  for (const event of document.events) latest = Math.max(latest, Date.parse(event.occurredAt));
  for (const entry of document.outbox) latest = Math.max(latest, Date.parse(entry.updatedAt));
  return new Date(Math.max(proposed, latest + 1)).toISOString();
}

function isReplayable(entry, observedAt) {
  if (entry.status === "pending" || entry.status === "failed") return true;
  return entry.status === "claimed" && Date.parse(entry.claimUntil) <= Date.parse(observedAt);
}

function assertActiveClaim(entry, token) {
  if (entry.status !== "claimed" || entry.claimToken !== token) {
    throw new ActionItemOutboxConflictError("Outbox entry is not held by this claim", {
      lookupDigest: lookupDigest(entry.idempotencyKey),
    });
  }
}

function actionHandle(value) {
  if (typeof value !== "string" || !OPAQUE_HANDLE.test(value)) throw new ActionItemValidationError("Action-item handle is malformed");
  return value;
}

function claimToken(value) {
  if (typeof value !== "string" || !OPAQUE_CLAIM.test(value)) throw new ActionItemValidationError("Action-item claim token is malformed");
  return value;
}

function outboxKey(value) {
  if (typeof value !== "string" || !OUTBOX_KEY.test(value)) {
    throw new ActionItemValidationError("Action-item outbox key is malformed");
  }
  return value;
}

function privateReference(value, field) {
  if (typeof value !== "string" || !PRIVATE_REFERENCE.test(value)) {
    throw new ActionItemValidationError(`${field} must be a bounded opaque reference`);
  }
  return value;
}

function publicProjectKey(value, privateReferences = []) {
  if (typeof value !== "string" || !PUBLIC_PROJECT_KEY.test(value) || value === "." || value === ".." || NATIVE_IDENTIFIER.test(value)) {
    throw new ActionItemValidationError("projectKey must be a public opaque key, not a path");
  }
  assertNoPrivateReferences(value, "projectKey", privateReferences);
  return value;
}

function publicProjectLabel(value, privateReferences = []) {
  const label = boundDisplayText(value, "projectLabel", 120, privateReferences);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()'&-]*$/u.test(label) || /(?:^|\s)~|\.\.|:\\|:\//.test(label)) {
    throw new ActionItemValidationError("projectLabel must be a sanitized public label, not a path");
  }
  return label;
}

function boundedText(value, field, maximum, options = {}) {
  if (typeof value !== "string") throw new ActionItemValidationError(`${field} must be a string`);
  if (CONTROL_CHARACTERS.test(value)) throw new ActionItemValidationError(`${field} contains control characters`);
  const normalized = options.compact === false ? value.trim() : value.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new ActionItemValidationError(`${field} must not be empty`);
  if ([...normalized].length > maximum) throw new ActionItemValidationError(`${field} exceeds ${maximum} characters`);
  return normalized;
}

function displayText(value, field, maximum) {
  const normalized = boundedText(value, field, maximum);
  if (ABSOLUTE_PATH.test(normalized) || RELATIVE_TRAVERSAL.test(normalized) || PROMPT_PAYLOAD.test(normalized) || SECRET_PAYLOAD.test(normalized)
    || CALLBACK_SECRET.test(normalized) || NATIVE_IDENTIFIER.test(normalized)) {
    throw new ActionItemValidationError(`${field} contains private or unsafe display content`);
  }
  return normalized;
}

function boundDisplayText(value, field, maximum, privateReferences) {
  const normalized = displayText(value, field, maximum);
  assertNoPrivateReferences(normalized, field, privateReferences);
  return normalized;
}

function assertNoPrivateReferences(value, field, privateReferences) {
  const folded = value.toLocaleLowerCase("en-US");
  if (privateReferences.some((reference) => folded.includes(reference.toLocaleLowerCase("en-US")))) {
    throw new ActionItemValidationError(`${field} contains private or unsafe display content`);
  }
}

function canonicalTimestamp(value, field) {
  if (typeof value !== "string") throw new ActionItemValidationError(`${field} must be a canonical ISO timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ActionItemValidationError(`${field} must be a valid timestamp`);
  const canonical = date.toISOString();
  if (value !== canonical) throw new ActionItemValidationError(`${field} must be a canonical ISO timestamp`);
  return canonical;
}

function clockTimestamp(value, field) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ActionItemValidationError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function positiveInteger(value, field, ErrorType = ActionItemValidationError) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ErrorType(`${field} must be a positive integer`);
  return value;
}

function boundedInteger(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ActionItemValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertClosedObject(value, allowed, label) {
  if (!isObject(value)) throw new ActionItemValidationError(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new ActionItemValidationError(`${label} contains unsupported fields`);
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new ActionItemValidationError(`Duplicate ${label}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function opaqueId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function lookupDigest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 20);
}

function transaction(result, commit) {
  return { transaction: true, commit, result };
}

function isTransaction(value) {
  return isObject(value) && value.transaction === true && typeof value.commit === "boolean" && Object.hasOwn(value, "result");
}
