import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { Logger } from "../src/core/logger.mjs";
import { ResponsesAssembler } from "../src/bridge/responses.mjs";
import { normalizeResponsesInput, toOpenAiChatMessages } from "../src/core/input-normalizer.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

function observeMockRequests(service) {
  const requests = [];
  const provider = service.registry.providers.get("mock");
  const run = provider.run.bind(provider);
  provider.run = async function* observedRun(request) {
    requests.push({ mode: request.mode, workspace: request.workspace, metadata: { ...request.metadata } });
    yield* run(request);
  };
  return requests;
}

test("assembler emits a valid text lifecycle and final object", () => {
  const assembler = new ResponsesAssembler({ model: "integrated/mock/m", input: "x" }, {
    providerId: "mock", mode: "integrated", model: "m", threadId: "t", exposeReasoning: false,
  });
  const events = [
    ...assembler.begin(),
    ...assembler.accept({ type: "text-delta", delta: "hel" }),
    ...assembler.accept({ type: "text-delta", delta: "lo" }),
    ...assembler.accept({ type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }),
    ...assembler.finish({ finishReason: "stop" }),
  ];
  assert.equal(assembler.response.status, "completed");
  assert.equal(assembler.response.output_text, "hello");
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_event, index) => index));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(assembler.response.usage.total_tokens, 3);
});

test("assembler preserves hidden reasoning and emits function-call lifecycle", () => {
  const assembler = new ResponsesAssembler({ model: "integrated/mock/m", input: "x" }, {
    providerId: "mock", mode: "integrated", model: "m", threadId: "t", exposeReasoning: false,
  });
  assembler.begin();
  assert.deepEqual(assembler.accept({ type: "reasoning-delta", delta: "secret" }), []);
  const events = [
    ...assembler.accept({ type: "tool-call-delta", index: 0, id: "call_a", nameDelta: "read", argumentsDelta: '{"x":' }),
    ...assembler.accept({ type: "tool-call-delta", index: 0, argumentsDelta: "1}" }),
    ...assembler.finish({ finishReason: "tool_calls" }),
  ];
  assert.equal(assembler.assistantMessage().reasoningContent, "secret");
  assert.deepEqual(assembler.assistantMessage().toolCalls[0].arguments, { x: 1 });
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.delta"));
  assert.ok(events.some((event) => event.type === "response.function_call_arguments.done"));
});

test("reasoning and parallel function calls retain one ordered assistant turn for replay", () => {
  const messages = normalizeResponsesInput({ input: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
    { type: "function_call", call_id: "call_a", name: "first", arguments: '{"x":1}' },
    { type: "function_call", call_id: "call_b", name: "second", arguments: '{"y":2}' },
    { type: "function_call_output", call_id: "call_a", output: "one" },
    { type: "function_call_output", call_id: "call_b", output: "two" },
  ] });
  assert.equal(messages[0].reasoningContent, "plan");
  assert.deepEqual(messages[0].toolCalls.map((call) => call.id), ["call_a", "call_b"]);
  const replay = toOpenAiChatMessages(messages);
  assert.equal(replay[0].reasoning_content, "plan");
  assert.deepEqual(replay.slice(1).map((message) => message.tool_call_id), ["call_a", "call_b"]);
});

test("BridgeService executes mock Responses requests and links previous responses", async () => {
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  try {
    const first = await service.executeResponse({ model: "consult/mock/mock-model", input: "first" });
    const second = await service.executeResponse({
      model: "consult/mock/mock-model",
      previous_response_id: first.id,
      input: "second",
    });
    assert.equal(first.status, "completed");
    assert.match(first.output_text, /first$/);
    assert.match(second.output_text, /second$/);
    const record = service.sessions.getResponse(second.id);
    assert.ok(record.messages.some((message) => message.content === "first"));
    assert.ok(record.messages.some((message) => message.content === "second"));
  } finally {
    await service.close();
  }
});

