import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildCodexNativeWorkerArguments,
  buildCodexWorkerArguments,
  CodexNativeWorkerProvider,
  CodexWorkerProvider,
  nativeCodexEnvironment,
  parseCodexNativeUsageLimit,
  parseCodexWorkerJsonl,
} from "../src/providers/codex-worker.mjs";
import { nativePath, silentLogger } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const fixture = nativePath(new URL("./fixtures/codex-worker.mjs", import.meta.url));
const route = "integrated/nous/deepseek/deepseek-v4-flash-0731";
const gitAvailable = await execFileAsync("git", ["--version"]).then(() => true, () => false);

function provider(overrides = {}) {
  return new CodexWorkerProvider("codex-worker", {
    adapter: "codex-worker",
    command: process.execPath,
    commandArgs: [fixture],
    model: route,
    profile: "threadspan_integrated",
    timeoutMs: 5_000,
    ...overrides,
  }, { logger: silentLogger() });
}

function request(workspace, overrides = {}) {
  return {
    mode: "delegate",
    model: route,
    workspace,
    messages: [{ role: "user", content: "Implement the bounded change" }],
    metadata: {
      bridge_scope: {
        allowed: ["src/owned.mjs", "test/owned.test.mjs"],
        denied: ["src/registry.mjs"],
        nonGoals: ["publishing"],
      },
      bridge_acceptance_commands: ["node --test test/owned.test.mjs"],
    },
    ...overrides,
  };
}

async function createLinkedWorktree(t) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-codex-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const worktree = join(root, "worker");
  await execFileAsync("git", ["init", repository]);
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Threadspan Test"], { cwd: repository });
  await writeFile(join(repository, "base.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "base.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repository });
  await execFileAsync("git", ["worktree", "add", "-b", "worker", worktree], { cwd: repository });
  return { root, repository, worktree };
}

test("Codex Worker advertises Delegate only and command-backed auth", () => {
  const capabilities = provider().capabilities();
  assert.equal(capabilities.modes.consult.supported, false);
  assert.equal(capabilities.modes.integrated.supported, false);
  assert.equal(capabilities.modes.delegate.supported, true);
  assert.equal(capabilities.authentication, "existing-codex-cli-session");
  assert.equal(capabilities.integrationAuthority, false);
  const settings = provider().effectiveSettings({ mode: "delegate", model: route, metadata: {} });
  assert.deepEqual(settings.divergences.slice(0, 4).map((item) => item.setting), ["profile", "model", "modelProvider", "requestRetries"]);
  assert.equal(settings.divergences.every((item) => item.reversible), true);
  assert.match(settings.digest, /^[0-9a-f]{64}$/);
});

test("Codex Worker argv selects a shared-daemon profile and Integrated route without a shell prompt", () => {
  const injectedRoute = "integrated/nous/deepseek/model;touch-should-not-run";
  const workspace = join(tmpdir(), "linked worker");
  const args = buildCodexWorkerArguments({ profile: "threadspan_integrated" }, {
    mode: "delegate",
    model: injectedRoute,
    workspace,
    metadata: {},
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.equal(args[args.indexOf("--profile") + 1], "threadspan_integrated");
  assert.equal(args[args.indexOf("--model") + 1], injectedRoute);
  assert.equal(args[args.indexOf("--cd") + 1], workspace);
  assert.ok(args.includes("model_providers.threadspan_bridge.request_max_retries=0"));
  assert.ok(args.includes("model_providers.threadspan_bridge.stream_max_retries=0"));
  assert.equal(args.some((arg) => arg.startsWith("approval_policy=")), false);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("goals"), false);
  assert.equal(args.includes("--ask-for-approval"), false);
  assert.equal(args.at(-1), "-");
  assert.equal(args.some((arg) => arg.includes("Implement the bounded change")), false);
});

test("Codex Native Worker isolates auth while inheriting native user and project execution settings", () => {
  const workspace = join(tmpdir(), "native worker");
  const native = new CodexNativeWorkerProvider("openai-codex", {
    adapter: "codex-native-worker",
    model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    capabilities: ["delegate"],
  }, { logger: silentLogger() });
  const capabilities = native.capabilities();
  assert.equal(capabilities.modes.consult.supported, false);
  assert.equal(capabilities.modes.integrated.supported, false);
  assert.equal(capabilities.modes.delegate.supported, true);
  assert.equal(capabilities.authentication, "isolated-provider-native-codex-home");

  const args = buildCodexNativeWorkerArguments(native.config, {
    mode: "delegate",
    model: "gpt-5.6-sol",
    workspace,
  });
  assert.deepEqual(args.slice(0, 4), ["exec", "--json", "--ephemeral", "--color"]);
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(args[args.indexOf("--cd") + 1], workspace);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.some((arg) => /approval_policy|model_provider|model_context_window|model_reasoning_effort|request_max_retries|stream_max_retries/.test(arg)), false);
  assert.equal(args.includes("--profile"), false);
  assert.equal(args.some((arg) => arg.includes("threadspan_integrated") || arg.includes("threadspan_bridge") || arg.startsWith("integrated/") || /base_url/i.test(arg)), false);
  assert.throws(() => buildCodexNativeWorkerArguments(native.config, { mode: "delegate", model: "integrated/openai/gpt-5.6-sol", workspace }), /native Codex catalog slug/);
  assert.throws(() => buildCodexNativeWorkerArguments(native.config, { mode: "delegate", model: "gpt-5.6-terra", workspace }), /not in the configured native Codex catalog/);

  const settings = native.effectiveSettings({ mode: "delegate", model: "gpt-5.6-sol", workspace });
  assert.equal(settings.inheritance, "isolated-native-user-profile-plus-project");
  assert.equal(settings.authentication, "isolated-provider-native-codex-home");
  assert.deepEqual(settings.preserved, ["sandbox", "approval", "tools", "web", "memory", "user", "project"]);
  assert.deepEqual(settings.divergences.map((item) => item.setting), ["model"]);
  assert.match(settings.digest, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(settings.preserved), true);
  assert.equal(Object.isFrozen(settings.divergences[0]), true);

  const explicit = { ...native.config, sandbox: "read-only", approvalPolicy: "on-request", contextWindow: 480000, reasoningEffort: "xhigh", disableGoals: true };
  const explicitArgs = buildCodexNativeWorkerArguments(explicit, { mode: "delegate", model: "gpt-5.6-sol", workspace });
  assert.equal(explicitArgs[explicitArgs.indexOf("--sandbox") + 1], "read-only");
  assert.ok(explicitArgs.includes('approval_policy="on-request"'));
  assert.ok(explicitArgs.includes("model_context_window=480000"));
  assert.ok(explicitArgs.includes('model_reasoning_effort="xhigh"'));
  assert.ok(explicitArgs.includes("goals"));
});

