import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  let observedPersistedClaim = false;
  const journal = new MaximumUtilizationJournal({ path });
  const controller = new MaximumUtilizationController({
    policy,
    journal,
    quotaAdapter: fakeQuotaAdapter(() => [nativeQuota({ usedRatio: 0.96, snapshot: undefined })]),
    snapshotProvider: async () => snapshot(),
    capabilities: hostCapabilities({
      "task.notice": async (action, context) => {
        const document = JSON.parse(await readFile(path, "utf8"));
        observedPersistedClaim ||= document.outbox.some((entry) => entry.idempotencyKey === action.idempotencyKey && entry.status === "claimed");
        if (first) { first = false; throw new Error("temporary host failure"); }
        return executedResult(action, context);
      },
    }),
  });
  await controller.initialize();
  await controller.refreshNative();
  assert.equal(observedPersistedClaim, true);
  let counts = await journal.statusCounts();
  assert.equal(counts.indeterminate, 1);
  assert.ok(counts.unsupported >= 1);

  const replayed = [];
  const replay = (capability) => async (action, context) => {
    replayed.push([capability, action.idempotencyKey]);
    return executedResult(action, context);
  };
  const restartedJournal = new MaximumUtilizationJournal({ path });
  const restarted = new MaximumUtilizationController({
    policy,
    journal: restartedJournal,
    capabilities: hostCapabilities({
      "task.notice": replay("task.notice"),
      "turn.protect": replay("turn.protect"),
      "monitor.suspend-future": replay("monitor.suspend-future"),
      "manifest.start": replay("manifest.start"),
    }),
  });
  await restarted.initialize();
  counts = await restartedJournal.statusCounts();
  assert.equal(counts.pending, 0);
  assert.equal(counts.unsupported, 0);
  assert.equal(counts.indeterminate, 1);
  assert.ok(counts.executed > 0);
  assert.ok(replayed.length > 0);
  assert.equal(replayed.some(([capability]) => capability === "task.notice"), false);

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
    codexNativeQuotaAdapter: fakeQuotaAdapter(() => [nativeQuota({ usedRatio: 0.96, snapshot: undefined })]),
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
    quotaAdapter: fakeQuotaAdapter(() => [nativeQuota()]),
    snapshotProvider: async () => snapshot(),
    capabilities: hostCapabilities({
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
    }),
  });
  await seed.initialize();
  await seed.refreshNative();
  assert.equal(seed.state.phase, "maximum-utilization");
  await seed.close();

  const dispatched = [];
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: hostCapabilities({
      "turn.unprotect": async (action, context) => { dispatched.push(action.type); return executedResult(action, context); },
      "monitor.restore-cas": async (action, context) => { dispatched.push(action.type); return executedResult(action, context); },
      "task.notice": async () => { dispatched.push("unexpected-notice"); },
      "turn.protect": async () => { dispatched.push("unexpected-protect"); },
    }),
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
    quotaAdapter: fakeQuotaAdapter(() => [nativeQuota()]),
    snapshotProvider: async () => snapshot(),
    capabilities: hostCapabilities({
      "task.notice": executedResult,
      "turn.protect": executedResult,
      "monitor.suspend-future": executedResult,
      "manifest.start": executedResult,
      "turn.unprotect": async () => ({ supported: false }),
      "monitor.restore-cas": async () => ({ supported: false }),
    }),
  });
  await seed.initialize();
  await seed.refreshNative();
  await seed.ownerDisable();
  await seed.close();

  const dispatched = [];
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: hostCapabilities({
      "turn.unprotect": async (action, context) => { dispatched.push(action.type); return executedResult(action, context); },
      "monitor.restore-cas": async (action, context) => { dispatched.push(action.type); return executedResult(action, context); },
    }),
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
    maximumUtilizationCapabilities: hostCapabilities({ "turn.unprotect": async () => { capabilityCalls += 1; } }),
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
    capabilities: hostCapabilities({ "manifest.start": async () => ({ supported: false }) }),
  });
  await seed.initialize();
  await seed.enterManual({ scope: { kind: "account", label: "Work" }, manifest: [{ id: "manual-one" }] });
  await seed.close();

  let manifestCalls = 0;
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: false } }), {
    logger: silentLogger(),
    maximumUtilizationJournal: new MaximumUtilizationJournal({ path }),
    maximumUtilizationCapabilities: hostCapabilities({ "manifest.start": async () => { manifestCalls += 1; } }),
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
      quotaAdapter: fakeQuotaAdapter(() => observations()),
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
    quotaAdapter: fakeQuotaAdapter(() => observations),
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
    quotaAdapter: fakeQuotaAdapter(() => [nativeQuota({ usedRatio: 0.99, remainingCapacity: 0.01 })]),
    snapshotProvider: async () => snapshot(),
    capabilities: hostCapabilities({
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
      "fast-canary.start": unsupported,
      "turn.unprotect": async (action, context) => { cleanup.push(action.type); return executedResult(action, context); },
      "monitor.restore-cas": async (action, context) => { cleanup.push(action.type); return executedResult(action, context); },
    }),
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
    capabilities: hostCapabilities({
      "task.notice": capture("task.notice"),
      "turn.protect": capture("turn.protect"),
      "monitor.suspend-future": capture("monitor.suspend-future"),
      "manifest.start": capture("manifest.start"),
      "fast-canary.start": capture("fast-canary.start"),
    }),
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
    quotaAdapter: fakeQuotaAdapter(() => [observation]),
    snapshotProvider: async () => snapshot(),
    capabilities: hostCapabilities({
      "task.notice": unsupported,
      "turn.protect": unsupported,
      "monitor.suspend-future": unsupported,
      "manifest.start": unsupported,
      "turn.unprotect": unsupported,
      "monitor.restore-cas": unsupported,
    }),
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
    capabilities: hostCapabilities({
      "turn.unprotect": async () => { replayedCleanup.push("unprotect"); },
      "monitor.restore-cas": async () => { replayedCleanup.push("restore"); },
    }),
  });
  await Promise.all([restarted.initialize(), restarted.initialize()]);
  assert.deepEqual(replayedCleanup, []);
});

