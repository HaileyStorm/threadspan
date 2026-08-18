import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomaticTakeoverController } from "../src/core/automatic-takeover-controller.mjs";

const enabledPolicy = Object.freeze({
  enabled: true,
  crossProviderEnabled: true,
  batchSize: 2,
  staggerMs: 100,
  tickIntervalMs: 0,
});

const frozen = Object.freeze({
  mode: "delegate",
  tools: ["edit", "shell"],
  workspace: "workspace-a",
  privacy: 3,
  context: 128_000,
  intelligence: 7,
});

test("duplicate monitors collapse to one exact target/provider/account/window incident", async (t) => {
  const harness = await createHarness(t);
  await harness.controller.registerTarget(target());
  const first = await harness.controller.observeFailure(failure());
  const duplicate = await harness.controller.observeFailure(failure());

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.handle, first.handle);
  const model = await harness.controller.readModel();
  assert.equal(model.counts.monitors, 1);
  assert.doesNotMatch(JSON.stringify(model), /target-a|provider-a|account-a|window-a/);
  assert.equal((await lstat(harness.statePath)).mode & 0o777, 0o600);
});

test("same-provider same-account healthy lane is selected before alternate accounts", async (t) => {
  const harness = await createHarness(t, {
    candidates: [
      candidate({ accountId: "account-b", quotaWindowId: "window-b" }),
      candidate({ accountId: "account-a", quotaWindowId: "window-new" }),
    ],
  });
  await observeRegistered(harness.controller);
  await harness.controller.tick();

  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0].candidate.accountId, "account-a");
  assert.equal(harness.starts[0].candidate.quotaWindowId, "window-new");
});

test("cross-provider takeover waits until every healthy same-provider account is exhausted", async (t) => {
  const harness = await createHarness(t, {
    target: { crossProviderEnabled: true },
    candidates: [
      candidate({ accountId: "account-b", quotaWindowId: "window-b" }),
      candidate({ providerId: "provider-z", accountId: "account-z", quotaWindowId: "window-z" }),
    ],
    startReplacement: async (request) => request.candidate.providerId === "provider-a"
      ? { status: "exhausted" }
      : { status: "active", receipt: "cross-active" },
  });
  await observeRegistered(harness.controller, harness.target);

  await harness.controller.tick();
  assert.deepEqual(harness.starts.map((entry) => entry.candidate.providerId), ["provider-a"]);
  await harness.controller.tick();
  assert.deepEqual(harness.starts.map((entry) => entry.candidate.providerId), ["provider-a", "provider-z"]);
});

test("explicit routes require request-local opt-in while smart routes remain automatic", async (t) => {
  const blocked = await createHarness(t, { target: { explicitRoute: true, automaticTakeoverOptIn: false } });
  await observeRegistered(blocked.controller, blocked.target);
  await blocked.controller.tick();

  assert.deepEqual(blocked.starts, []);
  const model = await blocked.controller.readModel();
  assert.equal(model.phase, "blocked");
  assert.equal(model.monitors[0].phase, "blocked-explicit-route");

  const optedIn = await createHarness(t, { target: { targetId: "opted-in", explicitRoute: true, automaticTakeoverOptIn: true } });
  await observeRegistered(optedIn.controller, optedIn.target);
  await optedIn.controller.tick();
  assert.equal(optedIn.starts.length, 1);

  const smart = await createHarness(t, { target: { targetId: "smart", explicitRoute: false, automaticTakeoverOptIn: false } });
  await observeRegistered(smart.controller, smart.target);
  await smart.controller.tick();
  assert.equal(smart.starts.length, 1);
});

test("a running maximum-utilization target coexists with a separate successor lane", async (t) => {
  const harness = await createHarness(t, {
    status: "running",
    target: { maximumUtilizationProtected: true, successorLaneEnabled: true },
  });
  await harness.controller.registerTarget(harness.target);
  await harness.controller.observeFailure(failure({ kind: "quota" }));
  await harness.controller.tick();

  assert.equal(harness.starts.length, 1);
  assert.equal(harness.starts[0].lane, "successor");
  assert.deepEqual(harness.cancellations, []);
});

