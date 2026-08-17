#!/usr/bin/env node

const args = process.argv.slice(2);
if (args[0] === "models") {
  process.stdout.write("auto - Auto\ncursor-grok-4.6-high - Cursor Grok 4.6\n");
  process.exit(0);
}
const prompt = args.at(-1) ?? "";
process.stdout.write(`${JSON.stringify({
  type: "result",
  result: `cursor:${prompt}`,
  session_id: "session-test",
  request_id: "request-test",
  usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 1 },
})}\n`);
