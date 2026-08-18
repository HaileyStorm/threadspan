import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexContinuityController } from "../src/codex/continuity-controller.mjs";

function nativeHarness() {
  const calls = [];
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
  const result = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") return { data: structuredClone(params.archived ? archived : live) };
    if (method === "thread/read") return { thread: structuredClone([...live, ...archived].find((item) => item.id === params.threadId) ?? thread) };
    if (method === "thread/goal/get") return { goal: structuredClone(goals.get(params.threadId) ?? null) };
    if (method === "thread/setName") { thread.name = params.name; return {}; }
    if (method === "thread/resume") { thread.status = { type: "idle" }; return { thread: structuredClone(thread) }; }
    if (method === "turn/start") { thread.status = { type: "active", activeFlags: [] }; return { turn: { id: "turn-native-private" } }; }
    throw new Error(`Unexpected native method ${method}`);
  };
  return {
    calls,
    thread,
    live,
    archived,
    goals,
    call: async (method, params) => ({ result: await result(method, params), receipt: { kind: "native", method } }),
    callBatch: async (requests) => ({ results: await Promise.all(requests.map((request) => result(request.method, request.params))), receipt: { kind: "native-batch", methods: requests.map((request) => request.method) } }),
  };
}

test("Continuity publishes opaque lineage and routes Promote through one fixed native control turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  let uuidCounter = 0;
  const controller = new CodexContinuityController({
    enabled: true,
    controlEnabled: true,
    statePath: join(root, "continuity.json"),
  }, {
    call: native.call,
    callBatch: native.callBatch,
    uuid: () => `opaque-handle-${String(++uuidCounter).padStart(4, "0")}`,
    now: () => 1_800_000_000_000,
  });

  const view = await controller.view();
  assert.equal(view.tasks.length, 1);
  assert.equal(view.tasks[0].action, "Promote");
  assert.match(view.tasks[0].handle, /^opaque-handle-/);
  const serialized = JSON.stringify(view);
  assert.doesNotMatch(serialized, /019dead0|private first prompt|private objective|private\/project/);

  await controller.rename({ handle: view.tasks[0].handle, name: "Named logical task" });
  assert.equal(native.thread.name, "Named logical task");
  native.thread.status = { type: "idle" };
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  assert.match(preview.digest, /^[0-9a-f]{64}$/);
  const accepted = await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  assert.equal(accepted.state, "supervisor-requested");
  const methods = native.calls.map((call) => call.method);
  assert.ok(methods.includes("turn/start"));
  assert.equal(methods.some((method) => ["thread/fork", "thread/archive", "thread/goal/set", "thread/goal/clear"].includes(method)), false);
  const turn = native.calls.find((call) => call.method === "turn/start");
  assert.match(turn.params.input[0].text, /Continuity supervisor/);
  assert.doesNotMatch(turn.params.input[0].text, /019dead0|private first prompt|private objective/);
  await assert.rejects(controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest }), /already awaiting native recovery/);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, 1);
});

test("Continuity binds one source-matched successor and clears pending after Goal read-back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-successor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  let uuidCounter = 0;
  const statePath = join(root, "state.json");
  const controller = new CodexContinuityController({ enabled: true, controlEnabled: true, statePath }, {
    call: native.call, callBatch: native.callBatch, uuid: () => `opaque-successor-${String(++uuidCounter).padStart(4, "0")}`,
  });
  const initial = await controller.view();
  const preview = await controller.previewRollover({ handle: initial.tasks[0].handle });
  const requested = await controller.rollover({ handle: initial.tasks[0].handle, digest: preview.digest });
  const successor = {
    ...native.thread,
    id: "019dead0-native-successor",
    name: "Existing task",
    threadSource: `continuity:worker:${requested.operationId}:rw`,
    createdAt: native.thread.createdAt + 10,
    updatedAt: native.thread.updatedAt + 10,
    recencyAt: native.thread.recencyAt + 10,
    status: { type: "idle" },
  };
  native.live.splice(0, native.live.length, successor);
  native.archived.push({ ...native.thread, status: { type: "notLoaded" } });
  native.goals.delete(native.thread.id);
  native.goals.set(successor.id, { threadId: successor.id, status: "active", createdAt: 3, updatedAt: 4 });

  const reconciled = await controller.view();
  assert.equal(reconciled.tasks.length, 1);
  assert.equal(reconciled.tasks[0].current.generation, 2);
  assert.equal(reconciled.tasks[0].pendingRecovery, false);
  assert.equal(reconciled.tasks[0].generations.filter((generation) => generation.role === "current").length, 1);
  await chmod(statePath, 0o644);
  const restarted = new CodexContinuityController({ enabled: true, controlEnabled: true, statePath }, { call: native.call, callBatch: native.callBatch });
  await restarted.initialize();
  const state = await lstat(statePath);
  if (process.platform === "win32") assert.equal(state.isFile(), true);
  else assert.equal(state.mode & 0o777, 0o600);
});

