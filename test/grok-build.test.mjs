import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  GrokBuildProvider,
  buildGrokBuildArguments,
  inspectGrokBuildInstallation,
  parseGrokBuildPayload,
  resolveGrokExecutionPolicy,
  resolveGrokTaskProfile,
} from "../src/providers/grok-build.mjs";
import { nativePath, silentLogger } from "./helpers.mjs";

const fixture = nativePath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

function createProviderConfig(overrides = {}) {
  return {
    adapter: "grok-build",
    capabilities: ["consult", "delegate"],
    command: process.execPath,
    commandArgs: [fixture],
    versionArgs: ["--version"],
    versionPattern: "^grok\\s",
    model: "grok-4.6",
    models: ["grok-4.6"],
    strictModelList: true,
    allowedEfforts: ["low", "medium", "high"],
    maxTurnsCeiling: 24,
    inheritEnv: false,
    envAllowlist: [],
    noAutoUpdate: true,
    allowSubagents: true,
    noMemory: true,
    allowWebSearch: true,
    admission: { maxActive: 1, minStartIntervalMs: 0, maxUnitsPerWindow: 10, windowMs: 1000 },
    ledger: { enabled: false },
    consult: { workspaceStrategy: "none", profile: "diagnose", maxTurns: 8, expectedTurns: 2, noPlan: true },
    delegate: { profile: "balanced", maxTurns: 16, expectedTurns: 4 },
    ...overrides,
  };
}

test("Grok installation preflight validates version without consuming inference", async () => {
  const result = await inspectGrokBuildInstallation(createProviderConfig());
  assert.equal(result.ok, true);
  assert.equal(result.executable, process.execPath);
  assert.match(result.version, /^grok 1\.0\.4/);
});

test("Grok Build keeps native profile auth paths but excludes unnamed provider and daemon credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "grok-env.mjs");
  await writeFile(script, `
    if (process.argv.includes("--version")) process.stdout.write("grok 1.0.4");
    else process.stdout.write(JSON.stringify({ output_text: JSON.stringify({
      home: process.env.HOME ?? process.env.USERPROFILE,
      named: process.env.THREADSPAN_GROK_NAMED,
      configured: process.env.THREADSPAN_GROK_CONFIGURED,
      providerKey: process.env.XAI_API_KEY,
      daemonCredential: process.env.THREADSPAN_CONNECTOR_TOKEN,
      unrelated: process.env.THREADSPAN_GROK_PRIVATE,
    }) }));
  `);
  const names = ["HOME", "THREADSPAN_GROK_NAMED", "THREADSPAN_GROK_PRIVATE", "XAI_API_KEY", "THREADSPAN_CONNECTOR_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: "/threadspan-test-home",
    THREADSPAN_GROK_NAMED: "named-value",
    THREADSPAN_GROK_PRIVATE: "must-not-leak",
    XAI_API_KEY: "provider-key-must-not-leak",
    THREADSPAN_CONNECTOR_TOKEN: "daemon-credential-must-not-leak",
  });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const provider = new GrokBuildProvider("grok", createProviderConfig({
    commandArgs: [script],
    inheritEnv: undefined,
    envAllowlist: ["THREADSPAN_GROK_NAMED"],
    env: { THREADSPAN_GROK_CONFIGURED: "configured-value" },
  }), { logger: silentLogger() });
  const events = [];
  try {
    for await (const event of provider.run({
      mode: "consult",
      model: "grok-4.6",
      messages: [{ role: "user", content: "hello" }],
    })) events.push(event);
  } finally {
    await provider.close();
  }

  assert.deepEqual(JSON.parse(events.at(-1).message.content), {
    home: "/threadspan-test-home",
    named: "named-value",
    configured: "configured-value",
  });
});

