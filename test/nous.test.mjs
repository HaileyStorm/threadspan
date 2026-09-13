import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

test("Nous V4.1 Flash defaults to max effort and preserves ordered multiple tool calls", async (t) => {
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
    model: "deepseek/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "test" }],
  })) events.push(event);
  assert.equal(upstream.requests[0].model, "deepseek/deepseek-v4.1-flash");
  assert.equal(upstream.requests[0].reasoning_effort, "max");
  assert.deepEqual(events.at(-1).message.toolCalls.map(({ id, name }) => ({ id, name })), [
    { id: "one", name: "first" },
    { id: "two", name: "second" },
  ]);
  assert.equal(provider.runtimeStats().maxToolCallsPerTurn, 16);
  assert.equal(provider.runtimeStats().parallelToolCalls, true);
});

test("Nous forwards supported reasoning effort and rejects unsupported effort before contact", async (t) => {
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    capabilities: ["consult", "integrated"],
  }, { logger: silentLogger() });
  for await (const _event of provider.run({
    mode: "consult",
    model: "deepseek/deepseek-v4.1-flash",
    reasoningEffort: "high",
    messages: [{ role: "user", content: "test" }],
  })) {}
  assert.equal(upstream.requests[0].reasoning_effort, "high");
  const untrustedValues = ["", "x".repeat(100_000), "sk-private-sentinel-do-not-echo"];
  for (const reasoningEffort of untrustedValues) {
    await assert.rejects(async () => {
      for await (const _event of provider.run({
        mode: "consult",
        model: "deepseek/deepseek-v4.1-flash",
        reasoningEffort,
        messages: [{ role: "user", content: "test" }],
      })) {}
    }, (error) => {
      assert.equal(error.message, "Nous reasoning effort is unsupported; choose a value from the provider's configured allowedReasoningEfforts");
      assert.doesNotMatch(error.message, /sk-private-sentinel|x{32}|medium/);
      return true;
    });
  }
  const untrustedConfiguredValue = "configured-secret-sentinel-do-not-echo";
  const configured = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    allowedReasoningEfforts: ["max", untrustedConfiguredValue],
    capabilities: ["consult"],
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of configured.run({
      mode: "consult",
      model: "deepseek/deepseek-v4.1-flash",
      reasoningEffort: "requested-secret-sentinel-do-not-echo",
      messages: [{ role: "user", content: "test" }],
    })) {}
  }, (error) => {
    assert.doesNotMatch(error.message, /configured-secret-sentinel|requested-secret-sentinel/);
    return true;
  });
  assert.equal(upstream.requests.length, 1);
});

test("Nous catalog normalizes V4.1 Flash picker metadata and preserves existing models", async (t) => {
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [
      {
        id: "deepseek/deepseek-v4.1-flash",
        canonical_slug: "deepseek/deepseek-v4.1-flash-20260910",
        hugging_face_id: "deepseek-ai/DeepSeek-V4.1-Flash",
        context_length: 1_048_576,
        top_provider: { context_length: 1_048_576, max_completion_tokens: 131_072 },
        supported_parameters: ["reasoning_effort", "tools"],
        reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
      },
      { id: "deepseek/deepseek-v4-flash-0731", context_length: 1_310_720 },
      { id: "deepseek/deepseek-v4-pro-0813", context_length: 1_048_576 },
      { id: "other/provider-model", context_length: 32_768 },
      { id: "malformed/bool-context", context_length: true, reasoning: { supported_efforts: ["high", "high"], default_effort: "high" } },
      { id: "malformed/string-context", context_length: "65536", reasoning: { supported_efforts: ["high", { effort: "low" }], default_effort: "high" } },
      { id: "malformed/direct-duplicate-strings", supported_reasoning_levels: ["max", "max"], default_reasoning_level: "max" },
      { id: "malformed/direct-bool", supported_reasoning_levels: [true], default_reasoning_level: "max" },
      { id: "malformed/direct-duplicate-objects", supported_reasoning_levels: [{ effort: "max" }, { effort: "max" }], default_reasoning_level: "max" },
      { id: "malformed/context-camel", contextWindow: true },
      { id: "malformed/context-snake", context_window: "65536" },
      { id: "malformed/output-camel", maxCompletionTokens: true },
      { id: "malformed/output-snake", max_completion_tokens: "131072" },
      { id: "valid/direct-objects", supported_reasoning_levels: [{ effort: "max", description: "Maximum" }, { effort: "low", description: "Low" }], default_reasoning_level: "max" },
    ] }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    discoverModels: true,
    capabilities: ["consult", "integrated"],
  }, { logger: silentLogger() });
  const models = await provider.listModels();
  assert.deepEqual(models.map(({ id }) => id), [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v4-pro-0813",
    "other/provider-model",
    "malformed/bool-context",
    "malformed/string-context",
    "malformed/direct-duplicate-strings",
    "malformed/direct-bool",
    "malformed/direct-duplicate-objects",
    "malformed/context-camel",
    "malformed/context-snake",
    "malformed/output-camel",
    "malformed/output-snake",
    "valid/direct-objects",
  ]);
  const model = models[0];
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxCompletionTokens, 131_072);
  assert.deepEqual(model.supported_reasoning_levels.map(({ effort }) => effort), ["max", "high", "low"]);
  assert.equal(model.default_reasoning_level, "high");
  for (const malformed of models.filter(({ id }) => id.startsWith("malformed/"))) {
    assert.equal(malformed.contextWindow, undefined);
    assert.equal(malformed.context_window, undefined);
    assert.equal(malformed.maxCompletionTokens, undefined);
    assert.equal(malformed.max_completion_tokens, undefined);
    assert.equal(malformed.supported_reasoning_levels, undefined);
    assert.equal(malformed.default_reasoning_level, undefined);
  }
  assert.deepEqual(models.at(-1).supported_reasoning_levels, [
    { effort: "max", description: "Maximum" },
    { effort: "low", description: "Low" },
  ]);
  assert.equal(models.at(-1).default_reasoning_level, "max");
  assert.equal(upstream.requests.length, 1);
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

