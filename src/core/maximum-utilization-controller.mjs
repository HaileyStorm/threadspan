import { createHash } from "node:crypto";

export const MAXIMUM_UTILIZATION_SOURCE_KIND = "codex-native-quota";

export const DEFAULT_MAXIMUM_UTILIZATION_POLICY = Object.freeze({
  enabled: false,
  automaticPollingEnabled: false,
  pollIntervalMs: 60_000,
  manualManifestMaxEntries: 32,
  triggerUsedRatio: 0.96,
  fastCanaryUsedRatio: 0.99,
  normalRolloverConsideration: 0.78,
  pressuredRolloverConsideration: 0.75,
  oneManifestPerEpoch: true,
  requireExactNativeQuotaRecovery: true,
});

const BLOCKED_SUPERVISOR_ACTIONS = new Set([
  "message", "steer", "interrupt", "wake", "promote", "rotate", "acknowledge", "check-in",
]);
const ROLLOVER_GATES = Object.freeze([
  "predecessorStopped", "singleSuccessor", "identityVerified", "reservationClear", "quietBoundary", "noUserInputRequired",
]);
const AUTOMATIC_STALE_ACTION_TYPES = Object.freeze([
  "send-entry-notice",
  "protect-running-turn",
  "suspend-future-monitor",
  "start-preauthorized-manifest",
  "start-fast-canary",
  "deliver-owner-inbox",
  "mark-output-provisional",
  "deny-supervisor-action",
  "consider-rollover",
]);
const INVERSE_CLEANUP_ACTION_TYPES = Object.freeze(["unprotect-running-turn", "restore-monitor-cas"]);
const ENTRY_NOTICE = "Maximum-utilization window: continue productive in-scope work and safe blocker workarounds; do not start subagents, send cross-task messages, check in, retry/poll, or interfere with reserved foreground, hardware, or GPU work.";

/** Return a serializable state for the pure reducer. */
export function createMaximumUtilizationState(policy = {}) {
  const effective = normalizePolicy(policy);
  return {
    schemaVersion: 1,
    enabled: effective.enabled,
    phase: effective.enabled ? "idle" : "disabled",
    readiness: effective.enabled ? "awaiting-native-quota" : "disabled",
    epoch: 0,
    bucket: null,
    observationsByScope: {},
    suppressedWindowsByScope: {},
    lastNativeObservation: null,
    snapshot: null,
    noticeIssued: [],
    protectedTargetIds: [],
    manifestIssued: false,
    fastCanaryIssued: false,
    directExhaustion: false,
    recoveryConfirmed: false,
    monitors: {},
    inbox: {},
    rolloverConsiderations: [],
    overrunCount: 0,
    provisionalOutputCount: 0,
    manual: { active: false, epoch: 0, scope: null, manifest: [] },
  };
}

/** Return true only when an existing disabled journal needs bounded recovery work. */
export function needsDisabledMaximumUtilizationRecovery(snapshot) {
  const state = snapshot?.state;
  const appliedProtection = Array.isArray(state?.protectedTargetIds) && state.protectedTargetIds.length > 0
    || Object.values(state?.monitors ?? {}).some((monitor) => monitor?.suspensionRequested === true);
  const activeState = ["maximum-utilization", "exhausted"].includes(state?.phase) || state?.manual?.active === true;
  const replayableWork = (snapshot?.outbox ?? []).some((entry) => ["pending", "unsupported"].includes(entry?.status));
  return appliedProtection || activeState || replayableWork;
}

/**
 * Pure maximum-utilization state transition. It performs no I/O and emits only
 * capability-tagged requested actions.
 * @param {Record<string, any>} previousState
 * @param {Record<string, any>} event
 * @param {Record<string, any>} policy
 * @returns {{state: Record<string, any>, actions: Record<string, any>[], cancellations: Record<string, any>[]}}
 */
