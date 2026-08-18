import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexContinuityController } from "../src/codex/continuity-controller.mjs";

function nativeHarness(options = {}) {
  const calls = [];
  const now = options.now ?? (() => Date.now());
  const thread = {
    id: "019dead0-native-thread-id",
    name: "Existing task",
    preview: "private first prompt",
    cwd: "/private/project/path",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    parentThreadId: null,
    threadSource: null,
    status: { type: "idle" },
  };
  const goal = { threadId: thread.id, objective: "private objective", status: "active", createdAt: 1, updatedAt: 2, tokensUsed: 10, timeUsedSeconds: 1 };
  const live = [thread];
  const archived = [];
  const goals = new Map([[thread.id, goal]]);
  let receiptMutation = null;
  let failTurnStart = false;
  const result = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: structuredClone(params.archived ? archived : live) };
    if (method === "thread/read") return { thread: structuredClone([...live, ...archived].find((item) => item.id === params.threadId) ?? thread) };
    if (method === "thread/goal/get") return { goal: structuredClone(goals.get(params.threadId) ?? null) };
    if (method === "thread/setName") { thread.name = params.name; return {}; }
    if (method === "thread/resume") { thread.status = { type: "idle" }; return { thread: structuredClone(thread) }; }
    if (method === "turn/start") {
      if (failTurnStart) throw new Error("transport lost after dispatch boundary");
      thread.status = { type: "active", activeFlags: [] };
      return { turn: { id: "turn-native-private" } };
    }
    throw new Error(`Unexpected native method ${method}`);
  };
  const wrap = (methods, results) => {
    const receipt = nativeReceipt(methods, results, now());
    return receiptMutation ? receiptMutation(receipt, methods, results) : receipt;
  };
  return {
    calls,
    thread,
    live,
    archived,
    goals,
    setReceiptMutation(value) { receiptMutation = value; },
    setFailTurnStart(value) { failTurnStart = value; },
    call: async (method, params) => {
      const value = await result(method, params);
      return { result: value, receipt: wrap([method], [value]) };
    },
    callBatch: async (requests) => {
      const results = await Promise.all(requests.map((request) => result(request.method, request.params)));
      return { results, receipt: wrap(requests.map((request) => request.method), results) };
    },
  };
}

function nativeReceipt(methods, results, now) {
  const receipt = {
    kind: "codex-app-server-process",
    methods,
    ...(methods.length === 1 ? { method: methods[0] } : {}),
    processId: 12345,
    startedAt: new Date(now - 10).toISOString(),
    completedAt: new Date(now).toISOString(),
    executable: { path: process.execPath, sha256: "a".repeat(64), version: process.version, metadataDigest: "b".repeat(64) },
    argv: [process.execPath, "app-server", "--stdio"],
    spawnArgv: [process.execPath, "app-server", "--stdio"],
    codexHome: join(tmpdir(), "threadspan-codex-home-fixture"),
    executableVerifiedAfterRead: true,
    resultDigest: digest(results),
  };
  return { ...receipt, id: digest(receipt) };
}

function controllerOptions(statePath, native, extra = {}) {
  return new CodexContinuityController({ enabled: true, controlEnabled: true, statePath }, {
    call: native.call,
    callBatch: native.callBatch,
    ...extra,
  });
}

function operationFromCalls(native) {
  const text = native.calls.findLast((call) => call.method === "turn/start")?.params.input[0].text ?? "";
  return /control request ([^ .]+)/.exec(text)?.[1];
}

function successorFor(native, operationId, overrides = {}) {
  return {
    ...native.thread,
    id: overrides.id ?? "019dead0-native-successor",
    name: "Existing task",
    threadSource: overrides.threadSource ?? `continuity:worker:${operationId}:rw`,
    createdAt: native.thread.createdAt + 10,
    updatedAt: native.thread.updatedAt + 10,
    recencyAt: native.thread.recencyAt + 10,
    status: { type: "idle" },
  };
}

