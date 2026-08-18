import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { MCP_TOOLS, runMcpHttpProxy, runMcpServer } from "../src/mcp/server.mjs";
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
  assert.match(byId.get(1).result.instructions, /brainstorming-worthy/);
  assert.match(byId.get(1).result.instructions, /ImageGen/);
  assert.match(byId.get(1).result.instructions, /audit provider handles/);
  assert.match(byId.get(1).result.instructions, /bounded direct\/meta\/meta-meta hardening/);
  assert.match(byId.get(1).result.instructions, /Compatibility Watch detects app\/provider drift/);
  assert.ok(byId.get(2).result.tools.some((tool) => tool.name === "consult"));
  assert.match(byId.get(2).result.tools.find((tool) => tool.name === "integrated").description, /host retains tools, approvals, web, memory/);
  assert.match(byId.get(2).result.tools.find((tool) => tool.name === "bridge_models").description, /provider\/account\/transport lifecycle/);
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

test("MCP forwards an explicit disjoint-write scope without changing native settings", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let received;
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = {
    async delegate(value) {
      received = value;
      return { text: "scoped", threadId: "thread_scope" };
    },
  };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 301,
    method: "tools/call",
    params: {
      name: "delegate",
      arguments: {
        question: "Implement one disjoint slice",
        workspace: "/repo/worker",
        scope: { allowed: ["src/owned.mjs"], denied: ["src/shared.mjs"], non_goals: ["release"] },
        acceptance_commands: ["node --test test/owned.test.mjs"],
      },
    },
  })}\n`);
  await running;
  assert.equal(JSON.parse(text.trim()).result.isError, false);
  assert.deepEqual(received.scope, { allowed: ["src/owned.mjs"], denied: ["src/shared.mjs"], non_goals: ["release"] });
  assert.deepEqual(received.acceptanceCommands, ["node --test test/owned.test.mjs"]);
  const schema = MCP_TOOLS.find((tool) => tool.name === "delegate").inputSchema.properties.scope;
  assert.equal(schema.additionalProperties, false);
  assert.match(schema.description, /never changes native host\/project settings/);
});

test("MCP proxy input closure aborts the active transport instead of orphaning a parent turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-mcp-proxy-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenFile = join(root, "connector.token");
  await writeFile(tokenFile, "connector-token\n", { mode: 0o600 });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let transportAborted = false;
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const running = runMcpHttpProxy({
    endpoint: "http://127.0.0.1:8743/mcp",
    tokenFile,
    input,
    output,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      const abort = () => { transportAborted = true; reject(options.signal.reason); };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }),
  });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 302, method: "tools/call", params: { name: "bridge_status", arguments: {} } })}\n`);
  await running;
  assert.equal(transportAborted, true);
  assert.match(JSON.parse(text.trim()).error.message, /MCP proxy input closed/);
});

test("MCP proxy refuses plaintext remote bearer transport and Integrated rejects no-op prompts", async () => {
  await assert.rejects(runMcpHttpProxy({
    endpoint: "http://provider.example/mcp",
    tokenFile: "/not-read",
    input: new PassThrough(),
    output: new PassThrough(),
  }), /requires HTTPS except for verified loopback HTTP/);

  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  let called = false;
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const service = {
    config: { defaults: { provider: "raw", model: "model" } },
    async executeResponse() { called = true; return {}; },
  };
  const running = runMcpServer({ service, input, output, logger: silentLogger() });
  input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 303, method: "tools/call", params: { name: "integrated", arguments: { question: "   " } } })}\n`);
  await running;
  const result = JSON.parse(text.trim()).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /non-empty question/);
  assert.equal(called, false);
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

test("MCP request identity preserves type, rejects active duplicates, and cancels the exact typed id",async()=>{const input=new PassThrough(),output=new PassThrough();let text="";output.on("data",chunk=>{text+=chunk.toString("utf8")});const service={consult(_value,{signal}){return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}))}};const running=runMcpServer({service,input,output,logger:silentLogger()});for(const id of [7,"7"])input.write(`${JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name:"consult",arguments:{question:"block"}}})}\n`);input.write(`${JSON.stringify({jsonrpc:"2.0",id:7,method:"ping",params:{}})}\n`);await waitFor(()=>text.split("\n").some(line=>line&&JSON.parse(line).id===7&&JSON.parse(line).error));input.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:"7",reason:"stop-string"}})}\n`);await waitFor(()=>text.split("\n").some(line=>line&&JSON.parse(line).id==="7"));assert.equal(text.split("\n").filter(Boolean).some(line=>JSON.parse(line).id===7&&JSON.parse(line).result),false);input.write(`${JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:7,reason:"stop-number"}})}\n`);await waitFor(()=>text.split("\n").some(line=>line&&JSON.parse(line).id===7&&JSON.parse(line).result));input.end();await running;const responses=text.trim().split("\n").map(line=>JSON.parse(line));assert.match(responses.find(value=>value.id==="7").result.content[0].text,/stop-string/);assert.match(responses.find(value=>value.id===7&&value.result).result.content[0].text,/stop-number/);assert.match(responses.find(value=>value.id===7&&value.error).error.message,/Duplicate active/)});

test("Consult and Delegate schemas accept explicit continuity handoff without weakening strict objects",()=>{for(const name of ["consult","delegate"]){const schema=MCP_TOOLS.find(tool=>tool.name===name).inputSchema;assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.properties.continuity_handoff,{type:"boolean",description:"Explicitly authorize a mode-changing continuation on an existing bridge thread."})}});