test("automatic entry rejects stale, tampered, and adapter-unrechecked native batches", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const cases = [
    fakeQuotaAdapter(() => [nativeQuota()], {
      mutate: (batch) => { batch.observations[0].nativeReceipt.argv.push("--tampered"); return batch; },
    }),
    fakeQuotaAdapter(() => [nativeQuota()], { observedAt: new Date(Date.now() - 180_000).toISOString() }),
  ];
  const sourceWithoutRecheck = fakeQuotaAdapter(() => [nativeQuota()]);
  cases.push({ read: sourceWithoutRecheck.read });
  for (const quotaAdapter of cases) {
    const root = await mkdtemp(join(tmpdir(), "threadspan-native-reject-"));
    roots.push(root);
    const controller = new MaximumUtilizationController({
      policy,
      journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
      quotaAdapter,
      snapshotProvider: async () => snapshot(),
    });
    await controller.initialize();
    await assert.rejects(controller.refreshNative(), /validation|revalidation/);
    assert.equal(controller.state.phase, "idle");
    assert.deepEqual(await controller.journal.replayableOutbox(), []);
  }
});

test("a restarted adapter generation must present strictly newer source times", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-native-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let readNumber = 0;
  let lastBatch;
  const baseTime = Date.now();
  const quotaAdapter = {
    async read() {
      readNumber += 1;
      lastBatch = certifyNativeBatch([nativeQuota({ usedRatio: readNumber === 1 ? 0.5 : 0.96, remainingCapacity: readNumber === 1 ? 0.5 : 0.04 })], {
        adapterInstanceId: `restart-${readNumber}`,
        adapterGenerationId: `generation-${readNumber}`,
        batchSequence: 1,
        observedAt: new Date(baseTime + (readNumber === 1 ? 100 : 50)).toISOString(),
      });
      return lastBatch;
    },
    async withRevalidatedBinding(batch, operation) {
      const proof = batch.bindingProof;
      return operation({ valid: true, batchId: proof.batchId, bindingProofDigest: batch.bindingProofDigest, accountSelectionBindingDigest: proof.accountSelectionBindingDigest, adapterInstanceId: proof.adapterInstanceId, adapterGenerationId: proof.adapterGenerationId, batchSequence: proof.batchSequence, nativeIdentityRecheckReceiptId: "f".repeat(64) });
    },
  };
  const controller = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
    quotaAdapter,
    snapshotProvider: async () => snapshot(),
  });
  await controller.initialize();
  await controller.refreshNative();
  await assert.rejects(controller.refreshNative(), /not newer/);
  assert.equal(controller.state.phase, "idle");
  assert.equal(controller.state.epoch, 0);
});