export function reduce(previousState, event, policy = {}) {
  const effective = normalizePolicy(policy);
  const state = cloneState(previousState, effective);
  const actions = [];
  const cancellations = [];
  if (!effective.enabled) return { state: { ...createMaximumUtilizationState(effective), epoch: state.epoch ?? 0 }, actions, cancellations };
  state.enabled = true;
  if (state.phase === "disabled") state.phase = "idle";
  if (!event || typeof event !== "object" || Array.isArray(event)) return { state, actions, cancellations };

  if (event.type === "native-quota-observed") {
    reduceNativeQuota(state, event, effective, actions, cancellations);
  } else if (event.type === "native-quota-batch-observed") {
    reduceNativeQuotaBatch(state, event, effective, actions, cancellations);
  } else if (event.type === "supervisor-action-requested") {
    reduceSupervisorRequest(state, event, actions);
  } else if (event.type === "monitor-future-invocation") {
    reduceMonitorInvocation(state, event, actions);
  } else if (event.type === "monitor-state-observed") {
    reduceMonitorObservation(state, event);
  } else if (event.type === "inbox-message-enqueued") {
    reduceInboxEnqueue(state, event);
  } else if (event.type === "natural-checkpoint") {
    reduceNaturalCheckpoint(state, event, actions);
  } else if (event.type === "inbox-delivery-acknowledged") {
    reduceInboxAcknowledgement(state, event);
  } else if (event.type === "output-phase-observed") {
    reduceOutputPhase(state, event, actions);
  } else if (event.type === "context-observed") {
    reduceContextObservation(state, event, effective, actions);
  } else if (event.type === "overrun-observed" && activeProtection(state)) {
    state.overrunCount += 1;
  } else if (event.type === "manual-full-push-enter") {
    reduceManualEnter(state, event, effective, actions, cancellations);
  } else if (event.type === "manual-full-push-leave") {
    reduceManualLeave(state, cancellations);
  } else if (event.type === "owner-disable") {
    reduceOwnerDisable(state, actions, cancellations);
  }
  return { state, actions, cancellations };
}

/**
 * Stateful daemon composition around the pure reducer and durable outbox.
 */
export class MaximumUtilizationController {
  /** @param {{policy: Record<string, any>, journal: any, quotaAdapter?: any, snapshotProvider?: Function, capabilities?: Record<string, Function>, logger?: any}} options */
  constructor(options) {
    if (!options?.journal) throw new TypeError("maximum-utilization journal is required");
    this.policy = normalizePolicy(options.policy);
    this.journal = options.journal;
    this.capabilities = Object.freeze({ ...(options.capabilities ?? {}) });
    this.logger = options.logger;
    this.quotaAdapter = options.quotaAdapter;
    this.snapshotProvider = options.snapshotProvider;
    this.state = createMaximumUtilizationState(this.policy);
    this.queue = Promise.resolve();
    this.initialized = false;
    this.initializeInFlight = null;
    this.dispatchInFlight = null;
    this.dispatchAgain = false;
    this.pollTimer = null;
    this.refreshInFlight = null;
    this.closed = false;
  }

  /** Restore reducer state and replay unproved outbox effects. */
  async initialize() {
    if (this.initialized) return this.readModel();
    this.initializeInFlight ??= this.#initialize().finally(() => { this.initializeInFlight = null; });
    return this.initializeInFlight;
  }

