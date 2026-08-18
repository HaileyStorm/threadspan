import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callCodexAppServerWithReceipt, discoverNativeCodexCatalog } from "../src/codex/app-server.mjs";
import { AccountStore } from "../src/core/account-store.mjs";
import { CodexNativeQuotaAdapter } from "../src/core/codex-native-quota.mjs";
import { bindExecutable } from "../src/core/executable.mjs";
import { nativePath } from "./helpers.mjs";

test("App Server discovery converts the signed-in native model list to a catalog", async () => {
  const fixture = nativePath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  const catalog = await discoverNativeCodexCatalog({ command: process.execPath, commandArgs: [fixture] });
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.models[0], {
    ...catalog.models[0],
    slug: "gpt-fixture",
    display_name: "GPT Fixture",
    default_reasoning_level: "high",
    visibility: "list",
    priority: 1000,
    input_modalities: ["text", "image"],
  });
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [{ effort: "high", description: "Deep" }]);
});

test("native quota binds the selected isolated Codex account and official multi-bucket receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-native-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, "isolated-codex-home");
  await mkdir(codexHome);
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const account = await store.create({ providerId: "openai-codex", label: "Work", authKind: "cli-login", profileRef: "codex-work" });
  await store.select(account.id);
  let call;
  const adapter = new CodexNativeQuotaAdapter({
    accountStore: store,
    config: {
      accounts: { profileSources: { "codex-work": { kind: "codex-home", root: codexHome } } },
      providers: { "openai-codex": { command: "codex-fixture" } },
    },
    instanceId: "adapter-instance",
    now: () => "2026-08-17T20:00:00Z",
    callAppServerBatch: async (requests, options) => {
      call = { requests, options };
      return {
        receipt: nativeProcessReceipt(codexHome),
        results: [{ account: { type: "chatgpt", email: "owner@example.test", planType: "pro" }, requiresOpenaiAuth: true }, {
          rateLimitsByLimitId: {
            codex: { limitId: "codex", primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: 1787515200 }, secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1786996800 }, planType: "pro", rateLimitReachedType: null },
            "secondary-controls": { limitId: "secondary-controls", primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1786996800 }, secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: 1787515200 }, planType: "pro", rateLimitReachedType: null },
            weekly: { limitId: "weekly", primary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1787515200 }, secondary: null, planType: "pro", rateLimitReachedType: null },
          },
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }],
      };
    },
  });
  const result = await adapter.read();
  assert.deepEqual(call.requests, [
    { method: "account/read", params: { refreshToken: false } },
    { method: "account/rateLimits/read", params: {} },
  ]);
  assert.equal(call.options.environment.CODEX_HOME, codexHome);
  assert.equal(call.options.command, "codex-fixture");
  assert.equal(call.options.environment.OPENAI_BASE_URL, undefined);
  assert.equal(result.accountId, account.id);
  assert.equal(result.observations.length, 3);
  assert.equal(result.observations[0].providerId, "openai-codex");
  assert.equal(result.observations[0].bucketId, "codex");
  assert.equal(result.observations[0].usedRatio, 0.96);
  assert.equal(result.observations[0].resetAt, new Date(1787515200 * 1000).toISOString());
  const secondaryControls = result.observations.find((observation) => observation.bucketId === "secondary-controls");
  assert.equal(secondaryControls.usedRatio, 0.95);
  assert.equal(secondaryControls.resetAt, new Date(1787515200 * 1000).toISOString());
  assert.equal(result.observations[0].resetCreditsAvailable, 2);
  assert.equal(result.observations[0].nativeReceipt.adapterInstanceId, "adapter-instance");
  assert.match(result.observations[0].nativeReceipt.nativeAccountIdentityDigest, /^[a-f0-9]{64}$/);
  assert.match(result.observations[0].nativeReceipt.profileBindingDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /owner@example\.test/);
  assert.match(result.observations[0].windowIdentity, /^[a-f0-9]{64}$/);
  assert.match(result.observations[0].sourceDigest, /^[a-f0-9]{64}$/);
});

