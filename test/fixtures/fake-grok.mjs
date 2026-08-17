import { appendFile, writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (process.env.FAKE_GROK_COUNTER_PATH) {
  await appendFile(process.env.FAKE_GROK_COUNTER_PATH, `${JSON.stringify(args)}\n`, "utf8");
}
if (args.includes("--version")) {
  process.stdout.write("grok 1.0.4 (test)\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(JSON.stringify({ models: [{ id: "grok-4.6" }] }));
  process.exit(0);
}
if (process.env.FAKE_GROK_ARGS_PATH) {
  await writeFile(process.env.FAKE_GROK_ARGS_PATH, JSON.stringify(args), "utf8");
}
if (process.env.FAKE_GROK_QUOTA === "1") {
  process.stderr.write(JSON.stringify({ error: { code: "subscription:free-usage-exhausted", message: "quota exhausted" } }));
  process.exit(1);
}
const promptIndex = args.indexOf("--single");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
process.stdout.write(JSON.stringify({
  output_text: prompt.includes("AUTHORITATIVE THREAD PACKET") ? "worker-ok" : "missing-packet",
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    output_tokens: 3,
    reasoning_tokens: 2,
    total_tokens: 35
  },
  turns: 2,
  model_calls: 2,
  estimated_cost: "$0.0100",
  model: "grok-4.6",
  finish_reason: "stop"
}));
