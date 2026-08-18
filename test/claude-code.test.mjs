import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AccountStore } from "../src/core/account-store.mjs";
import { createTestConfig, createWindowsNpmBinShim, nativePath, silentLogger } from "./helpers.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import {
  ClaudeCodeProvider,
  buildClaudeCodeInvocation,
  normalizeClaudeCodeEvent,
  parseClaudeCodeNdjson,
} from "../src/providers/claude-code.mjs";

const fixture = nativePath(new URL("./fixtures/claude-code-cli.mjs", import.meta.url));
const sessionId = "550e8400-e29b-41d4-a716-446655440000";
const emptyMcpConfigPath = join(tmpdir(), "threadspan-empty-mcp.json");

function provider(overrides = {}) {
  return new ClaudeCodeProvider("claude-preview", {
    adapter: "claude-code",
    command: fixture,
    model: "sonnet",
    models: ["sonnet"],
    capabilities: ["consult", "delegate"],
    maxTurnsCeiling: 12,
    consult: { maxTurns: 3, workspaceStrategy: "snapshot" },
    delegate: { maxTurns: 5, requireGit: false, permissionMode: "acceptEdits" },
    ...overrides,
  }, { logger: silentLogger() });
}

async function collect(iterable) {
  const output = [];
  for await (const event of iterable) output.push(event);
  return output;
}

