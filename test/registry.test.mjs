import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/core/account-store.mjs";
import { CapabilityError, RequestError } from "../src/core/errors.mjs";
import { aggregateUsageEvents, normalizeUsageEvent } from "../src/core/usage-ledger.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import { BridgeService } from "../src/bridge/service.mjs";
import { createTestConfig as createBaseTestConfig, silentLogger } from "./helpers.mjs";

let accountStateSequence = 0;
function createTestConfig(override = {}) {
  return createBaseTestConfig({
    ...override,
    accounts: {
      path: join(tmpdir(), `threadspan-registry-account-state-${process.pid}-${accountStateSequence++}.json`),
      profileSources: {},
      fallback: { enabled: false, maxCandidates: 1 },
      ...(override.accounts ?? {}),
    },
  });
}

test("registry tests never resolve account state beneath the owner home", () => {
  const config = createTestConfig();
  assert.notEqual(config.accounts.path, join(homedir(), ".threadspan", "accounts.json"));
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  assert.equal(registry.accountStore.path, config.accounts.path);
});

test("registry resolves route-prefixed and explicit provider models", () => {
  const registry = new ProviderRegistry(createTestConfig(), { logger: silentLogger() });
  const routed = registry.resolveRoute({ model: "integrated/mock/a/b" });
  assert.equal(routed.mode, "integrated");
  assert.equal(routed.providerId, "mock");
  assert.equal(routed.model, "a/b");

  const short = registry.resolveRoute({ model: "mock/other" });
  assert.equal(short.mode, "consult");
  assert.equal(short.model, "other");

  const explicitPrefixed = registry.resolveRoute({ providerId: "mock", model: "mock/other" });
  assert.equal(explicitPrefixed.providerId, "mock");
  assert.equal(explicitPrefixed.model, "mock/other");
});

