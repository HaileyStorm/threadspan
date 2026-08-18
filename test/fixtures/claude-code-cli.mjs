#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const sessionFlag = args.includes("--resume") ? "--resume" : "--session-id";
const sessionId = args[args.indexOf(sessionFlag) + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");

await appendFile(join(process.cwd(), ".fake-claude-invocations.jsonl"), `${JSON.stringify({
  args,
  sessionFlag,
  sessionId,
  prompt,
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  anthropicApiKeyVisible: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_API_KEY"),
  anthropicAuthTokenVisible: Object.prototype.hasOwnProperty.call(process.env, "ANTHROPIC_AUTH_TOKEN"),
  anthropicCredentialsMatch: process.env.ANTHROPIC_API_KEY === process.env.ANTHROPIC_AUTH_TOKEN,
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
  anthropicModel: process.env.ANTHROPIC_MODEL ?? null,
})}\n`);

const events = [
  { type: "system", subtype: "init", session_id: sessionId, future_init_field: { exact: [1, 2, 3] } },
  { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "fake " } }, future_stream_field: "kept" },
  { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } } },
  { type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: "fake answer" }], usage: { input_tokens: 3, output_tokens: 2, future_usage_field: 9 } }, future_assistant_field: true },
  { type: "result", subtype: "success", is_error: false, session_id: sessionId, result: "fake answer", usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0.01, future_result_field: { nested: "preserved" }, future_sensitive_echo: process.env.ANTHROPIC_API_KEY ?? null },
];
for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
