import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const ACTIVE_MONITOR_PHASES = new Set([
  "observed",
  "pending-replay",
  "retrying",
  "unsupported-candidate",
  "unsupported-liveness",
  "unsupported-candidates",
  "unsupported-start",
  "waiting-coordinator",
]);

/** Conservative defaults for daemon-owned automatic takeover. */
export const DEFAULT_AUTOMATIC_TAKEOVER_POLICY = Object.freeze({
  enabled: false,
  crossProviderEnabled: false,
  batchSize: 2,
  staggerMs: 1_000,
  tickIntervalMs: 0,
  maxJournalEntries: 2_000,
});

/**
 * Provider-neutral external liveness and takeover coordinator.
 *
 * Adapters are deliberately small. `startReplacement` must honor the supplied
 * idempotency key: an indeterminate call is replayed with the same key after a
 * retry or daemon restart. It may return `{status: "active"|"queued", receipt}`,
 * `{status: "exhausted"}`, or `{supported: false}`.
 */
export class AutomaticTakeoverController {
  /**
   * @param {{
   *   statePath: string,
   *   policy?: Partial<typeof DEFAULT_AUTOMATIC_TAKEOVER_POLICY>,
   *   adapters?: {
   *     readLiveness?: (target: Record<string, any>) => Promise<string|{status: string}>,
   *     listCandidates?: (target: Record<string, any>) => Promise<Record<string, any>[]>,
   *     startReplacement?: (request: Record<string, any>) => Promise<Record<string, any>>,
   *     cancelQueuedReplacement?: (request: Record<string, any>) => Promise<Record<string, any>|void>,
   *   },
   *   now?: () => number|Date|string,
   *   logger?: {warn?: Function},
   * }} options
   */
  constructor(options) {
    if (!options?.statePath) throw new TypeError("automatic takeover statePath is required");
    this.statePath = validateStatePath(options.statePath);
    this.policy = normalizePolicy(options.policy);
    this.adapters = Object.freeze({ ...(options.adapters ?? {}) });
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
    this.state = null;
    this.tail = Promise.resolve();
    this.initializeInFlight = null;
    this.tickInFlight = null;
    this.timer = null;
    this.closed = false;
  }

  /** Restore private state without dispatching unjournaled effects. */
  async initialize() {
    if (this.state) return this.readModel();
    this.initializeInFlight ??= this.#serialized(() => this.#initialize())
      .finally(() => { this.initializeInFlight = null; });
    return this.initializeInFlight;
  }