test("Continuity refuses active-task promotion before posting a control turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-active-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  native.thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  let uuidCounter = 0;
  const controller = new CodexContinuityController({ enabled: true, controlEnabled: true, statePath: join(root, "state.json") }, {
    call: native.call, callBatch: native.callBatch, uuid: () => `opaque-active-${String(++uuidCounter).padStart(5, "0")}`,
  });
  const view = await controller.view();
  await assert.rejects(controller.previewRollover({ handle: view.tasks[0].handle }), /requires the current task to be idle/);
  assert.equal(native.calls.some((call) => call.method === "turn/start"), false);
});

test("Continuity promotes a goal-free task without fabricating Goal state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-goal-free-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const originalBatch = native.callBatch;
  native.callBatch = async (requests) => {
    const response = await originalBatch(requests);
    response.results = response.results.map((result, index) => requests[index].method === "thread/goal/get" ? { goal: null } : result);
    return response;
  };
  let uuidCounter = 0;
  const controller = new CodexContinuityController({ enabled: true, controlEnabled: true, statePath: join(root, "state.json") }, {
    call: native.call, callBatch: native.callBatch, uuid: () => `opaque-goal-free-${String(++uuidCounter).padStart(4, "0")}`,
  });
  const view = await controller.view();
  assert.equal(view.tasks[0].current.goalStatus, "none");
  assert.equal(view.tasks[0].generations[0].role, "current");
  assert.equal(view.tasks[0].generations[0].label, "Origin task · Current generation");
  const preview = await controller.previewRollover({ handle: view.tasks[0].handle });
  assert.equal(preview.accepted, false);
  const result = await controller.rollover({ handle: view.tasks[0].handle, digest: preview.digest });
  assert.equal(result.state, "supervisor-requested");
});

test("Continuity delivers one action completion only to the exact non-active Codex owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-continuity-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = nativeHarness();
  const controller = new CodexContinuityController({ enabled: true, controlEnabled: true, statePath: join(root, "state.json") }, {
    call: native.call, callBatch: native.callBatch,
  });
  const handle = "act_0123456789abcdef0123456789abcdef";

  const delivered = await controller.deliverActionItem({
    ownerRef: "codex-thread",
    nativeId: native.thread.id,
    handle,
    note: "Approval granted",
  });
  assert.equal(delivered.supported, true);
  assert.match(delivered.deliveryRef, /^codex-turn:[0-9a-f]{32}$/);
  assert.doesNotMatch(JSON.stringify(delivered), /019dead0|turn-native-private/);
  const start = native.calls.findLast((call) => call.method === "turn/start");
  assert.equal(start.params.threadId, native.thread.id);
  assert.match(start.params.input[0].text, new RegExp(handle));
  assert.match(start.params.input[0].text, /Approval granted/);
  assert.match(start.params.input[0].text, /Do not create an acknowledgement action item/);

  native.thread.status = { type: "active" };
  const before = native.calls.filter((call) => call.method === "turn/start").length;
  await assert.rejects(controller.deliverActionItem({ ownerRef: "codex-thread", nativeId: native.thread.id, handle, note: null }), /owner is active/);
  assert.equal(native.calls.filter((call) => call.method === "turn/start").length, before);
  assert.deepEqual(await controller.deliverActionItem({ ownerRef: "other-provider", nativeId: native.thread.id, handle, note: null }), { supported: false });
});