test("Grok Windows preflight resolves a bare PATHEXT command and records the final PowerShell artifact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan grok windows "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.CMD");
  const script = join(root, "grok.ps1");
  const scriptBody = process.platform === "win32"
    ? "Write-Output 'grok ps1-final 2.0.0'\r\n"
    : "#!/bin/sh\nprintf 'grok ps1-final 2.0.0\\n'\n";
  await writeFile(command, "@echo off\r\necho wrong-wrapper-version\r\n");
  await writeFile(script, scriptBody);
  if (process.platform !== "win32") await chmod(script, 0o755);
  const expectedSha256 = createHash("sha256").update(scriptBody).digest("hex");

  const result = await inspectGrokBuildInstallation(createProviderConfig({
    command: "grok",
    commandArgs: [],
    requireAbsoluteCommand: false,
    versionArgs: ["--version"],
    versionPattern: "^grok ps1-final 2\\.0\\.0$",
    pin: { version: "ps1-final 2.0.0", sha256: expectedSha256 },
  }), {
    platform: "win32",
    environment: { PATH: root, PATHEXT: ".CMD" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.executable, script);
  assert.equal(result.version, "grok ps1-final 2.0.0");
  assert.equal(result.sha256, expectedSha256);
});

test("Grok Windows preflight hashes the final PowerShell artifact and rejects wrapper-hash pinning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.cmd");
  const script = join(root, "grok.ps1");
  const commandBody = "reviewed wrapper";
  const scriptBody = "different final artifact";
  await writeFile(command, commandBody);
  await writeFile(script, scriptBody);
  const wrapperSha256 = createHash("sha256").update(commandBody).digest("hex");
  const scriptSha256 = createHash("sha256").update(scriptBody).digest("hex");

  const result = await inspectGrokBuildInstallation(createProviderConfig({
    command,
    commandArgs: [],
    skipVersionCheck: true,
    versionPattern: undefined,
    pin: { sha256: wrapperSha256 },
  }), { platform: "win32", environment: {} });

  assert.equal(result.ok, false);
  assert.equal(result.executable, script);
  assert.equal(result.sha256, scriptSha256);
  assert.match(result.errors.join("; "), /does not match configured pin/);
});

test("Grok Windows preflight rejects missing PowerShell siblings and batch launchers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.cmd");
  const batch = join(root, "grok.bat");
  await writeFile(command, "not evaluated");
  await writeFile(batch, "not evaluated");

  const missingSibling = await inspectGrokBuildInstallation(createProviderConfig({ command }), { platform: "win32", environment: {} });
  assert.equal(missingSibling.ok, false);
  assert.match(missingSibling.errors.join("; "), /sibling PowerShell shim does not exist/);

  const rejectedBatch = await inspectGrokBuildInstallation(createProviderConfig({ command: batch }), { platform: "win32", environment: {} });
  assert.equal(rejectedBatch.ok, false);
  assert.match(rejectedBatch.errors.join("; "), /\.bat launchers are not supported/);
});

test("Grok parser preserves cache-read/reasoning usage and terminal accounting", () => {
  const parsed = parseGrokBuildPayload(JSON.stringify({
    output_text: "ok",
    usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3, reasoning_tokens: 4, total_tokens: 10 },
    model_calls: 2,
    estimated_cost: "$0.02",
  }));
  assert.equal(parsed.text, "ok");
  assert.deepEqual(parsed.usage, {
    inputTokens: 1,
    cachedInputTokens: 2,
    outputTokens: 3,
    reasoningTokens: 4,
    totalTokens: 10,
  });
  assert.equal(parsed.modelCalls, 2);
  assert.equal(parsed.estimatedCostUsd, 0.02);
});

test("Grok task profiles honor bounded mode and request overrides", () => {
  const profile = resolveGrokTaskProfile(createProviderConfig(), {
    mode: "delegate",
    metadata: { bridge_reasoning_effort: "high", bridge_max_turns: "12", bridge_expected_turns: "5", bridge_no_plan: true },
  });
  assert.deepEqual(profile, { name: "balanced", reasoningEffort: "high", maxTurns: 12, expectedTurns: 5, noPlan: true });
  assert.throws(() => resolveGrokTaskProfile(createProviderConfig(), {
    mode: "delegate",
    metadata: { bridge_max_turns: "25" },
  }), /from 1 to 24/);
});

