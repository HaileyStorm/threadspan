import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import {
  MaximumUtilizationController,
  createMaximumUtilizationState,
  reduce,
} from "../src/core/maximum-utilization-controller.mjs";
import { MaximumUtilizationJournal } from "../src/core/maximum-utilization-journal.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

const policy = Object.freeze({
  enabled: true,
  triggerUsedRatio: 0.96,
  fastCanaryUsedRatio: 0.99,
  normalRolloverConsideration: 0.78,
  pressuredRolloverConsideration: 0.75,
  oneManifestPerEpoch: true,
  requireExactNativeQuotaRecovery: true,
});

test("maximum-utilization stays disabled and rejects non-native launch evidence", () => {
  const disabled = reduce(createMaximumUtilizationState(), nativeQuota(), { ...policy, enabled: false });
  assert.equal(disabled.state.phase, "disabled");
  assert.deepEqual(disabled.actions, []);

  for (const event of [
    { type: "forecast", usedRatio: 1 },
    { type: "generic-429", authoritative: true, usedRatio: 1 },
    { ...nativeQuota(), sourceKind: "local-usage" },
    { ...nativeQuota(), accountId: "other" },
    { ...nativeQuota(), nativeReceipt: null },
    { ...nativeQuota(), monotonicObservation: "1" },
  ]) {
    const result = reduce(createMaximumUtilizationState(policy), event, policy);
    assert.equal(result.state.phase, "idle");
    assert.deepEqual(result.actions, []);
  }
});

test("launch freezes one snapshot and emits one capability-tagged action set", () => {
  let state = createMaximumUtilizationState(policy);
  ({ state } = reduce(state, nativeQuota({ usedRatio: 0.95, monotonicObservation: 1 }), policy));
  const launched = reduce(state, nativeQuota({
    usedRatio: 0.96,
    monotonicObservation: 2,
    snapshot: snapshot(),
  }), policy);
  state = launched.state;
  assert.equal(state.phase, "maximum-utilization");
  assert.equal(state.epoch, 1);
  assert.deepEqual(state.protectedTargetIds, ["task-a", "task-b"]);
  assert.equal(launched.actions.filter((action) => action.type === "send-entry-notice").length, 2);
  assert.equal(launched.actions.filter((action) => action.type === "protect-running-turn").length, 2);
  assert.equal(launched.actions.filter((action) => action.type === "start-preauthorized-manifest").length, 1);
  assert.equal(launched.actions.filter((action) => action.type === "suspend-future-monitor").length, 1);
  assert.ok(launched.actions.every((action) => action.capability && action.prerequisitesDigest.length === 64));
  assert.equal(new Set(launched.actions.map((action) => action.idempotencyKey)).size, launched.actions.length);
  assert.ok(launched.actions.every((action) => action.idempotencyKey.startsWith(`1/${action.type}/`)));

  const noExpansion = reduce(state, nativeQuota({
    usedRatio: 0.97,
    monotonicObservation: 3,
    snapshot: { targets: [{ id: "late-task", status: "running" }] },
  }), policy);
  assert.deepEqual(noExpansion.state.protectedTargetIds, ["task-a", "task-b"]);
  assert.deepEqual(noExpansion.actions, []);
});

