import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("HTTP surface serves health, models, buffered Responses, and SSE", async (t) => {
  const config = createTestConfig();
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  const models = await fetch(`${base}/v1/models`).then((response) => response.json());
  assert.ok(models.data.some((model) => model.id === "consult/mock/mock-model"));
  const sidecar = await fetch(`${base}/threadspan/`);
  assert.equal(sidecar.status, 200);
  assert.match(sidecar.headers.get("content-type"), /text\/html/);
  assert.match(await sidecar.text(), /One task\. Every model\./);
  const sidecarState = await fetch(`${base}/threadspan/state`).then((response) => response.json());
  assert.equal(sidecarState.product.name, "Threadspan");
  assert.ok(sidecarState.routeMap.nodes.some((node) => node.id === "mock"));
  assert.equal("thread" in sidecarState, false);

  const bufferedResponse = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "consult/mock/mock-model", input: "buffered" }),
  });
  assert.equal(bufferedResponse.status, 200);
  assert.match((await bufferedResponse.json()).output_text, /buffered$/);

  const streamResponse = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "consult/mock/mock-model", input: "stream", stream: true }),
  });
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: response\.created/);
  assert.match(streamText, /event: response\.completed/);
  assert.match(streamText, /data: \[DONE\]/);
});

test("HTTP surface rejects unapproved browser origins without a valid token", async (t) => {
  const original = process.env.CURSOR_BRIDGE_TEST_TOKEN;
  process.env.CURSOR_BRIDGE_TEST_TOKEN = "token";
  t.after(() => {
    if (original === undefined) delete process.env.CURSOR_BRIDGE_TEST_TOKEN;
    else process.env.CURSOR_BRIDGE_TEST_TOKEN = original;
  });
  const config = createTestConfig({ server: { allowUnauthenticatedLoopback: false } });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  const authorized = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: { origin: "https://evil.example", authorization: "Bearer token" },
  });
  assert.equal(authorized.status, 200);
  const stateWithoutToken = await fetch(`http://127.0.0.1:${address.port}/threadspan/state`);
  assert.equal(stateWithoutToken.status, 401);
  const stateWithToken = await fetch(`http://127.0.0.1:${address.port}/threadspan/state`, { headers: { authorization: "Bearer token" } });
  assert.equal(stateWithToken.status, 200);
});

test("HTTP surface permits bearerless CORS preflight for an explicitly allowed origin", async (t) => {
  const original = process.env.CURSOR_BRIDGE_TEST_TOKEN;
  process.env.CURSOR_BRIDGE_TEST_TOKEN = "token";
  t.after(() => {
    if (original === undefined) delete process.env.CURSOR_BRIDGE_TEST_TOKEN;
    else process.env.CURSOR_BRIDGE_TEST_TOKEN = original;
  });
  const allowedOrigin = "https://client.example";
  const config = createTestConfig({ server: { allowedOrigins: [allowedOrigin] } });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "OPTIONS",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);

  const actual = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: { origin: allowedOrigin, authorization: "Bearer token" },
  });
  assert.equal(actual.status, 200);
  assert.equal(actual.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(actual.headers.get("vary"), /Origin/i);
});

test("HTTP convenience routes normalize managed-worker snake_case controls", async (t) => {
  const fixture = new URL("./fixtures/fake-grok.mjs", import.meta.url).pathname;
  const config = createTestConfig({
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: {
      grok: {
        adapter: "grok-build",
        capabilities: ["consult", "delegate"],
        command: process.execPath,
        commandArgs: [fixture],
        versionArgs: ["--version"],
        versionPattern: "^grok\\s",
        model: "grok-4.6",
        models: ["grok-4.6"],
        strictModelList: true,
        allowedEfforts: ["low", "medium", "high"],
        maxTurnsCeiling: 24,
        inheritEnv: false,
        envAllowlist: [],
        noAutoUpdate: true,
        allowSubagents: true,
        noMemory: true,
        allowWebSearch: true,
        admission: { maxActive: 1, minStartIntervalMs: 0, maxUnitsPerWindow: 20, windowMs: 1000 },
        ledger: { enabled: false },
        consult: { workspaceStrategy: "none", profile: "diagnose", maxTurns: 8, expectedTurns: 2 },
        delegate: { profile: "balanced", maxTurns: 16, expectedTurns: 4 },
      },
    },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/consult`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "Review the bounded worker contract",
      provider: "grok",
      model: "grok-4.6",
      profile: "mechanical",
      reasoning_effort: "high",
      max_turns: 7,
      expected_turns: 5,
      no_plan: true,
      acceptance_commands: ["npm test", "npm run check"],
      allow_subagents: false,
      allow_web_search: false,
      coordinator_id: "cgpt-http",
      worker_group: "http-normalization",
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, "worker-ok");
  assert.deepEqual(result.providerMetadata.grokBuild, {
    ...result.providerMetadata.grokBuild,
    profile: "mechanical",
    reasoningEffort: "high",
    maxTurns: 7,
    expectedTurns: 5,
    allowSubagents: false,
    allowWebSearch: false,
    coordinatorId: "cgpt-http",
    workerGroup: "http-normalization",
    acceptanceCommands: ["npm test", "npm run check"],
  });
});