  /**
   * Register one coordinator or subagent and freeze all takeover constraints.
   * Re-registering an identical target is idempotent; changing it fails closed.
   * @param {Record<string, any>} input
   */
  async registerTarget(input) {
    await this.initialize();
    return this.#serialized(async () => {
      this.#assertOpen();
      const target = normalizeTarget(input, this.state);
      const existing = this.state.targets[target.targetId];
      if (existing) {
        if (stableStringify(targetComparable(existing)) !== stableStringify(targetComparable(target))) {
          throw new Error("A registered takeover target cannot be redefined");
        }
        return { registered: false, handle: existing.handle };
      }
      this.state.targets[target.targetId] = target;
      this.#journal("target-registered", null, { targetHandle: target.handle });
      await this.#persist();
      return { registered: true, handle: target.handle };
    });
  }

  /**
   * Record one externally observed failure, deduplicated by the exact failed
   * target/provider/account/quota-window tuple.
   * @param {{targetId: string, providerId: string, accountId: string, quotaWindowId: string, kind?: string}} input
   */
  async observeFailure(input) {
    await this.initialize();
    return this.#serialized(async () => {
      this.#assertOpen();
      const targetId = requiredString(input?.targetId, "targetId");
      const target = this.state.targets[targetId];
      if (!target) throw new Error("Cannot observe failure for an unregistered target");
      const providerId = requiredString(input?.providerId, "providerId");
      const accountId = requiredString(input?.accountId, "accountId");
      const quotaWindowId = requiredString(input?.quotaWindowId, "quotaWindowId");
      if (providerId !== target.providerId || accountId !== target.accountId || quotaWindowId !== target.quotaWindowId) {
        throw new Error("Failure identity does not match the registered target route");
      }
      const dedupeKey = tupleKey(targetId, providerId, accountId, quotaWindowId);
      const knownHandle = this.state.monitorByTuple[dedupeKey];
      if (knownHandle) {
        const known = this.state.monitors[knownHandle];
        return { accepted: true, duplicate: true, handle: known.handle, phase: known.phase };
      }
      const handle = opaqueHandle(this.state.secret, "monitor", dedupeKey);
      const monitor = {
        handle,
        dedupeKey,
        targetId,
        providerId,
        accountId,
        quotaWindowId,
        kind: optionalString(input?.kind) ?? "liveness",
        order: this.state.nextOrder++,
        phase: initialMonitorPhase(this.state, this.policy, target),
        automatic: this.policy.enabled === true && this.state.ownerDisabled !== true,
        attempts: {},
        replacement: null,
        reset: null,
      };
      if (["blocked-explicit-route", "protected-running", "disabled"].includes(monitor.phase)) monitor.automatic = false;
      this.state.monitors[handle] = monitor;
      this.state.monitorByTuple[dedupeKey] = handle;
      this.#journal("failure-observed", monitor);
      await this.#persist();
      return { accepted: true, duplicate: false, handle, phase: monitor.phase };
    });
  }

  /**
   * Reconcile exact reset evidence, liveness, and durable takeover effects.
   * @param {{resetEvidence?: Record<string, any>|Record<string, any>[]}} [input]
   */
  async tick(input = {}) {
    await this.initialize();
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.#serialized(() => this.#tick(input))
      .finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  /** Return only aggregate counts, phases, and opaque monitor handles. */
  async readModel() {
    if (!this.state) await this.initialize();
    const monitors = Object.values(this.state.monitors).sort(compareOrder);
    const unsupported = monitors.filter((monitor) => monitor.phase.startsWith("unsupported")).length
      + this.state.outbox.filter((entry) => entry.status === "unsupported").length;
    const blocked = monitors.filter((monitor) => monitor.phase.startsWith("blocked")
      || monitor.phase === "protected-running" || monitor.phase === "waiting-coordinator").length;
    const queued = monitors.filter((monitor) => monitor.replacement?.status === "queued").length;
    const active = monitors.filter((monitor) => monitor.replacement?.status === "active").length;
    const automatic = monitors.some((monitor) => monitor.automatic === true && ACTIVE_MONITOR_PHASES.has(monitor.phase));
    let phase = "idle";
    if (this.policy.enabled !== true || this.state.ownerDisabled === true) phase = "disabled";
    else if (unsupported > 0) phase = "unsupported";
    else if (automatic) phase = "automatic";
    else if (blocked > 0) phase = "blocked";
    return {
      phase,
      counts: {
        targets: Object.keys(this.state.targets).length,
        monitors: monitors.length,
        queued,
        active,
        unsupported,
        blocked,
      },
      monitors: monitors.map((monitor) => ({ handle: monitor.handle, phase: monitor.phase })),
    };
  }

  /** Disable future automatic work, cancel queued work, and leave active replacements alone. */
  async ownerDisable() {
    await this.initialize();
    return this.#serialized(async () => {
      this.state.ownerDisabled = true;
      for (const monitor of Object.values(this.state.monitors)) {
        monitor.automatic = false;
        this.#cancelPendingStarts(monitor, "owner-disabled");
        if (monitor.replacement?.status === "queued") this.#queueCancellation(monitor, "owner-disabled");
        else if (monitor.replacement?.status !== "active") monitor.phase = "disabled";
        this.#journal("owner-disabled", monitor);
      }
      await this.#persist();
      await this.#dispatchPendingCancellations();
      return this.readModel();
    });
  }

  /** Stop automatic ticking after the current serialized operation finishes. */
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickInFlight?.catch(() => undefined);
    await this.tail.catch(() => undefined);
  }

  async #initialize() {
    const existing = await readSecureState(this.statePath);
    this.state = existing ? normalizeState(existing) : emptyState();
    if (!existing) await this.#persist();
    this.#startTimer();
    return this.readModel();
  }

  async #tick(input) {
    this.#assertOpen();
    for (const evidence of toArray(input?.resetEvidence)) this.#applyExactReset(evidence);
    await this.#persist();
    await this.#dispatchPendingCancellations();
    await this.#dispatchPendingStarts();
    if (this.policy.enabled !== true || this.state.ownerDisabled === true) return this.readModel();

    const activeMonitors = Object.values(this.state.monitors)
      .filter((monitor) => monitor.automatic === true && ACTIVE_MONITOR_PHASES.has(monitor.phase))
      .sort(compareOrder);
    if (activeMonitors.length === 0) return this.readModel();
    if (typeof this.adapters.readLiveness !== "function") {
      for (const monitor of activeMonitors) this.#unsupported(monitor, "unsupported-liveness");
      await this.#persist();
      return this.readModel();
    }

    const statusByTarget = new Map();
    for (const monitor of activeMonitors) {
      if (statusByTarget.has(monitor.targetId)) continue;
      const target = this.state.targets[monitor.targetId];
      try {
        const result = await this.adapters.readLiveness(adapterTarget(target));
        const status = typeof result === "string" ? result : result?.status;
        statusByTarget.set(monitor.targetId, normalizeLiveness(status));
      } catch (error) {
        statusByTarget.set(monitor.targetId, "unknown");
        this.logger?.warn?.("Automatic takeover liveness check failed", { message: errorMessage(error) });
      }
    }
    const coordinatorIds = new Set(activeMonitors.flatMap((monitor) => {
      const coordinatorId = this.state.targets[monitor.targetId]?.coordinatorId;
      return coordinatorId ? [coordinatorId] : [];
    }));
    for (const coordinatorId of coordinatorIds) {
      if (statusByTarget.has(coordinatorId)) continue;
      const coordinator = this.state.targets[coordinatorId];
      if (!coordinator) {
        statusByTarget.set(coordinatorId, "unknown");
        continue;
      }
      try {
        const result = await this.adapters.readLiveness(adapterTarget(coordinator));
        const status = typeof result === "string" ? result : result?.status;
        statusByTarget.set(coordinatorId, normalizeLiveness(status));
      } catch (error) {
        statusByTarget.set(coordinatorId, "unknown");
        this.logger?.warn?.("Automatic takeover coordinator liveness check failed", { message: errorMessage(error) });
      }
    }

    const actionable = [];
    for (const monitor of activeMonitors) {
      const target = this.state.targets[monitor.targetId];
      const status = statusByTarget.get(monitor.targetId) ?? "unknown";
      target.lastStatus = status;
      if (status === "unknown") {
        this.#unsupported(monitor, "unsupported-liveness");
      } else if (status === "running" && !(target.maximumUtilizationProtected && target.successorLaneEnabled && monitor.kind === "quota")) {
        monitor.automatic = false;
        monitor.phase = target.maximumUtilizationProtected ? "protected-running" : "running-no-action";
        this.#journal("running-left-alone", monitor);
      } else if (target.maximumUtilizationProtected && status === "running" && !target.successorLaneEnabled) {
        monitor.automatic = false;
        monitor.phase = "protected-running";
        this.#journal("protected-running-left-alone", monitor);
      } else {
        actionable.push(monitor);
      }
    }
    await this.#persist();

    const coordinators = actionable.filter((monitor) => this.state.targets[monitor.targetId].role === "coordinator");
    if (coordinators.length > 0) {
      await this.#processBatch(coordinators.slice(0, 1));
      return this.readModel();
    }

    const subagents = [];
    for (const monitor of actionable) {
      const target = this.state.targets[monitor.targetId];
      if (target.role !== "subagent") continue;
      if (!this.#coordinatorReady(target, statusByTarget)) {
        monitor.phase = "waiting-coordinator";
        continue;
      }
      subagents.push(monitor);
    }
    await this.#persist();
    const now = nowMillis(this.now());
    if (subagents.length > 0 && now >= this.state.nextBatchAt) {
      await this.#processBatch(subagents.slice(0, this.policy.batchSize));
      this.state.nextBatchAt = now + this.policy.staggerMs;
      await this.#persist();
    }
    return this.readModel();
  }

  /** Process at most one durable candidate attempt per selected monitor. */
  async #processBatch(monitors) {
    for (const monitor of monitors) {
      if (this.#hasOpenStart(monitor)) continue;
      const target = this.state.targets[monitor.targetId];
      if (target.explicitRoute && !target.automaticTakeoverOptIn) {
        monitor.automatic = false;
        monitor.phase = "blocked-explicit-route";
        continue;
      }
      if (target.maximumUtilizationProtected && !target.successorLaneEnabled) {
        monitor.automatic = false;
        monitor.phase = "protected-running";
        continue;
      }
      if (typeof this.adapters.listCandidates !== "function") {
        this.#unsupported(monitor, "unsupported-candidates");
        continue;
      }
      if (typeof this.adapters.startReplacement !== "function") {
        this.#unsupported(monitor, "unsupported-start");
        continue;
      }
      let candidates;
      try {
        candidates = await this.adapters.listCandidates(adapterTarget(target));
      } catch (error) {
        this.#unsupported(monitor, "unsupported-candidates");
        this.logger?.warn?.("Automatic takeover candidate discovery failed", { message: errorMessage(error) });
        continue;
      }
      if (!Array.isArray(candidates)) {
        this.#unsupported(monitor, "unsupported-candidates");
        continue;
      }
      const selection = selectCandidate(candidates, target, monitor, this.policy);
      if (!selection.candidate) {
        monitor.phase = selection.blocked ? "blocked-cross-provider" : "blocked-no-candidate";
        monitor.automatic = false;
        this.#journal("candidate-selection-blocked", monitor);
        continue;
      }
      const candidate = selection.candidate;
      const candidateKey = candidateIdentity(candidate);
      const idempotencyKey = opaqueHandle(this.state.secret, "start", `${monitor.handle}\0${candidateKey}`);
      const action = {
        idempotencyKey,
        type: "start",
        monitorHandle: monitor.handle,
        candidateKey,
        candidate,
        status: "pending",
        dispatchAttempts: 0,
        receipt: null,
        order: this.state.nextOrder++,
      };
      this.state.outbox.push(action);
      monitor.phase = "pending-replay";
      this.#journal("replacement-persisted", monitor);
      await this.#persist();
      await this.#dispatchAction(action);
    }
    await this.#persist();
  }

  async #dispatchPendingStarts() {
    for (const action of this.state.outbox.filter((entry) => entry.type === "start" && entry.status === "pending").sort(compareOrder)) {
      await this.#dispatchAction(action);
    }
  }

  async #dispatchPendingCancellations() {
    for (const action of this.state.outbox.filter((entry) => entry.type === "cancel" && ["pending", "unsupported"].includes(entry.status)).sort(compareOrder)) {
      action.status = "pending";
      await this.#dispatchAction(action);
    }
  }

  /** Dispatch one previously persisted effect and preserve unknown outcomes for replay. */
  async #dispatchAction(action) {
    const monitor = this.state.monitors[action.monitorHandle];
    if (!monitor || action.status !== "pending") return;
    action.dispatchAttempts += 1;
    if (action.type === "cancel") {
      const cancel = this.adapters.cancelQueuedReplacement;
      if (typeof cancel !== "function") {
        action.status = "unsupported";
        monitor.phase = "unsupported-cancel";
        this.#journal("cancellation-unsupported", monitor);
        await this.#persist();
        return;
      }
      try {
        const result = await cancel({
          idempotencyKey: action.idempotencyKey,
          receipt: action.receipt,
          lane: action.lane,
        });
        if (result?.supported === false) {
          action.status = "unsupported";
          monitor.phase = "unsupported-cancel";
        } else {
          action.status = "executed";
          if (monitor.replacement?.status === "queued") monitor.replacement.status = "cancelled";
          monitor.phase = monitor.reset ? "reset-cancelled" : "disabled";
        }
        this.#journal("cancellation-receipt", monitor, result?.receipt ?? action.receipt);
      } catch (error) {
        action.lastError = errorMessage(error);
        monitor.phase = "pending-replay";
        this.logger?.warn?.("Automatic takeover cancellation remains pending", { message: action.lastError });
      }
      await this.#persist();
      return;
    }

    const target = this.state.targets[monitor.targetId];
    try {
      const result = await this.adapters.startReplacement({
        idempotencyKey: action.idempotencyKey,
        target: adapterTarget(target),
        candidate: structuredClone(action.candidate),
        lane: target.maximumUtilizationProtected ? "successor" : "replacement",
        frozen: structuredClone(target.frozen),
      });
      if (result?.supported === false) {
        action.status = "unsupported";
        monitor.attempts[action.candidateKey] = "unsupported";
        monitor.phase = "unsupported-candidate";
      } else if (result?.status === "exhausted") {
        action.status = "executed";
        monitor.attempts[action.candidateKey] = "exhausted";
        monitor.phase = "retrying";
      } else if (["active", "queued"].includes(result?.status)) {
        action.status = "executed";
        action.receipt = result.receipt ?? null;
        monitor.attempts[action.candidateKey] = result.status;
        monitor.replacement = {
          status: result.status,
          receipt: result.receipt ?? null,
          actionKey: action.idempotencyKey,
          lane: target.maximumUtilizationProtected ? "successor" : "replacement",
        };
        monitor.phase = `replacement-${result.status}`;
        monitor.automatic = false;
      } else {
        action.status = "unsupported";
        monitor.attempts[action.candidateKey] = "unsupported";
        monitor.phase = "unsupported-start";
      }
      this.#journal("replacement-receipt", monitor, result?.receipt);
    } catch (error) {
      action.lastError = errorMessage(error);
      monitor.phase = "pending-replay";
      this.logger?.warn?.("Automatic takeover start remains pending", { message: action.lastError });
    }
    await this.#persist();
  }

  #applyExactReset(evidence) {
    if (!isExactResetEvidence(evidence)) return;
    for (const monitor of Object.values(this.state.monitors)) {
      if (monitor.providerId !== evidence.providerId || monitor.accountId !== evidence.accountId
        || monitor.quotaWindowId !== evidence.previousQuotaWindowId) continue;
      monitor.reset = { exact: true, currentQuotaWindowId: evidence.currentQuotaWindowId };
      monitor.automatic = false;
      this.#cancelPendingStarts(monitor, "exact-native-reset");
      if (monitor.replacement?.status === "queued") this.#queueCancellation(monitor, "exact-native-reset");
      else if (monitor.replacement?.status === "active") monitor.phase = "reset-active-replacement";
      else monitor.phase = "reset-cancelled";
      this.#journal("exact-native-reset", monitor);
    }
  }

  #cancelPendingStarts(monitor, reason) {
    for (const action of this.state.outbox) {
      if (action.monitorHandle === monitor.handle && action.type === "start" && action.status === "pending") {
        action.status = "cancelled";
        action.cancelReason = reason;
      }
    }
  }

  #queueCancellation(monitor, reason) {
    const replacement = monitor.replacement;
    if (!replacement || replacement.status !== "queued") return;
    const idempotencyKey = opaqueHandle(this.state.secret, "cancel", `${replacement.actionKey}\0${reason}`);
    if (this.state.outbox.some((entry) => entry.idempotencyKey === idempotencyKey)) return;
    this.state.outbox.push({
      idempotencyKey,
      type: "cancel",
      monitorHandle: monitor.handle,
      receipt: replacement.receipt,
      lane: replacement.lane,
      reason,
      status: "pending",
      dispatchAttempts: 0,
      order: this.state.nextOrder++,
    });
    monitor.phase = "pending-replay";
  }

  #coordinatorReady(target, statusByTarget) {
    if (!target.coordinatorId) return false;
    if (statusByTarget.get(target.coordinatorId) === "running") return true;
    const coordinatorMonitor = Object.values(this.state.monitors).find((monitor) => monitor.targetId === target.coordinatorId);
    return ["active", "queued"].includes(coordinatorMonitor?.replacement?.status);
  }

  #hasOpenStart(monitor) {
    return this.state.outbox.some((entry) => entry.monitorHandle === monitor.handle && entry.type === "start" && entry.status === "pending");
  }

  #unsupported(monitor, phase) {
    monitor.phase = phase;
    this.#journal("capability-unsupported", monitor);
  }

  #journal(event, monitor, detail = {}) {
    const receipt = event.endsWith("receipt")
      ? detail
      : isRecord(detail) && Object.hasOwn(detail, "receipt") ? detail.receipt : undefined;
    this.state.journal.push({
      sequence: this.state.nextSequence++,
      at: new Date(nowMillis(this.now())).toISOString(),
      event,
      handle: monitor?.handle ?? (isRecord(detail) ? detail.targetHandle : null) ?? null,
      phase: monitor?.phase ?? null,
      ...(receipt !== undefined ? { receiptDigest: digest(receipt) } : {}),
    });
    if (this.state.journal.length > this.policy.maxJournalEntries) {
      this.state.journal.splice(0, this.state.journal.length - this.policy.maxJournalEntries);
    }
  }

  async #persist() {
    await writeSecureState(this.statePath, this.state);
  }

  #startTimer() {
    if (this.timer || this.closed || this.policy.enabled !== true || this.policy.tickIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (!this.closed) void this.tick().catch((error) => this.logger?.warn?.("Automatic takeover tick failed", { message: errorMessage(error) }));
    }, this.policy.tickIntervalMs);
    this.timer.unref?.();
  }

  #serialized(operation) {
    const run = this.tail.then(operation, operation);
    this.tail = run.catch(() => undefined);
    return run;
  }

  #assertOpen() {
    if (this.closed) throw new Error("Automatic takeover controller is closed");
  }
}

