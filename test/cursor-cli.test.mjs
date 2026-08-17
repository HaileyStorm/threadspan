import assert from "node:assert/strict";
import test from "node:test";
import { CursorCliProvider, parseCursorModels } from "../src/providers/cursor-cli.mjs";
import { silentLogger } from "./helpers.mjs";

function provider() {
  return new CursorCliProvider("cursor", {
    adapter: "cursor-cli",
    command: process.execPath,
    commandArgs: [new URL("./fixtures/cursor-cli.mjs", import.meta.url).pathname],
    model: "auto",
    capabilities: ["consult", "delegate"],
    sandbox: "disabled",
  }, { logger: silentLogger() });
}

test("Cursor CLI adapter discovers signed-in account models", async () => {
  const models = await provider().listModels();
  assert.deepEqual(models, [
    { id: "auto", name: "Auto" },
    { id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6" },
  ]);
  assert.deepEqual(parseCursorModels("noise\na - A\n"), [{ id: "a", name: "A" }]);
});

test("Cursor CLI Consult uses a disposable workspace and normalizes usage", async () => {
  const events = [];
  for await (const event of provider().run({
    mode: "consult",
    model: "cursor-grok-4.6-high",
    messages: [{ role: "user", content: "hello" }],
  })) events.push(event);
  assert.match(events.at(-1).message.content, /cursor:/);
  assert.equal(events.at(-1).usage.totalTokens, 6);
  assert.equal(events.at(-1).usage.cachedInputTokens, 1);
  assert.equal(events.at(-1).providerMetadata.cursorCli.sessionId, "session-test");
});

test("Cursor CLI Delegate requires an explicit workspace", async () => {
  await assert.rejects(async () => {
    for await (const _event of provider().run({ mode: "delegate", model: "auto", messages: [{ role: "user", content: "work" }] })) {}
  }, /requires a workspace/);
});