test("concurrent journal dispatchers claim one host effect exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-dispatch-cas-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  await seed.initialize();
  await seed.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  await seed.close();
  let calls = 0;
  const handler = async (action, context) => { calls += 1; return executedResult(action, context); };
  const first = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }), capabilities: hostCapabilities({ "manifest.start": handler }), dispatcherId: "first" });
  const second = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }), capabilities: hostCapabilities({ "manifest.start": handler }), dispatcherId: "second" });
  await Promise.all([first.initialize(), second.initialize()]);
  assert.equal(calls, 1);
  const counts = await first.journal.statusCounts();
  assert.equal(counts.executed, 1);
  assert.equal(counts.indeterminate, 0);
});

test("cancellation racing an in-flight host effect cannot be resurrected by late success", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-dispatch-cancel-race-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  let startedResolve;
  const releaseGate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let calls = 0;
  const first = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    capabilities: hostCapabilities({ "manifest.start": async (action, context) => {
      calls += 1;
      startedResolve();
      await releaseGate;
      return executedResult(action, context);
    } }),
    dispatcherId: "racing-first",
  });
  await first.initialize();
  const entering = first.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  await started;
  const second = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }), dispatcherId: "racing-second" });
  await second.initialize();
  await second.leaveManual();
  release();
  await entering;
  const snapshotAfter = await second.journal.snapshot();
  assert.equal(calls, 1);
  assert.equal(snapshotAfter.state.manual.active, false);
  assert.equal(snapshotAfter.outbox[0].status, "indeterminate");
  assert.match(snapshotAfter.outbox[0].lastError, /cancelled while dispatch claim/);
});

test("an expired dispatch claim becomes indeterminate and never replayable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-dispatch-expiry-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = Date.now();
  const now = () => new Date(nowMs).toISOString();
  const journal = new MaximumUtilizationJournal({ path, now });
  const controller = new MaximumUtilizationController({ policy, journal });
  await controller.initialize();
  await controller.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  const [entry] = await journal.replayableOutbox();
  const claim = await journal.claimDispatch(entry.idempotencyKey, { dispatcherId: "crashed", leaseMs: 10 });
  assert.ok(claim);
  nowMs += 11;
  assert.deepEqual(await journal.replayableOutbox(), []);
  const counts = await journal.statusCounts();
  assert.equal(counts.indeterminate, 1);
  assert.equal(counts.executed, 0);
});

test("tampered durable outbox action binding fails closed before replay", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-outbox-tamper-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  await controller.initialize();
  await controller.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  const document = JSON.parse(await readFile(path, "utf8"));
  document.outbox[0].action.prerequisites.entries[0].id = "tampered";
  await writeFile(path, `${JSON.stringify(document)}\n`);
  await assert.rejects(new MaximumUtilizationJournal({ path }).initialize(), /Malformed maximum-utilization outbox entry/);
});