test("App Server receipt binds canonical executable hash version argv and isolated CODEX_HOME", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-app-receipt-"));
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = nativePath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  const { receipt } = await callCodexAppServerWithReceipt("model/list", {}, {
    command: process.execPath,
    commandArgs: [fixture],
    environment: { ...process.env, CODEX_HOME: codexHome },
  });
  const executable = await realpath(process.execPath);
  assert.equal(receipt.executable.path, executable);
  assert.match(receipt.executable.sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.executable.metadataDigest, /^[a-f0-9]{64}$/);
  assert.match(receipt.executable.version, /^v\d+/);
  assert.deepEqual(receipt.argv, [executable, fixture]);
  assert.equal(receipt.codexHome, codexHome);
  assert.equal(receipt.executableVerifiedAfterRead, true);
});

test("native quota fails closed when App Server identity or source receipt is not bindable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-native-quota-closed-"));
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const account = await store.create({ providerId: "openai-codex", label: "Work", authKind: "cli-login", profileRef: "codex-work" });
  await store.select(account.id);
  const makeAdapter = (accountResult, receipt = nativeProcessReceipt(codexHome)) => new CodexNativeQuotaAdapter({
    accountStore: store,
    config: {
      accounts: { profileSources: { "codex-work": { kind: "codex-home", root: codexHome } } },
      providers: { "openai-codex": { command: "codex-fixture" } },
    },
    callAppServerBatch: async () => ({
      receipt,
      results: [accountResult, { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 96 }, secondary: null, planType: "pro", rateLimitReachedType: null } } }],
    }),
  });
  await assert.rejects(makeAdapter({ account: { type: "chatgpt", email: null, planType: "pro" }, requiresOpenaiAuth: true }).read(), /bindable native ChatGPT account identity/);
  await assert.rejects(makeAdapter({ account: { type: "chatgpt", email: "owner@example.test", planType: "pro" }, requiresOpenaiAuth: true }, { ...nativeProcessReceipt(codexHome), executableVerifiedAfterRead: false }).read(), /not source-bound/);
});

test("native quota rejects canonical aliases of the default profile before App Server use", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-native-default-alias-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousCodexHome = process.env.CODEX_HOME;
  const defaultHome = join(root, "default-codex-home");
  const alias = join(root, "codex-alias");
  await mkdir(defaultHome);
  process.env.CODEX_HOME = defaultHome;
  t.after(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  });
  await symlink(defaultHome, alias, process.platform === "win32" ? "junction" : "dir");
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const account = await store.create({ providerId: "openai-codex", label: "Work", authKind: "cli-login", profileRef: "codex-work" });
  await store.select(account.id);
  let called = false;
  const adapter = new CodexNativeQuotaAdapter({
    accountStore: store,
    config: { accounts: { profileSources: { "codex-work": { kind: "codex-home", root: alias } } } },
    callAppServerBatch: async () => { called = true; },
  });
  await assert.rejects(adapter.read(), /refuses the current\/default CODEX_HOME/);
  assert.equal(called, false);
});

test("authoritative executable binding rejects indirect Windows launchers and bounded output rejects cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-executable-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = join(root, "codex.cmd");
  await writeFile(launcher, "@echo off\r\nnode codex.js %*\r\n");
  await assert.rejects(bindExecutable(launcher, { platform: "win32" }), /refuses indirect Windows launcher/);

  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const fixture = nativePath(new URL("./fixtures/codex-app-server.mjs", import.meta.url));
  await assert.rejects(callCodexAppServerWithReceipt("model/list", {}, {
    command: process.execPath,
    commandArgs: [fixture],
    environment: { ...process.env, CODEX_HOME: codexHome },
    maxOutputBytes: 8,
  }), /exceeded 8 bytes/);
});

function nativeProcessReceipt(codexHome) {
  return {
    id: "d".repeat(64),
    kind: "codex-app-server-process",
    methods: ["account/read", "account/rateLimits/read"],
    executable: { path: process.execPath, sha256: "a".repeat(64), version: process.version, metadataDigest: "b".repeat(64) },
    argv: [process.execPath, "app-server", "--stdio"],
    spawnArgv: [process.execPath, "app-server", "--stdio"],
    codexHome,
    executableVerifiedAfterRead: true,
    resultDigest: "c".repeat(64),
  };
}
