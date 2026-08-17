import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GrokBuildProvider,
  buildGrokBuildArguments,
  inspectGrokBuildInstallation,
  parseGrokBuildPayload,
  resolveGrokExecutionPolicy,
  resolveGrokTaskProfile,
} from "../src/providers/grok-build.mjs";
import { silentLogger } from "./helpers.mjs";

const fixture = new URL("./fixtures/fake-grok.mjs", import.meta.url).pathname;

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