test("service and convenience modes preserve explicit workspace provenance without exposing cwd by default", async () => {
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  const requests = observeMockRequests(service);
  try {
    await service.executeResponse({ model: "consult/mock/mock-model", input: "private consult" });
    await service.executeResponse({ model: "integrated/mock/mock-model", input: "private integrated" });
    await service.executeResponse({
      model: "consult/mock/mock-model",
      input: "compatibility marker",
      metadata: { bridge_no_default_workspace: true },
    });
    await service.executeResponse({
      model: "consult/mock/mock-model",
      input: "explicit cwd",
      metadata: { cwd: "/explicit/cwd" },
    });
    await service.consult({ question: "convenience without source" });
    await service.consult({ question: "convenience with source", workspace: "/explicit/convenience" });
    await service.delegate({ question: "explicit delegate source", workspace: "/explicit/delegate", scope: { allowed: ["."] } });

    assert.deepEqual(requests.map(({ mode, workspace }) => [mode, workspace]), [
      ["consult", undefined],
      ["integrated", undefined],
      ["consult", undefined],
      ["consult", "/explicit/cwd"],
      ["consult", undefined],
      ["consult", "/explicit/convenience"],
      ["delegate", "/explicit/delegate"],
    ]);
    assert.equal(requests.some((request) => request.workspace === process.cwd()), false);
    await assert.rejects(
      service.delegate({ question: "must not infer cwd", scope: { allowed: ["."] } }),
      /Delegate requires an explicit workspace/,
    );
    assert.equal(requests.length, 7, "Workspace-less Delegate must fail before provider invocation");
  } finally {
    await service.close();
  }
});

test("previous responses cannot cross provider routes without an explicit Continuity handoff", async () => {
  const service = new BridgeService(createTestConfig({
    providers: {
      other: { adapter: "mock", model: "mock-model", capabilities: ["consult"] },
    },
  }), { logger: silentLogger() });
  try {
    const first = await service.executeResponse({ model: "consult/mock/mock-model", input: "first" });
    await assert.rejects(() => service.executeResponse({
      model: "consult/other/mock-model",
      previous_response_id: first.id,
      input: "second",
    }), /bridge_continuity_handoff=true/);
    const handedOff = await service.executeResponse({
      model: "consult/other/mock-model",
      previous_response_id: first.id,
      metadata: { bridge_continuity_handoff: true },
      input: "second",
    });
    assert.equal(handedOff.metadata.bridge_provider, "other");
  } finally {
    await service.close();
  }
});

test("BridgeService streams tool calls for Integrated mode", async () => {
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  const events = [];
  try {
    const response = await service.executeResponse({
      model: "integrated/mock/mock-model",
      input: 'CALL_TOOL(read_file, {"path":"a.txt"})',
      tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
      stream: true,
    }, { onEvent: (event) => events.push(event) });
    assert.equal(response.output[0].type, "function_call");
    assert.equal(response.output[0].name, "read_file");
    assert.ok(events.some((event) => event.type === "response.output_item.added" && event.item.type === "function_call"));
  } finally {
    await service.close();
  }
});

test("legacy-unbound Consult thread accepts its first concrete route and preserves prior tool-call linkage", async () => {
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  try {
    const thread = service.sessions.getOrCreateThread("thread-with-tools");
    thread.messages = [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        reasoningContent: "private-reasoning",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.txt" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "contents" },
    ];

    await service.consult({ threadId: thread.id, question: "What follows?" });
    const updated = service.sessions.getThread(thread.id);
    const assistantToolMessage = updated.messages.find((message) => message.toolCalls?.[0]?.id === "call_1");
    const toolOutput = updated.messages.find((message) => message.role === "tool" && message.toolCallId === "call_1");
    assert.equal(assistantToolMessage.reasoningContent, "private-reasoning");
    assert.deepEqual(assistantToolMessage.toolCalls[0].arguments, { path: "a.txt" });
    assert.equal(toolOutput.content, "contents");
    assert.equal([updated.mode, updated.providerId, updated.accountId, updated.model].join("/"), "consult/mock/unknown/default/mock-model");
  } finally {
    await service.close();
  }
});

test("established Consult thread provider, mode, model, and account changes require continuity handoff", async () => {
  const service = new BridgeService(createTestConfig({
    providers: {
      other: { adapter: "mock", model: "mock-model", capabilities: ["consult"] },
    },
  }), { logger: silentLogger() });
  try {
    const concrete = { providerId: "mock", accountId: "unknown/default", mode: "consult", model: "mock-model" };
    service.sessions.getOrCreateThread("provider-bound", concrete);
    service.sessions.getOrCreateThread("mode-bound", concrete);
    service.sessions.getOrCreateThread("model-bound", concrete);
    service.sessions.getOrCreateThread("account-bound", { ...concrete, accountId: "acct_established" });

    await assert.rejects(() => service.consult({ threadId: "provider-bound", provider: "other", question: "provider change" }), /explicit continuity handoff/);
    await assert.rejects(() => service.delegate({ threadId: "mode-bound", question: "mode change" }), /explicit continuity handoff/);
    await assert.rejects(() => service.consult({ threadId: "model-bound", model: "other-model", question: "model change" }), /explicit continuity handoff/);
    await assert.rejects(() => service.consult({ threadId: "account-bound", question: "account change" }), /explicit continuity handoff/);
  } finally {
    await service.close();
  }
});

