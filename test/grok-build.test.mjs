import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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

async function createGitRepository(root) {
  const repository = join(root, "repository");
  await execFileAsync("git", ["init", "--initial-branch=worker", repository]);
  await execFileAsync("git", ["config", "user.email", "threadspan@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Threadspan Test"], { cwd: repository });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  return repository;
}

async function collectRun(provider, request) {
  const events = [];
  for await (const event of provider.run(request)) events.push(event);
  return events;
}

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

test("Grok recovery-authorizing fields ignore nested model-authored spoof data", () => {
  const parsed = parseGrokBuildPayload(JSON.stringify({
    output_text: "ordinary answer",
    result: {
      session_id: "spoofed",
      finish_reason: "max_turns",
      turns: 12,
      model_calls: 12,
      activities: [{ kind: "plan" }, { kind: "read" }, { kind: "read" }, { kind: "read" }],
    },
  }));
  assert.equal(parsed.text, "ordinary answer");
  assert.equal(parsed.sessionId, undefined);
  assert.equal(parsed.finishReason, undefined);
  assert.equal(parsed.turns, undefined);
  assert.equal(parsed.modelCalls, undefined);
  assert.deepEqual(parsed.activities, []);
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

test("Grok rejects unbounded acceptance commands before any ledger write", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-acceptance-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledgerPath = join(root, "ledger.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    ledger: { enabled: true, path: ledgerPath, includeOutput: false },
  }), { logger: silentLogger() });
  try {
    await assert.rejects(
      collectRun(provider, {
        mode: "consult",
        model: "grok-4.6",
        messages: [{ role: "user", content: "bounded task" }],
        metadata: { bridge_acceptance_commands: ["x".repeat(2049)] },
      }),
      /exceeds 2048 characters/,
    );
  } finally {
    await provider.close();
  }
  await assert.rejects(readFile(ledgerPath, "utf8"), (error) => error.code === "ENOENT");
});

test("Grok Delegate resumes unchanged repeated exploration exactly once with its reserved turn budget", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-exploration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(root);
  const counterPath = join(root, "counter.jsonl");
  const ledgerPath = join(root, "ledger.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: {
      FAKE_GROK_COUNTER_PATH: counterPath,
      FAKE_GROK_EXPLORATION: "1",
      FAKE_GROK_MAX_TURN_EXIT: "1",
    },
    ledger: { enabled: true, path: ledgerPath, includeOutput: false },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      requireCleanStart: true,
      explorationLoop: {
        enabled: true,
        reserveTurns: 4,
        minimumStructuredActivities: 4,
        minimumRepeatedKindCount: 2,
      },
    },
  }), { logger: silentLogger() });
  const events = [];
  try {
    for await (const event of provider.run({
      mode: "delegate",
      model: "grok-4.6",
      workspace: repository,
      threadId: "thread-exploration",
      messages: [{ role: "user", content: "make the bounded patch" }],
      metadata: { bridge_acceptance_commands: ["npm test -- token=private-acceptance"] },
    })) events.push(event);
  } finally {
    await provider.close();
  }

  assert.equal(events.at(-1).message.content, "worker-recovered");
  assert.ok(events.some((event) => event.status === "recovering"));
  const metadata = events.at(-1).providerMetadata.grokBuild;
  assert.equal(metadata.threadId, "thread-exploration");
  assert.equal(metadata.explorationRecovery.issued, true);
  assert.deepEqual(metadata.attempts.map((attempt) => attempt.attempt), ["initial", "recovery"]);
  assert.deepEqual(metadata.attempts.map((attempt) => attempt.maxTurns), [12, 4]);
  assert.deepEqual(metadata.attempts.map((attempt) => attempt.exitCode), [17, 0]);
  assert.equal(metadata.attempts[0].recoverableNonzeroExit, true);
  assert.equal(metadata.admissionExpectedTurns, 8);
  assert.equal(metadata.modelCalls, 15);
  assert.equal(events.at(-1).usage.totalTokens, 38);
  assert.equal(Object.hasOwn(metadata.attempts[0], "prompt"), false);

  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((args) => !args.includes("--version"));
  assert.equal(invocations.length, 2);
  const initialSessionIndex = invocations[0].indexOf("--session-id");
  const recoverySessionIndex = invocations[1].indexOf("--resume");
  assert.ok(initialSessionIndex >= 0);
  assert.ok(recoverySessionIndex >= 0);
  assert.equal(invocations[0][initialSessionIndex + 1], invocations[1][recoverySessionIndex + 1]);
  assert.equal(invocations[0][invocations[0].indexOf("--max-turns") + 1], "12");
  assert.equal(invocations[1][invocations[1].indexOf("--max-turns") + 1], "4");
  assert.match(invocations[1][invocations[1].indexOf("--single") + 1], /PATCH-FIRST RECOVERY[\s\S]*npm test/);

  const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
  const running = ledger.filter((record) => record.event === "running");
  assert.deepEqual(running.map((record) => record.attempt), ["initial", "recovery"]);
  assert.deepEqual(running.map((record) => record.sessionOperation), ["create", "resume"]);
  assert.equal(running[0].sessionId, running[1].sessionId);
  assert.equal(ledger.find((record) => record.event === "exploration-classified").recoveryIssued, true);
  assert.equal(ledger.find((record) => record.event === "queued").acceptanceCommands.count, 1);
  assert.equal(ledger.find((record) => record.event === "queued").acceptanceCommands.digests.length, 1);
  assert.doesNotMatch(JSON.stringify(ledger), /make the bounded patch|PATCH-FIRST RECOVERY|private-acceptance/);
});