test("Codex Native Worker parses only the exact usage-limit class and reset timestamp", () => {
  assert.deepEqual(parseCodexNativeUsageLimit("You've hit your usage limit. Try again at 2026-08-18T12:34:56Z."), {
    message: "You've hit your usage limit. Try again at 2026-08-18T12:34:56Z.",
    resetAt: "2026-08-18T12:34:56.000Z",
  });
  assert.equal(parseCodexNativeUsageLimit("HTTP 429 rate limited"), undefined);
  assert.equal(parseCodexNativeUsageLimit("quota exhausted"), undefined);
});

test("Codex one-shot interruption audits never invent resumable handles", async () => {
  const native = new CodexNativeWorkerProvider("openai-codex", {
    adapter: "codex-native-worker",
    model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    capabilities: ["delegate"],
  }, { logger: silentLogger() });
  const audit = await native.auditRecovery({ threadId: "thread-interrupted" });
  assert.equal(audit.status, "one-shot-process-tree-audited");
  assert.equal(audit.resumable, false);
  assert.equal(audit.orphaned, false);
  assert.match(audit.instruction, /existing account and authority gates/i);
  const lifecycle = native.connectionLifecycle({ providerHealth: "interrupted", accountHealth: "unknown", transportHealth: "audit-required" });
  assert.deepEqual(lifecycle.health, { provider: "interrupted", account: "unknown", transport: "audit-required" });
  assert.equal(lifecycle.recovery.parentInterruptionHandleAudit, "required");
  assert.match(lifecycle.digest, /^[0-9a-f]{64}$/);
});

test("Codex native child environment keeps profile isolation and drops bridge/provider credentials", () => {
  const environment = nativeCodexEnvironment("/isolated/codex", {
    PATH: "/bin",
    HOME: "/owner",
    OPENAI_API_KEY: "openai-secret",
    NOUS_API_KEY: "nous-secret",
    THREADSPAN_TOKEN: "bridge-secret",
    GITHUB_TOKEN: "unrelated-token",
    OPENAI_BASE_URL: "https://override.invalid",
  });
  assert.equal(environment.CODEX_HOME, "/isolated/codex");
  assert.equal(environment.PATH, "/bin");
  assert.equal(environment.HOME, "/owner");
  assert.equal(environment.GITHUB_TOKEN, "unrelated-token");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.NOUS_API_KEY, undefined);
  assert.equal(environment.THREADSPAN_TOKEN, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
});

