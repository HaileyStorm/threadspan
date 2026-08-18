import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NousProvider } from "../src/providers/nous.mjs";
import { silentLogger } from "./helpers.mjs";

async function startUpstream(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    requests.push(body ? JSON.parse(body) : undefined);
    await handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests };
}

test("Nous defaults to max effort and preserves ordered multiple tool calls", async (t) => {
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content: "", tool_calls: [
        { id: "one", function: { name: "first", arguments: "{}" } },
        { id: "two", function: { name: "second", arguments: "{}" } },
      ] }, finish_reason: "tool_calls" }],
    }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    capabilities: ["integrated"],
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "integrated",
    model: "deepseek/deepseek-v4-flash-0731",
    messages: [{ role: "user", content: "test" }],
  })) events.push(event);
  assert.equal(upstream.requests[0].reasoning_effort, "max");
  assert.deepEqual(events.at(-1).message.toolCalls.map(({ id, name }) => ({ id, name })), [
    { id: "one", name: "first" },
    { id: "two", name: "second" },
  ]);
  assert.equal(provider.runtimeStats().maxToolCallsPerTurn, 16);
  assert.equal(provider.runtimeStats().parallelToolCalls, true);
});

test("Nous rejects a provider turn above the bounded multi-call ceiling before exposing output", async (t) => {
  const toolCalls = Array.from({ length: 17 }, (_, index) => ({
    id: `call_${index}`,
    function: { name: `tool_${index}`, arguments: "{}" },
  }));
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "", tool_calls: toolCalls }, finish_reason: "tool_calls" }] }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    capabilities: ["integrated"],
  }, { logger: silentLogger() });
  const exposed = [];
  await assert.rejects(async () => {
    for await (const event of provider.run({
      mode: "integrated",
      model: "deepseek/deepseek-v4-flash-0731",
      messages: [{ role: "user", content: "test" }],
    })) exposed.push(event);
  }, /more than 16 tool calls/);
  assert.deepEqual(exposed, []);
});

test("Nous writes a persistent owner-cleared stop marker on HTTP 402", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadspan-nous-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stopMarkerPath = join(directory, "nous_provider_stop.json");
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "credits exhausted" } }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    stopMarkerPath,
    capabilities: ["consult"],
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "test" }] })) {}
  }, /HTTP 402/);
  const marker = JSON.parse(await readFile(stopMarkerPath, "utf8"));
  assert.equal(marker.reason, "http_402");
  assert.equal(marker.owner_clear_required, true);
  assert.equal(provider.runtimeStats().stopped, true);
});