  async #initialize() {
    const snapshot = await this.journal.initialize();
    this.state = snapshot.state ? cloneState(snapshot.state, this.policy) : createMaximumUtilizationState(this.policy);
    if (this.policy.enabled !== true && needsDisabledMaximumUtilizationRecovery(snapshot)) {
      const transition = reconcileDisabledRestart(this.state, snapshot.outbox);
      await this.journal.commit(transition);
      this.state = transition.state;
    }
    this.initialized = true;
    await this.dispatchPending();
    this.#startPolling();
    return this.readModel();
  }

  /** Persist a reducer transition before dispatching any requested host effect. */
  async handle(event) {
    if (["native-quota-observed", "native-quota-batch-observed"].includes(event?.type)) throw new TypeError("Native quota events are accepted only from the daemon-owned CodexNativeQuotaAdapter");
    return this.#commitEvent(event);
  }

  async #commitEvent(event) {
    return this.#serialized(async () => {
      if (!this.initialized) await this.initialize();
      const transition = reduce(this.state, event, this.policy);
      await this.journal.commit({ event, state: transition.state, actions: transition.actions, cancellations: transition.cancellations });
      this.state = transition.state;
      await this.dispatchPending();
      return { accepted: true, actionCount: transition.actions.length, readModel: await this.readModel() };
    });
  }

  /** Refresh the current selected Codex account through the native App Server adapter. */
  async refreshNative() {
    if (!this.quotaAdapter?.read) throw new Error("Native Codex quota adapter is unavailable");
    this.refreshInFlight ??= this.#refreshNative().finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  async #refreshNative() {
    if (!this.initialized) await this.initialize();
    const result = await this.quotaAdapter.read();
    const observations = sortNativeObservations(result.observations ?? []);
    const accountId = nonEmpty(result.accountId);
    if (!accountId || observations.length === 0 || observations.some((observation) => observation.accountId !== accountId || observation.controllingAccountId !== accountId)) {
      throw new Error("Native Codex quota adapter returned an unbound or empty observation batch");
    }
    const worst = observations[0];
    const snapshot = worst.usedRatio >= this.policy.triggerUsedRatio && worst.exhausted !== true && worst.usedRatio < 1 && !activeProtection(this.state)
      ? (typeof this.snapshotProvider === "function" ? await this.snapshotProvider() : {})
      : undefined;
    const outcome = await this.#commitEvent({ type: "native-quota-batch-observed", observations, ...(snapshot ? { snapshot } : {}) });
    return { ...outcome, accountBound: true, observationCount: observations.length };
  }

  /** Enter owner-requested quota-independent full-push mode for one labeled scope. */
  async enterManual(input) {
    if (!normalizeManualScope(input?.scope)) throw new TypeError("Manual full-push requires scope.kind provider|app|account and a non-empty label");
    if (!Array.isArray(input?.manifest)) throw new TypeError("Manual full-push requires a manifest array");
    if (input.manifest.length > this.policy.manualManifestMaxEntries) {
      throw new TypeError(`Manual full-push manifest exceeds ${this.policy.manualManifestMaxEntries} entries`);
    }
    return this.#commitEvent({ type: "manual-full-push-enter", scope: input?.scope, manifest: input?.manifest });
  }

  /** Leave owner-requested full-push mode without inferring quota or reset state. */
  async leaveManual() {
    return this.#commitEvent({ type: "manual-full-push-leave" });
  }

  /** Exit active automatic/manual modes and restore suspended controls. */
  async ownerDisable() {
    return this.#commitEvent({ type: "owner-disable" });
  }

  /** Stop future native polling without interrupting a read already in flight. */
  async close() {
    this.closed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    await this.refreshInFlight?.catch(() => undefined);
  }

  /** Replay pending or formerly unsupported effects against current capabilities. */
  async dispatchPending() {
    if (this.dispatchInFlight) {
      this.dispatchAgain = true;
      return this.dispatchInFlight;
    }
    this.dispatchInFlight = this.#dispatchPending().finally(() => { this.dispatchInFlight = null; });
    return this.dispatchInFlight;
  }

  async #dispatchPending() {
    do {
      this.dispatchAgain = false;
      const entries = await this.journal.replayableOutbox();
      for (const entry of entries) {
        if (this.policy.enabled !== true && !INVERSE_CLEANUP_ACTION_TYPES.includes(entry.action.type)) {
          await this.journal.recordDispatch(entry.idempotencyKey, { status: "cancelled", error: "disabled restart rejected obsolete non-cleanup action" });
          continue;
        }
        const handler = this.capabilities[entry.action.capability];
        if (typeof handler !== "function") {
          if (entry.status !== "unsupported") await this.journal.recordDispatch(entry.idempotencyKey, { status: "unsupported" });
          continue;
        }
        try {
          const result = await handler(structuredClone(entry.action));
          const status = result?.supported === false ? "unsupported" : "executed";
          await this.journal.recordDispatch(entry.idempotencyKey, { status });
        } catch (error) {
          await this.journal.recordDispatch(entry.idempotencyKey, {
            status: "pending",
            error: error instanceof Error ? error.message : String(error),
          });
          this.logger?.warn?.("Maximum-utilization host action remains pending", {
            capability: entry.action.capability,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } while (this.dispatchAgain);
  }

  /** Count-only, identifier-free HUD state. */
  async readModel() {
    if (!this.initialized) await this.initialize();
    const outbox = await this.journal.statusCounts();
    const inbox = Object.values(this.state.inbox ?? {}).flat();
    return {
      phase: this.state.phase,
      readiness: this.state.readiness,
      epoch: this.state.epoch,
      quota: {
        usedRatio: ratio(this.state.lastNativeObservation?.usedRatio),
        observedAt: timestamp(this.state.lastNativeObservation?.observedAt),
        resetAt: timestamp(this.state.lastNativeObservation?.resetAt),
      },
      counts: {
        protectedTasks: this.state.protectedTargetIds.length,
        notices: this.state.noticeIssued.length,
        inboxPending: inbox.filter((item) => item.delivered !== true).length,
        suspendedMonitors: Object.values(this.state.monitors ?? {}).filter((item) => item.suspensionRequested === true).length,
        overruns: this.state.overrunCount,
        provisionalOutputs: this.state.provisionalOutputCount,
      },
      statuses: {
        outbox,
        manifest: this.state.manifestIssued ? "requested" : "not-requested",
        fastCanary: this.state.fastCanaryIssued ? "requested" : "not-requested",
        recovery: this.state.recoveryConfirmed ? "confirmed" : "unconfirmed",
      },
      automatic: {
        enabled: this.policy.automaticPollingEnabled === true,
        active: activeProtection(this.state),
        scope: this.state.bucket ? { provider: "OpenAI Codex", account: "selected account", bucket: "native bucket" } : null,
      },
      manual: {
        active: this.state.manual?.active === true,
        scope: this.state.manual?.scope ? structuredClone(this.state.manual.scope) : null,
        manifestCount: this.state.manual?.manifest?.length ?? 0,
      },
    };
  }

  #startPolling() {
    if (this.pollTimer || this.policy.enabled !== true || this.policy.automaticPollingEnabled !== true || !this.quotaAdapter?.read) return;
    const poll = () => {
      if (this.closed) return;
      void this.refreshNative().catch((error) => this.logger?.warn?.("Native Codex quota refresh failed", { message: error instanceof Error ? error.message : String(error) }));
    };
    this.pollTimer = setInterval(poll, this.policy.pollIntervalMs);
    this.pollTimer.unref?.();
    queueMicrotask(poll);
  }

  async #serialized(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function reduceNativeQuota(state, event, policy, actions, cancellations) {
  const observation = normalizeNativeObservation(event);
  if (!observation || !recordNativeObservation(state, observation)) return;
  applyNativeObservation(state, observation, event.snapshot, policy, actions, cancellations, false);
}

function reconcileDisabledRestart(previousState, outbox) {
  const priorEpoch = previousState.epoch ?? 0;
  const hasAppliedProtection = (previousState.protectedTargetIds?.length ?? 0) > 0
    || Object.values(previousState.monitors ?? {}).some((monitor) => monitor?.suspensionRequested === true);
  const cleanupEpoch = hasAppliedProtection ? priorEpoch + 1 : priorEpoch;
  const state = cloneState(previousState, { enabled: false });
  state.epoch = cleanupEpoch;
  const actions = [];
  const cancellations = [
    { throughEpoch: priorEpoch, actionTypes: [...AUTOMATIC_STALE_ACTION_TYPES, "start-manual-full-push-manifest"], reason: "policy-disabled-restart" },
  ];
  if (hasAppliedProtection) {
    cancellations.push({ throughEpoch: priorEpoch, actionTypes: INVERSE_CLEANUP_ACTION_TYPES, reason: "policy-disabled-restart-regenerated" });
    restoreAutomaticState(state, actions, "policy-disabled-restart");
  }
  state.enabled = false;
  state.phase = "disabled";
  state.readiness = "disabled";
  state.manual = { active: false, epoch: state.manual?.epoch ?? 0, scope: null, manifest: [] };
  return {
    event: { type: "policy-disabled-restart", replayableInverseCount: (outbox ?? []).filter((entry) => ["pending", "unsupported"].includes(entry.status) && INVERSE_CLEANUP_ACTION_TYPES.includes(entry.action?.type)).length },
    state,
    actions,
    cancellations,
  };
}

function reduceNativeQuotaBatch(state, event, policy, actions, cancellations) {
  const observations = sortNativeObservations(event.observations ?? [])
    .map(normalizeNativeObservation)
    .filter(Boolean);
  if (observations.length === 0) return;
  const controlling = state.bucket
    ? observations.find((observation) => bucketMatchesScope(state.bucket, observation))
    : null;
  const fresh = observations.filter((observation) => recordNativeObservation(state, observation));
  if (fresh.length === 0) return;
  if (activeProtection(state) && (!controlling || !fresh.includes(controlling))) {
    state.readiness = "awaiting-exact-native-recovery";
    return;
  }
  const authoritative = fresh.find((observation) => {
    const scopeKey = bucketScopeKey(observation);
    const suppressedWindow = state.suppressedWindowsByScope?.[scopeKey];
    if (suppressedWindow === observation.windowId) return false;
    if (suppressedWindow) delete state.suppressedWindowsByScope[scopeKey];
    return true;
  });
  if (!authoritative) {
    state.lastNativeObservation = fresh[0];
    state.readiness = "owner-disabled";
    return;
  }
  if (activeProtection(state) && authoritative.usedRatio < policy.triggerUsedRatio) {
    const presentScopes = new Set(observations.map(bucketScopeKey));
    const knownScopes = Object.values(state.observationsByScope ?? {})
      .filter((observation) => observation.providerId === state.bucket.providerId && observation.accountId === state.bucket.accountId)
      .map(bucketScopeKey);
    if (fresh.length !== observations.length || knownScopes.some((scopeKey) => !presentScopes.has(scopeKey))) {
      state.readiness = "awaiting-exact-native-recovery";
      return;
    }
  }
  applyNativeObservation(state, authoritative, event.snapshot, policy, actions, cancellations, true);
}

function recordNativeObservation(state, observation) {
  const scopeKey = bucketScopeKey(observation);
  const previous = state.observationsByScope?.[scopeKey];
  if (previous?.adapterInstanceId === observation.adapterInstanceId && observation.monotonicObservation <= previous.monotonicObservation) return false;
  state.observationsByScope ??= {};
  state.observationsByScope[scopeKey] = observation;
  return true;
}

function applyNativeObservation(state, observation, snapshot, policy, actions, cancellations, authoritativeAcrossBuckets) {
  const scopeKey = bucketScopeKey(observation);
  const sameBucket = bucketMatchesScope(state.bucket, observation);
  if (activeProtection(state) && !sameBucket && !authoritativeAcrossBuckets) return;

  const suppressedWindow = state.suppressedWindowsByScope?.[scopeKey];
  if (suppressedWindow === observation.windowId) {
    state.lastNativeObservation = observation;
    state.readiness = "owner-disabled";
    return;
  }
  if (suppressedWindow && suppressedWindow !== observation.windowId) delete state.suppressedWindowsByScope[scopeKey];

  const hadObservation = Boolean(state.lastNativeObservation);
  state.lastNativeObservation = observation;
  state.readiness = "native-quota-observed";
  if (activeProtection(state) && authoritativeAcrossBuckets) state.bucket = bucketOf(observation);

  if (!hadObservation && observation.exhausted) {
    state.epoch += 1;
    cancellations.push(inverseCleanupCancellation(state.epoch - 1, "new-direct-exhaustion"));
    state.phase = "exhausted";
    state.readiness = "direct-exhaustion-observed";
    state.bucket = bucketOf(observation);
    state.directExhaustion = true;
    state.recoveryConfirmed = false;
    return;
  }

  if (activeProtection(state)) {
    if (observation.exhausted) {
      state.phase = "exhausted";
      state.readiness = "awaiting-exact-native-recovery";
      return;
    }
    if (observation.usedRatio < policy.triggerUsedRatio) {
      cancellations.push(automaticCancellation(state.epoch, "native-recovery-confirmed"));
      restoreAutomaticState(state, actions, "native-recovery-confirmed");
      return;
    }
    if (state.phase === "maximum-utilization") {
      maybeRequestFastCanary(state, observation, policy, actions);
      return;
    }
    return;
  }

  if (observation.exhausted) {
    state.epoch += 1;
    cancellations.push(inverseCleanupCancellation(state.epoch - 1, "new-direct-exhaustion"));
    state.phase = "exhausted";
    state.readiness = "awaiting-exact-native-recovery";
    state.bucket = bucketOf(observation);
    state.directExhaustion = true;
    state.recoveryConfirmed = false;
    return;
  }
  if (observation.usedRatio < policy.triggerUsedRatio) return;

  state.epoch += 1;
  cancellations.push(inverseCleanupCancellation(state.epoch - 1, "new-maximum-utilization-epoch"));
  state.phase = "maximum-utilization";
  state.readiness = "active";
  state.bucket = bucketOf(observation);
  state.snapshot = freezeSnapshot(snapshot);
  state.noticeIssued = [];
  state.protectedTargetIds = state.snapshot.targets.map((target) => target.id);
  state.manifestIssued = false;
  state.fastCanaryIssued = false;
  state.directExhaustion = false;
  state.recoveryConfirmed = false;
  state.monitors = {};

  for (const target of state.snapshot.targets) {
    state.noticeIssued.push(target.id);
    actions.push(requestedAction(state.epoch, "send-entry-notice", "task.notice", { targetId: target.id, notice: ENTRY_NOTICE }));
    actions.push(requestedAction(state.epoch, "protect-running-turn", "turn.protect", { targetId: target.id }));
  }
  for (const monitor of state.snapshot.monitors) {
    state.monitors[monitor.id] = { baselineVersion: monitor.version, priorState: monitor.state, suspensionRequested: true };
    actions.push(requestedAction(state.epoch, "suspend-future-monitor", "monitor.suspend-future", {
      monitorId: monitor.id,
      expectedVersion: monitor.version,
      currentOccurrenceContinues: true,
    }));
  }
  if (policy.oneManifestPerEpoch && state.snapshot.manifest.length > 0) {
    state.manifestIssued = true;
    actions.push(requestedAction(state.epoch, "start-preauthorized-manifest", "manifest.start", {
      entries: state.snapshot.manifest,
      frozen: true,
    }));
  }
  maybeRequestFastCanary(state, observation, policy, actions);
}

function reduceManualEnter(state, event, policy, actions, cancellations) {
  const scope = normalizeManualScope(event.scope);
  const manifest = freezeManualManifest(event.manifest, policy.manualManifestMaxEntries);
  if (!scope) return;
  if (state.manual?.active) cancellations.push(manualCancellation(state.manual.epoch, "manual-replaced"));
  const epoch = (state.manual?.epoch ?? 0) + 1;
  state.manual = { active: true, epoch, scope, manifest };
  if (manifest.length > 0) {
    actions.push(requestedAction(epoch, "start-manual-full-push-manifest", "manifest.start", {
      mode: "manual-full-push",
      scope,
      entries: manifest,
      frozen: true,
      quotaIndependent: true,
    }));
  }
}

function reduceManualLeave(state, cancellations) {
  if (state.manual?.active) cancellations.push(manualCancellation(state.manual.epoch, "manual-left"));
  state.manual = { active: false, epoch: state.manual?.epoch ?? 0, scope: null, manifest: [] };
}

function reduceOwnerDisable(state, actions, cancellations) {
  const accountId = state.bucket?.accountId ?? state.lastNativeObservation?.accountId;
  if (accountId) {
    state.suppressedWindowsByScope ??= {};
    for (const observation of Object.values(state.observationsByScope ?? {})) {
      if (observation.providerId !== "openai-codex" || observation.accountId !== accountId) continue;
      state.suppressedWindowsByScope[bucketScopeKey(observation)] = observation.windowId;
    }
  }
  if (activeProtection(state)) cancellations.push(automaticCancellation(state.epoch, "owner-disabled"));
  if (state.manual?.active) cancellations.push(manualCancellation(state.manual.epoch, "owner-disabled"));
  restoreAutomaticState(state, actions, "owner-disabled");
  state.manual = { active: false, epoch: state.manual?.epoch ?? 0, scope: null, manifest: [] };
}

function restoreAutomaticState(state, actions, readiness) {
  for (const targetId of state.protectedTargetIds ?? []) {
    actions.push(requestedAction(state.epoch, "unprotect-running-turn", "turn.unprotect", { targetId, reason: readiness }));
  }
  for (const [monitorId, monitor] of Object.entries(state.monitors ?? {})) {
    if (!monitor.suspensionRequested) continue;
    actions.push(requestedAction(state.epoch, "restore-monitor-cas", "monitor.restore-cas", {
      monitorId,
      expectedVersion: monitor.baselineVersion,
      priorState: monitor.priorState,
      reason: readiness,
    }));
  }
  state.phase = "idle";
  state.readiness = readiness;
  state.recoveryConfirmed = readiness === "native-recovery-confirmed";
  state.directExhaustion = false;
  state.bucket = null;
  state.snapshot = null;
  state.protectedTargetIds = [];
  state.noticeIssued = [];
  state.manifestIssued = false;
  state.fastCanaryIssued = false;
  state.monitors = {};
}

function reduceSupervisorRequest(state, event, actions) {
  const targetId = nonEmpty(event.targetId);
  const action = nonEmpty(event.action);
  if (!targetId || !action) return;
  if (["user-stop", "safety"].includes(event.authority)) {
    actions.push(requestedAction(state.epoch, "allow-authority-action", "authority.allow", { targetId, action, authority: event.authority }));
    return;
  }
  if (activeProtection(state) && state.protectedTargetIds.includes(targetId) && BLOCKED_SUPERVISOR_ACTIONS.has(action)) {
    actions.push(requestedAction(state.epoch, "deny-supervisor-action", "supervisor.deny", { targetId, action }));
  }
}

function reduceMonitorInvocation(state, event, actions) {
  if (!activeProtection(state)) return;
  const monitorId = nonEmpty(event.monitorId);
  if (!monitorId) return;
  const existing = state.monitors[monitorId];
  if (existing?.suspensionRequested) return;
  state.monitors[monitorId] = { baselineVersion: event.version ?? null, priorState: event.state ?? null, suspensionRequested: true };
  actions.push(requestedAction(state.epoch, "suspend-future-monitor", "monitor.suspend-future", {
    monitorId,
    expectedVersion: event.version ?? null,
    currentOccurrenceContinues: true,
  }));
}

function reduceMonitorObservation(state, event) {
  const monitorId = nonEmpty(event.monitorId);
  if (!monitorId || !state.monitors[monitorId]) return;
  state.monitors[monitorId].observedVersion = event.version ?? null;
  state.monitors[monitorId].observedState = event.state ?? null;
}

function reduceInboxEnqueue(state, event) {
  if (!activeProtection(state) || event.visibility !== "owner-private") return;
  const targetId = nonEmpty(event.targetId);
  const sequence = event.sequence;
  if (!targetId || !Number.isSafeInteger(sequence) || sequence <= 0) return;
  const inbox = state.inbox[targetId] ?? [];
  if (inbox.some((item) => item.sequence === sequence)) return;
  inbox.push({ sequence, body: event.body ?? null, deliveryRequested: false, delivered: false });
  inbox.sort((left, right) => left.sequence - right.sequence);
  state.inbox[targetId] = inbox;
}

function reduceNaturalCheckpoint(state, event, actions) {
  if (!activeProtection(state)) return;
  const targetId = nonEmpty(event.targetId);
  if (!targetId) return;
  for (const item of state.inbox[targetId] ?? []) {
    if (item.deliveryRequested || item.delivered) continue;
    item.deliveryRequested = true;
    actions.push(requestedAction(state.epoch, "deliver-owner-inbox", "inbox.deliver", {
      targetId,
      sequence: item.sequence,
      body: item.body,
      checkpointKind: "natural",
    }));
  }
}

function reduceInboxAcknowledgement(state, event) {
  const targetId = nonEmpty(event.targetId);
  const sequence = event.sequence;
  const item = state.inbox[targetId]?.find((candidate) => candidate.sequence === sequence);
  if (item) item.delivered = true;
}

function reduceOutputPhase(state, event, actions) {
  if (!activeProtection(state) || !["primary", "final"].includes(event.phase)) return;
  const targetId = nonEmpty(event.targetId);
  if (!targetId || !state.protectedTargetIds.includes(targetId)) return;
  state.provisionalOutputCount += 1;
  actions.push(requestedAction(state.epoch, "mark-output-provisional", "output.mark-provisional", {
    targetId,
    phase: event.phase,
    protectionContinues: true,
  }));
}

function reduceContextObservation(state, event, policy, actions) {
  const contextRatio = ratio(event.contextRatio);
  const targetId = nonEmpty(event.targetId);
  const considerationId = nonEmpty(event.considerationId) ?? `${targetId ?? "target"}:${contextRatio}`;
  if (contextRatio == null || !targetId || !ROLLOVER_GATES.every((gate) => event.gates?.[gate] === true)) return;
  const threshold = activeProtection(state) ? policy.pressuredRolloverConsideration : policy.normalRolloverConsideration;
  if (contextRatio < threshold || state.rolloverConsiderations.includes(considerationId)) return;
  state.rolloverConsiderations.push(considerationId);
  actions.push(requestedAction(state.epoch, "consider-rollover", "rollover.consider", {
    targetId,
    contextRatio,
    threshold,
    gates: Object.fromEntries(ROLLOVER_GATES.map((gate) => [gate, true])),
    promote: false,
  }));
}

function maybeRequestFastCanary(state, observation, policy, actions) {
  const canary = state.snapshot?.fastCanary;
  if (state.fastCanaryIssued || observation.usedRatio < policy.fastCanaryUsedRatio || !canary?.eligible) return;
  state.fastCanaryIssued = true;
  actions.push(requestedAction(state.epoch, "start-fast-canary", "fast-canary.start", {
    turnId: canary.turnId,
    bounded: true,
    catalogSupported: true,
    survivalGuaranteed: false,
  }));
}

function normalizeNativeObservation(event) {
  if (event.sourceKind !== MAXIMUM_UTILIZATION_SOURCE_KIND) return null;
  const accountId = nonEmpty(event.accountId);
  const controllingAccountId = nonEmpty(event.controllingAccountId);
  const bucketId = nonEmpty(event.bucketId);
  const windowId = nonEmpty(event.windowId);
  const receipt = event.nativeReceipt;
  const receiptId = nonEmpty(typeof receipt === "string" ? receipt : receipt?.id);
  const monotonicObservation = event.monotonicObservation;
  const adapterInstanceId = nonEmpty(event.adapterInstanceId ?? receipt?.adapterInstanceId);
  const usedRatio = ratio(event.usedRatio);
  const observedAt = timestamp(event.observedAt);
  const remainingCapacity = Number(event.remainingCapacity);
  const providerId = nonEmpty(event.providerId);
  if (providerId !== "openai-codex" || !accountId || accountId !== controllingAccountId || !bucketId || !windowId || !receiptId || !adapterInstanceId) return null;
  if (!Number.isSafeInteger(monotonicObservation) || monotonicObservation < 0 || usedRatio == null || !observedAt) return null;
  if (!Number.isFinite(remainingCapacity) || remainingCapacity < 0) return null;
  return {
    accountId,
    providerId,
    bucketId,
    windowId,
    nativeReceiptDigest: digest(receipt),
    monotonicObservation,
    adapterInstanceId,
    usedRatio,
    remainingCapacity,
    observedAt,
    resetAt: timestamp(event.resetAt),
    exhausted: event.exhausted === true || usedRatio >= 1,
  };
}

function normalizeManualScope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = nonEmpty(value.kind);
  const label = nonEmpty(value.label);
  if (!label || !["provider", "app", "account"].includes(kind) || label.length > 80) return null;
  return { kind, label };
}