test("Grok nonzero max-turn exits remain terminal for Consult and exploration-disabled Delegate", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-nonzero-disabled-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(root);
  for (const scenario of [
    { name: "consult", request: { mode: "consult", model: "grok-4.6", messages: [{ role: "user", content: "advice" }] } },
    { name: "disabled-delegate", request: { mode: "delegate", model: "grok-4.6", workspace: repository, messages: [{ role: "user", content: "work" }] } },
  ]) {
    await t.test(scenario.name, async () => {
      const counterPath = join(root, `${scenario.name}.jsonl`);
      const provider = new GrokBuildProvider("grok", createProviderConfig({
        env: {
          FAKE_GROK_COUNTER_PATH: counterPath,
          FAKE_GROK_EXPLORATION: "1",
          FAKE_GROK_MAX_TURN_EXIT: "1",
        },
        delegate: {
          profile: "balanced",
          maxTurns: 16,
          expectedTurns: 4,
          requireGit: true,
          explorationLoop: { enabled: false, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
        },
      }), { logger: silentLogger() });
      try {
        await assert.rejects(collectRun(provider, scenario.request), /exited with code 17/);
      } finally {
        await provider.close();
      }
      const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
        .filter((args) => !args.includes("--version"));
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0].includes("--resume"), false);
    });
  }
});

