import { ProviderAdapter } from "./base.mjs";

/** Deterministic provider used for tests and offline validation. */
export class MockProvider extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      tools: true,
      durableThreads: true,
    };
  }

  async *run(request) {
    this.assertMode(request.mode);
    yield { type: "status", status: "started" };
    const last = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const toolMatch = /CALL_TOOL\(([^,]+),\s*(\{.*\})\)/s.exec(last);
    if (toolMatch && request.mode === "integrated") {
      const call = { id: "call_mock_1", name: toolMatch[1].trim(), argumentsText: toolMatch[2], arguments: JSON.parse(toolMatch[2]) };
      yield { type: "tool-call-delta", index: 0, id: call.id, nameDelta: call.name, argumentsDelta: call.argumentsText };
      yield { type: "done", finishReason: "tool_calls", message: { role: "assistant", content: "", toolCalls: [call] }, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 0 } };
      return;
    }
    const text = this.config.reply ?? `mock:${request.mode}:${last}`;
    const midpoint = Math.max(1, Math.floor(text.length / 2));
    yield { type: "text-delta", delta: text.slice(0, midpoint) };
    yield { type: "text-delta", delta: text.slice(midpoint) };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0 } };
    yield { type: "done", finishReason: "stop", message: { role: "assistant", content: text }, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0 } };
  }
}