test("Nous writes persistent diagnostic evidence on HTTP 402", async (t) => {
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
  assert.equal(marker.launch_gate, false);
  assert.equal(provider.runtimeStats().paymentEvidencePresent, true);
});

test("sequential Nous HTTP 402 evidence preserves the first record and retains later occurrences", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadspan-nous-sequential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stopMarkerPath = join(directory, "nous_provider_stop.json");
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "credits exhausted" } }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous", baseUrl: upstream.baseUrl, apiKey: "test", streaming: false, stopMarkerPath, capabilities: ["consult"],
  }, { logger: silentLogger() });
  const runOnce = () => consume(provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "test" }] }));
  await assert.rejects(runOnce, (error) => error.status === 402 && /HTTP 402/.test(error.message));
  const original = await readFile(stopMarkerPath, "utf8");
  await assert.rejects(runOnce, (error) => error.status === 402 && /HTTP 402/.test(error.message));
  assert.equal(await readFile(stopMarkerPath, "utf8"), original);
  const evidence = (await readdir(directory)).filter((name) => name.startsWith("nous_provider_stop.json.occurrence-"));
  assert.equal(evidence.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, evidence[0]), "utf8")).reason, "http_402");
  for (const path of [stopMarkerPath, join(directory, evidence[0])]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("concurrent Nous HTTP 402 evidence uses collision-free private occurrence records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadspan-nous-concurrent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stopMarkerPath = join(directory, "nous_provider_stop.json");
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "credits exhausted" } }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous", baseUrl: upstream.baseUrl, apiKey: "test", streaming: false, stopMarkerPath, capabilities: ["consult"],
  }, { logger: silentLogger() });
  const request = { mode: "consult", model: "m", messages: [{ role: "user", content: "test" }] };
  const results = await Promise.allSettled([consume(provider.run(request)), consume(provider.run(request)), consume(provider.run(request))]);
  assert.equal(results.every((result) => result.status === "rejected" && result.reason.status === 402 && /HTTP 402/.test(result.reason.message)), true);
  const files = await readdir(directory);
  assert.equal(files.filter((name) => name === "nous_provider_stop.json").length, 1);
  assert.equal(files.filter((name) => name.startsWith("nous_provider_stop.json.occurrence-")).length, 2);
  for (const name of files) assert.equal((await stat(join(directory, name))).mode & 0o777, 0o600);
});

test("Nous evidence publication failure does not mask the terminal HTTP 402", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadspan-nous-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blockedParent = join(directory, "not-a-directory");
  await writeFile(blockedParent, "blocked", { mode: 0o600 });
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(402, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "credits exhausted" } }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous", baseUrl: upstream.baseUrl, apiKey: "test", streaming: false,
    stopMarkerPath: join(blockedParent, "nous_provider_stop.json"), capabilities: ["consult"],
  }, { logger: silentLogger() });
  await assert.rejects(
    consume(provider.run({ mode: "consult", model: "m", messages: [{ role: "user", content: "test" }] })),
    (error) => error.status === 402 && error.code === "provider_error" && /HTTP 402/.test(error.message),
  );
  assert.equal(upstream.requests.length, 1);
});

test("historical Nous 402 evidence does not gate a later one-shot request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "threadspan-nous-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stopMarkerPath = join(directory, "nous_provider_stop.json");
  await writeFile(stopMarkerPath, JSON.stringify({ schema_version: 1, provider: "nous", reason: "http_402" }));
  const upstream = await startUpstream(t, async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  const provider = new NousProvider("nous", {
    adapter: "nous",
    baseUrl: upstream.baseUrl,
    apiKey: "test",
    streaming: false,
    stopMarkerPath,
    capabilities: ["consult"],
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "consult",
    model: "deepseek/deepseek-v4.1-flash",
    messages: [{ role: "user", content: "test" }],
  })) events.push(event);
  assert.equal(upstream.requests.length, 1);
  assert.equal(events.at(-1).message.content, "ok");
});

async function consume(iterable) {
  for await (const _event of iterable) {}
}