test("Grok nonzero max-turn recovery classifies table-driven mixed diagnostics without broad numeric false positives", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  for (const scenario of [
    { name: "message-only", env: { FAKE_GROK_MAX_TURN_ERROR_MESSAGE: "ordinary worker failure" }, status: 502 },
    { name: "authentication-failed", env: { FAKE_GROK_MAX_TURN_STDERR: "authentication failed" }, status: 401 },
    { name: "invalid-credentials", env: { FAKE_GROK_MAX_TURN_STDERR: "invalid credentials" }, status: 401 },
    { name: "http-401", env: { FAKE_GROK_MAX_TURN_STDERR: "HTTP 401" }, status: 401 },
    { name: "http-402", env: { FAKE_GROK_MAX_TURN_STDERR: "HTTP 402 payment required" }, status: 402 },
    { name: "http-403", env: { FAKE_GROK_MAX_TURN_STDERR: "HTTP 403" }, status: 401 },
    { name: "http-429", env: { FAKE_GROK_MAX_TURN_STDERR: "HTTP 429" }, status: 429 },
    { name: "quota-exceeded", env: { FAKE_GROK_MAX_TURN_STDERR: "quota exceeded" }, status: 429 },
    { name: "rate-exceeded", env: { FAKE_GROK_MAX_TURN_STDERR: "rate exceeded" }, status: 429 },
    { name: "subscription-expired", env: { FAKE_GROK_MAX_TURN_STDERR: "subscription expired" }, status: 401 },
    { name: "entitlement-missing", env: { FAKE_GROK_MAX_TURN_STDERR: "entitlement missing" }, status: 401 },
    { name: "token-expired", env: { FAKE_GROK_MAX_TURN_STDERR: "token expired" }, status: 401 },
    { name: "api-key-expired-diagnostic", env: { FAKE_GROK_MAX_TURN_DIAGNOSTIC: "API key expired" }, status: 401 },
    { name: "access-denied-status", env: { FAKE_GROK_MAX_TURN_ERROR_STATUS: "access denied" }, status: 401 },
    { name: "insufficient-quota-diagnostic", env: { FAKE_GROK_MAX_TURN_DIAGNOSTIC: "insufficient quota" }, status: 429 },
    { name: "resource-exhausted-code", env: { FAKE_GROK_MAX_TURN_ERROR_CODE: "RESOURCE_EXHAUSTED" }, status: 429 },
    { name: "insufficient-funds-diagnostic", env: { FAKE_GROK_MAX_TURN_DIAGNOSTIC: "insufficient funds" }, status: 402 },
    { name: "insufficient-credits", env: { FAKE_GROK_MAX_TURN_STDERR: "insufficient credits" }, status: 402 },
    { name: "billing-required-status", env: { FAKE_GROK_MAX_TURN_ERROR_STATUS: "billing required" }, status: 402 },
    { name: "payment-required-diagnostic", env: { FAKE_GROK_MAX_TURN_DIAGNOSTIC: "payment required" }, status: 402 },
    { name: "benign-issue-number", env: { FAKE_GROK_MAX_TURN_STDERR: "auth.js notes issue 402 and change 4290" }, status: undefined },
    {
      name: "assistant-discusses-failure-phrases",
      env: {
        FAKE_GROK_EXPLORATION_TEXT: "Docs discuss authentication failed, token expired, RESOURCE_EXHAUSTED, insufficient quota, and payment required.",
      },
      status: undefined,
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-grok-nonzero-${scenario.name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const repository = await createGitRepository(root);
      const counterPath = join(root, "counter.jsonl");
      const provider = new GrokBuildProvider("grok", createProviderConfig({
        env: {
          FAKE_GROK_COUNTER_PATH: counterPath,
          FAKE_GROK_EXPLORATION: "1",
          FAKE_GROK_MAX_TURN_EXIT: "1",
          ...scenario.env,
        },
        delegate: {
          profile: "balanced",
          maxTurns: 16,
          expectedTurns: 4,
          requireGit: true,
          explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
        },
      }), { logger: silentLogger() });
      try {
        const run = collectRun(provider, {
          mode: "delegate",
          model: "grok-4.6",
          workspace: repository,
          messages: [{ role: "user", content: "bounded task" }],
        });
        if (scenario.status === undefined) {
          const events = await run;
          assert.equal(events.at(-1).message.content, "worker-recovered");
        } else {
          await assert.rejects(run, (error) => error.status === scenario.status && error.retryable === false);
        }
      } finally {
        await provider.close();
      }
      const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
        .filter((args) => !args.includes("--version"));
      assert.equal(invocations.length, scenario.status === undefined ? 2 : 1);
    });
  }
});