test("Continuity publishes opaque lineage and routes Promote through one fixed native control turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const controller = controllerOptions(join(root, "continuity.json"), native);

  const view = await controller.view();
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].action, "Promote");
  assert.match(view.tasks[0].handle, /^ctask_[0-9a-f]{40}$/);
  assert.doesNotMatch(JSON.stringify(view), /019dead0|private first prompt|private objective|private\/project/);

  await controller.rename({ handle: view.tasks[0].handle, name: "Named logical task" });
  native.thread.status = { type: "idle" };
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  const accepted = await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  assert.equal(accepted.state, "supervisor-requested");
  assert.match(accepted.operationHandle, /^cop_[0-9a-f]{40}$/);
  assert.equal("operationId" in accepted, false);
  const methods = native.calls.map((call) => call.method);
  assert.equal(methods.some((method) => ["thread/fork", "thread/archive", "thread/goal/set", "thread/goal/clear"].includes(method)), false);
  const turn = native.calls.find((call) => call.method === "turn/start");
  assert.match(turn.params.input[0].text, /Continuity supervisor/);
  assert.doesNotMatch(turn.params.input[0].text, /019dead0|private first prompt|private objective/);
  assert.doesNotMatch(await readFile(join(root, "continuity.json"), "utf8"), /private first prompt|private objective/);
  await assert.rejects(controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest }), /already awaiting native recovery/);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("Continuity accepts only exact worker/rw successor with predecessor stop and full Goal parity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-successor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const statePath = join(root, "state.json");
  const controller = controllerOptions(statePath, native);
  const initial = await controller.view();
  const preview = await controller.previewRollover({ handle: initial.tasks[0].handle });
  await controller.rollover({ handle: initial.tasks[0].handle, digest: preview.digest });
  const operationId = operationFromCalls(native);
  const successor = successorFor(native, operationId);
  native.live.splice(0, native.live.length, successor);
  native.archived.push({ ...native.thread, status: { type: "notLoaded" } });
  native.goals.delete(native.thread.id);
  native.goals.set(successor.id, { threadId: successor.id, objective: "private objective", status: "active", createdAt: 1, updatedAt: 4, tokensUsed: 10, timeUsedSeconds: 1 });

  const reconciled = await controller.view();
  assert.equal(reconciled.tasks[0].current.generation, 2);
  assert.equal(reconciled.tasks[0].pendingRecovery, false);
  assert.equal(reconciled.tasks[0].generations.filter((generation) => generation.role === "current").length, 1);
  await chmod(statePath, 0o644);
  const restarted = controllerOptions(statePath, native);
  await restarted.initialize();
  const state = await lstat(statePath);
  if (process.platform === "win32") assert.equal(state.isFile(), true);
  else assert.equal(state.mode & 0o777, 0o600);
});

test("Continuity refuses active tasks and unsupported Goal read-back before dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const controller = controllerOptions(join(root, "state.json"), native);
  const view = await controller.view();
  await assert.rejects(controller.previewRollover({ handle: view.tasks[0].handle }), /requires the current task to be idle/);
  assert.equal(native.calls.some((call) => call.method === "turn/start"), false);

  native.thread.status = { type: "idle" };
  const originalBatch = native.callBatch;
  native.callBatch = async (requests, options) => {
    const response = await originalBatch(requests, options);
    if (requests.some((request) => request.method === "thread/goal/get")) {
      const index = requests.findIndex((request) => request.method === "thread/goal/get");
      response.results[index] = {};
      response.receipt = nativeReceipt(requests.map((request) => request.method), response.results, Date.now());
    }
    return response;
  };
  const unsupported = controllerOptions(join(root, "unsupported.json"), native);
  const unsupportedView = await unsupported.view();
  assert.equal(unsupportedView.tasks[0].action, "Unsupported");
  assert.equal(unsupportedView.controlEnabled, false);
});

test("Continuity promotes a goal-free task without fabricating Goal state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-goal-free-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.goals.clear();
  const controller = controllerOptions(join(root, "state.json"), native);
  const view = await controller.view();
  assert.equal(view.tasks[0].current.goalStatus, "none");
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  const result = await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  assert.equal(result.state, "supervisor-requested");
});

test("Continuity delivers action completion only to exact non-active owner with validated receipts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const controller = controllerOptions(join(root, "state.json"), native);
  const handle = "act_0123456789abcdef0123456789abcdef";
  const delivered = await controller.deliverActionItem({ ownerRef: "codex-thread", nativeId: native.thread.id, handle, note: "Approval granted" });
  assert.equal(delivered.supported, true);
  assert.match(delivered.deliveryRef, /^codex-turn:[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(delivered), /019dead0|turn-native-private/);
  native.thread.status = { type: "active" };
  const before = native.calls.filter((call) => call.method === "turn/start").length;
  await assert.rejects(controller.deliverActionItem({ ownerRef: "codex-thread", nativeId: native.thread.id, handle, note: null }), /owner is active/);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, before);
  assert.deepEqual(await controller.deliverActionItem({ ownerRef: "other-provider", nativeId: native.thread.id, handle, note: null }), { supported: false });
});