test("host execution requires a self-digested receipt bound to claim, capability, action, host, and time", async (t) => {
  const roots = [];
  t.after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
  const handlers = [
    async (action, context) => {
      const result = executedResult(action, context);
      result.receipt.id = "not-a-self-digest";
      return result;
    },
    async (action, context) => {
      const result = executedResult(action, context);
      const unsigned = { ...result.receipt, claimId: "wrong-claim" };
      delete unsigned.id;
      result.receipt = { ...unsigned, id: digest(unsigned) };
      return result;
    },
    async (action, context) => {
      const result = executedResult(action, context);
      const late = new Date(Date.parse(context.leaseExpiresAt) + 1).toISOString();
      const unsigned = { ...result.receipt, startedAt: late, completedAt: late };
      delete unsigned.id;
      result.receipt = { ...unsigned, id: digest(unsigned) };
      return result;
    },
    async (action, context) => {
      const result = executedResult(action, context);
      const unsigned = { ...result.receipt, hostAdapterId: "forged-host-adapter" };
      delete unsigned.id;
      result.receipt = { ...unsigned, id: digest(unsigned) };
      return result;
    },
  ];
  for (const handler of handlers) {
    const root = await mkdtemp(join(tmpdir(), "threadspan-host-receipt-"));
    roots.push(root);
    const controller = new MaximumUtilizationController({
      policy,
      journal: new MaximumUtilizationJournal({ path: join(root, "journal.json") }),
      capabilities: hostCapabilities({ "manifest.start": handler }),
    });
    await controller.initialize();
    await controller.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
    const counts = await controller.journal.statusCounts();
    assert.equal(counts.executed, 0);
    assert.equal(counts.indeterminate, 1);
  }
});

test("journal rejects receiptless execution and makes unswept late completion indeterminate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-late-completion-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  let nowMs = Date.now();
  const journal = new MaximumUtilizationJournal({ path, now: () => new Date(nowMs).toISOString() });
  const controller = new MaximumUtilizationController({ policy, journal });
  await controller.initialize();
  await controller.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  const [entry] = await journal.replayableOutbox();
  const first = await journal.claimDispatch(entry.idempotencyKey, { dispatcherId: "receiptless", leaseMs: 100 });
  await assert.rejects(journal.completeDispatch(first.claimToken, { status: "executed" }), /requires a receipt digest/);
  nowMs += 101;
  const late = await journal.completeDispatch(first.claimToken, { status: "executed", receiptDigest: "a".repeat(64) });
  assert.equal(late.accepted, false);
  assert.equal(late.entry.status, "indeterminate");
  assert.match(late.entry.lastError, /after dispatch lease expiry/);
});

test("legacy or tampered receiptless executed journal entry migrates to indeterminate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-receiptless-migration-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new MaximumUtilizationController({
    policy,
    journal: new MaximumUtilizationJournal({ path }),
    capabilities: hostCapabilities({ "manifest.start": executedResult }),
  });
  await controller.initialize();
  await controller.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.equal(document.outbox[0].status, "executed");
  assert.match(document.outbox[0].dispatchReceiptDigest, /^[a-f0-9]{64}$/);
  document.outbox[0].dispatchReceiptDigest = null;
  await writeFile(path, `${JSON.stringify(document)}\n`);
  const migrated = new MaximumUtilizationJournal({ path });
  const counts = await migrated.statusCounts();
  assert.equal(counts.executed, 0);
  assert.equal(counts.indeterminate, 1);
  assert.deepEqual(await migrated.replayableOutbox(), []);
});

test("claim-locked invocation and cancellation cannot produce cancelled-but-invoked work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-invoke-cancel-cas-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  await first.initialize();
  await first.enterManual({ scope: { kind: "app", label: "Manual" }, manifest: [{ id: "one" }] });
  const [entry] = await first.journal.replayableOutbox();
  const claim = await first.journal.claimDispatch(entry.idempotencyKey, { dispatcherId: "invoke-racer", leaseMs: 5_000 });
  const second = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  await second.initialize();
  let invoked = 0;
  const [invocation] = await Promise.all([
    first.journal.invokeClaimedDispatch(claim.claimToken, () => { invoked += 1; }),
    second.leaveManual(),
  ]);
  if (invocation.invoked) await invocation.result;
  const current = (await first.journal.snapshot()).outbox[0];
  assert.equal(current.status === "cancelled" && invoked > 0, false);
  assert.ok(["cancelled", "indeterminate"].includes(current.status));
});

