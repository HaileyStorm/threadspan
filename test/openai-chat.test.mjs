import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAiChatProvider, parseSseData } from "../src/providers/openai-chat.mjs";
import { silentLogger } from "./helpers.mjs";

/** Start a local upstream server and return its URL plus captured requests. */
async function startUpstream(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    requests.push({ url: request.url, headers: request.headers, body: body ? JSON.parse(body) : undefined });
    await handler(request, response, requests.at(-1));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

test("OpenAiChatProvider streams text, reasoning, tool calls, and usage", async (t) => {
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "answer" } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"p":' } }] } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  const provider = new OpenAiChatProvider("openai", {
    adapter: "openai-chat", baseUrl: upstream.url, apiKey: "secret", capabilities: ["integrated"],
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "integrated", model: "m", messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }], toolChoice: "auto", parallelToolCalls: false,
  })) events.push(event);
  const done = events.at(-1);
  assert.equal(done.message.content, "answer");
  assert.equal(done.message.reasoningContent, "think");
  assert.deepEqual(done.message.toolCalls[0].arguments, { p: "x" });
  assert.equal(done.usage.totalTokens, 5);
  assert.equal(upstream.requests[0].headers.authorization, "Bearer secret");
  assert.equal(upstream.requests[0].body.tools[0].function.name, "read");
  assert.equal(upstream.requests[0].body.parallel_tool_calls, false);
});

test("OpenAiChatProvider retries buffered only for an explicit streaming-unsupported response", async (t) => {
  let count = 0;
  const upstream = await startUpstream(t, async (_request, response, captured) => {
    count += 1;
    if (captured.body.stream) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "streaming is unsupported" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "buffered" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  const provider = new OpenAiChatProvider("openai", {
    adapter: "openai-chat", baseUrl: upstream.url, apiKey: "x", capabilities: ["consult"],
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "hi" }] })) events.push(event);
  assert.equal(count, 2);
  assert.ok(events.some((event) => event.type === "warning"));
  assert.equal(events.at(-1).message.content, "buffered");
});

test("a buffered downgrade failure cannot trigger a second account attempt", async (t) => {
  const upstream = await startUpstream(t, async (_request, response, captured) => {
    if (captured.body.stream) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "streaming is unsupported" } }));
      return;
    }
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const provider = new OpenAiChatProvider("openai", {
    adapter: "openai-chat", baseUrl: upstream.url, apiKey: "x", capabilities: ["consult"], retryWithoutStreaming: true,
  }, { logger: silentLogger() });

  await assert.rejects(async () => {
    for await (const _event of provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "hi" }] })) { /* consume */ }
  }, (error) => error.details?.upstream?.httpStatus === 429 && error.details.upstream.safeToFallbackBeforeOutput === false);
  assert.equal(upstream.requests.length, 2);
});

test("OpenAiChatProvider certifies only HTTP 429 for safe account fallback", async (t) => {
  let status = 429;
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `failure-${status}` } }));
  });
  const provider = new OpenAiChatProvider("openai", {
    adapter: "openai-chat", baseUrl: upstream.url, apiKey: "x", capabilities: ["consult"], retryWithoutStreaming: true,
  }, { logger: silentLogger() });

  for (const expected of [
    { status: 429, retryable: true, safe: true },
    { status: 401, retryable: false, safe: false },
    { status: 503, retryable: true, safe: false },
  ]) {
    status = expected.status;
    const requestsBefore = upstream.requests.length;
    await assert.rejects(async () => {
      for await (const _event of provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "hi" }] })) { /* consume */ }
    }, (error) => {
      assert.equal(error.retryable, expected.retryable);
      assert.equal(error.details?.upstream?.httpStatus, expected.status);
      assert.equal(error.details?.upstream?.safeToFallbackBeforeOutput, expected.safe);
      assert.equal(error.details?.upstream?.safeToRetryWithoutStreaming, false);
      return true;
    });
    assert.equal(upstream.requests.length, requestsBefore + 1, `HTTP ${expected.status} must not retry the account`);
  }
});

test("parseSseData handles CRLF, multiple data lines, and final unterminated block", async () => {
  async function* chunks() {
    yield Buffer.from("data: one\r\ndata: two\r\n\r\n");
    yield Buffer.from("data: three");
  }
  const values = [];
  for await (const value of parseSseData(chunks())) values.push(value);
  assert.deepEqual(values, ["one\ntwo", "three"]);
});

test("parseSseData handles a CRLF delimiter split across byte chunks", async () => {
  async function* chunks() {
    yield Buffer.from("data: split\r");
    yield Buffer.from("\n\r");
    yield Buffer.from("\ndata: next\r\n\r");
    yield Buffer.from("\n");
  }
  const values = [];
  for await (const value of parseSseData(chunks())) values.push(value);
  assert.deepEqual(values, ["split", "next"]);
});

test("OpenAiChatProvider preserves reasoning usage and xAI-style exact cost ticks", async (t) => {
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-xai",
      model: "grok-4.6",
      cost_in_usd_ticks: 12345,
      choices: [{ message: { content: "accounted" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 5,
        total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 3 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    }));
  });
  const provider = new OpenAiChatProvider("xai", {
    adapter: "openai-chat",
    baseUrl: upstream.url,
    apiKey: "x",
    capabilities: ["consult", "integrated"],
    streaming: false,
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({ mode: "consult", model: "grok-4.6", messages: [{ role: "user", content: "hi" }] })) events.push(event);
  const done = events.at(-1);
  assert.equal(done.usage.reasoningTokens, 2);
  assert.equal(done.usage.cachedInputTokens, 3);
  assert.equal(done.providerMetadata.upstream.costInUsdTicks, 12345);
  assert.equal(done.providerMetadata.upstream.model, "grok-4.6");
});