test("Claude Code invocation preserves Linux and Windows argv without a shell", () => {
  const common = {
    command: "claude",
    model: "claude-sonnet-5",
    mode: "consult",
    sessionId,
    resume: false,
    maxTurns: 3,
    permissionMode: "plan",
    tools: ["Read", "Glob", "Grep"],
    workspace: process.cwd(),
    environment: { PATH: "/bin", ANTHROPIC_API_KEY: "must-not-forward" },
    mcpConfigPath: emptyMcpConfigPath,
  };
  const linux = buildClaudeCodeInvocation({ ...common, platform: "linux" });
  const windows = buildClaudeCodeInvocation({ ...common, platform: "win32", command: "C:\\Tools\\claude.exe", environment: { Path: "C:\\Windows" } });

  for (const invocation of [linux, windows]) {
    assert.equal(invocation.shell, false);
    assert.deepEqual(invocation.args.slice(0, 5), ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "claude-sonnet-5");
    assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "plan");
    assert.equal(invocation.args[invocation.args.indexOf("--session-id") + 1], sessionId);
    assert.ok(invocation.args.includes("--bare"));
    assert.ok(invocation.args.includes("--safe-mode"));
    assert.ok(invocation.args.includes("--strict-mcp-config"));
    assert.equal(invocation.args[invocation.args.indexOf("--mcp-config") + 1], emptyMcpConfigPath);
    assert.ok(invocation.args.includes("--disable-slash-commands"));
    assert.ok(invocation.args.includes("--no-chrome"));
    assert.equal(invocation.args.some((value) => /dangerously-skip-permissions|plugin-dir|--continue|--cloud/.test(value)), false);
    assert.equal(invocation.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(invocation.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(invocation.env.ANTHROPIC_MODEL, undefined);
  }
  assert.equal(windows.command, "C:\\Tools\\claude.exe");
});

test("Claude Code Delegate stays finite and never permits bypassPermissions", () => {
  const invocation = buildClaudeCodeInvocation({
    command: "claude",
    model: "opus",
    mode: "delegate",
    sessionId,
    resume: true,
    maxTurns: 7,
    permissionMode: "acceptEdits",
    tools: ["Read", "Edit", "Write"],
    allowedTools: ["Read", "Edit", "Write"],
    workspace: process.cwd(),
    mcpConfigPath: emptyMcpConfigPath,
  });
  assert.equal(invocation.args[invocation.args.indexOf("--resume") + 1], sessionId);
  assert.equal(invocation.args[invocation.args.indexOf("--max-turns") + 1], "7");
  assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.throws(() => buildClaudeCodeInvocation({
    command: "claude", model: "opus", mode: "delegate", sessionId, maxTurns: 1,
    permissionMode: "bypassPermissions", tools: ["Read"], workspace: process.cwd(), mcpConfigPath: emptyMcpConfigPath,
  }), /must not bypass/);
});

test("Claude Code config rejects Integrated, credential fields, and unbounded permission shortcuts", () => {
  const configured = {
    adapter: "claude-code",
    command: fixture,
    model: "sonnet",
    models: ["sonnet"],
    capabilities: ["consult", "delegate"],
    maxTurnsCeiling: 12,
    consult: { maxTurns: 3, workspaceStrategy: "snapshot" },
    delegate: { maxTurns: 6, permissionMode: "acceptEdits" },
  };
  assert.equal(createTestConfig({ defaults: { provider: "claude", mode: "consult", model: "sonnet" }, providers: { claude: configured } }).providers.claude.adapter, "claude-code");
  assert.throws(() => createTestConfig({ defaults: { provider: "claude", mode: "integrated", model: "sonnet" }, providers: { claude: { ...configured, capabilities: ["integrated"] } } }), /cannot enable Integrated/);
  assert.throws(() => createTestConfig({ defaults: { provider: "claude", mode: "consult", model: "sonnet" }, providers: { claude: { ...configured, apiKeyEnv: "ANTHROPIC_API_KEY" } } }), /apiKeyEnv is forbidden/);
  assert.throws(() => createTestConfig({ defaults: { provider: "claude", mode: "delegate", model: "sonnet" }, providers: { claude: { ...configured, delegate: { maxTurns: 6, permissionMode: "bypassPermissions" } } } }), /cannot bypass/);
});

test("AgentRouter gateway validation and child environment fail closed without leaking ambient Anthropic settings", () => {
  const gateway = { baseUrl: "https://agentrouter.org", apiKeyEnv: "AGENTROUTER_API_KEY", model: "claude-opus-4-8", provider: "agentrouter" };
  const configured = {
    adapter: "claude-code", command: fixture, model: "claude-opus-4-8", models: ["claude-opus-4-8"],
    capabilities: ["consult", "delegate"], gateway,
  };
  const normalized = createTestConfig({
    defaults: { provider: "agentrouter", mode: "consult", model: "claude-opus-4-8" },
    providers: { agentrouter: configured },
  });
  assert.deepEqual(normalized.providers.agentrouter.gateway, gateway);
  const gatewayProvider = provider({ model: "claude-opus-4-8", models: ["claude-opus-4-8"], gateway });
  assert.equal(gatewayProvider.capabilities().status, "live-verified-route");
  assert.equal(gatewayProvider.capabilities().liveTested, true);
  assert.deepEqual(gatewayProvider.capabilities().liveEvidence.hosts, ["linux", "windows"]);
  assert.equal(provider().capabilities().status, "preview");
  assert.equal(provider().capabilities().liveTested, false);
  for (const invalid of [
    { ...gateway, baseUrl: "http://agentrouter.org" },
    { ...gateway, baseUrl: "https://user:secret@agentrouter.example.test" },
    { ...gateway, apiKeyEnv: "NOT VALID" },
    { ...gateway, model: "other-model" },
    { ...gateway, secret: "forbidden" },
  ]) {
    assert.throws(() => createTestConfig({
      defaults: { provider: "agentrouter", mode: "consult", model: "claude-opus-4-8" },
      providers: { agentrouter: { ...configured, gateway: invalid } },
    }), /gateway/);
  }

  const common = {
    command: "claude", model: "claude-opus-4-8", mode: "consult", sessionId,
    resume: false, maxTurns: 1, permissionMode: "plan", tools: ["Read"], workspace: process.cwd(), gateway,
    mcpConfigPath: emptyMcpConfigPath,
  };
  assert.throws(() => buildClaudeCodeInvocation({
    ...common,
    environment: { PATH: "/bin", ANTHROPIC_API_KEY: "ambient", ANTHROPIC_AUTH_TOKEN: "ambient", ANTHROPIC_BASE_URL: "https://ambient.invalid", ANTHROPIC_MODEL: "ambient" },
  }), /AGENTROUTER_API_KEY.*not set/);
  const invocation = buildClaudeCodeInvocation({
    ...common,
    environment: {
      PATH: "/bin", AGENTROUTER_API_KEY: "capped-test-token", ANTHROPIC_API_KEY: "ambient",
      ANTHROPIC_AUTH_TOKEN: "ambient", ANTHROPIC_BASE_URL: "https://ambient.invalid", ANTHROPIC_MODEL: "ambient",
    },
  });
  assert.equal(invocation.shell, false);
  assert.equal(invocation.env.ANTHROPIC_API_KEY, "capped-test-token");
  assert.equal(invocation.env.ANTHROPIC_AUTH_TOKEN, "capped-test-token");
  assert.equal(invocation.env.ANTHROPIC_BASE_URL, "https://agentrouter.org");
  assert.equal(invocation.env.ANTHROPIC_MODEL, "claude-opus-4-8");
  assert.equal(JSON.stringify({ args: invocation.args, cwd: invocation.cwd, command: invocation.command }), JSON.stringify({ args: invocation.args, cwd: invocation.cwd, command: invocation.command }));
  assert.doesNotMatch(JSON.stringify({ args: invocation.args, cwd: invocation.cwd, command: invocation.command }), /capped-test-token|ambient/);
});

test("AgentRouter gateway redacts its exact token from Claude output metadata", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-agentrouter-redaction-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const previous = process.env.AGENTROUTER_TEST_KEY;
  process.env.AGENTROUTER_TEST_KEY = "synthetic-gateway-secret";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTROUTER_TEST_KEY;
    else process.env.AGENTROUTER_TEST_KEY = previous;
  });
  const adapter = provider({
    model: "claude-opus-4-8",
    models: ["claude-opus-4-8"],
    gateway: { baseUrl: "https://agentrouter.org", apiKeyEnv: "AGENTROUTER_TEST_KEY", model: "claude-opus-4-8", provider: "agentrouter" },
  });
  const events = await collect(adapter.run({
    mode: "delegate",
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "Return bounded fixture output" }],
    threadId: "agentrouter-redaction",
    workspace,
    metadata: { bridge_scope: { allowed: ["."] } },
  }));
  assert.doesNotMatch(JSON.stringify(events), /synthetic-gateway-secret/);
  assert.match(JSON.stringify(events), /\[REDACTED\]/);
});