test("controller reloads committed state after losing cross-process state CAS", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-controller-cas-reload-"));
  const path = join(root, "journal.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  const second = new MaximumUtilizationController({ policy, journal: new MaximumUtilizationJournal({ path }) });
  await Promise.all([first.initialize(), second.initialize()]);
  await first.enterManual({ scope: { kind: "app", label: "First" }, manifest: [] });
  await assert.rejects(second.enterManual({ scope: { kind: "app", label: "Second" }, manifest: [] }), /state changed in another process/);
  assert.equal(second.state.manual.scope.label, "First");
  await second.leaveManual();
  assert.equal((await second.journal.snapshot()).state.manual.active, false);
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
    remainingCapacity: 0.04,
    observedAt: "2026-08-17T18:00:00Z",
    resetAt: "2026-08-18T18:00:00Z",
    ...overrides,
  };
}

let fakeAdapterNumber = 0;

function fakeQuotaAdapter(readObservations, options = {}) {
  const adapterInstanceId = `fake-adapter-${++fakeAdapterNumber}`;
  const adapterGenerationId = `fake-generation-${fakeAdapterNumber}`;
  let batchSequence = 0;
  let lastBatch;
  return {
    async read() {
      lastBatch = certifyNativeBatch(await readObservations(), {
        adapterInstanceId,
        adapterGenerationId,
        batchSequence: ++batchSequence,
        observedAt: options.observedAt,
      });
      return typeof options.mutate === "function" ? options.mutate(structuredClone(lastBatch)) : lastBatch;
    },
    async withRevalidatedBinding(batch, operation) {
      assert.equal(batch.bindingProofDigest, lastBatch.bindingProofDigest);
      const proof = batch.bindingProof;
      return operation({
        valid: true,
        batchId: proof.batchId,
        bindingProofDigest: batch.bindingProofDigest,
        accountSelectionBindingDigest: proof.accountSelectionBindingDigest,
        adapterInstanceId: proof.adapterInstanceId,
        adapterGenerationId: proof.adapterGenerationId,
        batchSequence: proof.batchSequence,
        nativeIdentityRecheckReceiptId: "f".repeat(64),
      });
    },
  };
}