test("simultaneous Consult follow-ups on one thread retain both turns in order", async () => {
  const service = new BridgeService(createTestConfig(), { logger: silentLogger() });
  try {
    await service.consult({ threadId: "serial-thread", question: "seed" });
    await Promise.all([
      service.consult({ threadId: "serial-thread", question: "left" }),
      service.consult({ threadId: "serial-thread", question: "right" }),
    ]);
    const messages = service.sessions.getThread("serial-thread").messages;
    const userText = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    assert.match(userText, /seed/);
    assert.match(userText, /left/);
    assert.match(userText, /right/);
  } finally {
    await service.close();
  }
});

test("opt-in body logging is bounded and redacts credential fields", async () => {
  const lines = [];
  const sink = {
    write(chunk) {
      lines.push(String(chunk));
      return true;
    },
  };
  const logger = new Logger({ level: "debug", sink });
  const service = new BridgeService(createTestConfig({
    logging: { level: "debug", logBodies: true },
  }), { logger });
  try {
    await service.executeResponse({
      model: "consult/mock/mock-model",
      metadata: { apiToken: "should-not-appear" },
      input: `review ${"x".repeat(40_000)}`,
    });
  } finally {
    await service.close();
  }

  const records = lines.map((line) => JSON.parse(line));
  const requestLog = records.find((record) => record.message === "Response request body");
  const resultLog = records.find((record) => record.message === "Response result body");
  assert.ok(requestLog);
  assert.ok(resultLog);
  assert.equal(requestLog.fields.body.truncated, true);
  assert.ok(requestLog.fields.body.json.length <= 32_768);
  assert.doesNotMatch(JSON.stringify(requestLog), /should-not-appear/);
  assert.match(requestLog.fields.body.json, /\[redacted\]/);
});

test("body logging remains off by default", async () => {
  const lines = [];
  const sink = { write(chunk) { lines.push(String(chunk)); return true; } };
  const logger = new Logger({ level: "debug", sink });
  const service = new BridgeService(createTestConfig({
    logging: { level: "debug", logBodies: false },
  }), { logger });
  try {
    await service.executeResponse({ model: "consult/mock/mock-model", input: "private" });
  } finally {
    await service.close();
  }
  assert.equal(lines.some((line) => line.includes("Response request body") || line.includes("Response result body")), false);
});

test("maximum-utilization composition accepts only authoritative native quota and exposes a sanitized read model", async () => {
  const observed = [];
  const controller = {
    async refreshNative() { observed.push("daemon-native-read"); return { accepted: true, observationCount: 1 }; },
    async readModel() {
      return {
        phase: "maximum-utilization",
        readiness: "active",
        epoch: 4,
        quota: { usedRatio: 0.97, observedAt: "2026-08-17T12:00:00Z" },
        counts: { protectedTasks: 2, inboxPending: 1, suspendedMonitors: 3, overruns: 1 },
        statuses: { manifest: "executed", recovery: "pending" },
        rawPrompt: "must-not-leak",
        taskIds: ["task-secret"],
      };
    },
  };
  const service = new BridgeService(createTestConfig({ maximumUtilization: { enabled: true } }), {
    logger: silentLogger(),
    maximumUtilizationController: controller,
  });
  try {
    assert.equal(service.observeNativeQuota, undefined, "callers cannot submit automatic quota events");
    assert.equal((await service.refreshMaximumUtilizationNative()).accepted, true);
    assert.equal(observed.length, 1);
    const state = await service.threadspanState();
    assert.equal(state.maximumUtilization.phase, "maximum-utilization");
    assert.equal(state.maximumUtilization.readiness, "active");
    assert.equal(state.maximumUtilization.counts.protectedTasks, 2);
    assert.doesNotMatch(JSON.stringify(state.maximumUtilization), /must-not-leak|task-secret|rawPrompt|taskIds/);
  } finally {
    await service.close();
  }
});


test("assembler exposes provider accounting metadata as a namespaced bridge extension", () => {
  const assembler = new ResponsesAssembler({ model: "consult/grok/grok-4.6", input: "x" }, {
    providerId: "grok", mode: "consult", model: "grok-4.6", threadId: "t", exposeReasoning: false,
  });
  assembler.begin();
  assembler.accept({ type: "text-delta", delta: "done" });
  assembler.finish({
    finishReason: "stop",
    providerMetadata: { grokBuild: { turns: 4, estimatedCostUsd: 0.08 } },
  });
  assert.deepEqual(assembler.response.bridge_provider_metadata, {
    grokBuild: { turns: 4, estimatedCostUsd: 0.08 },
  });
});