function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    secret: randomBytes(32).toString("hex"),
    ownerDisabled: false,
    nextSequence: 1,
    nextOrder: 1,
    nextBatchAt: 0,
    targets: {},
    monitors: {},
    monitorByTuple: {},
    outbox: [],
    journal: [],
  };
}

function normalizeState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.secret !== "string"
    || !isRecord(value.targets) || !isRecord(value.monitors) || !isRecord(value.monitorByTuple)
    || !Array.isArray(value.outbox) || !Array.isArray(value.journal)) {
    throw new Error("Unsupported or malformed automatic takeover state");
  }
  return value;
}

function normalizePolicy(value = {}) {
  const policy = { ...DEFAULT_AUTOMATIC_TAKEOVER_POLICY, ...value };
  if (typeof policy.enabled !== "boolean" || typeof policy.crossProviderEnabled !== "boolean") throw new TypeError("Takeover policy flags must be boolean");
  for (const key of ["batchSize", "maxJournalEntries"]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new TypeError(`${key} must be a positive integer`);
  }
  for (const key of ["staggerMs", "tickIntervalMs"]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new TypeError(`${key} must be a non-negative integer`);
  }
  return Object.freeze(policy);
}

function normalizeTarget(input, state) {
  const targetId = requiredString(input?.targetId, "targetId");
  const role = input?.role ?? "coordinator";
  if (!["coordinator", "subagent"].includes(role)) throw new TypeError("role must be coordinator or subagent");
  const coordinatorId = role === "subagent" ? requiredString(input?.coordinatorId, "coordinatorId") : null;
  if (coordinatorId === targetId) throw new TypeError("A subagent cannot coordinate itself");
  const frozen = normalizeFrozen(input?.frozen);
  return {
    targetId,
    handle: opaqueHandle(state.secret, "target", targetId),
    providerId: requiredString(input?.providerId, "providerId"),
    accountId: requiredString(input?.accountId, "accountId"),
    quotaWindowId: requiredString(input?.quotaWindowId, "quotaWindowId"),
    role,
    coordinatorId,
    explicitRoute: input?.explicitRoute === true,
    automaticTakeoverOptIn: input?.automaticTakeoverOptIn === true,
    crossProviderEnabled: input?.crossProviderEnabled === true,
    maximumUtilizationProtected: input?.maximumUtilizationProtected === true,
    successorLaneEnabled: input?.successorLaneEnabled === true,
    frozen,
    order: state.nextOrder++,
    lastStatus: "unknown",
  };
}