function freezeManualManifest(value, maximum) {
  if (!Array.isArray(value)) return [];
  return uniqueById(value).slice(0, maximum).map((item) => ({
    id: item.id,
    prerequisitesDigest: nonEmpty(item.prerequisitesDigest) ?? digest(item.prerequisites ?? {}),
  }));
}

function freezeSnapshot(value) {
  const snapshot = value && typeof value === "object" ? value : {};
  const targets = uniqueById(snapshot.targets)
    .filter((item) => item.status === "running")
    .map((item) => ({ id: item.id, continuationMode: item.continuationMode ?? "unspecified" }));
  const monitors = uniqueById(snapshot.monitors)
    .map((item) => ({ id: item.id, version: item.version ?? null, state: item.state ?? null }));
  const manifest = uniqueById(snapshot.manifest)
    .filter((item) => item.status === "idle" && item.continuationMode === "continuous" && item.preauthorized === true)
    .map((item) => ({ id: item.id, prerequisitesDigest: nonEmpty(item.prerequisitesDigest) ?? digest(item.prerequisites ?? {}) }));
  const fast = snapshot.fastCanary;
  const fastCanary = fast?.eligible === true && nonEmpty(fast.turnId)
    ? { eligible: true, turnId: fast.turnId }
    : null;
  return structuredClone({ frozen: true, targets, monitors, manifest, fastCanary });
}