test("direct first exhaustion and existing-epoch exhaustion never emit entry actions", () => {
  let direct = reduce(createMaximumUtilizationState(policy), nativeQuota({ usedRatio: 1, remainingCapacity: 0 }), policy);
  assert.equal(direct.state.phase, "exhausted");
  assert.equal(direct.state.directExhaustion, true);
  assert.deepEqual(direct.actions, []);

  direct = reduce(direct.state, nativeQuota({ usedRatio: 0.4, remainingCapacity: 10, bucketId: "different", monotonicObservation: 2 }), policy);
  assert.equal(direct.state.phase, "exhausted");
  direct = reduce(direct.state, nativeQuota({ usedRatio: 0.4, remainingCapacity: 10, monotonicObservation: 1 }), policy);
  assert.equal(direct.state.phase, "exhausted");
  direct = reduce(direct.state, nativeQuota({ usedRatio: 0.4, remainingCapacity: 10, monotonicObservation: 2, windowId: "new-reset-window" }), policy);
  assert.equal(direct.state.phase, "idle");
  assert.equal(direct.state.recoveryConfirmed, true);

  const launched = reduce(createMaximumUtilizationState(policy), nativeQuota({ usedRatio: 0.96, snapshot: snapshot() }), policy);
  const exhausted = reduce(launched.state, nativeQuota({ usedRatio: 1, remainingCapacity: 0, monotonicObservation: 2 }), policy);
  assert.equal(exhausted.state.phase, "exhausted");
  assert.deepEqual(exhausted.actions, []);
});

test("owner disable restores active automatic state and suppresses the same native window", () => {
  let result = reduce(createMaximumUtilizationState(policy), nativeQuota({ usedRatio: 0.96, snapshot: snapshot() }), policy);
  result = reduce(result.state, { type: "owner-disable" }, policy);
  assert.equal(result.state.phase, "idle");
  assert.equal(result.state.readiness, "owner-disabled");
  assert.ok(result.actions.some((action) => action.type === "restore-monitor-cas"));
  assert.equal(result.actions.filter((action) => action.type === "unprotect-running-turn").length, 2);
  assert.equal(result.cancellations.length, 1);
  result = reduce(result.state, nativeQuota({ usedRatio: 0.99, monotonicObservation: 2, snapshot: snapshot() }), policy);
  assert.equal(result.state.phase, "idle");
  result = reduce(result.state, nativeQuota({ usedRatio: 0.96, monotonicObservation: 3, windowId: "new-window", snapshot: snapshot() }), policy);
  assert.equal(result.state.phase, "maximum-utilization");
});

test("Fast is one bounded eligible turn and rollover emits consider only after every gate", () => {
  const normalState = createMaximumUtilizationState(policy);
  const normalTooEarly = reduce(normalState, { type: "context-observed", targetId: "task-a", contextRatio: 0.77, considerationId: "normal", gates: rolloverGates() }, policy);
  assert.deepEqual(normalTooEarly.actions, []);
  const normalConsidered = reduce(normalTooEarly.state, { type: "context-observed", targetId: "task-a", contextRatio: 0.78, considerationId: "normal", gates: rolloverGates() }, policy);
  assert.equal(normalConsidered.actions[0].prerequisites.threshold, 0.78);

  let transition = reduce(createMaximumUtilizationState(policy), nativeQuota({ usedRatio: 0.96, snapshot: snapshot() }), policy);
  assert.equal(transition.state.fastCanaryIssued, false);
  transition = reduce(transition.state, nativeQuota({ usedRatio: 0.99, monotonicObservation: 2, snapshot: { fastCanary: { eligible: true, turnId: "late" } } }), policy);
  assert.equal(transition.actions.filter((action) => action.type === "start-fast-canary").length, 1);
  assert.equal(transition.actions[0].prerequisites.survivalGuaranteed, false);
  const repeatedFast = reduce(transition.state, nativeQuota({ usedRatio: 0.995, monotonicObservation: 3 }), policy);
  assert.deepEqual(repeatedFast.actions, []);

  const incomplete = reduce(repeatedFast.state, {
    type: "context-observed", targetId: "task-a", contextRatio: 0.75, considerationId: "roll-1", gates: { predecessorStopped: true },
  }, policy);
  assert.deepEqual(incomplete.actions, []);
  const considered = reduce(incomplete.state, {
    type: "context-observed", targetId: "task-a", contextRatio: 0.75, considerationId: "roll-1", gates: rolloverGates(),
  }, policy);
  assert.equal(considered.actions.length, 1);
  assert.equal(considered.actions[0].type, "consider-rollover");
  assert.equal(considered.actions[0].prerequisites.promote, false);
  assert.equal(considered.actions[0].prerequisites.threshold, 0.75);
});