test("Codex Worker parser extracts agent text, usage, and lifecycle identifiers", () => {
  const parsed = parseCodexWorkerJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "turn.started", turn_id: "turn-1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 5 } }),
  ].join("\n"));
  assert.equal(parsed.text, "done");
  assert.equal(parsed.threadId, "thread-1");
  assert.equal(parsed.turnId, "turn-1");
  assert.equal(parsed.completed, true);
  assert.deepEqual(parsed.usage, {
    inputTokens: 7,
    outputTokens: 5,
    totalTokens: 12,
    cachedInputTokens: 3,
    reasoningTokens: 0,
  });
  assert.throws(() => parseCodexWorkerJsonl("{not-json}"), /malformed JSONL/);
});

test("Codex Worker requires explicit workspace, scope, and acceptance contracts", async () => {
  await assert.rejects(async () => {
    for await (const _event of provider().run(request(undefined))) {}
  }, /requires an explicit workspace/);
  await assert.rejects(async () => {
    for await (const _event of provider().run(request("/tmp", { metadata: { bridge_acceptance_commands: [] } }))) {}
  }, /bridge_scope/);
  await assert.rejects(async () => {
    for await (const _event of provider().run(request("/tmp", { metadata: { bridge_scope: ["src/owned.mjs"] } }))) {}
  }, /bridge_acceptance_commands/);
});

test("Codex Worker runs once in a writable linked worktree and returns bounded evidence", { skip: !gitAvailable }, async (t) => {
  const { root, worktree } = await createLinkedWorktree(t);
  const capturePath = join(root, "capture.json");
  process.env.CODEX_WORKER_FIXTURE_CAPTURE = capturePath;
  t.after(() => { delete process.env.CODEX_WORKER_FIXTURE_CAPTURE; });

  const events = [];
  for await (const event of provider().run(request(worktree))) events.push(event);
  const done = events.at(-1);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));

  assert.equal(done.message.content, "worker-ok");
  assert.equal(events.find((event) => event.type === "usage").usage.cachedInputTokens, 8);
  assert.equal(capture.args.filter((arg) => arg === "exec").length, 1);
  assert.equal(capture.args[capture.args.indexOf("--profile") + 1], "threadspan_integrated");
  assert.equal(capture.args[capture.args.indexOf("--model") + 1], route);
  assert.equal(capture.args.at(-1), "-");
  assert.match(capture.prompt, /no integration authority/i);
  assert.match(capture.prompt, /May change: src\/owned\.mjs/);
  assert.match(capture.prompt, /node --test test\/owned\.test\.mjs/);
  assert.match(capture.prompt, /independently reproduce acceptance/i);
  assert.equal(done.providerMetadata.codexWorker.process.exitCode, 0);
  assert.equal(done.providerMetadata.codexWorker.gitBefore.linkedWorktree, true);
  assert.equal(done.providerMetadata.codexWorker.independentAcceptanceRequired, true);
  assert.match(done.providerMetadata.codexWorker.evidence.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.equal(done.providerMetadata.codexWorker.threadId, "thread-fixture");
});

test("Codex Worker rejects a primary checkout", { skip: !gitAvailable }, async (t) => {
  const { repository } = await createLinkedWorktree(t);
  await assert.rejects(async () => {
    for await (const _event of provider().run(request(repository))) {}
  }, /linked Git worktree|denied/);
});

test("Codex Worker times out a process tree without retrying", { skip: !gitAvailable }, async (t) => {
  const { root, worktree } = await createLinkedWorktree(t);
  const counterPath = join(root, "counter.jsonl");
  process.env.CODEX_WORKER_FIXTURE_COUNTER = counterPath;
  process.env.CODEX_WORKER_FIXTURE_HANG = "1";
  t.after(() => {
    delete process.env.CODEX_WORKER_FIXTURE_COUNTER;
    delete process.env.CODEX_WORKER_FIXTURE_HANG;
  });

  await assert.rejects(async () => {
    for await (const _event of provider({ timeoutMs: 500 }).run(request(worktree))) {}
  }, (error) => error.status === 504 && error.retryable === false && error.details?.upstream?.retryPolicy === "no-automatic-retry");
  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n");
  assert.equal(invocations.length, 1);
});

test("Codex Worker surfaces a failed JSONL turn without retrying", { skip: !gitAvailable }, async (t) => {
  const { root, worktree } = await createLinkedWorktree(t);
  const counterPath = join(root, "counter.jsonl");
  process.env.CODEX_WORKER_FIXTURE_COUNTER = counterPath;
  process.env.CODEX_WORKER_FIXTURE_FAIL = "1";
  t.after(() => {
    delete process.env.CODEX_WORKER_FIXTURE_COUNTER;
    delete process.env.CODEX_WORKER_FIXTURE_FAIL;
  });

  await assert.rejects(async () => {
    for await (const _event of provider().run(request(worktree))) {}
  }, (error) => error.retryable === false && /fixture failure/.test(error.message));
  const invocations = (await readFile(counterPath, "utf8")).trim().split("\n");
  assert.equal(invocations.length, 1);
});