function uniqueById(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((item) => {
    const id = nonEmpty(item?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ ...item, id }];
  });
}

function requestedAction(epoch, type, capability, prerequisites) {
  const prerequisitesDigest = digest(prerequisites);
  return {
    epoch,
    type,
    capability,
    prerequisites: structuredClone(prerequisites),
    prerequisitesDigest,
    idempotencyKey: `${epoch}/${type}/${prerequisitesDigest}`,
  };
}

function automaticCancellation(epoch, reason) {
  return { epoch, actionTypes: AUTOMATIC_STALE_ACTION_TYPES, reason };
}

function manualCancellation(epoch, reason) {
  return { epoch, actionTypes: ["start-manual-full-push-manifest"], reason };
}

function inverseCleanupCancellation(throughEpoch, reason) {
  return { throughEpoch, actionTypes: INVERSE_CLEANUP_ACTION_TYPES, reason };
}

function sortNativeObservations(value) {
  if (!Array.isArray(value)) return [];
  return [...value].sort((left, right) => {
    const leftRatio = ratio(left?.usedRatio) ?? -1;
    const rightRatio = ratio(right?.usedRatio) ?? -1;
    const leftExhausted = left?.exhausted === true || leftRatio >= 1;
    const rightExhausted = right?.exhausted === true || rightRatio >= 1;
    if (leftExhausted !== rightExhausted) return leftExhausted ? -1 : 1;
    if (leftRatio !== rightRatio) return rightRatio - leftRatio;
    const leftRemaining = Number.isFinite(Number(left?.remainingCapacity)) ? Number(left.remainingCapacity) : Number.POSITIVE_INFINITY;
    const rightRemaining = Number.isFinite(Number(right?.remainingCapacity)) ? Number(right.remainingCapacity) : Number.POSITIVE_INFINITY;
    if (leftRemaining !== rightRemaining) return leftRemaining - rightRemaining;
    return nativeObservationTieBreak(left).localeCompare(nativeObservationTieBreak(right));
  });
}