test("protection, future-monitor, inbox, output, and CAS recovery semantics are exact", () => {
  let state = reduce(createMaximumUtilizationState(policy), nativeQuota({ usedRatio: 0.96, snapshot: snapshot() }), policy).state;
  let result = reduce(state, { type: "supervisor-action-requested", targetId: "task-a", action: "steer", authority: "supervisor" }, policy);
  assert.equal(result.actions[0].type, "deny-supervisor-action");
  result = reduce(result.state, { type: "supervisor-action-requested", targetId: "task-a", action: "interrupt", authority: "user-stop" }, policy);
  assert.equal(result.actions[0].type, "allow-authority-action");
  state = result.state;

  state = reduce(state, { type: "inbox-message-enqueued", targetId: "task-a", sequence: 1, visibility: "owner-private", body: "private body" }, policy).state;
  state = reduce(state, { type: "inbox-message-enqueued", targetId: "task-a", sequence: 1, visibility: "owner-private", body: "duplicate" }, policy).state;
  result = reduce(state, { type: "natural-checkpoint", targetId: "task-a" }, policy);
  assert.equal(result.actions.filter((action) => action.type === "deliver-owner-inbox").length, 1);
  assert.deepEqual(reduce(result.state, { type: "natural-checkpoint", targetId: "task-a" }, policy).actions, []);

  result = reduce(result.state, { type: "output-phase-observed", targetId: "task-a", phase: "final" }, policy);
  assert.equal(result.state.phase, "maximum-utilization");
  assert.equal(result.actions[0].prerequisites.protectionContinues, true);
  result = reduce(result.state, { type: "monitor-future-invocation", monitorId: "later-monitor", version: 7, state: "enabled" }, policy);
  assert.equal(result.actions[0].type, "suspend-future-monitor");

  result = reduce(result.state, nativeQuota({ usedRatio: 1, remainingCapacity: 0, monotonicObservation: 2 }), policy);
  result = reduce(result.state, nativeQuota({ usedRatio: 0.2, remainingCapacity: 20, monotonicObservation: 3 }), policy);
  assert.equal(result.state.phase, "idle");
  assert.equal(result.cancellations.length, 1);
  assert.equal(result.actions.filter((action) => action.type === "unprotect-running-turn").length, 2);
  const restores = result.actions.filter((action) => action.type === "restore-monitor-cas");
  assert.equal(restores.length, 2);
  assert.ok(restores.some((action) => action.prerequisites.expectedVersion === 7));
});

test("journal persists before dispatch, preserves unsupported truth, and replays after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-max-util-"));
  const path = join(root, "state", "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let first = true;
  let observedPersistedPending = false;
  const journal = new MaximumUtilizationJournal({ path });
  const controller = new MaximumUtilizationController({
    policy,
    journal,
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations: [nativeQuota({ usedRatio: 0.96, snapshot: undefined })] }) },
    snapshotProvider: async () => snapshot(),
    capabilities: {
      "task.notice": async (action) => {
        const document = JSON.parse(await readFile(path, "utf8"));
        observedPersistedPending ||= document.outbox.some((entry) => entry.idempotencyKey === action.idempotencyKey && entry.status === "pending");
        if (first) { first = false; throw new Error("temporary host failure"); }
      },
    },
  });
  await controller.initialize();
  await controller.refreshNative();
  assert.equal(observedPersistedPending, true);
  let counts = await journal.statusCounts();
  assert.ok(counts.pending >= 1);
  assert.ok(counts.unsupported >= 1);

  const replayed = [];
  const replay = (capability) => async (action) => replayed.push([capability, action.idempotencyKey]);
  const restartedJournal = new MaximumUtilizationJournal({ path });
  const restarted = new MaximumUtilizationController({
    policy,
    journal: restartedJournal,
    capabilities: {
      "task.notice": replay("task.notice"),
      "turn.protect": replay("turn.protect"),
      "monitor.suspend-future": replay("monitor.suspend-future"),
      "manifest.start": replay("manifest.start"),
    },
  });
  await restarted.initialize();
  counts = await restartedJournal.statusCounts();
  assert.equal(counts.pending, 0);
  assert.equal(counts.unsupported, 0);
  assert.ok(counts.executed > 0);
  assert.ok(replayed.length > 0);

  const hud = await restarted.readModel();
  const serialized = JSON.stringify(hud);
  assert.doesNotMatch(serialized, /task-a|task-b|monitor-a|private body|receipt-secret|\/private\//);
  assert.deepEqual(Object.keys(hud).sort(), ["automatic", "counts", "epoch", "manual", "phase", "quota", "readiness", "statuses"]);
});