test("Grok Delegate does not recover changed work or incomplete output without structured repetition", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  for (const scenario of [
    { name: "changed", env: { FAKE_GROK_EXPLORATION: "1", FAKE_GROK_CHANGE_FILE: "1" }, reason: "git-state-changed-or-unavailable" },
    { name: "unstructured", env: { FAKE_GROK_INCOMPLETE: "1" }, reason: "insufficient-structured-activity" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-grok-no-recovery-${scenario.name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const repository = await createGitRepository(root);
      const counterPath = join(root, "counter.jsonl");
      const provider = new GrokBuildProvider("grok", createProviderConfig({
        env: { FAKE_GROK_COUNTER_PATH: counterPath, ...scenario.env },
        delegate: {
          profile: "balanced",
          maxTurns: 16,
          expectedTurns: 4,
          requireGit: true,
          explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
        },
      }), { logger: silentLogger() });
      const events = [];
      try {
        for await (const event of provider.run({
          mode: "delegate",
          model: "grok-4.6",
          workspace: repository,
          messages: [{ role: "user", content: "bounded task" }],
        })) events.push(event);
      } finally {
        await provider.close();
      }
      assert.equal(events.at(-1).providerMetadata.grokBuild.explorationRecovery.issued, false);
      assert.equal(events.at(-1).providerMetadata.grokBuild.explorationRecovery.classification.reason, scenario.reason);
      const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
        .filter((args) => !args.includes("--version"));
      assert.equal(invocations.length, 1);
    });
  }
});

test("Grok Delegate recovery entitlement failure remains terminal without a third inference invocation", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-recovery-entitlement-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(root);
  const counterPath = join(root, "counter.jsonl");
  const ledgerPath = join(root, "ledger.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: {
      FAKE_GROK_COUNTER_PATH: counterPath,
      FAKE_GROK_EXPLORATION: "1",
      FAKE_GROK_RECOVERY_ENTITLEMENT: "1",
    },
    ledger: { enabled: true, path: ledgerPath, includeOutput: false },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await assert.rejects(async () => {
      for await (const _event of provider.run({
        mode: "delegate",
        model: "grok-4.6",
        workspace: repository,
        threadId: "thread-entitlement",
        messages: [{ role: "user", content: "bounded task" }],
      })) {}
    }, (error) => error.status === 401 && error.retryable === false && error.details?.upstream?.retryPolicy === "no-automatic-retry");
  } finally {
    await provider.close();
  }
  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((args) => !args.includes("--version"));
  assert.equal(invocations.length, 2, "one initial inference plus one recovery; no retry after entitlement failure");
  assert.ok(invocations[1].includes("--resume"));
  const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
  const failedAttempt = ledger.find((record) => record.event === "attempt-failed" && record.attempt === "recovery");
  assert.equal(failedAttempt.sessionOperation, "resume");
  assert.match(failedAttempt.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(failedAttempt.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.match(failedAttempt.stderrSha256, /^[a-f0-9]{64}$/);
  assert.equal(ledger.at(-1).event, "failed");
});

test("Grok exploration-enabled Delegate ordinary success and Consult never recover", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-ordinary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(root);
  const counterPath = join(root, "counter.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_COUNTER_PATH: counterPath },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    const delegate = await collectRun(provider, {
      mode: "delegate",
      model: "grok-4.6",
      workspace: repository,
      messages: [{ role: "user", content: "ordinary bounded task" }],
    });
    assert.equal(delegate.at(-1).message.content, "worker-ok");
    assert.equal(delegate.at(-1).providerMetadata.grokBuild.explorationRecovery.issued, false);
    assert.equal(delegate.at(-1).providerMetadata.grokBuild.explorationRecovery.classification.reason, "attempt-complete");

    const consult = await collectRun(provider, {
      mode: "consult",
      model: "grok-4.6",
      messages: [{ role: "user", content: "advice only" }],
    });
    assert.equal(consult.at(-1).message.content, "worker-ok");
    assert.equal(consult.at(-1).providerMetadata.grokBuild.explorationRecovery.enabled, false);
  } finally {
    await provider.close();
  }
  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
    .filter((args) => !args.includes("--version"));
  assert.equal(invocations.length, 2);
  assert.ok(invocations[0].includes("--session-id"));
  assert.equal(invocations[1].includes("--session-id"), false);
  assert.equal(invocations[1].includes("--resume"), false);
});