test("stream-json parser handles split NDJSON and preserves unknown fields and raw lines", async () => {
  const first = '{"type":"future","unknown":{"nested":[1,2]},"text":"caf';
  const second = '\u00e9"}\r\n';
  const frames = await collect(parseClaudeCodeNdjson(Readable.from([Buffer.from(first), Buffer.from(second)])));
  assert.deepEqual(frames[0].raw.unknown, { nested: [1, 2] });
  assert.equal(frames[0].raw.text, "caf\u00e9");
  assert.equal(frames[0].rawLine, `${first}${second.slice(0, -1)}`);
  const normalized = normalizeClaudeCodeEvent(frames[0].raw);
  assert.deepEqual(normalized[0].providerMetadata.claudeCode.rawEvent.unknown, { nested: [1, 2] });
});

test("fake Claude CLI binds a session, resumes it, isolates the profile, and preserves terminal fields", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-claude-delegate-"));
  const profile = await mkdtemp(join(tmpdir(), "threadspan-claude-profile-"));
  t.after(() => Promise.all([rm(workspace, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })]));
  const adapter = provider({
    __threadspanClaudeConfigDir: profile,
    command: await createWindowsNpmBinShim(t, fixture, "claude"),
  });
  const request = {
    mode: "delegate",
    model: "sonnet",
    messages: [{ role: "user", content: "Do the bounded task" }],
    threadId: "thread-one",
    accountId: "account-one",
    workspace,
    metadata: {
      bridge_scope: { allowed: ["src"], denied: ["secrets"], nonGoals: ["release"] },
      bridge_acceptance_commands: ["npm test"],
      bridge_max_turns: "4",
    },
  };

  const first = await collect(adapter.run(request));
  const second = await collect(adapter.run({
    ...request,
    messages: [...request.messages, { role: "user", content: "Follow-up only" }],
  }));
  const invocations = (await readFile(join(workspace, ".fake-claude-invocations.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations[0].sessionFlag, "--session-id");
  assert.equal(invocations[1].sessionFlag, "--resume");
  assert.equal(invocations[1].sessionId, invocations[0].sessionId);
  assert.equal(invocations[0].claudeConfigDir, profile);
  assert.equal(invocations[0].anthropicApiKeyVisible, false);
  assert.equal(invocations[0].args[invocations[0].args.indexOf("--max-turns") + 1], "4");
  assert.match(invocations[0].prompt, /May change: src/);
  assert.match(invocations[0].prompt, /Must not change: secrets/);
  assert.match(invocations[0].prompt, /1\. npm test/);
  assert.doesNotMatch(invocations[1].prompt, /Do the bounded task/);
  assert.match(invocations[1].prompt, /Follow-up only/);
  assert.equal(first.filter((event) => event.type === "text-delta").map((event) => event.delta).join(""), "fake answer");
  const terminal = second.find((event) => event.type === "done");
  assert.deepEqual(terminal.providerMetadata.claudeCode.rawResult.future_result_field, { nested: "preserved" });
  assert.equal(terminal.providerMetadata.claudeCode.costIsQuotaEvidence, false);
  assert.equal(adapter.runtimeStats().liveTested, false);
});

test("Claude profile isolation is accepted only through a canonical CLAUDE_CONFIG_DIR reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-claude-account-"));
  const profile = await mkdtemp(join(tmpdir(), "threadspan-claude-account-profile-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })]));
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const account = await store.create({ providerId: "claude", label: "Isolated", authKind: "cli-login", profileRef: "claude-isolated" });
  const config = createTestConfig({
    accounts: { path: store.path, profileSources: { "claude-isolated": { kind: "claude-config-dir", root: profile } }, fallback: { enabled: false, maxCandidates: 3 } },
    defaults: { provider: "claude", mode: "consult", model: "sonnet" },
    providers: { claude: { adapter: "claude-code", command: fixture, model: "sonnet", models: ["sonnet"], capabilities: ["consult", "delegate"] } },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), accountStore: store });
  const isolated = registry.get("claude", account.id);
  assert.equal(isolated.config.__threadspanClaudeConfigDir, profile);
  assert.equal(isolated.accountBinding().isolated, true);
  assert.throws(() => createTestConfig({
    defaults: { provider: "claude", mode: "consult", model: "sonnet" },
    providers: { claude: { adapter: "claude-code", command: fixture, model: "sonnet", capabilities: ["consult"], claudeConfigDir: profile } },
  }), /claudeConfigDir is forbidden/);
});