test("persistent BridgeService composition restores the controller and publishes only the sanitized HUD", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-max-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new MaximumUtilizationJournal({ path: join(root, "maximum-utilization.json") });
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: true } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: journal,
    codexNativeQuotaAdapter: { read: async () => ({ accountId: "account-a", observations: [nativeQuota({ usedRatio: 0.96, snapshot: undefined })] }) },
    maximumUtilizationSnapshotProvider: async () => snapshot(),
  });
  t.after(() => service.close());
  await service.initialize();
  assert.equal(service.maximumUtilizationEvent, undefined);
  const accepted = await service.refreshMaximumUtilizationNative();
  assert.equal(accepted.accepted, true);
  const published = (await service.threadspanState()).maximumUtilization;
  assert.equal(published.phase, "maximum-utilization");
  assert.equal(published.readiness, "active");
  assert.equal(published.counts.protectedTasks, 2);
  assert.ok(published.statuses.unsupportedActions > 0);
  assert.doesNotMatch(JSON.stringify(published), /task-a|monitor-a|receipt-secret|nativeReceipt|bucketId|windowId|accountId/);
});

test("disabled service restart reconciles persisted applied protection before bounded cleanup dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-disabled-restart-"));
  const path = join(root, "maximum-utilization.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const unsupported = async () => ({ supported: false });
  const seed = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations: [nativeQuota()] }) },
    snapshotProvider: async () => snapshot(),
    capabilities: {
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
    },
  });
  await seed.initialize();
  await seed.refreshNative();
  assert.equal(seed.state.phase, "maximum-utilization");
  await seed.close();

  const dispatched = [];
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: {
      "turn.unprotect": async (action) => { dispatched.push(action.type); },
      "monitor.restore-cas": async (action) => { dispatched.push(action.type); },
      "task.notice": async () => { dispatched.push("unexpected-notice"); },
      "turn.protect": async () => { dispatched.push("unexpected-protect"); },
    },
  });
  t.after(() => service.close());
  await service.initialize();
  assert.equal(dispatched.filter((type) => type === "unprotect-running-turn").length, 2);
  assert.equal(dispatched.filter((type) => type === "restore-monitor-cas").length, 1);
  assert.doesNotMatch(dispatched.join(","), /unexpected/);
  assert.equal(service.maximumUtilizationController.state.phase, "disabled");
  assert.deepEqual(await service.maximumUtilizationController.journal.replayableOutbox(), []);
});