test("service provider descriptions and Threadspan route map preserve optional web metadata", async (t) => {
  const config = createTestConfig({
    providers: {
      mock: {
        officialUrl: "https://provider.example",
        accountUrl: "https://provider.example/account",
        usageUrl: "https://provider.example/usage",
      },
      plain: { adapter: "mock", model: "plain-model", capabilities: ["consult"] },
    },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  t.after(() => service.close());

  const providers = await service.describeProviders();
  const described = providers.find((provider) => provider.id === "mock");
  assert.equal(described.officialUrl, "https://provider.example");
  assert.equal(described.accountUrl, "https://provider.example/account");
  assert.equal(described.usageUrl, "https://provider.example/usage");
  const plain = providers.find((provider) => provider.id === "plain");
  for (const key of ["officialUrl", "accountUrl", "usageUrl"]) assert.equal(Object.hasOwn(plain, key), false);

  const state = await service.threadspanState();
  const node = state.routeMap.nodes.find((candidate) => candidate.id === "mock");
  const plainNode = state.routeMap.nodes.find((candidate) => candidate.id === "plain");
  assert.equal(node.officialUrl, "https://provider.example");
  assert.equal(node.accountUrl, "https://provider.example/account");
  assert.equal(node.usageUrl, "https://provider.example/usage");
  assert.equal(state.route.officialUrl, "https://provider.example");
  assert.equal(state.route.accountUrl, "https://provider.example/account");
  assert.equal(state.route.usageUrl, "https://provider.example/usage");
  assert.equal("creditState" in node, false);
  assert.equal("expiryState" in node, false);
  for (const key of ["officialUrl", "accountUrl", "usageUrl"]) assert.equal(Object.hasOwn(plainNode, key), false);

  const plainService = new BridgeService(createTestConfig({
    defaults: { provider: "plain", mode: "consult", model: "plain-model" },
    providers: { plain: { adapter: "mock", model: "plain-model", capabilities: ["consult"] } },
  }), { logger: silentLogger() });
  t.after(() => plainService.close());
  const plainState = await plainService.threadspanState();
  for (const key of ["officialUrl", "accountUrl", "usageUrl"]) assert.equal(Object.hasOwn(plainState.route, key), false);
  assert.equal("creditState" in plainState.route, false);
  assert.equal("expiryState" in plainState.route, false);
});

test("registry rejects unknown providers and unsupported modes", () => {
  const config = createTestConfig({ providers: { mock: { adapter: "mock", model: "m", capabilities: ["consult"] } } });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  assert.throws(() => registry.resolveRoute({ providerId: "missing", model: "m" }), RequestError);
  assert.throws(() => registry.resolveRoute({ providerId: "mock", mode: "delegate", model: "m" }), CapabilityError);
});

test("enabled provider-native Codex describes setup-required while routes fail closed", async (t) => {
  const nativeProvider = {
    adapter: "codex-native-worker",
    command: "codex",
    model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    contextWindow: 480000,
    reasoningEffort: "high",
    capabilities: ["delegate"],
    sandbox: "workspace-write",
    approvalPolicy: "never",
  };
  const config = createTestConfig({
    defaults: { provider: "openai-codex", mode: "delegate", model: "gpt-5.6-sol" },
    providers: { "openai-codex": nativeProvider },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  t.after(() => registry.close());
  assert.throws(() => registry.resolveRoute({ providerId: "openai-codex", mode: "delegate", model: "gpt-5.6-sol" }), /requires an explicit validated isolated account/);
  const described = await registry.describe();
  const codex = described.find((item) => item.id === "openai-codex");
  assert.equal(codex.setupRequired, true);
  assert.equal(codex.health.status, "unavailable");
  assert.deepEqual(codex.accounts, []);
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: registry.accountStore });
  const state = await service.threadspanState();
  assert.equal(state.route.provider, "openai-codex");
  assert.equal(state.route.verified, false);
  assert.match(state.route.verificationSource, /requires an explicit validated isolated account/);
  assert.throws(() => createTestConfig({ providers: { "openai-codex": { ...nativeProvider, profile: "threadspan_integrated" } } }), /profile is forbidden/);
  assert.throws(() => createTestConfig({ providers: { "openai-codex": { ...nativeProvider, model: "integrated\/openai\/gpt-5.6-sol", models: ["integrated\/openai\/gpt-5.6-sol"] } } }), /native Codex catalog slug/);
});

test("routed model list contains one id per supported mode", async () => {
  const registry = new ProviderRegistry(createTestConfig(), { logger: silentLogger() });
  const ids = (await registry.listRoutedModels()).map((entry) => entry.id).sort();
  assert.deepEqual(ids, [
    "consult/mock/mock-model",
    "consult/threadspan/auto",
    "delegate/mock/mock-model",
    "delegate/threadspan/auto",
    "integrated/mock/mock-model",
    "integrated/threadspan/auto",
  ]);
});

test("threadspan smart routes honor mode-specific provider order", () => {
  const config = createTestConfig({
    routing: { providerOrder: { consult: ["second", "mock"] } },
    providers: {
      second: { adapter: "mock", model: "second-model", capabilities: ["consult"] },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  const route = registry.resolveRoute({ model: "consult/threadspan/auto" });
  assert.equal(route.smart, true);
  assert.equal(route.providerId, "second");
  assert.equal(route.model, "second-model");
});

test("registry accepts an embedding-application adapter without core edits", async () => {
  class ExternalAdapter {
    constructor(id, config) { this.id = id; this.config = config; }
    capabilities() { return { modes: { consult: { supported: true }, integrated: { supported: false }, delegate: { supported: false } } }; }
    assertMode(mode) { if (mode !== "consult") throw new Error("unsupported"); }
    async listModels() { return [{ id: "external-model" }]; }
    async *run() { yield { type: "done", message: { role: "assistant", content: "external" } }; }
    async close() {}
  }
  const config = createTestConfig({ defaults: { provider: "external", mode: "consult", model: "external-model" }, providers: { external: { adapter: "external", capabilities: ["consult"] } } });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), adapters: { external: ExternalAdapter } });
  assert.equal(registry.resolveRoute({ model: "external/external-model" }).providerId, "external");
  assert.ok((await registry.listRoutedModels()).some((entry) => entry.id === "consult/external/external-model"));
});


test("registry runtime stats aggregate provider-local count-only diagnostics", () => {
  class ExternalAdapter {
    constructor(id, config) { this.id = id; this.config = config; }
    capabilities() { return { modes: { consult: { supported: true }, integrated: { supported: false }, delegate: { supported: false } } }; }
    assertMode() {}
    runtimeStats() { return { kind: "external", active: 3 }; }
    async listModels() { return [{ id: "m" }]; }
    async close() {}
  }
  const config = createTestConfig({
    defaults: { provider: "external", mode: "consult", model: "m" },
    providers: { external: { adapter: "external", capabilities: ["consult"] } },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), adapters: { external: ExternalAdapter } });
  const stats = registry.runtimeStats();
  assert.equal(stats.external.kind, "external");
  assert.equal(stats.external.active, 3);
  assert.equal(stats.external.health.status, "unknown");
  assert.equal(stats.external.usage.requests, 0);
  assert.equal(stats.mock.kind, "mock");
});

test("registry attaches deterministic per-account and compatible aggregate forecasts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-registry-forecast-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.REGISTRY_FORECAST_KEY;
  process.env.REGISTRY_FORECAST_KEY = "fake";
  t.after(() => { if (previous === undefined) delete process.env.REGISTRY_FORECAST_KEY; else process.env.REGISTRY_FORECAST_KEY = previous; });
  const store = new AccountStore({ path: join(root, "accounts.json"), now: () => "2026-08-17T12:00:00Z" });
  const account = await store.create({ providerId: "api", label: "Forecast", authKind: "api-key-env", authSourceRef: "REGISTRY_FORECAST_KEY" });
  const listAccounts = store.list.bind(store);
  store.list = (options) => listAccounts(options).map((item) => item.id === account.id ? { ...item, quota: { entitlementIdentity: "api-account-plan", unit: "tokens", windowMs: 86_400_000, allowance: 600, remaining: 60, resetAt: "2026-08-18T18:00:00Z", renewalAt: null, source: "provider-api", observedAt: "2026-08-17T18:00:00Z" } } : item);
  const events = ["2026-08-17T12:00:00Z", "2026-08-17T18:00:00Z"].map((timestamp) => normalizeUsageEvent({ timestamp, provider: "api", accountId: account.id, model: "m", mode: "consult", status: "completed", evidenceClass: "live-provider", inputTokens: 20, outputTokens: 10 }));
  const usageLedger = { summarize: async (options) => aggregateUsageEvents(events, { ...options, now: "2026-08-17T18:00:00Z" }) };
  const config = createTestConfig({ providers: { api: { adapter: "openai-chat", baseUrl: "https://example.test/v1", model: "m", models: ["m"], strictModelList: true, capabilities: ["consult"] } }, accounts: { path: store.path, profileSources: {}, fallback: { enabled: false, maxCandidates: 3 } } });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), usageLedger, accountStore: store });
  t.after(() => registry.close());
  const described = await registry.describeAccounts();
  assert.equal(described.accounts[0].forecast.scope.accountId, account.id);
  assert.equal(described.accounts[0].forecast.status, "projected");
  assert.equal(described.accounts[0].forecast.entitlement.remaining, 60);
  assert.ok(described.accounts[0].forecast.exhaustion);
  assert.equal(described.forecasts.providers.api.length, 1);
  assert.equal(described.forecasts.combined.length, 1);
  assert.equal(described.accounts[0].quota.remaining, 60);
});