test("Consult runs the fake CLI only in a disposable snapshot", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-claude-consult-source-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, "snapshot-input.txt"), "explicit workspace content");
  const adapter = provider({ command: await createWindowsNpmBinShim(t, fixture, "claude") });
  const events = await collect(adapter.run({
    mode: "consult",
    model: "sonnet",
    messages: [{ role: "user", content: "Inspect only" }],
    threadId: "consult-thread",
    workspace,
  }));
  assert.equal(events.find((event) => event.type === "done").message.content, "fake answer");
  await assert.rejects(readFile(join(workspace, ".fake-claude-invocations.jsonl"), "utf8"), /ENOENT/);
  await assert.rejects(collect(provider({ consult: { maxTurns: 3, workspaceStrategy: "snapshot", snapshotMaxBytes: 1 } }).run({
    mode: "consult",
    model: "sonnet",
    messages: [{ role: "user", content: "Bound the explicit snapshot" }],
    threadId: "consult-explicit-bounded",
    workspace,
  })), /Consult snapshot exceeds maxBytes \(1\)/);
});

test("bridge Consult without an explicit workspace uses a fresh empty disposable workspace instead of synthesized cwd", async (t) => {
  const synthesizedCwd = await mkdtemp(join(tmpdir(), "threadspan-claude-synthesized-cwd-"));
  t.after(() => rm(synthesizedCwd, { recursive: true, force: true }));
  await writeFile(join(synthesizedCwd, "must-not-be-snapshotted.txt"), "larger than one byte");
  const adapter = provider({
    command: await createWindowsNpmBinShim(t, fixture, "claude"),
    consult: { maxTurns: 3, workspaceStrategy: "snapshot", snapshotMaxBytes: 1 },
  });
  const events = await collect(adapter.run({
    mode: "consult",
    model: "sonnet",
    messages: [{ role: "user", content: "No repository context was authorized" }],
    threadId: "consult-no-explicit-workspace",
    workspace: synthesizedCwd,
    metadata: {
      bridge_mode: "consult",
      bridge_provider: "agentrouter-claude",
      bridge_thread_id: "consult-no-explicit-workspace",
    },
  }));
  assert.equal(events.find((event) => event.type === "done").message.content, "fake answer");
  await assert.rejects(readFile(join(synthesizedCwd, ".fake-claude-invocations.jsonl"), "utf8"), /ENOENT/);
});

test("missing Claude binary fails closed without an install or provider fallback", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-claude-missing-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const adapter = provider({ command: join(workspace, "missing-claude") });
  await assert.rejects(collect(adapter.run({
    mode: "delegate",
    model: "sonnet",
    messages: [{ role: "user", content: "No call" }],
    threadId: "missing-thread",
    workspace,
    metadata: { bridge_scope: { allowed: ["."] } },
  })), /Could not start or monitor Claude Code command/);
});

test("Delegate rejects missing or escaping scope before starting Claude", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-claude-scope-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const request = { mode: "delegate", model: "sonnet", messages: [{ role: "user", content: "No scope" }], threadId: "scope-thread", workspace };
  await assert.rejects(collect(provider().run(request)), /requires non-empty metadata\.bridge_scope/);
  await assert.rejects(collect(provider().run({ ...request, metadata: { bridge_scope: { allowed: ["../escape"] } } })), /escapes its workspace/);
});

test("an already-cancelled queued turn fails without leaving the event stream open", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before start"));
  await assert.rejects(collect(provider().run({
    mode: "consult",
    model: "sonnet",
    messages: [{ role: "user", content: "Do not start" }],
    threadId: "cancelled-thread",
    signal: controller.signal,
  })), /cancelled before start/);
});
