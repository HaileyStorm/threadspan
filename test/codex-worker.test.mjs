import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildCodexWorkerArguments,
  CodexWorkerProvider,
  parseCodexWorkerJsonl,
} from "../src/providers/codex-worker.mjs";
import { silentLogger } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const fixture = new URL("./fixtures/codex-worker.mjs", import.meta.url).pathname;
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
});

test("Codex Worker argv selects a shared-daemon profile and Integrated route without a shell prompt", () => {
  const injectedRoute = "integrated/nous/deepseek/model;touch-should-not-run";
  const args = buildCodexWorkerArguments({ profile: "threadspan_integrated" }, {
    mode: "delegate",
    model: injectedRoute,
    workspace: "/tmp/linked worker",
    metadata: {},
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "--json", "--ephemeral"]);
  assert.equal(args[args.indexOf("--profile") + 1], "threadspan_integrated");
  assert.equal(args[args.indexOf("--model") + 1], injectedRoute);
  assert.equal(args[args.indexOf("--cd") + 1], "/tmp/linked worker");
  assert.ok(args.includes("model_providers.threadspan_bridge.request_max_retries=0"));
  assert.ok(args.includes("model_providers.threadspan_bridge.stream_max_retries=0"));
  assert.ok(args.includes('approval_policy="never"'));
  assert.equal(args.includes("--ask-for-approval"), false);
  assert.equal(args.at(-1), "-");
  assert.equal(args.some((arg) => arg.includes("Implement the bounded change")), false);
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
