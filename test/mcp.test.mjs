import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { runMcpServer } from "../src/mcp/server.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("MCP server initializes, lists tools, and executes Consult", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "consult", arguments: { question: "hello", provider: "mock", model: "mock-model" } } })}\n`);
  input.end();
  await running;
  await service.close();
  const responses = text.trim().split("\n").map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.serverInfo.name, "cursor-codex-bridge");
  assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === "consult"));
  assert.match(byId.get(3).result.content[0].text, /hello$/);
});

test("MCP server dispatches concurrently and processes cancellation while a tool call is active", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = {
    consult(_input, options) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
    stats() { return { status: "ok" }; },
  };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "consult", arguments: { question: "block" } } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping", params: {} })}\n`);

  await waitFor(() => text.split("\n").some((line) => line && JSON.parse(line).id === 11));
  assert.equal(text.split("\n").filter(Boolean).some((line) => JSON.parse(line).id === 10), false);

  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 10, reason: "stop-now" } })}\n`);
  await waitFor(() => text.split("\n").some((line) => line && JSON.parse(line).id === 10));
  input.end();
  await running;

  const responses = text.trim().split("\n").map((line) => JSON.parse(line));
  const cancelled = responses.find((response) => response.id === 10);
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.content[0].text, /stop-now/);
});

test("MCP version negotiation falls back to the latest implemented version", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = { stats() { return { status: "ok" }; } };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2099-01-01" } })}\n`);
  await running;
  const response = JSON.parse(text.trim());
  assert.equal(response.result.protocolVersion, "2025-11-25");
});

test("MCP tool validation failures are returned as tool errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "consult", arguments: {} } })}\n`);
  await running;
  await service.close();
  const response = JSON.parse(text.trim());
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, "invalid_request");
});

/** Wait until a synchronous predicate succeeds, with a bounded test timeout. */
async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for MCP output");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("MCP forwards fleet, subagent, and web controls to the shared service contract", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let received;
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = {
    async consult(value) {
      received = value;
      return { text: "ok", threadId: "thread_1" };
    },
  };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: {
      name: "consult",
      arguments: {
        question: "review",
        allow_subagents: true,
        allow_web_search: true,
        coordinator_id: "cgpt-a",
        worker_group: "grok-nine",
      },
    },
  })}\n`);
  await running;

  assert.equal(JSON.parse(text.trim()).result.isError, false);
  assert.equal(received.allowSubagents, true);
  assert.equal(received.allowWebSearch, true);
  assert.equal(received.coordinatorId, "cgpt-a");
  assert.equal(received.workerGroup, "grok-nine");
});

test("MCP bridge status accepts an asynchronous remote-service stats implementation", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = { async stats() { return { status: "ok", providerRuntime: { cursor: { retainedDelegateAgents: 2 } } }; } };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "bridge_status", arguments: {} } })}\n`);
  await running;
  const response = JSON.parse(text.trim());
  assert.equal(response.result.structuredContent.providerRuntime.cursor.retainedDelegateAgents, 2);
});