test("Grok argument builder keeps subagents and web enabled by default while retaining finite controls", () => {
  const args = buildGrokBuildArguments(createProviderConfig(), { mode: "delegate", model: "grok-4.6", metadata: {} }, {
    reasoningEffort: "medium", maxTurns: 8, expectedTurns: 2, noPlan: true,
  }, "/tmp/worktree", "task");
  for (const expected of ["--no-auto-update", "--single", "--permission-mode", "dontAsk", "--sandbox", "strict", "--no-memory", "--max-turns", "8", "--no-plan"]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
  assert.equal(args.includes("--no-subagents"), false);
  assert.equal(args.includes("--disable-web-search"), false);
});

test("Grok rejects protected execution-policy flags from every arbitrary argument tail", () => {
  const cases = [
    ["commandArgs", [fixture, "-mgrok-other"]],
    ["modelListArgs", ["models", "--no-subagents"]],
    ["preArgs", ["--permission-mode", "bypassPermissions"]],
    ["postArgs", ["--resume=old-session"]],
    ["versionArgs", ["--version", "--disable-web-search"]],
  ];
  for (const [field, values] of cases) {
    assert.throws(
      () => new GrokBuildProvider("grok", createProviderConfig({ [field]: values }), { logger: silentLogger() }),
      new RegExp(`${field} contains protected argument`),
    );
  }
});

test("Grok bypassPermissions is Delegate-only and forces a clean linked worktree", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-bypass-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const worktree = join(root, "worker");
  await execFileAsync("git", ["init", "--initial-branch=main", repository]);
  await execFileAsync("git", ["config", "user.email", "threadspan@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Threadspan Test"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  await execFileAsync("git", ["worktree", "add", "-b", "worker", worktree], { cwd: repository });

  const config = createProviderConfig({
    delegate: {
      permissionMode: "bypassPermissions",
      requireGit: false,
      requireLinkedWorktree: false,
      requireCleanStart: false,
    },
  });
  assert.throws(
    () => buildGrokBuildArguments(createProviderConfig({ consult: { permissionMode: "bypassPermissions" } }), { mode: "consult", model: "grok-4.6", metadata: {} }, {
      reasoningEffort: "medium", maxTurns: 4, expectedTurns: 1, noPlan: false,
    }, repository, "task"),
    /only for Delegate in a clean linked worktree/,
  );

  const provider = new GrokBuildProvider("grok", config, { logger: silentLogger() });
  const request = { mode: "delegate", model: "grok-4.6", messages: [{ role: "user", content: "bounded task" }] };
  try {
    await assert.rejects(async () => {
      for await (const _event of provider.run({ ...request, workspace: repository })) {}
    }, /linked Git worktree/);
    const events = [];
    for await (const event of provider.run({ ...request, workspace: worktree })) events.push(event);
    assert.equal(events.at(-1).message.content, "worker-ok");
    await writeFile(join(worktree, "tracked.txt"), "dirty\n");
    await assert.rejects(async () => {
      for await (const _event of provider.run({ ...request, workspace: worktree })) {}
    }, /must be clean/);
  } finally {
    await provider.close();
  }
});

test("Grok execution policy supports explicit per-request subagent and web disabling", () => {
  const request = {
    mode: "delegate",
    model: "grok-4.6",
    metadata: { bridge_allow_subagents: false, bridge_allow_web_search: "false" },
  };
  assert.deepEqual(resolveGrokExecutionPolicy(createProviderConfig(), request), {
    allowSubagents: false,
    allowWebSearch: false,
    noMemory: true,
  });
  const args = buildGrokBuildArguments(createProviderConfig(), request, {
    reasoningEffort: "medium", maxTurns: 8, expectedTurns: 2, noPlan: false,
  }, "/tmp/worktree", "task");
  assert.ok(args.includes("--no-subagents"));
  assert.ok(args.includes("--disable-web-search"));
});

test("Grok execution policy retains legacy negative configuration aliases", () => {
  const config = createProviderConfig({
    allowSubagents: undefined,
    noSubagents: true,
    allowWebSearch: undefined,
    disableWebSearch: true,
  });
  assert.deepEqual(resolveGrokExecutionPolicy(config, { mode: "delegate", metadata: {} }), {
    allowSubagents: false,
    allowWebSearch: false,
    noMemory: true,
  });
});

test("Grok Consult executes in a disposable workspace and emits usage/metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-grok-test-"));
  const argsPath = join(root, "args.json");
  const provider = new GrokBuildProvider("grok", createProviderConfig({ env: { FAKE_GROK_ARGS_PATH: argsPath } }), { logger: silentLogger() });
  const events = [];
  for await (const event of provider.run({
    mode: "consult",
    model: "grok-4.6",
    threadId: "thread-test",
    messages: [{ role: "user", content: "Review this design" }],
    metadata: {
      bridge_acceptance_commands: ["npm test"],
      bridge_allow_subagents: true,
      bridge_allow_web_search: true,
      bridge_coordinator_id: "cgpt-a",
      bridge_worker_group: "grok-nine",
    },
  })) events.push(event);
  await provider.close();

  assert.equal(events.at(-1).message.content, "worker-ok");
  assert.equal(events.find((event) => event.type === "usage").usage.cachedInputTokens, 20);
  assert.equal(events.at(-1).providerMetadata.grokBuild.modelCalls, 2);
  const args = JSON.parse(await readFile(argsPath, "utf8"));
  assert.ok(args.includes("--single"));
  assert.equal(args.filter((value) => value === fixture).length, 0, "commandArgs must be applied exactly once as the Node script path, not duplicated into script argv");
  const prompt = args[args.indexOf("--single") + 1];
  assert.match(prompt, /NESTED AGENTS[\s\S]*subagents are allowed/i);
  assert.match(prompt, /WEB AND INFORMATION RETRIEVAL[\s\S]*Web\/search access is allowed/i);
  assert.match(prompt, /FLEET IDENTITY[\s\S]*coordinator_id=cgpt-a[\s\S]*worker_group=grok-nine/);
  assert.match(prompt, /ACCEPTANCE COMMANDS[\s\S]*npm test/);
  assert.equal(events.at(-1).providerMetadata.grokBuild.allowSubagents, true);
  assert.equal(events.at(-1).providerMetadata.grokBuild.allowWebSearch, true);
  assert.equal(events.at(-1).providerMetadata.grokBuild.coordinatorId, "cgpt-a");
});