test("two controller instances issue at most one native rollover request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const statePath = join(root, "state.json");
  const first = controllerOptions(statePath, native, { ownerId: "owner-one" });
  const second = controllerOptions(statePath, native, { ownerId: "owner-two" });
  const [firstView, secondView] = await Promise.all([first.view(), second.view()]);
  const [firstPreview, secondPreview] = await Promise.all([
    first.previewRollover({ handle: firstView.tasks[0].handle }),
    second.previewRollover({ handle: secondView.tasks[0].handle }),
  ]);
  const settled = await Promise.allSettled([
    first.rollover({ handle: firstView.tasks[0].handle, digest: firstPreview.digest }),
    second.rollover({ handle: secondView.tasks[0].handle, digest: secondPreview.digest }),
  ]);
  assert.equal(settled.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("foreign or orphaned mutation claims fail closed with exact manual-review evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-claim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const claimPath = `${statePath}.claim`;
  await writeFile(claimPath, `${JSON.stringify({ schemaVersion: 1, kind: "threadspan-continuity-state-claim", claimId: "orphan", ownerId: "review-owner", processId: 4242, host: "review-host", createdAt: "2026-08-18T00:00:00.000Z" })}\n`);
  const controller = controllerOptions(statePath, nativeHarness());
  await assert.rejects(controller.view(), /inspect the private claim file/);
  assert.match(await readFile(claimPath, "utf8"), /review-owner/);
});

test("state CAS rejects an out-of-claim replacement instead of overwriting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const native = nativeHarness();
  const originalBatch = native.callBatch;
  let replaced = false;
  native.callBatch = async (...args) => {
    const response = await originalBatch(...args);
    if (!replaced) {
      replaced = true;
      await writeFile(statePath, `${JSON.stringify({ external: true })}\n`);
    }
    return response;
  };
  const controller = controllerOptions(statePath, native);
  await assert.rejects(controller.view(), /CAS refused/);
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), { external: true });
});

test("post-journal uncertainty persists as dispatch-indeterminate and never auto-replays after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-indeterminate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const statePath = join(root, "state.json");
  const controller = controllerOptions(statePath, native);
  const view = await controller.view();
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  native.setFailTurnStart(true);
  await assert.rejects(controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest }), /indeterminate and requires recovery/);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 1);
  native.setFailTurnStart(false);
  native.thread.status = { type: "idle" };
  const restarted = controllerOptions(statePath, native);
  const recovered = await restarted.view();
  assert.equal(recovered.tasks[0].pendingRecovery.phase, "dispatch-indeterminate");
  assert.equal(recovered.tasks[0].pendingRecovery.authority.dispatch, "indeterminate");
  assert.equal(recovered.controlEnabled, false);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("tampered receipt and closed-state contamination fail before evidence is granted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.setReceiptMutation((receipt) => ({ ...receipt, resultDigest: "c".repeat(64) }));
  await assert.rejects(controllerOptions(join(root, "tamper.json"), native).view(), /result binding is invalid/);

  await writeFile(join(root, "closed.json"), `${JSON.stringify({ schemaVersion: 2, revision: 0, sourceBindingDigest: null, tasks: [], pending: null, completedOperations: [], provenance: { migratedFrom: null, legacyReceiptDigests: [], receipts: [] }, prompt: "secret" })}\n`);
  await assert.rejects(controllerOptions(join(root, "closed.json"), nativeHarness()).initialize(), /contains invalid fields/);
});

test("source-bound receipt evidence rejects swapped native thread and Goal targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-swapped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const originalBatch = native.callBatch;
  native.callBatch = async (requests, options) => {
    const response = await originalBatch(requests, options);
    const index = requests.findIndex((request) => request.method === "thread/goal/get");
    if (index >= 0) {
      response.results[index] = { goal: { ...response.results[index].goal, threadId: "swapped-thread" } };
      response.receipt = nativeReceipt(requests.map((request) => request.method), response.results, Date.now());
    }
    return response;
  };
  await assert.rejects(controllerOptions(join(root, "state.json"), native).view(), /Goal read returned the wrong exact task/);
});

