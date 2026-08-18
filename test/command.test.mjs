import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildChildEnvironment, CommandProvider } from "../src/providers/command.mjs";
import { silentLogger } from "./helpers.mjs";

async function assertProcessGone(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`process ${pid} was still alive after ${timeoutMs} ms`);
}

function killProcessIfRunning(pid) {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}

async function readPidWhenReady(path, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`PID file ${path} was not written within ${timeoutMs} ms`);
}

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

test("CommandProvider reaps descendants after normal leader completion", { skip: process.platform === "win32" }, async (t) => {
  const fixture = fileURLToPath(new URL("./fixtures/process-tree-leak.mjs", import.meta.url));
  let descendantPid;
  t.after(() => killProcessIfRunning(descendantPid));
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: [fixture, "--provider"],
    outputFormat: "text",
    terminationGraceMs: 20,
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
  })) events.push(event);
  descendantPid = Number(events.at(-1).message.content.trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await assertProcessGone(descendantPid);
});

test("CommandProvider cancellation reaps a stubborn descendant", { skip: process.platform === "win32" }, async (t) => {
  const fixture = fileURLToPath(new URL("./fixtures/process-tree-leak.mjs", import.meta.url));
  const controller = new AbortController();
  let descendantPid;
  t.after(() => killProcessIfRunning(descendantPid));
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: [fixture, "--provider", "--cancel"],
    outputFormat: "text",
    terminationGraceMs: 20,
  }, { logger: silentLogger() });
  const iterator = provider.run({
    mode: "consult",
    model: "m",
    messages: [{ role: "user", content: "hello" }],
    workspace: process.cwd(),
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  while (!descendantPid) {
    const step = await iterator.next();
    assert.equal(step.done, false);
    if (step.value.type === "text-delta") descendantPid = Number(step.value.delta.trim());
  }
  const cancellation = new Error("command cancellation requested");
  controller.abort(cancellation);
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {}
  }, /command cancellation requested/);
  await assertProcessGone(descendantPid);
});

test("CommandProvider early iterator return reaps the started process tree", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-command-early-return-"));
  const pidFile = join(root, "descendant.pid");
  const fixture = fileURLToPath(new URL("./fixtures/process-tree-leak.mjs", import.meta.url));
  let descendantPid;
  t.after(() => {
    killProcessIfRunning(descendantPid);
    return rm(root, { recursive: true, force: true });
  });
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: [fixture, "--provider", "--cancel", "--pid-file", pidFile],
    outputFormat: "text",
    terminationGraceMs: 20,
  }, { logger: silentLogger() });
  const iterator = provider.run({
    mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
  })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "status");
  descendantPid = await readPidWhenReady(pidFile);
  await iterator.return();
  await assertProcessGone(descendantPid);
});

test("CommandProvider rejects pre-aborted requests before spawning", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before command spawn"));
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: `threadspan-command-that-must-not-spawn-${process.pid}`,
  }, { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({
      mode: "consult",
      model: "m",
      messages: [{ role: "user", content: "hello" }],
      workspace: process.cwd(),
      signal: controller.signal,
    })) {}
  }, /cancelled before command spawn/);
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


test("CommandProvider defaults to named environment inheritance without provider or daemon credentials", async (t) => {
  const names = ["HOME", "THREADSPAN_COMMAND_PRIVATE", "OPENAI_API_KEY", "THREADSPAN_CONNECTOR_TOKEN", "THREADSPAN_COMMAND_NAMED"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: "/threadspan-test-home",
    THREADSPAN_COMMAND_PRIVATE: "must-not-leak",
    OPENAI_API_KEY: "provider-key-must-not-leak",
    THREADSPAN_CONNECTOR_TOKEN: "daemon-credential-must-not-leak",
    THREADSPAN_COMMAND_NAMED: "named-value",
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", `process.stdout.write(JSON.stringify({
      privateValue: process.env.THREADSPAN_COMMAND_PRIVATE,
      providerKey: process.env.OPENAI_API_KEY,
      daemonCredential: process.env.THREADSPAN_CONNECTOR_TOKEN,
      named: process.env.THREADSPAN_COMMAND_NAMED,
      configured: process.env.THREADSPAN_COMMAND_CONFIGURED,
      home: process.env.HOME ?? process.env.USERPROFILE,
    }))`],
    envAllowlist: ["THREADSPAN_COMMAND_NAMED"],
    env: { THREADSPAN_COMMAND_CONFIGURED: "configured-value" },
    outputFormat: "text",
  }, { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "consult", model: "m", messages: [{ role: "user", content: "hello" }], workspace: process.cwd(),
  })) events.push(event);
  assert.deepEqual(JSON.parse(events.at(-1).message.content), {
    named: "named-value",
    configured: "configured-value",
    home: "/threadspan-test-home",
  });
});

test("child environment broad inheritance requires explicit inheritEnv true", () => {
  const base = {
    HOME: "/profile",
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    OPENAI_API_KEY: "provider-key",
    THREADSPAN_TOKEN: "daemon-token",
    NAMED_ONLY: "named",
  };
  assert.deepEqual(buildChildEnvironment({ envAllowlist: ["NAMED_ONLY"] }, {}, {}, base), {
    HOME: "/profile",
    PATH: "/bin",
    SystemRoot: "C:\\Windows",
    NAMED_ONLY: "named",
  });
  assert.deepEqual(buildChildEnvironment({ inheritEnv: true }, {}, {}, base), base);
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