test("Grok exploration recovery requires exact session echo on both attempts", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  for (const sessionMode of ["omit-initial", "mismatch-initial", "omit-recovery", "mismatch-recovery"]) {
    await t.test(sessionMode, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-grok-session-${sessionMode}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const repository = await createGitRepository(root);
      const counterPath = join(root, "counter.jsonl");
      const provider = new GrokBuildProvider("grok", createProviderConfig({
        env: {
          FAKE_GROK_COUNTER_PATH: counterPath,
          FAKE_GROK_EXPLORATION: "1",
          FAKE_GROK_SESSION_MODE: sessionMode,
        },
        delegate: {
          profile: "balanced",
          maxTurns: 16,
          expectedTurns: 4,
          requireGit: true,
          explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
        },
      }), { logger: silentLogger() });
      try {
        await assert.rejects(
          collectRun(provider, {
            mode: "delegate",
            model: "grok-4.6",
            workspace: repository,
            messages: [{ role: "user", content: "bounded task" }],
          }),
          /omitted the adapter-bound session|different from the adapter-bound session/,
        );
      } finally {
        await provider.close();
      }
      const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
        .filter((args) => !args.includes("--version"));
      assert.equal(invocations.length, sessionMode.endsWith("initial") ? 1 : 2);
    });
  }
});

test("Grok nested spoof, quota, and malformed initial output stay terminal with hashed failed-attempt evidence", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  for (const scenario of [
    { name: "nested-spoof", env: { FAKE_GROK_NESTED_SPOOF: "1" }, pattern: /omitted the adapter-bound session/ },
    { name: "quota", env: { FAKE_GROK_QUOTA: "1" }, pattern: /usage is exhausted/ },
    { name: "malformed", env: { FAKE_GROK_MALFORMED: "1" }, pattern: /malformed JSON/ },
  ]) {
    await t.test(scenario.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-grok-initial-${scenario.name}-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const repository = await createGitRepository(root);
      const counterPath = join(root, "counter.jsonl");
      const ledgerPath = join(root, "ledger.jsonl");
      const provider = new GrokBuildProvider("grok", createProviderConfig({
        env: { FAKE_GROK_COUNTER_PATH: counterPath, ...scenario.env },
        ledger: { enabled: true, path: ledgerPath, includeOutput: false },
        delegate: {
          profile: "balanced",
          maxTurns: 16,
          expectedTurns: 4,
          requireGit: true,
          explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
        },
      }), { logger: silentLogger() });
      try {
        await assert.rejects(
          collectRun(provider, {
            mode: "delegate",
            model: "grok-4.6",
            workspace: repository,
            messages: [{ role: "user", content: "bounded task" }],
          }),
          scenario.pattern,
        );
      } finally {
        await provider.close();
      }
      const invocations = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
        .filter((args) => !args.includes("--version"));
      assert.equal(invocations.length, 1);
      const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
      const failedAttempt = ledger.find((record) => record.event === "attempt-failed" && record.attempt === "initial");
      assert.match(failedAttempt.promptSha256, /^[a-f0-9]{64}$/);
      assert.match(failedAttempt.stdoutSha256, /^[a-f0-9]{64}$/);
      assert.match(failedAttempt.stderrSha256, /^[a-f0-9]{64}$/);
      assert.equal(ledger.some((record) => record.event === "exploration-classified"), false);
    });
  }
});