function normalizeFrozen(value) {
  if (value == null) return null;
  if (!isRecord(value)) throw new TypeError("frozen must be an object");
  const tools = Array.isArray(value.tools) && value.tools.every((tool) => typeof tool === "string" && tool.length > 0)
    ? [...new Set(value.tools)].sort()
    : null;
  const mode = optionalString(value.mode);
  const workspace = optionalString(value.workspace);
  const privacy = nonNegativeNumber(value.privacy);
  const context = positiveNumber(value.context);
  const intelligence = nonNegativeNumber(value.intelligence);
  return { mode, tools, workspace, privacy, context, intelligence };
}

function targetComparable(target) {
  const { handle, order, lastStatus, ...comparable } = target;
  return comparable;
}

function initialMonitorPhase(state, policy, target) {
  if (policy.enabled !== true || state.ownerDisabled === true) return "disabled";
  if (target.explicitRoute && !target.automaticTakeoverOptIn) return "blocked-explicit-route";
  if (target.maximumUtilizationProtected && !target.successorLaneEnabled) return "protected-running";
  return "observed";
}

/** Select one deterministic candidate without weakening a frozen route floor. */
function selectCandidate(values, target, monitor, policy) {
  const normalized = values.flatMap((value) => normalizeCandidate(value) ?? []);
  const healthy = normalized.filter((candidate) => candidate.certifiedHealthy === true
    && candidateIdentity(candidate) !== routeIdentity(monitor.providerId, monitor.accountId, monitor.quotaWindowId)
    && monitor.attempts[candidateIdentity(candidate)] === undefined);
  const sameProvider = healthy
    .filter((candidate) => candidate.providerId === monitor.providerId)
    .sort((left, right) => candidateRank(left, monitor) - candidateRank(right, monitor) || candidateIdentity(left).localeCompare(candidateIdentity(right)));
  if (sameProvider.length > 0) return { candidate: sameProvider[0], blocked: false };
  const cross = healthy.filter((candidate) => candidate.providerId !== monitor.providerId).sort(candidateSort);
  if (cross.length === 0) return { candidate: null, blocked: false };
  if (policy.crossProviderEnabled !== true || target.crossProviderEnabled !== true || !completeFrozen(target.frozen)) {
    return { candidate: null, blocked: true };
  }
  const compatible = cross.filter((candidate) => meetsFrozen(candidate, target.frozen));
  return { candidate: compatible[0] ?? null, blocked: compatible.length === 0 };
}