function certifyNativeBatch(values, generation) {
  const accountId = "account-a";
  const profileRef = "test-isolated-profile";
  const codexHome = "/test/isolated-codex-home";
  const observedAt = generation.observedAt ?? new Date(Date.now() + generation.batchSequence).toISOString();
  const completedAt = new Date(Date.parse(observedAt) - 1).toISOString();
  const startedAt = new Date(Date.parse(observedAt) - 2).toISOString();
  const nativeAccountIdentityDigest = digest({ type: "chatgpt", email: "private@example.test", planType: "pro" });
  const accountSelectionBindingDigest = digest({ kind: "account-selection-binding", providerId: "openai-codex", accountId, authKind: "cli-login", authSourceRef: null, profileRef });
  const executable = { path: process.execPath, sha256: "a".repeat(64), version: process.version, metadataDigest: "b".repeat(64) };
  const profileBindingDigest = digest({ accountId, profileRef, codexHome, nativeAccountIdentityDigest, executableSha256: executable.sha256, accountSelectionBindingDigest });
  const normalized = values.map((value) => {
    const { type: ignoredType, snapshot: ignoredSnapshot, receiptObservedAt, ...observation } = value;
    return {
      ...observation,
      sourceKind: "codex-native-quota",
      providerId: "openai-codex",
      accountId,
      controllingAccountId: accountId,
      limitId: observation.bucketId,
      windowIdentity: observation.windowId,
      observedAt: receiptObservedAt ?? observedAt,
      adapterInstanceId: generation.adapterInstanceId,
      adapterGenerationId: generation.adapterGenerationId,
      remainingCapacity: observation.remainingCapacity ?? Math.max(0, 1 - observation.usedRatio),
    };
  });
  const processResultDigest = digest({ batchSequence: generation.batchSequence, buckets: normalized.map(boundObservationResult) });
  const processReceipt = {
    kind: "codex-app-server-process",
    methods: ["account/read", "account/rateLimits/read"],
    processId: 23456,
    startedAt,
    completedAt,
    executable,
    argv: [process.execPath, "app-server", "--stdio"],
    spawnArgv: [process.execPath, "app-server", "--stdio"],
    codexHome,
    executableVerifiedAfterRead: true,
    resultDigest: processResultDigest,
  };
  processReceipt.id = digest(processReceipt);
  const resultBindingDigest = digest({
    processResultDigest,
    nativeAccountIdentityDigest,
    buckets: normalized.map(boundObservationResult).sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
  });
  const batchId = digest({
    processReceiptId: processReceipt.id,
    profileBindingDigest,
    resultBindingDigest,
    adapterInstanceId: generation.adapterInstanceId,
    adapterGenerationId: generation.adapterGenerationId,
    batchSequence: generation.batchSequence,
  });
  const observations = normalized.map((observation) => {
    const nativeReceipt = {
      ...processReceipt,
      nativeAccountIdentityDigest,
      profileBindingDigest,
      accountSelectionBindingDigest,
      adapterInstanceId: generation.adapterInstanceId,
      adapterGenerationId: generation.adapterGenerationId,
      adapterGenerationStartedAt: startedAt,
      batchSequence: generation.batchSequence,
      batchId,
      resultBindingDigest,
      bucketBindingDigest: digest({ resultBindingDigest, ...boundObservationResult(observation) }),
      monotonicObservation: observation.monotonicObservation,
    };
    const unsigned = { ...observation, nativeReceipt };
    return { ...unsigned, sourceDigest: digest(unsigned) };
  });
  const bindingProof = {
    kind: "codex-native-quota-binding",
    providerId: "openai-codex",
    accountId,
    profileRef,
    codexHome,
    profileBindingDigest,
    accountSelectionBindingDigest,
    nativeAccountIdentityDigest,
    executableSha256: executable.sha256,
    adapterInstanceId: generation.adapterInstanceId,
    adapterGenerationId: generation.adapterGenerationId,
    adapterGenerationStartedAt: startedAt,
    batchSequence: generation.batchSequence,
    batchId,
    processReceiptId: processReceipt.id,
    resultBindingDigest,
    observationDigests: observations.map((observation) => observation.sourceDigest).sort(),
  };
  return { providerId: "openai-codex", accountId, observations, bindingProof, bindingProofDigest: digest(bindingProof) };
}

function boundObservationResult(observation) {
  return {
    bucketId: observation.bucketId,
    windowId: observation.windowId,
    usedRatio: observation.usedRatio,
    remainingCapacity: observation.remainingCapacity,
    exhausted: observation.exhausted === true || observation.usedRatio >= 1,
    resetAt: observation.resetAt ? new Date(observation.resetAt).toISOString() : null,
  };
}

function executedResult(action, context) {
  const completedAt = new Date().toISOString();
  const unsignedReceipt = {
    kind: "maximum-utilization-host-effect",
    hostAdapterId: "test-host-adapter",
    idempotencyKey: context.idempotencyKey,
    dispatchKind: context.dispatchKind,
    claimId: context.claimId,
    capability: context.capability,
    actionDigest: context.actionDigest,
    status: "executed",
    applied: true,
    startedAt: completedAt,
    completedAt,
  };
  const receipt = { ...unsignedReceipt, id: digest(unsignedReceipt) };
  return { supported: true, applied: true, idempotencyKey: context.idempotencyKey, receipt };
}

function hostCapabilities(handlers, adapterId = "test-host-adapter") {
  return Object.fromEntries(Object.entries(handlers).map(([capability, execute]) => [capability, { adapterId, execute }]));
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
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