test("disabled restart dispatches existing pending inverse cleanup without recreating forward work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-disabled-inverse-"));
  const path = join(root, "maximum-utilization.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations: [nativeQuota()] }) },
    snapshotProvider: async () => snapshot(),
    capabilities: {
      "task.notice": async () => undefined,
      "turn.protect": async () => undefined,
      "monitor.suspend-future": async () => undefined,
      "manifest.start": async () => undefined,
      "turn.unprotect": async () => ({ supported: false }),
      "monitor.restore-cas": async () => ({ supported: false }),
    },
  });
  await seed.initialize();
  await seed.refreshNative();
  await seed.ownerDisable();
  await seed.close();

  const dispatched = [];
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: {
      "turn.unprotect": async (action) => { dispatched.push(action.type); },
      "monitor.restore-cas": async (action) => { dispatched.push(action.type); },
    },
  });
  t.after(() => service.close());
  await service.initialize();
  assert.equal(dispatched.filter((type) => type === "unprotect-running-turn").length, 2);
  assert.equal(dispatched.filter((type) => type === "restore-monitor-cas").length, 1);
  assert.equal(service.maximumUtilizationController.state.phase, "disabled");
  assert.deepEqual(await service.maximumUtilizationController.journal.replayableOutbox(), []);
});

test("disabled service with no prior journal remains filesystem-silent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-disabled-silent-"));
  const stateDirectory = join(root, "absent-state");
  const path = join(stateDirectory, "maximum-utilization.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let capabilityCalls = 0;
  let injectedInitializeCalls = 0;
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationController: { initialize: async () => { injectedInitializeCalls += 1; } },
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: { "turn.unprotect": async () => { capabilityCalls += 1; } },
  });
  t.after(() => service.close());
  await service.initialize();
  assert.equal(service.maximumUtilizationController, null);
  assert.equal(capabilityCalls, 0);
  assert.equal(injectedInitializeCalls, 0);
  await assert.rejects(stat(stateDirectory), (error) => error?.code === "ENOENT");
});

test("disabled restart cancels stale forward-only work that could otherwise replay after re-enable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-disabled-forward-"));
  const path = join(root, "maximum-utilization.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    capabilities: { "manifest.start": async () => ({ supported: false }) },
  });
  await seed.initialize();
  await seed.enterManual({ scope: { kind: "account", label: "Work" }, manifest: [{ id: "manual-one" }] });
  await seed.close();

  let manifestCalls = 0;
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: { "manifest.start": async () => { manifestCalls += 1; } },
  });
  t.after(() => service.close());
  await service.initialize();
  assert.equal(manifestCalls, 0);
  assert.equal(service.maximumUtilizationController.state.phase, "disabled");
  assert.deepEqual(await service.maximumUtilizationController.journal.replayableOutbox(), []);
});

test("manual full-push is scope-labeled, bounded, and quota-independent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-manual-full-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new MaximumUtilizationController({
    policy: { ...policy, manualManifestMaxEntries: 2 },
    journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
  });
  await controller.initialize();
  const entered = await controller.enterManual({
    scope: { kind: "account", label: "Codex work account" },
    manifest: [{ id: "one" }, { id: "two" }],
  });
  assert.equal(entered.readModel.manual.active, true);
  assert.deepEqual(entered.readModel.manual.scope, { kind: "account", label: "Codex work account" });
  assert.equal(entered.readModel.manual.manifestCount, 2);
  assert.equal(entered.readModel.statuses.fastCanary, "not-requested");
  assert.equal(entered.readModel.quota.usedRatio, null);
  await assert.rejects(controller.enterManual({ scope: { kind: "app", label: "Codex" }, manifest: [{ id: "a" }, { id: "b" }, { id: "c" }] }), /exceeds 2/);
  const left = await controller.leaveManual();
  assert.equal(left.readModel.manual.active, false);
});