test("exact native reset cancels queued work, exits automatic mode, and leaves active replacements alive", async (t) => {
  const harness = await createHarness(t, {
    startReplacement: async (request) => ({
      status: request.target.targetId === "target-a" ? "queued" : "active",
      receipt: `${request.target.targetId}-receipt`,
    }),
  });
  await observeRegistered(harness.controller);
  await harness.controller.tick();
  await harness.controller.tick({ resetEvidence: resetEvidence() });
  assert.equal(harness.cancellations.length, 1);
  assert.equal((await harness.controller.readModel()).phase, "idle");

  const second = target({ targetId: "target-b", accountId: "account-b", quotaWindowId: "window-b" });
  harness.statuses.set("target-b", "failed");
  harness.candidatesByTarget.set("target-b", [candidate({ accountId: "account-c", quotaWindowId: "window-c" })]);
  await harness.controller.registerTarget(second);
  await harness.controller.observeFailure(failure({ targetId: "target-b", accountId: "account-b", quotaWindowId: "window-b" }));
  await harness.controller.tick();
  await harness.controller.tick({
    resetEvidence: resetEvidence({ accountId: "account-b", previousQuotaWindowId: "window-b", currentQuotaWindowId: "window-b2" }),
  });
  const model = await harness.controller.readModel();
  assert.equal(harness.cancellations.length, 1, "an active replacement must not be cancelled");
  assert.equal(model.counts.active, 1);
  assert.equal(model.phase, "idle");
});

test("coordinator recovers first and late-running subagents are left alone in bounded batches", async (t) => {
  const harness = await createHarness(t, { candidates: [] });
  const coordinator = target({ targetId: "coordinator" });
  const late = target({ targetId: "child-late", role: "subagent", coordinatorId: "coordinator" });
  const failed = target({ targetId: "child-failed", role: "subagent", coordinatorId: "coordinator" });
  for (const item of [coordinator, late, failed]) {
    harness.statuses.set(item.targetId, "failed");
    harness.candidatesByTarget.set(item.targetId, [candidate({ accountId: `${item.targetId}-account`, quotaWindowId: `${item.targetId}-window` })]);
    await harness.controller.registerTarget(item);
    await harness.controller.observeFailure(failure({ targetId: item.targetId }));
  }

  await harness.controller.tick();
  assert.deepEqual(harness.starts.map((entry) => entry.target.targetId), ["coordinator"]);
  harness.statuses.set("child-late", "running");
  await harness.controller.tick();
  assert.deepEqual(harness.starts.map((entry) => entry.target.targetId), ["coordinator", "child-failed"]);
  assert.equal((await harness.controller.readModel()).monitors.some((entry) => entry.phase === "running-no-action"), true);
});

test("restart replays an indeterminate start with the same idempotency key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-takeover-replay-"));
  const statePath = join(root, "private", "state.json");
  const keys = [];
  const first = new AutomaticTakeoverController({
    statePath,
    policy: enabledPolicy,
    adapters: {
      readLiveness: async () => "failed",
      listCandidates: async () => [candidate()],
      startReplacement: async (request) => {
        keys.push(request.idempotencyKey);
        throw new Error("receipt lost");
      },
    },
  });
  await observeRegistered(first);
  await first.tick();
  await first.close();

  const restarted = new AutomaticTakeoverController({
    statePath,
    policy: enabledPolicy,
    adapters: {
      readLiveness: async () => "failed",
      listCandidates: async () => [candidate()],
      startReplacement: async (request) => {
        keys.push(request.idempotencyKey);
        return { status: "active", receipt: "replayed" };
      },
    },
  });
  t.after(async () => {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  });
  await restarted.initialize();
  await restarted.tick();

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal((await restarted.readModel()).counts.active, 1);
});