function normalizeCandidate(value) {
  if (!isRecord(value)) return null;
  try {
    return {
      providerId: requiredString(value.providerId, "candidate.providerId"),
      accountId: requiredString(value.accountId, "candidate.accountId"),
      quotaWindowId: requiredString(value.quotaWindowId, "candidate.quotaWindowId"),
      certifiedHealthy: value.certifiedHealthy === true,
      mode: optionalString(value.mode),
      tools: Array.isArray(value.tools) ? [...new Set(value.tools.filter((tool) => typeof tool === "string"))].sort() : [],
      workspace: optionalString(value.workspace),
      privacy: nonNegativeNumber(value.privacy),
      context: positiveNumber(value.context),
      intelligence: nonNegativeNumber(value.intelligence),
    };
  } catch {
    return null;
  }
}

function candidateRank(candidate, monitor) {
  return candidate.accountId === monitor.accountId ? 0 : 1;
}

function candidateSort(left, right) {
  return candidateIdentity(left).localeCompare(candidateIdentity(right));
}

function completeFrozen(value) {
  return Boolean(value?.mode && value?.tools && value?.workspace && value?.privacy != null
    && value?.context != null && value?.intelligence != null);
}

function meetsFrozen(candidate, frozen) {
  return candidate.mode === frozen.mode
    && frozen.tools.every((tool) => candidate.tools.includes(tool))
    && candidate.workspace === frozen.workspace
    && candidate.privacy != null && candidate.privacy >= frozen.privacy
    && candidate.context != null && candidate.context >= frozen.context
    && candidate.intelligence != null && candidate.intelligence >= frozen.intelligence;
}

