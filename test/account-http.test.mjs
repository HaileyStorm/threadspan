import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("account mutation requires the main token on loopback and public MCP exposes read-only accounts only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousMain = process.env.THREADSPAN_ACCOUNT_MAIN;
  const previousConnector = process.env.THREADSPAN_ACCOUNT_CONNECTOR;
  const previousApi = process.env.THREADSPAN_ACCOUNT_API;
  process.env.THREADSPAN_ACCOUNT_MAIN = "main-account-token";
  process.env.THREADSPAN_ACCOUNT_CONNECTOR = "connector-account-token";
  process.env.THREADSPAN_ACCOUNT_API = "fake-account-key";
  t.after(() => { if (previousMain === undefined) delete process.env.THREADSPAN_ACCOUNT_MAIN; else process.env.THREADSPAN_ACCOUNT_MAIN = previousMain; if (previousConnector === undefined) delete process.env.THREADSPAN_ACCOUNT_CONNECTOR; else process.env.THREADSPAN_ACCOUNT_CONNECTOR = previousConnector; if (previousApi === undefined) delete process.env.THREADSPAN_ACCOUNT_API; else process.env.THREADSPAN_ACCOUNT_API = previousApi; });
  const config = createTestConfig({
    server: { host: "127.0.0.1", port: 8743, authTokenEnv: "THREADSPAN_ACCOUNT_MAIN", connectorTokenEnv: "THREADSPAN_ACCOUNT_CONNECTOR", allowUnauthenticatedLoopback: true },
    accounts: { path: join(root, "accounts.json"), profileSources: {}, fallback: { enabled: false, maxCandidates: 3 } },
    providers: { api: { adapter: "openai-chat", baseUrl: "https://example.test/v1", model: "m", models: ["m"], strictModelList: true, capabilities: ["consult"] } },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const bound = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${bound.port}`;
  const body = JSON.stringify({ providerId: "api", label: "Native", authKind: "api-key-env", authSourceRef: "THREADSPAN_ACCOUNT_API" });
  assert.equal((await fetch(`${base}/v1/accounts`, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401);
  assert.equal((await fetch(`${base}/v1/accounts`, { method: "POST", headers: { authorization: "Bearer connector-account-token", "content-type": "application/json" }, body })).status, 401);
  const invalidNative = JSON.stringify({ providerId: "mock", label: "Unsafe native", authKind: "cli-login" });
  assert.equal((await fetch(`${base}/v1/accounts`, { method: "POST", headers: { authorization: "Bearer main-account-token", "content-type": "application/json" }, body: invalidNative })).status, 400);
  const unknownSecret = JSON.stringify({ providerId: "api", label: "Unknown ref", authKind: "secret-file-ref", authSourceRef: "missing" });
  assert.equal((await fetch(`${base}/v1/accounts`, { method: "POST", headers: { authorization: "Bearer main-account-token", "content-type": "application/json" }, body: unknownSecret })).status, 400);
  const created = await fetch(`${base}/v1/accounts`, { method: "POST", headers: { authorization: "Bearer main-account-token", "content-type": "application/json" }, body });
  assert.equal(created.status, 201);
  const initialized = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer connector-account-token", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const session = initialized.headers.get("mcp-session-id");
  const listed = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer connector-account-token", "content-type": "application/json", "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  const names = (await listed.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("bridge_accounts"));
  assert.equal(names.some((name) => /account.*(add|create|select|delete|remove|update)/i.test(name)), false);
  const readOnly = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer connector-account-token", "content-type": "application/json", "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bridge_accounts", arguments: {} } }) });
  const accountResult = (await readOnly.json()).result.structuredContent;
  assert.equal(accountResult.accounts.length, 1);
  assert.equal(accountResult.accounts[0].label, "Native");
  assert.doesNotMatch(JSON.stringify(accountResult), /main-account-token|connector-account-token|auth\.json|\/home\//);
});
