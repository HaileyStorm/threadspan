import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CommandProvider } from "../src/providers/command.mjs";
import { silentLogger } from "./helpers.mjs";

test("CommandProvider streams normalized JSONL events", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/command-jsonl.mjs", import.meta.url));
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: [fixture],
    outputFormat: "jsonl",
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "consult", model: "x", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
  })) events.push(event);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).message.content, "received:consult:yes");
});

test("CommandProvider substitutes request fields into configured environment values", async () => {
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.BRIDGE_TEMPLATE_VALUE)"],
    env: { BRIDGE_TEMPLATE_VALUE: "{mode}|{model}|{threadId}|{workspace}" },
    outputFormat: "text",
  }, { logger: silentLogger() });
  const workspace = process.cwd();
  const events = [];
  for await (const event of provider.run({
    mode: "consult",
    model: "model-x",
    threadId: "thread-y",
    messages: [{ role: "user", content: "hello" }],
    workspace,
  })) events.push(event);
  assert.equal(events.at(-1).message.content, `consult|model-x|thread-y|${workspace}`);
});

test("CommandProvider reports an explicit timeout", async () => {
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    outputFormat: "text",
    timeoutMs: 20,
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({
      mode: "consult",
      model: "model-x",
      messages: [{ role: "user", content: "hello" }],
      workspace: process.cwd(),
    })) {
      // Consume until the provider terminates and surfaces the timeout.
    }
  }, /timed out after 20 ms/);
});

test("CommandProvider normalizes malformed JSONL as a provider failure", async () => {
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "process.stdout.write('{not-json}' + String.fromCharCode(10))"],
    outputFormat: "jsonl",
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({
      mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
    })) {}
  }, /malformed JSONL/);
});

test("CommandProvider normalizes missing executables as provider failures", async () => {
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: `cursor-bridge-command-that-does-not-exist-${process.pid}`,
    outputFormat: "text",
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({
      mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
    })) {}
  }, /Could not start or monitor command/);
});


test("CommandProvider can replace broad environment inheritance with an allowlist", async () => {
  process.env.CURSOR_BRIDGE_COMMAND_PRIVATE = "must-not-leak";
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.CURSOR_BRIDGE_COMMAND_PRIVATE ?? 'absent')"],
    inheritEnv: false,
    envAllowlist: [],
    outputFormat: "text",
  }, { logger: silentLogger() });
  const events = [];
  try {
    for await (const event of provider.run({
      mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
    })) events.push(event);
  } finally {
    delete process.env.CURSOR_BRIDGE_COMMAND_PRIVATE;
  }
  assert.equal(events.at(-1).message.content, "absent");
});

test("CommandProvider applies configured repetitive-output summarization only to its agent prompt", async () => {
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "let value='';process.stdin.on('data',(chunk)=>value+=chunk);process.stdin.on('end',()=>process.stdout.write(value))"],
    outputFormat: "text",
    outputSummary: {
      minBytes: 128,
      minLines: 12,
      minRepetitions: 8,
      minDuplicateLineRatio: 0.7,
      headBytes: 96,
      tailBytes: 96,
    },
  }, { logger: silentLogger() });
  const original = ["head", ...Array.from({ length: 80 }, () => "repeat"), "tail"].join("\n");
  const messages = [{ role: "tool", toolCallId: "call_command", content: original }];
  const before = structuredClone(messages);
  const events = [];
  for await (const event of provider.run({
    mode: "consult",
    model: "m",
    messages,
    workspace: process.cwd(),
  })) events.push(event);
  assert.match(events.at(-1).message.content, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  assert.deepEqual(messages, before);
});