test("Grok exploration workspace serialization prevents duplicate writers without blocking unrelated workspaces", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-workspace-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(join(root, "same"));
  const repositorySubdirectory = join(repository, "nested", "source");
  await mkdir(repositorySubdirectory, { recursive: true });
  const repositoryAlias = join(root, "repository-alias");
  await symlink(repository, repositoryAlias, process.platform === "win32" ? "junction" : "dir");
  const sameLockDirectory = join(root, "same-locks");
  const enabledProvider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: sameLockDirectory, FAKE_GROK_LOCK_KEY: "same-physical-worktree", FAKE_GROK_LOCK_DELAY_MS: "80" },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await Promise.all([repository, repositorySubdirectory, repositoryAlias].map((workspace, index) => collectRun(enabledProvider, {
      mode: "delegate",
      model: "grok-4.6",
      workspace,
      messages: [{ role: "user", content: `same physical workspace ${index}` }],
    })));
  } finally {
    await enabledProvider.close();
  }

  const sharedConfig = createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: join(root, "cross-instance-locks"), FAKE_GROK_LOCK_KEY: "cross-instance-worktree", FAKE_GROK_LOCK_DELAY_MS: "80" },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  });
  const firstInstance = new GrokBuildProvider("grok-first", sharedConfig, { logger: silentLogger() });
  const secondInstance = new GrokBuildProvider("grok-second", sharedConfig, { logger: silentLogger() });
  try {
    await Promise.all([
      collectRun(firstInstance, { mode: "delegate", model: "grok-4.6", workspace: repository, messages: [{ role: "user", content: "first instance" }] }),
      collectRun(secondInstance, { mode: "delegate", model: "grok-4.6", workspace: repositorySubdirectory, messages: [{ role: "user", content: "second instance" }] }),
    ]);
  } finally {
    await Promise.all([firstInstance.close(), secondInstance.close()]);
  }

  if (process.platform === "win32") {
    const caseProvider = new GrokBuildProvider("grok-case", createProviderConfig({
      ...sharedConfig,
      env: { FAKE_GROK_LOCK_DIR: join(root, "case-locks"), FAKE_GROK_LOCK_KEY: "case-worktree", FAKE_GROK_LOCK_DELAY_MS: "80" },
    }), { logger: silentLogger() });
    try {
      await Promise.all([repository, repository.toUpperCase()].map((workspace) => collectRun(caseProvider, {
        mode: "delegate",
        model: "grok-4.6",
        workspace,
        messages: [{ role: "user", content: "case alias" }],
      })));
    } finally {
      await caseProvider.close();
    }
  }

  const left = await createGitRepository(join(root, "left"));
  const right = await createGitRepository(join(root, "right"));
  const unrelatedProvider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: join(root, "unrelated-locks"), FAKE_GROK_BARRIER_COUNT: "2" },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await Promise.all([left, right].map((workspace) => collectRun(unrelatedProvider, {
      mode: "delegate",
      model: "grok-4.6",
      workspace,
      messages: [{ role: "user", content: "unrelated workspace" }],
    })));
  } finally {
    await unrelatedProvider.close();
  }
});

test("Grok exploration-enabled Delegate fails closed when physical Git identity is unavailable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-no-git-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const counterPath = join(root, "counter.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_COUNTER_PATH: counterPath },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: false,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await assert.rejects(
      collectRun(provider, {
        mode: "delegate",
        model: "grok-4.6",
        workspace: root,
        messages: [{ role: "user", content: "must not launch" }],
      }),
      /inspectable physical Git worktree identity/,
    );
  } finally {
    await provider.close();
  }
  await assert.rejects(readFile(counterPath, "utf8"), (error) => error.code === "ENOENT");
});

