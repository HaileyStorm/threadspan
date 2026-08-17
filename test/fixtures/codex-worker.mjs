#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString("utf8");

if (process.env.CODEX_WORKER_FIXTURE_COUNTER) {
  await appendFile(process.env.CODEX_WORKER_FIXTURE_COUNTER, `${JSON.stringify({ args })}\n`, "utf8");
}
if (process.env.CODEX_WORKER_FIXTURE_CAPTURE) {
  await writeFile(process.env.CODEX_WORKER_FIXTURE_CAPTURE, JSON.stringify({ args, prompt }), "utf8");
}
if (process.env.CODEX_WORKER_FIXTURE_HANG === "1") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (process.env.CODEX_WORKER_FIXTURE_MALFORMED === "1") {
  process.stdout.write("{not-json}\n");
  process.exit(0);
}

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "thread.started", thread_id: "thread-fixture" });
emit({ type: "turn.started", turn_id: "turn-fixture" });
if (process.env.CODEX_WORKER_FIXTURE_FAIL === "1") {
  emit({ type: "turn.failed", turn_id: "turn-fixture", error: { message: "fixture failure" } });
  process.stderr.write("fixture stderr\n");
  process.exit(7);
}
emit({ type: "item.completed", item: { id: "item-message", type: "agent_message", text: "worker-ok" } });
emit({ type: "item.completed", item: { id: "item-command", type: "command_execution", command: "npm test", status: "completed", exit_code: 0 } });
emit({
  type: "turn.completed",
  turn_id: "turn-fixture",
  usage: { input_tokens: 40, cached_input_tokens: 8, output_tokens: 6, reasoning_tokens: 2, total_tokens: 46 },
});