test("Grok Build summarizes only repetitive tool output in the transmitted worker packet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argsPath = join(root, "args.json");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_ARGS_PATH: argsPath },
    outputSummary: {
      minBytes: 128,
      minLines: 12,
      minRepetitions: 8,
      minDuplicateLineRatio: 0.7,
      headBytes: 96,
      tailBytes: 96,
    },
  }), { logger: silentLogger() });
  const original = ["head", ...Array.from({ length: 80 }, () => "repeat"), "tail"].join("\n");
  const messages = [{ role: "tool", toolCallId: "call_grok", content: original }];
  const before = structuredClone(messages);
  try {
    for await (const _event of provider.run({ mode: "consult", model: "grok-4.6", messages })) {}
  } finally {
    await provider.close();
  }
  const args = JSON.parse(await readFile(argsPath, "utf8"));
  const prompt = args[args.indexOf("--single") + 1];
  assert.match(prompt, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  assert.deepEqual(messages, before);
});

test("Grok Build rejects Integrated rather than substituting its agent loop", async () => {
  const provider = new GrokBuildProvider("grok", createProviderConfig({ capabilities: ["consult", "integrated", "delegate"] }), { logger: silentLogger() });
  await assert.rejects(async () => {
    for await (const _event of provider.run({ mode: "integrated", model: "grok-4.6", messages: [] })) {}
  }, /does not support mode 'integrated'|coding-agent loop/);
  await provider.close();
});


test("Grok Build classifies stderr quota JSON and does not retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-grok-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counterPath = join(root, "counter.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_COUNTER_PATH: counterPath, FAKE_GROK_QUOTA: "1" },
  }), { logger: silentLogger() });
  try {
    await assert.rejects(async () => {
      for await (const _event of provider.run({
        mode: "consult",
        model: "grok-4.6",
        messages: [{ role: "user", content: "bounded probe" }],
      })) {}
    }, (error) => error.status === 429 && error.retryable === false && error.details?.upstream?.retryPolicy === "no-automatic-retry");
  } finally {
    await provider.close();
  }
  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2, "one version preflight plus one failed job; no retry");
});