function adapterTarget(target) {
  return structuredClone({
    targetId: target.targetId,
    providerId: target.providerId,
    accountId: target.accountId,
    quotaWindowId: target.quotaWindowId,
    role: target.role,
    coordinatorId: target.coordinatorId,
  });
}

function isExactResetEvidence(value) {
  return isRecord(value) && value.sourceKind === "native" && value.exact === true
    && optionalString(value.providerId) && optionalString(value.accountId)
    && optionalString(value.previousQuotaWindowId) && optionalString(value.currentQuotaWindowId)
    && value.previousQuotaWindowId !== value.currentQuotaWindowId;
}

function validateStatePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("automatic takeover statePath must be absolute");
  if (normalize(value) !== value || parse(value).root === value) throw new TypeError("automatic takeover statePath must be normalized and name a file");
  return resolve(value);
}

/** Load only a bounded regular file reached through non-symlink path components. */
async function readSecureState(path) {
  await assertSafeParent(path, false);
  const info = await safeLstat(path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Automatic takeover state must be a regular file, not a symbolic link");
  if (info.size > MAX_STATE_BYTES) throw new Error("Automatic takeover state exceeds the size limit");
  await chmod(path, 0o600);
  return normalizeState(JSON.parse(await readFile(path, "utf8")));
}

/** Persist through an owner-only same-directory temporary file and atomic rename. */
async function writeSecureState(path, state) {
  const parent = dirname(path);
  const parentBefore = await safeLstat(parent);
  await assertSafeParent(path, true);
  if (!parentBefore) await chmod(parent, 0o700);
  const canonicalParent = await realpath(parent);
  const target = await safeLstat(path);
  if (target && (target.isSymbolicLink() || !target.isFile())) throw new Error("Refusing to replace a non-regular automatic takeover state path");
  const temporary = join(parent, `.${parse(path).base}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await assertSafeParent(path, false);
    if (await realpath(parent) !== canonicalParent) throw new Error("Automatic takeover state parent changed during persistence");
    const current = await safeLstat(path);
    if (current?.isSymbolicLink()) throw new Error("Refusing to replace a symbolic-link automatic takeover state");
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Check every existing path component and optionally create the final parent. */
async function assertSafeParent(path, create) {
  const parent = dirname(path);
  const root = parse(parent).root;
  const parts = relative(root, parent).split(sep).filter(Boolean);
  let cursor = root;
  let missing = false;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = await safeLstat(cursor);
    if (!info) {
      missing = true;
      break;
    }
    if (info.isSymbolicLink()) throw new Error(`Automatic takeover state path contains a symbolic link: ${cursor}`);
    if (!info.isDirectory()) throw new Error(`Automatic takeover state parent is not a directory: ${cursor}`);
  }
  if (missing && create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const final = await safeLstat(parent);
  if (final && (final.isSymbolicLink() || !final.isDirectory())) throw new Error("Automatic takeover state parent is unsafe");
}

async function safeLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeLiveness(value) {
  return ["running", "failed", "not-running"].includes(value) ? value : "unknown";
}

function tupleKey(targetId, providerId, accountId, quotaWindowId) {
  return [targetId, providerId, accountId, quotaWindowId].join("\0");
}

function candidateIdentity(candidate) {
  return routeIdentity(candidate.providerId, candidate.accountId, candidate.quotaWindowId);
}

function routeIdentity(providerId, accountId, quotaWindowId) {
  return [providerId, accountId, quotaWindowId].join("\0");
}

function opaqueHandle(secret, kind, identity) {
  return `${kind}_${createHash("sha256").update(secret).update("\0").update(kind).update("\0").update(identity).digest("hex").slice(0, 24)}`;
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value ?? null)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${label} must be a non-empty string`);
  return normalized;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nowMillis(value) {
  const result = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number(value);
  if (!Number.isFinite(result)) throw new TypeError("now() must return a valid date or epoch milliseconds");
  return result;
}

function compareOrder(left, right) {
  return left.order - right.order;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error) {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}