function nativeObservationTieBreak(value) {
  return [value?.providerId, value?.accountId, value?.bucketId, value?.windowId].map((part) => String(part ?? "")).join("\u0000");
}

function normalizePolicy(value) {
  return { ...DEFAULT_MAXIMUM_UTILIZATION_POLICY, ...(value ?? {}) };
}

function cloneState(value, policy) {
  if (!value || typeof value !== "object") return createMaximumUtilizationState(policy);
  const state = { ...createMaximumUtilizationState(policy), ...structuredClone(value) };
  state.observationsByScope ??= {};
  state.suppressedWindowsByScope ??= {};
  state.manual ??= { active: false, epoch: 0, scope: null, manifest: [] };
  return state;
}

function bucketOf(observation) {
  return { providerId: observation.providerId, accountId: observation.accountId, bucketId: observation.bucketId, windowId: observation.windowId };
}

function bucketMatchesScope(bucket, observation) {
  return Boolean(bucket)
    && bucket.providerId === observation.providerId
    && bucket.accountId === observation.accountId
    && bucket.bucketId === observation.bucketId;
}

function bucketScopeKey(value) {
  return `${value.providerId ?? "openai-codex"}\u0000${value.accountId}\u0000${value.bucketId}`;
}

function activeProtection(state) {
  return ["maximum-utilization", "exhausted"].includes(state.phase);
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function ratio(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