test("multi-bucket authority is deterministic, worst-first, and owner disable suppresses every exact current window", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const projections = [];
  for (const order of [["steady", "exhausted"], ["exhausted", "steady"]]) {
    const root = await mkdtemp(join(tmpdir(), "threadspan-multi-bucket-"));
    roots.push(root);
    let sequence = 1;
    let windows = { steady: "steady-window", exhausted: "exhausted-window" };
    let currentOrder = order;
    const observations = () => currentOrder.map((bucketId) => nativeQuota({
      bucketId,
      windowId: windows[bucketId],
      monotonicObservation: sequence,
      usedRatio: bucketId === "exhausted" ? 1 : 0.96,
      remainingCapacity: bucketId === "exhausted" ? 0 : 0.04,
      exhausted: bucketId === "exhausted",
    }));
    const controller = new MaximumUtilizationController({
      policy,
      journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
      quotaAdapter: { read: async () => ({ accountId: "account-a", observations: observations() }) },
      snapshotProvider: async () => { throw new Error("direct exhaustion must not snapshot"); },
    });
    await controller.initialize();
    await controller.refreshNative();
    projections.push({ phase: controller.state.phase, epoch: controller.state.epoch, bucket: controller.state.bucket, directExhaustion: controller.state.directExhaustion });
    assert.equal(controller.state.phase, "exhausted");
    assert.equal(controller.state.bucket.bucketId, "exhausted");
    assert.equal(Object.keys(controller.state.observationsByScope).length, 2);
    assert.equal((await controller.journal.statusCounts()).pending, 0);

    await controller.ownerDisable();
    currentOrder = [...order].reverse();
    sequence = 2;
    await controller.refreshNative();
    assert.equal(controller.state.phase, "idle");
    assert.equal(controller.state.readiness, "owner-disabled");
    assert.equal(controller.state.epoch, 1);

    windows = { ...windows, exhausted: "next-exhausted-window" };
    sequence = 3;
    await controller.refreshNative();
    assert.equal(controller.state.phase, "exhausted");
    assert.equal(controller.state.epoch, 2);
  }
  assert.deepEqual(projections[0], projections[1]);
});

test("exact recovery requires a fresh complete batch containing the active controlling bucket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-exact-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let observations = [
    nativeQuota({ bucketId: "exhausted", windowId: "exhausted-window", usedRatio: 1, remainingCapacity: 0, exhausted: true }),
    nativeQuota({ bucketId: "steady", windowId: "steady-window", usedRatio: 0.5, remainingCapacity: 0.5 }),
  ];
  const controller = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations }) },
  });
  await controller.initialize();
  await controller.refreshNative();
  observations = [nativeQuota({ bucketId: "steady", windowId: "steady-window", monotonicObservation: 2, usedRatio: 0.2, remainingCapacity: 0.8 })];
  await controller.refreshNative();
  assert.equal(controller.state.phase, "exhausted");
  assert.equal(controller.state.readiness, "awaiting-exact-native-recovery");

  observations = [
    nativeQuota({ bucketId: "exhausted", windowId: "exhausted-window", monotonicObservation: 3, usedRatio: 0.2, remainingCapacity: 0.8 }),
    nativeQuota({ bucketId: "steady", windowId: "steady-window", monotonicObservation: 3, usedRatio: 0.1, remainingCapacity: 0.9 }),
  ];
  await controller.refreshNative();
  assert.equal(controller.state.phase, "idle");
  assert.equal(controller.state.recoveryConfirmed, true);
});

test("disable and manual leave atomically cancel obsolete launch work before restart capability changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-stale-outbox-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const cleanup = [];
  const unsupported = async () => ({ supported: false });
  const controller = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations: [nativeQuota({ usedRatio: 0.99 })] }) },
    snapshotProvider: async () => snapshot(),
    capabilities: {
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
      "fast-canary.start": unsupported,
      "turn.unprotect": async (action) => { cleanup.push(action.type); },
      "monitor.restore-cas": async (action) => { cleanup.push(action.type); },
    },
  });
  await controller.initialize();
  await controller.refreshNative();
  await controller.ownerDisable();
  assert.equal(cleanup.filter((type) => type === "unprotect-running-turn").length, 2);
  assert.equal(cleanup.filter((type) => type === "restore-monitor-cas").length, 1);

  await controller.enterManual({ scope: { kind: "account", label: "Work" }, manifest: [{ id: "manual-one" }] });
  await controller.leaveManual();
  const beforeRestart = await controller.journal.statusCounts();
  assert.ok(beforeRestart.cancelled > 0);
  assert.equal(beforeRestart.pending, 0);
  assert.equal(beforeRestart.unsupported, 0);

  const replayed = [];
  const capture = (capability) => async () => { replayed.push(capability); };
  const restartedJournal = new MaximumUtilizationJournal({ path });
  const restarted = new MaximumUtilizationController({
    policy,
    journal: restartedJournal,
    capabilities: {
      "task.notice": capture("task.notice"),
      "turn.protect": capture("turn.protect"),
      "monitor.suspend-future": capture("monitor.suspend-future"),
      "manifest.start": capture("manifest.start"),
      "fast-canary.start": capture("fast-canary.start"),
    },
  });
  await restarted.initialize();
  assert.deepEqual(replayed, []);
  assert.deepEqual(await restartedJournal.replayableOutbox(), []);
});

