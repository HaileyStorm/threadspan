import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { AccountStore } from "../src/core/account-store.mjs";
import { ProviderError } from "../src/core/errors.mjs";
import { forecastRecentBurn, normalizeUsageEvent } from "../src/core/usage-ledger.mjs";
import { BridgeService } from "../src/bridge/service.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const gitAvailable = await execFileAsync("git", ["--version"]).then(() => true, () => false);

async function createLinkedWorktree(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  await execFileAsync("git", ["worktree", "add", "-b", "native-worker", worktree], { cwd: repository });
  return { root, repository, worktree };
}

test("explicit and smart routes bind opaque accounts and isolate Codex child CODEX_HOME without touching default login", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-codex-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "accounts.json");
  const defaultHome = join(root, "default-codex");
  const alternateHome = join(root, "alternate-codex");
  const defaultAlias = join(root, "default-codex-alias");
  const alternateAlias = join(root, "alternate-codex-alias");
  const authPath = join(defaultHome, "auth.json");
  await writeFile(join(root, "probe.mjs"), 'process.stdout.write(JSON.stringify({codexHome:process.env.CODEX_HOME,marker:process.env.THREADSPAN_ACCOUNT_TEST_MARKER}))');
  await mkdir(defaultHome, { recursive: true });
  await mkdir(alternateHome, { recursive: true });
  await symlink(defaultHome, defaultAlias, process.platform === "win32" ? "junction" : "dir");
  await symlink(alternateHome, alternateAlias, process.platform === "win32" ? "junction" : "dir");
  await writeFile(authPath, Buffer.from([0, 1, 2, 3, 255]));
  const previousHome = process.env.CODEX_HOME;
  const previousMarker = process.env.THREADSPAN_ACCOUNT_TEST_MARKER;
  process.env.CODEX_HOME = defaultHome;
  process.env.THREADSPAN_ACCOUNT_TEST_MARKER = "parent-preserved";
  t.after(() => { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; if (previousMarker === undefined) delete process.env.THREADSPAN_ACCOUNT_TEST_MARKER; else process.env.THREADSPAN_ACCOUNT_TEST_MARKER = previousMarker; });
  const envBefore = Object.fromEntries(Object.entries(process.env));
  const authBefore = await readFile(authPath);
  const store = new AccountStore({ path: statePath });
  const account = await store.create({ providerId: "codex", label: "OAuth alt", authKind: "cli-login", profileRef: "codex-alt" });
  await store.select(account.id);
  assert.throws(() => createTestConfig({ accounts: { path: statePath, profileSources: { unsafe: { kind: "codex-home", root: defaultHome } }, fallback: { enabled: false, maxCandidates: 3 } } }), /must not target the current\/default Codex profile root/);
  assert.throws(() => createTestConfig({ accounts: { path: statePath, profileSources: { unsafe: { kind: "codex-home", root: defaultAlias } }, fallback: { enabled: false, maxCandidates: 3 } } }), /must not target the current\/default Codex profile root/);
  assert.throws(() => createTestConfig({ accounts: { path: statePath, profileSources: { relative: { kind: "codex-home", root: "alternate-codex" } }, fallback: { enabled: false, maxCandidates: 3 } } }), /must be an absolute path/);
  assert.throws(() => createTestConfig({ accounts: { path: statePath, profileSources: { first: { kind: "codex-home", root: alternateHome }, second: { kind: "codex-home", root: alternateAlias } }, fallback: { enabled: false, maxCandidates: 3 } } }), /duplicates profile root/);
  if (process.platform === "win32") {
    assert.throws(() => createTestConfig({ accounts: { path: statePath, profileSources: { unsafe: { kind: "codex-home", root: defaultHome.toUpperCase() } }, fallback: { enabled: false, maxCandidates: 3 } } }), /must not target the current\/default Codex profile root/);
  }
  const config = createTestConfig({
    accounts: { path: statePath, profileSources: { "codex-alt": { kind: "codex-home", root: alternateAlias } }, fallback: { enabled: false, maxCandidates: 3 } },
    defaults: { provider: "codex", mode: "delegate", model: "integrated/mock/model" },
    providers: { mock: { enabled: false, adapter: "mock", model: "m", capabilities: ["consult"] }, codex: { adapter: "codex-worker", command: process.execPath, commandArgs: [join(root, "probe.mjs")], model: "integrated/mock/model", capabilities: ["delegate"] } },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), accountStore: store });
  const explicit = registry.resolveRoute({ model: `delegate/codex/@${account.id}/integrated/mock/model` });
  const smart = registry.resolveRoute({ providerId: "threadspan", mode: "delegate", accountId: account.id, model: "integrated/mock/model" });
  const canonicalAlternateHome = await realpath(alternateHome);
  assert.equal(config.accounts.profileSources["codex-alt"].root, canonicalAlternateHome);
  assert.equal(explicit.accountId, account.id);
  assert.equal(smart.providerId, "codex");
  const spawned = spawnSync(explicit.provider.config.command, explicit.provider.config.commandArgs, { encoding: "utf8", env: process.env });
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.deepEqual(JSON.parse(spawned.stdout), { codexHome: canonicalAlternateHome, marker: "parent-preserved" });
  assert.deepEqual(Object.fromEntries(Object.entries(process.env)), envBefore);
  assert.deepEqual(await readFile(authPath), authBefore);
  await registry.close();
});

