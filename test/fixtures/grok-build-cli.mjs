#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (process.env.GROK_FIXTURE_COUNTER) {
  await appendFile(process.env.GROK_FIXTURE_COUNTER, `${JSON.stringify(args)}\n`, "utf8");
}
if (process.env.GROK_FIXTURE_ARGS_FILE) {
  await writeFile(process.env.GROK_FIXTURE_ARGS_FILE, JSON.stringify(args), "utf8");
}
if (args.includes("--version")) {
  process.stdout.write("grok 1.0.4 (fixture)\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(JSON.stringify({ models: [{ id: "grok-4.6" }] }));
  process.exit(0);
}
if (process.env.GROK_FIXTURE_QUOTA === "1") {
  process.stdout.write(JSON.stringify({ error: { code: "subscription:free-usage-exhausted", message: "quota exhausted" } }));
  process.exit(1);
}

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const cwd = valueAfter("--cwd") ?? process.cwd();
if (process.env.GROK_FIXTURE_WRITE === "1") {
  await writeFile(join(cwd, "fixture-worker-write.txt"), "worker mutation\n", "utf8");
}
const payload = {
  final_response: `fixture:${process.env.CURSOR_BRIDGE_MODE}:${valueAfter("--reasoning-effort")}`,
  model: valueAfter("--model"),
  input_tokens: 23559,
  cache_read_input_tokens: 51328,
  output_tokens: 1349,
  reasoning_tokens: 619,
  total_tokens: 76236,
  turns: 4,
  model_calls: 4,
  estimated_cost_usd: 0.080876,
  finish_reason: "stop",
};
process.stdout.write(JSON.stringify(payload));