test("a new automatic epoch cancels pending inverse cleanup so restart cannot undo current protection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-stale-cleanup-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let observation = nativeQuota({ usedRatio: 0.96 });
  const unsupported = async () => ({ supported: false });
  const controller = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    quotaAdapter: { read: async () => ({ accountId: "account-a", observations: [observation] }) },
    snapshotProvider: async () => snapshot(),
    capabilities: {
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
      "turn.unprotect": unsupported,
      "monitor.restore-cas": unsupported,
    },
  });
  await controller.initialize();
  await controller.refreshNative();
  await controller.ownerDisable();
  observation = nativeQuota({ windowId: "next-window", monotonicObservation: 2, usedRatio: 0.96 });
  await controller.refreshNative();
  assert.equal(controller.state.phase, "maximum-utilization");
  assert.equal(controller.state.epoch, 2);
  const cleanupEntries = (await controller.journal.snapshot()).outbox.filter((entry) => ["unprotect-running-turn", "restore-monitor-cas"].includes(entry.action.type));
  assert.ok(cleanupEntries.length > 0);
  assert.ok(cleanupEntries.every((entry) => entry.status === "cancelled"));

  const replayedCleanup = [];
  const restarted = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    capabilities: {
      "turn.unprotect": async () => { replayedCleanup.push("unprotect"); },
      "monitor.restore-cas": async () => { replayedCleanup.push("restore"); },
    },
  });
  await Promise.all([restarted.initialize(), restarted.initialize()]);
  assert.deepEqual(replayedCleanup, []);
});

function nativeQuota(overrides = {}) {
  return {
    type: "native-quota-observed",
    sourceKind: "codex-native-quota",
    providerId: "openai-codex",
    accountId: "account-a",
    controllingAccountId: "account-a",
    bucketId: "weekly",
    windowId: "2026-W34",
    nativeReceipt: { id: "receipt-secret", path: "/private/quota" },
    adapterInstanceId: "adapter-a",
    monotonicObservation: 1,
    usedRatio: 0.96,
    remainingCapacity: 4,
    observedAt: "2026-08-17T18:00:00Z",
    resetAt: "2026-08-18T18:00:00Z",
    ...overrides,
  };
}

function snapshot() {
  return {
    targets: [
      { id: "task-a", status: "running", continuationMode: "continuous" },
      { id: "task-b", status: "running", continuationMode: "milestone" },
      { id: "idle-task", status: "idle", continuationMode: "continuous" },
    ],
    monitors: [{ id: "monitor-a", version: 4, state: "enabled" }],
    manifest: [
      { id: "idle-task", status: "idle", continuationMode: "continuous", preauthorized: true, prerequisites: { reservation: "clear" } },
      { id: "milestone", status: "idle", continuationMode: "milestone", preauthorized: true },
    ],
    fastCanary: { eligible: true, turnId: "fast-turn" },
  };
}

function rolloverGates() {
  return {
    predecessorStopped: true,
    singleSuccessor: true,
    identityVerified: true,
    reservationClear: true,
    quietBoundary: true,
    noUserInputRequired: true,
  };
}
