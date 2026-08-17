import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../src/core/errors.mjs";
import { RemoteBridgeService, normalizeBridgeBaseUrl } from "../src/bridge/remote-service.mjs";

test("remote bridge normalizes root and Responses base URLs", () => {
  assert.equal(normalizeBridgeBaseUrl("http://127.0.0.1:8743/v1"), "http://127.0.0.1:8743");
  assert.equal(normalizeBridgeBaseUrl("http://127.0.0.1:8743/v1/"), "http://127.0.0.1:8743");
  assert.equal(normalizeBridgeBaseUrl("http://127.0.0.1:8743"), "http://127.0.0.1:8743");
});

test("remote bridge forwards Consult input and bearer authentication", async () => {
  const calls = [];
  const service = new RemoteBridgeService({
    baseUrl: "http://127.0.0.1:8743/v1",
    environment: { BRIDGE_SECRET: "token-value" },
    tokenEnv: "BRIDGE_SECRET",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ text: "remote-ok", threadId: "thread_remote" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await service.consult({
    question: "review",
    allowSubagents: true,
    allowWebSearch: true,
    coordinatorId: "cgpt-a",
    workerGroup: "grok-nine",
  });

  assert.equal(result.text, "remote-ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8743/v1/consult");
  assert.equal(calls[0].init.headers.authorization, "Bearer token-value");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    question: "review",
    allowSubagents: true,
    allowWebSearch: true,
    coordinatorId: "cgpt-a",
    workerGroup: "grok-nine",
  });
});

test("remote bridge exposes daemon provider/model and runtime status endpoints", async () => {
  const service = new RemoteBridgeService({
    baseUrl: "http://localhost:8743",
    fetchImpl: async (url) => {
      if (url.endsWith("/health")) return Response.json({ status: "ok", providerRuntime: { grok: { admission: { active: 3 } } } });
      if (url.endsWith("/v1/bridge/providers")) return Response.json({ object: "list", data: [{ id: "grok" }] });
      if (url.endsWith("/v1/models")) return Response.json({ object: "list", data: [{ id: "delegate/grok/grok-4.6" }] });
      return new Response("missing", { status: 404 });
    },
  });

  assert.equal((await service.stats()).providerRuntime.grok.admission.active, 3);
  assert.deepEqual(await service.describeProviders(), [{ id: "grok" }]);
  assert.deepEqual(await service.listModels(), [{ id: "delegate/grok/grok-4.6" }]);
});

test("remote bridge preserves structured upstream errors", async () => {
  const service = new RemoteBridgeService({
    baseUrl: "http://localhost:8743",
    fetchImpl: async () => Response.json({
      error: { code: "provider_error", message: "quota exhausted", details: { retryPolicy: "no-automatic-retry" } },
    }, { status: 429 }),
  });

  await assert.rejects(
    () => service.delegate({ question: "work", workspace: "/tmp/worktree" }),
    (error) => error instanceof BridgeError
      && error.status === 429
      && error.code === "provider_error"
      && error.details.retryPolicy === "no-automatic-retry",
  );
});