test("Grok binds child cwd, argv, and environment to the physical worktree across symlink retargeting", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-retarget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(join(root, "source"));
  const escapeTarget = join(root, "escape");
  await mkdir(escapeTarget);
  const alias = join(root, "workspace-link");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(repository, alias, linkType);
  const counterPath = join(root, "counter.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: {
      FAKE_GROK_COUNTER_PATH: counterPath,
      FAKE_GROK_RETARGET_LINK: alias,
      FAKE_GROK_RETARGET_TARGET: escapeTarget,
      FAKE_GROK_RETARGET_LINK_TYPE: linkType,
      FAKE_GROK_EXPECT_PHYSICAL_WORKSPACE: await realpath(repository),
    },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    const events = await collectRun(provider, {
      mode: "delegate",
      model: "grok-4.6",
      workspace: alias,
      messages: [{ role: "user", content: "retarget race" }],
    });
    assert.equal(events.at(-1).message.content, "worker-ok");
  } finally {
    await provider.close();
  }
  assert.equal(await realpath(alias), await realpath(escapeTarget));
  const invocation = (await readFile(counterPath, "utf8")).trim().split("\n").map(JSON.parse)
    .find((args) => !args.includes("--version"));
  assert.equal(invocation[invocation.indexOf("--cwd") + 1], await realpath(repository));
});

test("Grok ManagedProcessError records only evidence hashes available at its error boundary", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-timeout-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(root);
  const ledgerPath = join(root, "ledger.jsonl");
  const provider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: join(root, "locks"), FAKE_GROK_LOCK_DELAY_MS: "200" },
    ledger: { enabled: true, path: ledgerPath, includeOutput: false },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await assert.rejects(
      collectRun(provider, {
        mode: "delegate",
        model: "grok-4.6",
        workspace: repository,
        timeoutMs: 10,
        messages: [{ role: "user", content: "timeout probe" }],
      }),
      /process timeout failure/,
    );
  } finally {
    await provider.close();
  }
  const ledger = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
  const failedAttempt = ledger.find((record) => record.event === "attempt-failed");
  assert.match(failedAttempt.promptSha256, /^[a-f0-9]{64}$/);
  assert.match(failedAttempt.stderrSha256, /^[a-f0-9]{64}$/);
  assert.equal(failedAttempt.stdoutSha256, undefined);
});

test("Grok disabled exploration and Consult bypass workspace serialization", async (t) => {
  try { await execFileAsync("git", ["--version"]); } catch { t.skip("git is unavailable"); return; }
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-no-workspace-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createGitRepository(join(root, "disabled"));
  const disabledProvider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: join(root, "disabled-locks"), FAKE_GROK_LOCK_DELAY_MS: "100" },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      requireGit: true,
      explorationLoop: { enabled: false, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    const outcomes = await Promise.allSettled([1, 2].map((index) => collectRun(disabledProvider, {
      mode: "delegate",
      model: "grok-4.6",
      workspace: repository,
      messages: [{ role: "user", content: `disabled ${index}` }],
    })));
    assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["fulfilled", "rejected"]);
  } finally {
    await disabledProvider.close();
  }

  const consultProvider = new GrokBuildProvider("grok", createProviderConfig({
    env: { FAKE_GROK_LOCK_DIR: join(root, "consult-locks"), FAKE_GROK_BARRIER_COUNT: "2" },
    admission: { maxActive: 4, minStartIntervalMs: 0, maxUnitsPerWindow: 100, windowMs: 1000 },
    delegate: {
      profile: "balanced",
      maxTurns: 16,
      expectedTurns: 4,
      explorationLoop: { enabled: true, reserveTurns: 4, minimumStructuredActivities: 4, minimumRepeatedKindCount: 2 },
    },
  }), { logger: silentLogger() });
  try {
    await Promise.all([1, 2].map((index) => collectRun(consultProvider, {
      mode: "consult",
      model: "grok-4.6",
      messages: [{ role: "user", content: `consult ${index}` }],
    })));
  } finally {
    await consultProvider.close();
  }
});