test("native Codex usage limit falls through one isolated account while invalid alternates and unsafe failures do not", { skip: !gitAvailable }, async (t) => {
  const { root, worktree } = await createLinkedWorktree(t, "threadspan-native-account-routing-");
  const firstHome = join(root, "codex-first");
  const invalidHome = join(root, "codex-invalid");
  const secondHome = join(root, "codex-second");
  const thirdHome = join(root, "codex-third");
  const capturePath = join(root, "native-calls.jsonl");
  const fixturePath = join(root, "native-codex-fixture.mjs");
  await Promise.all([firstHome, invalidHome, secondHome, thirdHome].map((path) => mkdir(path, { recursive: true })));
  await writeFile(join(firstHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(secondHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(join(thirdHome, "auth.json"), "{}\n", { mode: 0o600 });
  await writeFile(fixturePath, [
    'import { appendFile } from "node:fs/promises";',
    'const args = process.argv.slice(2);',
    'await appendFile(process.env.NATIVE_CAPTURE_PATH, JSON.stringify({ codexHome: process.env.CODEX_HOME, args }) + "\\n");',
    'const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");',
    'if ((process.env.NATIVE_LIMIT_HOME || "").split("|").includes(process.env.CODEX_HOME)) {',
    '  if (process.env.NATIVE_SCENARIO === "output") {',
    '    emit({ type: "item.completed", item: { type: "agent_message", text: "partial" } });',
    '    emit({ type: "error", error: { code: "usage_limit_exceeded", message: "You\'ve hit your usage limit. Try again at 2026-08-18T12:34:56Z." } });',
    '  } else if (process.env.NATIVE_SCENARIO === "tool") {',
    '    emit({ type: "item.completed", item: { type: "command_execution", command: "true", status: "completed" } });',
    '    emit({ type: "error", error: { code: "usage_limit_exceeded", message: "You\'ve hit your usage limit. Try again at 2026-08-18T12:34:56Z." } });',
    '  } else if (process.env.NATIVE_SCENARIO === "non-limit") {',
    '    process.stderr.write("provider transport failed\\n");',
    '  } else {',
    '    process.stderr.write("You\'ve hit your usage limit. Try again at 2026-08-18T12:34:56Z.\\n");',
    '  }',
    '  process.exit(7);',
    '}',
    'emit({ type: "thread.started", thread_id: "thread-native" });',
    'emit({ type: "item.completed", item: { type: "agent_message", text: "native-ok" } });',
    'emit({ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });',
  ].join("\n"), "utf8");

  const previous = {
    capture: process.env.NATIVE_CAPTURE_PATH,
    limitHome: process.env.NATIVE_LIMIT_HOME,
    scenario: process.env.NATIVE_SCENARIO,
  };
  process.env.NATIVE_CAPTURE_PATH = capturePath;
  process.env.NATIVE_LIMIT_HOME = firstHome;
  delete process.env.NATIVE_SCENARIO;
  t.after(() => {
    if (previous.capture === undefined) delete process.env.NATIVE_CAPTURE_PATH; else process.env.NATIVE_CAPTURE_PATH = previous.capture;
    if (previous.limitHome === undefined) delete process.env.NATIVE_LIMIT_HOME; else process.env.NATIVE_LIMIT_HOME = previous.limitHome;
    if (previous.scenario === undefined) delete process.env.NATIVE_SCENARIO; else process.env.NATIVE_SCENARIO = previous.scenario;
  });

  const store = new AccountStore({ path: join(root, "accounts.json") });
  const first = await store.create({ providerId: "openai-codex", label: "Primary", authKind: "cli-login", profileRef: "codex-first" });
  const invalid = await store.create({ providerId: "openai-codex", label: "Invalid alternate", authKind: "cli-login", profileRef: "codex-invalid" });
  const second = await store.create({ providerId: "openai-codex", label: "Secondary", authKind: "cli-login", profileRef: "codex-second" });
  await store.create({ providerId: "openai-codex", label: "Tertiary", authKind: "cli-login", profileRef: "codex-third" });
  const quotaObservations = [];
  store.observeQuota = async (...args) => { quotaObservations.push(args); };
  const config = createTestConfig({
    accounts: {
      path: store.path,
      profileSources: {
        "codex-first": { kind: "codex-home", root: firstHome },
        "codex-invalid": { kind: "codex-home", root: invalidHome },
        "codex-second": { kind: "codex-home", root: secondHome },
        "codex-third": { kind: "codex-home", root: thirdHome },
      },
      fallback: { enabled: true, maxCandidates: 3 },
    },
    defaults: { provider: "openai-codex", mode: "delegate", model: "gpt-5.6-sol" },
    providers: {
      mock: { enabled: false, adapter: "mock", model: "m", capabilities: ["consult"] },
      "openai-codex": {
        adapter: "codex-native-worker",
        command: process.execPath,
        commandArgs: [fixturePath],
        model: "gpt-5.6-sol",
        models: ["gpt-5.6-sol"],
        contextWindow: 480000,
        reasoningEffort: "high",
        capabilities: ["delegate"],
        sandbox: "workspace-write",
        approvalPolicy: "never",
        disableGoals: true,
        delegate: { requireCleanStart: true, denyBranches: ["main", "master", "trunk"] },
      },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), accountStore: store });
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: store });
  t.after(() => service.close());
  await store.select(invalid.id);
  assert.throws(() => registry.resolveRoute({ providerId: "openai-codex", mode: "delegate", model: "gpt-5.6-sol" }), /existing provider-native Codex authentication/);
  await store.select(first.id);
  const request = () => ({
    model: "delegate/openai-codex/gpt-5.6-sol",
    input: "bounded native task",
    metadata: {
      bridge_workspace: worktree,
      bridge_scope: ["base.txt"],
      bridge_acceptance_commands: [],
      bridge_account_fallback: true,
    },
  });

  const response = await service.executeResponse(request());
  assert.equal(response.output_text, "native-ok");
  assert.equal(response.metadata.bridge_account_id, second.id);
  const calls = (await readFile(capturePath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls.map((call) => call.codexHome), [await realpath(firstHome), await realpath(secondHome)]);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.equal(call.args.includes("--ignore-user-config"), false);
    assert.equal(call.args.includes("--profile"), false);
    assert.equal(call.args.some((arg) => arg.includes("threadspan_integrated") || arg.includes("threadspan_bridge") || arg.startsWith("integrated/") || /base_url/i.test(arg)), false);
  }
  assert.deepEqual(quotaObservations, [[first.id, {
    remaining: 0,
    resetAt: "2026-08-18T12:34:56.000Z",
    renewalAt: null,
    charge: null,
    source: "codex-cli-usage-limit",
    observedAt: quotaObservations[0][1].observedAt,
  }]]);
  assert.ok(Number.isFinite(Date.parse(quotaObservations[0][1].observedAt)));
  await writeFile(capturePath, "", "utf8");
  process.env.NATIVE_LIMIT_HOME = `${firstHome}|${secondHome}`;
  await assert.rejects(service.executeResponse(request()), /usage limit/);
  const cappedCalls = (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.deepEqual(cappedCalls.map((call) => call.codexHome), [await realpath(firstHome), await realpath(secondHome)]);
  process.env.NATIVE_LIMIT_HOME = firstHome;
  const accounts = await registry.describeAccounts();
  assert.equal(accounts.accounts.find((account) => account.id === invalid.id).health.status, "unavailable");

  for (const scenario of ["output", "tool", "non-limit"]) {
    process.env.NATIVE_SCENARIO = scenario;
    await writeFile(capturePath, "", "utf8");
    await assert.rejects(service.executeResponse(request()));
    const blockedCalls = (await readFile(capturePath, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(blockedCalls.map((call) => call.codexHome), [await realpath(firstHome)], `${scenario} must not fall through to another account`);
  }
});

test("opt-in account fallback is same-route, pre-output only, and ledger-linked exactly once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstKeyPath = join(root, "first.key");
  const secondKeyPath = join(root, "second.key");
  const thirdKeyPath = join(root, "third.key");
  await writeFile(firstKeyPath, "key-one\n", { mode: 0o600 });
  await writeFile(secondKeyPath, "key-two\n", { mode: 0o600 });
  await writeFile(thirdKeyPath, "key-three\n", { mode: 0o600 });

  const calls = [];
  let scenario = "fallback";
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request body */ }
    const authorization = request.headers.authorization;
    calls.push(authorization);
    if (scenario === "chain" && ["Bearer key-one", "Bearer key-two"].includes(authorization)) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "rate limited in chain" } }));
      return;
    }
    if (authorization === "Bearer key-one") {
      if (scenario === "fallback") {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limited" } }));
        return;
      }
      if (scenario === "auth") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "invalid key" } }));
        return;
      }
      if (scenario === "server") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "temporarily unavailable" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (scenario === "partial") {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`);
      } else if (scenario === "usage") {
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } })}\n\n`);
      } else if (scenario === "tool") {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write", arguments: "{}" } }] } }] })}\n\n`);
      }
      response.end(`data: ${JSON.stringify({ error: { message: "stream failed" } })}\n\n`);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const store = new AccountStore({ path: join(root, "accounts.json") });
  const first = await store.create({ providerId: "api", label: "One", authKind: "secret-file-ref", authSourceRef: "first" });
  const second = await store.create({ providerId: "api", label: "Two", authKind: "secret-file-ref", authSourceRef: "second" });
  const third = await store.create({ providerId: "api", label: "Three", authKind: "secret-file-ref", authSourceRef: "third" });
  await store.select(first.id);
  const events = [];
  const ledger = { append: async (event) => { events.push(event); }, summarize: async () => ({ weekly: {}, providers: {}, accounts: {}, recentEvents: [] }), flush: async () => {} };
  const config = createTestConfig({
    accounts: { path: store.path, profileSources: {}, fallback: { enabled: true, maxCandidates: 3 } },
    defaults: { provider: "api", mode: "consult", model: "m" },
    providers: {
      mock: { enabled: false, adapter: "mock", model: "m", capabilities: ["consult"] },
      api: {
        adapter: "openai-chat",
        baseUrl,
        model: "m",
        capabilities: ["consult"],
        retryWithoutStreaming: true,
        headers: { Authorization: "Bearer shared-config-key" },
        accountSources: {
          first: { kind: "secret-file", path: firstKeyPath },
          second: { kind: "secret-file", path: secondKeyPath },
          third: { kind: "secret-file", path: thirdKeyPath },
        },
      },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), usageLedger: ledger, accountStore: store });
  const firstRoute = registry.resolveRoute({ providerId: "api", accountId: first.id, mode: "consult", model: "m" });
  const secondRoute = registry.resolveRoute({ providerId: "api", accountId: second.id, mode: "consult", model: "m" });
  assert.notEqual(firstRoute.provider, secondRoute.provider, "account-scoped adapters keep retained pools and credentials isolated");
  const catalogIds = (await registry.listRoutedModels()).map((item) => item.id);
  assert.ok(catalogIds.includes(`consult/api/@${first.id}/m`));
  assert.ok(catalogIds.includes(`consult/api/@${second.id}/m`));
  assert.ok(catalogIds.includes(`consult/api/@${third.id}/m`));
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: store, usageLedger: ledger });
  await assert.rejects(service.executeResponse({ model: "consult/api/m", input: "hi" }), /HTTP 429/);
  assert.deepEqual(calls, ["Bearer key-one"], "default policy must not fail over accounts");
  calls.length = 0;
  events.length = 0;
  const response = await service.executeResponse({ model: "consult/api/m", input: "hi", metadata: { bridge_account_fallback: true } });
  assert.equal(response.output_text, "ok");
  assert.equal(response.metadata.bridge_account_id, second.id);
  assert.deepEqual(calls, ["Bearer key-one", "Bearer key-two"], "each account must be attempted exactly once");
  assert.equal(events.length, 2);
  assert.equal(events[0].attemptGroupId, events[1].attemptGroupId);
  assert.deepEqual(events.map((event) => event.attemptOrdinal), [1, 2]);
  assert.deepEqual(events.map((event) => event.accountId), [first.id, second.id]);
  const forecast = forecastRecentBurn(events.map((event, index) => normalizeUsageEvent({ ...event, timestamp: `2026-08-17T12:00:0${index}Z` })), { now: "2026-08-17T12:00:02Z" });
  assert.deepEqual(forecast.accounts.map((item) => item.scope.accountId).sort(), [first.id, second.id].sort(), "fallback attempts remain attributed to the account actually attempted");
  assert.equal(forecast.combined.length, 2, "separate account attempts must not imply a shared quota pool");
  const telemetry = await registry.describeAccounts();
  assert.equal(telemetry.accounts.find((item) => item.id === first.id).health.status, "unavailable");
  assert.equal(telemetry.accounts.find((item) => item.id === second.id).health.status, "available");

  calls.length = 0;
  events.length = 0;
  const streamed = [];
  const streamedResponse = await service.executeResponse({ model: "consult/api/m", input: "stream", stream: true, metadata: { bridge_account_fallback: true } }, { onEvent: (event) => streamed.push(event) });
  assert.equal(streamedResponse.output_text, "ok");
  assert.deepEqual(calls, ["Bearer key-one", "Bearer key-two"]);
  assert.equal(streamed.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "ok");
  assert.equal(streamed.filter((event) => event.type === "response.completed").length, 1);
  assert.doesNotMatch(JSON.stringify(streamed), /rate limited|HTTP 429/i, "discarded pre-output attempt events must not enter the client stream");

  scenario = "chain";
  calls.length = 0;
  events.length = 0;
  await assert.rejects(
    service.executeResponse({ model: "consult/api/m", input: "chain", metadata: { bridge_account_fallback: true } }),
    /HTTP 429/,
  );
  assert.deepEqual(calls, ["Bearer key-one", "Bearer key-two"], "a three-account chain must stop after one alternate");
  assert.deepEqual(events.map((event) => event.accountId), [first.id, second.id]);
  assert.ok(!calls.includes("Bearer key-three"));

  for (const blocked of [
    { scenario: "auth", pattern: /HTTP 401/, status: "failed" },
    { scenario: "server", pattern: /HTTP 503/, status: "failed" },
    { scenario: "partial", pattern: /stream failed/, status: "partial" },
    { scenario: "usage", pattern: /stream failed/, status: "partial" },
    { scenario: "tool", pattern: /stream failed/, status: "partial" },
  ]) {
    scenario = blocked.scenario;
    calls.length = 0;
    events.length = 0;
    await assert.rejects(service.executeResponse({ model: "consult/api/m", input: "hi", metadata: { bridge_account_fallback: true } }), blocked.pattern);
    assert.deepEqual(calls, ["Bearer key-one"], `${blocked.scenario} failure must not retry or fall back`);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, blocked.status);
  }

  await rm(firstKeyPath);
  calls.length = 0;
  events.length = 0;
  await assert.rejects(service.executeResponse({ model: "consult/api/m", input: "hi", metadata: { bridge_account_fallback: true } }), /credential is unavailable/);
  assert.deepEqual(calls, [], "a missing account credential must not fall through to configured shared authorization");
  await service.close();
});