test("owner disable prevents queued automatic work and persists across ticks", async (t) => {
  const harness = await createHarness(t);
  await observeRegistered(harness.controller);
  await harness.controller.ownerDisable();
  await harness.controller.tick();

  assert.deepEqual(harness.starts, []);
  assert.equal((await harness.controller.readModel()).phase, "disabled");
});

test("missing takeover capability fails closed and stays visibly unsupported", async (t) => {
  const harness = await createHarness(t, { startReplacement: undefined });
  await observeRegistered(harness.controller);
  await harness.controller.tick();

  const model = await harness.controller.readModel();
  assert.equal(harness.starts.length, 0);
  assert.equal(model.phase, "unsupported");
  assert.ok(model.counts.unsupported > 0);
  assert.equal(model.counts.active, 0);
});

test("state paths reject symbolic-link targets", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-takeover-link-"));
  const privateRoot = join(root, "private");
  const outside = join(root, "outside.json");
  const statePath = join(privateRoot, "state.json");
  await mkdir(privateRoot, { mode: 0o700 });
  await writeFile(outside, "{}\n", { mode: 0o600 });
  await symlink(outside, statePath, "file");
  t.after(() => rm(root, { recursive: true, force: true }));

  const controller = new AutomaticTakeoverController({ statePath, policy: enabledPolicy });
  await assert.rejects(controller.initialize(), /symbolic link/i);
});

async function createHarness(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-takeover-"));
  const statePath = join(root, "private", "state.json");
  const starts = [];
  const cancellations = [];
  const targetValue = target(options.target);
  const statuses = new Map([[targetValue.targetId, options.status ?? "failed"]]);
  const candidatesByTarget = new Map([[targetValue.targetId, options.candidates ?? [candidate()]]]);
  const startReplacement = Object.hasOwn(options, "startReplacement")
    ? options.startReplacement
    : async () => ({ status: "active", receipt: "active-receipt" });
  const adapters = {
    readLiveness: async (registered) => statuses.get(registered.targetId) ?? "unknown",
    listCandidates: async (registered) => candidatesByTarget.get(registered.targetId) ?? [],
    ...(typeof startReplacement === "function" ? {
      startReplacement: async (request) => {
        starts.push(structuredClone(request));
        return startReplacement(request);
      },
    } : {}),
    cancelQueuedReplacement: async (request) => {
      cancellations.push(structuredClone(request));
      return { receipt: "cancelled" };
    },
  };
  const controller = new AutomaticTakeoverController({
    statePath,
    policy: { ...enabledPolicy, ...(options.policy ?? {}) },
    adapters,
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { controller, statePath, starts, cancellations, statuses, candidatesByTarget, target: targetValue };
}

async function observeRegistered(controller, targetValue = target()) {
  await controller.registerTarget(targetValue);
  return controller.observeFailure(failure({
    targetId: targetValue.targetId,
    providerId: targetValue.providerId,
    accountId: targetValue.accountId,
    quotaWindowId: targetValue.quotaWindowId,
  }));
}

function target(overrides = {}) {
  return {
    targetId: "target-a",
    providerId: "provider-a",
    accountId: "account-a",
    quotaWindowId: "window-a",
    role: "coordinator",
    frozen,
    ...overrides,
  };
}

function failure(overrides = {}) {
  return {
    targetId: "target-a",
    providerId: "provider-a",
    accountId: "account-a",
    quotaWindowId: "window-a",
    kind: "liveness",
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    providerId: "provider-a",
    accountId: "account-b",
    quotaWindowId: "window-b",
    certifiedHealthy: true,
    ...frozen,
    ...overrides,
  };
}

function resetEvidence(overrides = {}) {
  return {
    sourceKind: "native",
    exact: true,
    providerId: "provider-a",
    accountId: "account-a",
    previousQuotaWindowId: "window-a",
    currentQuotaWindowId: "window-a2",
    ...overrides,
  };
}
