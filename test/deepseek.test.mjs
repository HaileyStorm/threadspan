import assert from "node:assert/strict";
import test from "node:test";
import { DeepSeekProvider } from "../src/providers/deepseek.mjs";
import { silentLogger } from "./helpers.mjs";

test("DeepSeek thinking compatibility removes rejected controls and preserves tool reasoning", () => {
  const provider = new DeepSeekProvider("deepseek", {
    adapter: "deepseek",
    capabilities: ["integrated"],
    apiKey: "test",
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    reasoningEffort: "max",
  }, { logger: silentLogger() });
  const body = provider.buildRequestBody({
    mode: "integrated",
    model: "deepseek-v4-pro",
    temperature: 0.7,
    toolChoice: "auto",
    tools: [{ type: "function", name: "x", parameters: { type: "object" } }],
    messages: [{
      role: "assistant",
      content: "",
      reasoningContent: "reason",
      toolCalls: [{ id: "call_1", name: "x", arguments: {} }],
    }, { role: "tool", toolCallId: "call_1", content: "ok" }],
  });
  assert.equal(body.temperature, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.reasoning_effort, "max");
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.messages[0].content, "");
  assert.equal(body.messages[0].reasoning_content, "reason");
});
