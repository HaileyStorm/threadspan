import assert from "node:assert/strict";
import test from "node:test";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";

test("Continuity HTTP is owner-only, loopback-only, and delegates opaque controls", async (t) => {
  const previousOwner = process.env.THREADSPAN_CONTINUITY_OWNER;
  const previousConnector = process.env.THREADSPAN_CONTINUITY_CONNECTOR;
  process.env.THREADSPAN_CONTINUITY_OWNER = "owner-only";
  process.env.THREADSPAN_CONTINUITY_CONNECTOR = "connector-only";
  t.after(() => {
    if (previousOwner === undefined) delete process.env.THREADSPAN_CONTINUITY_OWNER; else process.env.THREADSPAN_CONTINUITY_OWNER = previousOwner;
    if (previousConnector === undefined) delete process.env.THREADSPAN_CONTINUITY_CONNECTOR; else process.env.THREADSPAN_CONTINUITY_CONNECTOR = previousConnector;
  });
  const calls = [];
  const service = {
    continuityState: async () => ({ enabled: true, tasks: [{ handle: "opaque-continuity-0001", title: "Task", generations: [] }] }),
    renameContinuityTask: async (input) => { calls.push(["rename", input]); return { accepted: true }; },
    previewContinuityRollover: async (input) => { calls.push(["preview", input]); return { preview: true, digest: "a".repeat(64) }; },
    requestContinuityRollover: async (input) => { calls.push(["rollover", input]); return { accepted: true }; },
    disableAutomaticTakeover: async () => { calls.push(["disable-takeover", {}]); return { phase: "disabled" }; },
    reviewCopy: async (input) => { calls.push(["copy-review", input]); return { status: "analyzed", original: input.text, suggestion: input.text }; },
    checkCopy: async (input) => { calls.push(["copy-check", input]); return { results: [], failsRelease: false }; },
  };
  const config = {
    server: {
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: "THREADSPAN_CONTINUITY_OWNER",
      connectorTokenEnv: "THREADSPAN_CONTINUITY_CONNECTOR",
      allowUnauthenticatedLoopback: false,
      maxBodyBytes: 4096,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      allowedOrigins: [],
    },
  };
  const server = createHttpServer(service, config);
  t.after(() => closeHttpServer(server));
  const bound = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${bound.port}`;
  const owner = { authorization: "Bearer owner-only", "content-type": "application/json" };

  assert.equal((await fetch(`${base}/v1/continuity`)).status, 401);
  assert.equal((await fetch(`${base}/v1/continuity`, { headers: { authorization: "Bearer connector-only" } })).status, 401);
  const stateResponse = await fetch(`${base}/v1/continuity`, { headers: owner });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.match(state.tasks[0].handle, /^opaque-/);
  assert.doesNotMatch(JSON.stringify(state), /threadId|goalId|recoveryKey/);

  for (const [path, body, status] of [
    ["rename", { handle: state.tasks[0].handle, name: "Renamed" }, 200],
    ["rollover/preview", { handle: state.tasks[0].handle }, 200],
    ["rollover", { handle: state.tasks[0].handle, digest: "a".repeat(64) }, 202],
  ]) {
    const response = await fetch(`${base}/v1/continuity/${path}`, { method: "POST", headers: owner, body: JSON.stringify(body) });
    assert.equal(response.status, status, path);
  }
  assert.deepEqual(calls.map(([kind]) => kind), ["rename", "preview", "rollover"]);
  const disabled = await fetch(`${base}/v1/automatic-takeover/disable`, { method: "POST", headers: owner, body: "{}" });
  assert.equal(disabled.status, 200);
  assert.deepEqual(calls.map(([kind]) => kind), ["rename", "preview", "rollover", "disable-takeover"]);
  const copy = await fetch(`${base}/v1/copy/review`, { method: "POST", headers: owner, body: JSON.stringify({ text: "Plain copy.", profile: "human" }) });
  assert.equal(copy.status, 200);
  assert.equal((await copy.json()).status, "analyzed");
  assert.equal(calls.at(-1)[0], "copy-review");
  const check = await fetch(`${base}/v1/copy/check`, { method: "POST", headers: owner, body: JSON.stringify({ text: "Plain copy.", trigger: "manual" }) });
  assert.equal(check.status, 200);
  assert.equal(calls.at(-1)[0], "copy-check");
});