test("every native account fails closed without a validated isolated profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-unisolated-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const first = await store.create({ providerId: "mock", label: "One", authKind: "cli-login" });
  const config = createTestConfig({ accounts: { path: store.path, profileSources: {}, fallback: { enabled: false, maxCandidates: 3 } } });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), accountStore: store });
  assert.throws(() => registry.resolveRoute({ providerId: "mock", accountId: first.id, mode: "consult", model: "m" }), /requires a validated isolated profileRef.*refusing the provider default profile/);
  assert.throws(() => registry.validateAccountDescriptor({ providerId: "mock", label: "Missing", authKind: "cli-login", profileRef: "missing-profile" }), /unavailable profile/);
  await registry.close();
});

test("an uncertified adapter cannot enter the account fallback chain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-uncertified-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const previousOne = process.env.API_ONE;
  const previousTwo = process.env.API_TWO;
  process.env.API_ONE = "one";
  process.env.API_TWO = "two";
  t.after(() => { if (previousOne === undefined) delete process.env.API_ONE; else process.env.API_ONE = previousOne; if (previousTwo === undefined) delete process.env.API_TWO; else process.env.API_TWO = previousTwo; });
  const first = await store.create({ providerId: "api", label: "One", authKind: "api-key-env", authSourceRef: "API_ONE" });
  await store.create({ providerId: "api", label: "Two", authKind: "api-key-env", authSourceRef: "API_TWO" });
  await store.select(first.id);
  const calls = [];
  class UncertifiedApi {
    constructor(id, config) { this.id = id; this.config = config; }
    capabilities() { return { modes: { consult: { supported: true } } }; }
    assertMode() {}
    accountBinding() { return this.config.__threadspanAccount; }
    async *run() {
      calls.push(this.config.apiKeyEnv);
      throw new ProviderError(this.id, "claimed safe failure", { retryable: true, details: { httpStatus: 429, safeToFallbackBeforeOutput: true } });
    }
    async close() {}
  }
  const config = createTestConfig({
    accounts: { path: store.path, profileSources: {}, fallback: { enabled: true, maxCandidates: 3 } },
    defaults: { provider: "api", mode: "consult", model: "m" },
    providers: { mock: { enabled: false, adapter: "mock" }, api: { adapter: "openai-chat", baseUrl: "https://example.test", model: "m", capabilities: ["consult"] } },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), adapters: { "openai-chat": UncertifiedApi }, accountStore: store });
  const route = registry.resolveRoute({ providerId: "api", accountId: first.id, mode: "consult", model: "m" });
  assert.deepEqual(registry.fallbackRoutes(route), []);
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: store });
  await assert.rejects(service.executeResponse({ model: "consult/api/m", input: "hi", metadata: { bridge_account_fallback: true } }), /claimed safe failure/);
  assert.deepEqual(calls, ["API_ONE"]);
  await service.close();
});