test("nested schema lineage redirects and unrelated Goal accounting fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-nested-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.goals.get(native.thread.id).foo = 1;
  const controller = controllerOptions(join(root, "goal.json"), native);
  const view = await controller.view();
  await assert.rejects(controller.previewRollover({ handle: view.tasks[0].handle }), /accounting evidence is unsupported/);

  const state = { schemaVersion: 2, revision: 0, sourceBindingDigest: null, tasks: [{ logicalId: "logical", title: "Task", rootThreadId: "root", currentThreadId: "redirect", enrolled: false, generations: [{ threadId: "root", archived: false, prepared: false, createdAt: "2026-08-18T00:00:00.000Z" }], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }], pending: null, completedOperations: [], provenance: { migratedFrom: null, legacyReceiptDigests: [], receipts: [] } };
  await writeFile(join(root, "redirect.json"), `${JSON.stringify(state)}\n`);
  await assert.rejects(controllerOptions(join(root, "redirect.json"), nativeHarness()).initialize(), /lineage is inconsistent/);
});

test("legacy state migrates lineage and receipt provenance into non-replayable recovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state.json");
  const native = nativeHarness();
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    tasks: [{ logicalId: "legacy-logical", title: "Legacy", rootThreadId: native.thread.id, currentThreadId: native.thread.id, enrolled: false, generations: [{ threadId: native.thread.id, archived: false, createdAt: "2026-08-18T00:00:00.000Z" }], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }],
    pending: { operationId: "legacy-operation", logicalId: "legacy-logical", predecessorThreadId: native.thread.id, previousGoalStatus: "active", phase: "request-journaled", successorThreadId: "legacy-successor", startedAt: "2026-08-18T00:00:00.000Z" },
    receiptDigests: ["d".repeat(64)],
  })}\n`);
  const controller = controllerOptions(statePath, native);
  const view = await controller.view();
  assert.equal(view.tasks[0].pendingRecovery.phase, "migration-recovery-required");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.provenance.migratedFrom, 1);
  assert.deepEqual(state.provenance.legacyReceiptDigests, ["d".repeat(64)]);
  assert.equal(state.pending.dispatch.status, "indeterminate");
  assert.equal(state.pending.logicalGeneration, 1);
  assert.equal(state.tasks[0].generations.find((generation) => generation.threadId === "legacy-successor")?.prepared, true);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 0);
});

test("wrong-role successors are ignored and duplicate exact successors stay ambiguous", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-duplicate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const controller = controllerOptions(join(root, "state.json"), native);
  const view = await controller.view();
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  const operationId = operationFromCalls(native);
  native.thread.status = { type: "idle" };
  native.live.push(successorFor(native, operationId, { id: "rogue", threadSource: `continuity:controller:${operationId}:rw` }));
  let pending = await controller.view();
  assert.equal(pending.tasks.find((task) => task.pendingRecovery)?.pendingRecovery.phase, "supervisor-requested");

  native.live.push(successorFor(native, operationId, { id: "successor-one" }), successorFor(native, operationId, { id: "successor-two" }));
  pending = await controller.view();
  const recovering = pending.tasks.find((task) => task.pendingRecovery);
  assert.equal(recovering.pendingRecovery.phase, "ambiguous-successors");
  assert.equal(recovering.pendingRecovery.authority.successor, "ambiguous");
  assert.equal(recovering.current.generation, 1);
});

test("unmatched worker/rw threads are quarantined instead of laundered as new logical tasks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-quarantine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.live.push(successorFor(native, "aged-out-operation", { id: "late-unmatched-worker" }));
  const view = await controllerOptions(join(root, "state.json"), native).view();
  assert.equal(view.tasks.length, 1);
  assert.doesNotMatch(JSON.stringify(view), /late-unmatched-worker|aged-out-operation/);
});

test("Goal mismatch and active archived predecessor cannot clear pending", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-goal-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const controller = controllerOptions(join(root, "state.json"), native);
  const view = await controller.view();
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  const operationId = operationFromCalls(native);
  const successor = successorFor(native, operationId);
  native.live.splice(0, native.live.length, successor);
  native.archived.push({ ...native.thread, status: { type: "active" } });
  native.goals.set(successor.id, { threadId: successor.id, objective: "different objective", status: "active", createdAt: 1, tokensUsed: 10, timeUsedSeconds: 1 });
  let pending = await controller.view();
  assert.equal(pending.tasks[0].pendingRecovery.phase, "predecessor-not-stopped");

  native.archived[0].status = { type: "futureUnknown" };
  pending = await controller.view();
  assert.equal(pending.tasks[0].pendingRecovery.phase, "predecessor-not-stopped");

  native.archived[0].status = { type: "notLoaded" };
  native.goals.delete(native.thread.id);
  pending = await controller.view();
  assert.equal(pending.tasks[0].pendingRecovery.phase, "goal-parity-mismatch");
});

function digest(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value) ?? "undefined"; }
