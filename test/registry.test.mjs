import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, UNKNOWN_ACCOUNT_ID } from "../src/core/account-store.mjs";
import { CapabilityError, RequestError } from "../src/core/errors.mjs";
import { aggregateUsageEvents, normalizeUsageEvent } from "../src/core/usage-ledger.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import { ProviderAdapter } from "../src/providers/base.mjs";
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

test("provider activation route resolution forbids smart selection and preserves capability errors", () => {
  const registry = new ProviderRegistry(createTestConfig({
    providers: { mock: { adapter: "mock", model: "exact-model", models: ["exact-model"], capabilities: ["consult"] } },
  }), { logger: silentLogger() });
  const route = registry.resolveExactActivationRoute({ providerId: "mock", mode: "consult", model: "exact-model" });
  assert.equal(route.smart, false);
  assert.equal(route.providerId, "mock");
  assert.equal(route.accountId, UNKNOWN_ACCOUNT_ID);
  assert.throws(() => registry.resolveExactActivationRoute({ providerId: "threadspan", mode: "consult", model: "exact-model" }), RequestError);
  assert.throws(() => registry.resolveExactActivationRoute({ providerId: "mock", mode: "consult", model: "auto" }), RequestError);
  assert.throws(() => registry.resolveExactActivationRoute({ providerId: "mock", mode: "delegate", model: "exact-model" }), CapabilityError);
});

test("bridge activation executor performs live discovery and one exact request", async (t) => {
  const config = createTestConfig({
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    providers: { mock: { adapter: "mock", model: "activation-model", models: ["activation-model"], capabilities: ["consult"], reply: "THREADSPAN_ACTIVATION_OK" } },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  t.after(() => service.close());
  let runs = 0;
  const provider = service.registry.get("mock");
  const originalRun = provider.run.bind(provider);
  provider.run = async function* (request) { runs += 1; yield* originalRun(request); };
  const receipt = await service.executeProviderActivation({ providerId: "mock", mode: "consult", model: "activation-model" });
  assert.equal(runs, 1);
  assert.deepEqual(receipt.route, { providerId: "mock", mode: "consult", model: "activation-model", accountId: null });
  assert.equal(receipt.success, true);
  assert.equal(receipt.discovered, true);

  const wrongConfig = createTestConfig({ providers: { mock: { adapter: "mock", model: "activation-model", models: ["activation-model"], capabilities: ["consult"], reply: "almost" } } });
  const wrong = new BridgeService(wrongConfig, { logger: silentLogger() });
  t.after(() => wrong.close());
  await assert.rejects(wrong.executeProviderActivation({ providerId: "mock", mode: "consult", model: "activation-model" }), /exact sentinel/);
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

test("automatic provider ties use a canonical provider id independent of insertion order", async (t) => {
  const build = (providers) => {
    const registry = new ProviderRegistry(createTestConfig({
      defaults: { provider: "threadspan", mode: "consult", model: "auto" },
      providers: { mock: { enabled: false }, ...providers },
    }), { logger: silentLogger() });
    t.after(() => registry.close());
    return registry;
  };
  const zetaFirst = build({
    zeta: { adapter: "mock", model: "zeta-model", capabilities: ["consult"] },
    alpha: { adapter: "mock", model: "alpha-model", capabilities: ["consult"] },
  });
  const alphaFirst = build({
    alpha: { adapter: "mock", model: "alpha-model", capabilities: ["consult"] },
    zeta: { adapter: "mock", model: "zeta-model", capabilities: ["consult"] },
  });

  for (const registry of [zetaFirst, alphaFirst]) {
    const map = await registry.routeMap();
    const edges = map.edges.filter((edge) => edge.mode === "consult");
    const route = registry.resolveRoute({ model: "consult/threadspan/auto" });
    assert.equal(route.providerId, "alpha");
    assert.deepEqual(edges.map((edge) => edge.provider), ["alpha", "zeta"]);
    assert.equal(edges[0].priority, 1);
    assert.equal(edges[0].score, edges[0].weight);
    assert.equal(edges[0].score, Object.values(edges[0].scoreComponents).reduce((total, value, index) => total + (index === 4 ? -value : value), 0));
    assert.deepEqual(edges[0].tieBreak, { field: "provider", value: "alpha" });
  }
});

test("canonical picker routes preserve executable catalog metadata without inferring free models", async (t) => {
  const config = createTestConfig({
    providers: {
      mock: {
        adapter: "mock",
        model: "model/name",
        capabilities: ["consult"],
        models: [
          { id: "model/name", free: false, contextWindow: 123_456, supported_reasoning_levels: [{ effort: "high", description: "Deep" }], default_reasoning_level: "high" },
          { id: "looks-free:free" },
        ],
      },
    },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  t.after(() => service.close());
  const state = await service.threadspanState();
  const exact = state.pickerRoutes.find((route) => route.id === "consult/mock/model/name");
  assert.equal(exact.provider, "mock");
  assert.equal(exact.accountId, "unknown/default");
  assert.equal(exact.model, "model/name");
  assert.equal(exact.free, false);
  assert.equal(exact.contextWindow, 123_456);
  assert.deepEqual(exact.supportedReasoningLevels, [{ effort: "high", description: "Deep" }]);
  assert.equal(exact.defaultReasoningLevel, "high");
  assert.equal(exact.catalogDegraded, false);
  assert.equal(exact.configuredFallback, false);
  assert.equal(exact.availability, "available");
  const unsafe = state.pickerRoutes.find((route) => route.id === "consult/mock/looks-free:free");
  assert.equal(Object.hasOwn(unsafe, "free"), false);
});

test("canonical picker provider order matches the frozen backend ranking", async (t) => {
  const config = createTestConfig({
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    routing: { providerOrder: { consult: ["alpha", "zeta"] } },
    providers: {
      mock: { enabled: false },
      zeta: { adapter: "mock", model: "zeta-model", capabilities: ["consult"] },
      alpha: { adapter: "mock", model: "alpha-model", capabilities: ["consult"] },
    },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  t.after(() => service.close());
  const state = await service.threadspanState();
  assert.equal(state.route.provider, "alpha");
  assert.deepEqual(state.routeMap.edges.filter((edge) => edge.mode === "consult").map((edge) => edge.provider), ["alpha", "zeta"]);
  assert.deepEqual(state.pickerRoutes.filter((route) => route.mode === "consult").map((route) => route.id), [
    "consult/threadspan/auto",
    "consult/alpha/alpha-model",
    "consult/zeta/zeta-model",
  ]);
});

test("canonical picker routes publish a bounded catalog fallback reason", async (t) => {
  class UnavailableCatalogProvider extends ProviderAdapter {
    async listModels() { throw new Error("private /machine/path and upstream details"); }
    async close() {}
  }
  const config = createTestConfig({
    defaults: { provider: "catalog", mode: "consult", model: "configured-model" },
    providers: { mock: { enabled: false }, catalog: { adapter: "unavailable-catalog", model: "configured-model", capabilities: ["consult"] } },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), adapters: { "unavailable-catalog": UnavailableCatalogProvider } });
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: registry.accountStore });
  t.after(() => service.close());
  const state = await service.threadspanState();
  const route = state.pickerRoutes.find((item) => item.id === "consult/catalog/configured-model");
  assert.equal(route.catalogDegraded, true);
  assert.equal(route.configuredFallback, true);
  assert.equal(route.catalogReason, "Live provider catalog unavailable; using the configured fallback.");
  assert.doesNotMatch(JSON.stringify(route), /machine\/path|upstream details/);
});

test("Threadspan state uses one post-catalog health snapshot for map, picker, and auto route", async (t) => {
  let catalogCalls = 0;
  class TransientCatalogProvider extends ProviderAdapter {
    async listModels() {
      catalogCalls += 1;
      if (catalogCalls === 1) return [{ id: "transient-live" }];
      throw new Error("transient catalog failure");
    }
    async close() {}
  }
  const config = createTestConfig({
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    providers: {
      mock: { enabled: false },
      transient: { adapter: "transient-catalog", model: "transient-configured", capabilities: ["consult"] },
      steady: { adapter: "mock", model: "steady-model", capabilities: ["consult"] },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), adapters: { "transient-catalog": TransientCatalogProvider } });
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: registry.accountStore });
  t.after(() => service.close());

  await service.describeProviders();
  assert.equal(catalogCalls, 1);
  const state = await service.threadspanState();
  assert.equal(catalogCalls, 2, "state performs one final catalog refresh and reuses it for every projection");
  assert.equal(state.route.provider, "steady");
  assert.equal(state.route.id, "consult/steady/steady-model");
  assert.equal(state.routeMap.edges.find((edge) => edge.mode === "consult" && edge.priority === 1).provider, "steady");
  assert.equal(state.routeMap.nodes.find((node) => node.id === "transient").availability, "degraded");
  const transient = state.pickerRoutes.find((route) => route.id === "consult/transient/transient-configured");
  assert.equal(transient.availability, "degraded");
  assert.equal(transient.catalogDegraded, true);
  assert.equal(transient.configuredFallback, true);
});

test("Threadspan state remains internally consistent when health changes during summary awaits", async (t) => {
  const config = createTestConfig({
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    providers: {
      mock: { enabled: false },
      alpha: { adapter: "mock", model: "alpha-model", capabilities: ["consult"] },
      zeta: { adapter: "mock", model: "zeta-model", capabilities: ["consult"] },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: registry.accountStore });
  t.after(() => service.close());
  const alpha = registry.resolveRoute({ providerId: "alpha", mode: "consult", model: "alpha-model" });
  const summarize = registry.usageSummary.bind(registry);
  const takeSnapshot = registry.routingSnapshot.bind(registry);
  let snapshot;
  let failed = false;
  registry.routingSnapshot = (input) => {
    snapshot = takeSnapshot(input);
    return snapshot;
  };
  registry.usageSummary = async (...args) => {
    if (!failed) {
      failed = true;
      await registry.recordFailure(alpha, new Error("concurrent post-snapshot failure"));
    }
    return summarize(...args);
  };

  const state = await service.threadspanState();
  assert.equal(failed, true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.routeMap.edges[0].scoreComponents), true);
  assert.equal(state.route.provider, "alpha");
  assert.equal(state.route.verified, true);
  assert.equal(state.routeMap.edges.find((edge) => edge.mode === "consult" && edge.priority === 1).provider, "alpha");
  assert.equal(state.routeMap.nodes.find((node) => node.id === "alpha").availability, "available");
  assert.equal(state.pickerRoutes.find((route) => route.id === "consult/alpha/alpha-model").availability, "available");
  assert.equal(registry.resolveRoute({ model: "consult/threadspan/auto" }).providerId, "zeta", "normal execution remains live after the frozen state projection");
});

test("captured and live smart routing both reject an explicit unknown/default account sentinel", async (t) => {
  const config = createTestConfig({
    defaults: { provider: "threadspan", accountId: UNKNOWN_ACCOUNT_ID, mode: "consult", model: "auto" },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  const service = new BridgeService(config, { logger: silentLogger(), registry, accountStore: registry.accountStore });
  t.after(() => service.close());
  assert.throws(
    () => registry.resolveRoute({ providerId: "threadspan", accountId: UNKNOWN_ACCOUNT_ID, mode: "consult", model: "auto" }),
    /Unknown account 'unknown\/default'/,
  );
  const routedModels = await registry.listRoutedModels();
  const snapshot = registry.routingSnapshot({
    routedModels,
    providerId: "threadspan",
    accountId: UNKNOWN_ACCOUNT_ID,
    mode: "consult",
    model: "auto",
  });
  assert.match(snapshot.routeError, /Unknown account 'unknown\/default'/);
  assert.equal(snapshot.route.providerId, "threadspan");
  assert.equal(snapshot.route.health.status, "unavailable");

  const state = await service.threadspanState();
  assert.equal(state.route.provider, "threadspan");
  assert.equal(state.route.accountId, UNKNOWN_ACCOUNT_ID);
  assert.equal(state.route.verified, false);
  assert.match(state.route.verificationSource, /Unknown account 'unknown\/default'/);
});

test("routed model grammar preserves ordinary slashes and rejects ambiguous or unsafe ids", async (t) => {
  const registry = new ProviderRegistry(createTestConfig({
    providers: { mock: { adapter: "mock", model: "family/model", models: ["family/model"], capabilities: ["consult"] } },
  }), { logger: silentLogger() });
  t.after(() => registry.close());
  const routed = registry.resolveRoute({ model: "consult/mock/family/model" });
  assert.equal(routed.accountId, "unknown/default");
  assert.equal(routed.model, "family/model");
  assert.ok((await registry.listRoutedModels()).some((entry) => entry.id === "consult/mock/family/model"));
  assert.equal(registry.resolveRoute({ providerId: "mock", mode: "consult", model: "@native-model" }).model, "@native-model", "non-routed explicit provider input is not reinterpreted");

  for (const unsafe of [
    "consult/mock/@leading",
    "consult/mock/@acct/@leading",
    "consult/mock/../secret",
    "consult/mock/model\\name",
    "consult/mock/model\nname",
    "consult/mock//name",
    `consult/mock/${"x".repeat(513)}`,
  ]) assert.throws(() => registry.resolveRoute({ model: unsafe }), RequestError, unsafe);

  for (const model of ["@leading", "../secret", "model\\name", "model\nname", "model//name", "x".repeat(513)]) {
    const unsafeRegistry = new ProviderRegistry(createTestConfig({
      providers: { mock: { adapter: "mock", model, models: [model], capabilities: ["consult"] } },
    }), { logger: silentLogger() });
    t.after(() => unsafeRegistry.close());
    await assert.rejects(unsafeRegistry.listRoutedModels(), /cannot be represented safely/);
  }
});

test("health, failure, balance, and mode bias keep route-map scores in parity with auto selection", async (t) => {
  const createRegistry = (providerProfiles = {}) => {
    const registry = new ProviderRegistry(createTestConfig({
      defaults: { provider: "threadspan", mode: "consult", model: "auto" },
      routing: { providerOrder: {}, providerProfiles },
      providers: {
        mock: { enabled: false },
        alpha: { adapter: "mock", model: "alpha-model", capabilities: ["consult"] },
        zeta: { adapter: "mock", model: "zeta-model", capabilities: ["consult"] },
      },
    }), { logger: silentLogger() });
    t.after(() => registry.close());
    return registry;
  };
  const descriptions = (registry) => [...registry.providers.entries()].map(([id, provider]) => ({
    id, accountId: "unknown/default", adapter: provider.config.adapter, capabilities: provider.capabilities(), models: [{ id: provider.config.model }], health: { status: "unknown" },
  }));
  const assertParity = async (registry, expected) => {
    const map = await registry.routeMap(descriptions(registry));
    const edge = map.edges.find((candidate) => candidate.mode === "consult" && candidate.priority === 1);
    const route = registry.resolveRoute({ model: "consult/threadspan/auto" });
    assert.equal(route.providerId, expected);
    assert.equal(edge.provider, expected);
    const components = edge.scoreComponents;
    assert.equal(edge.score, components.preference + components.healthPenalty + components.failurePenalty + components.balancePenalty - components.modeBias);
    assert.equal(edge.weight, edge.score);
    return map;
  };

  const health = createRegistry();
  await health.recordSuccess(health.resolveRoute({ providerId: "zeta", mode: "consult", model: "zeta-model" }), {});
  const healthMap = await assertParity(health, "zeta");
  assert.equal(healthMap.edges.find((edge) => edge.mode === "consult" && edge.provider === "zeta").scoreComponents.healthPenalty, 0);
  assert.equal(healthMap.edges.find((edge) => edge.mode === "consult" && edge.provider === "alpha").scoreComponents.healthPenalty, 15);

  const failure = createRegistry();
  const alpha = failure.resolveRoute({ providerId: "alpha", mode: "consult", model: "alpha-model" });
  const zeta = failure.resolveRoute({ providerId: "zeta", mode: "consult", model: "zeta-model" });
  await failure.recordSuccess(alpha, {});
  await failure.recordSuccess(zeta, {});
  await failure.recordFailure(alpha, new Error("failure"));
  await failure.recordSuccess(alpha, {});
  const failureMap = await assertParity(failure, "zeta");
  assert.ok(failureMap.edges.find((edge) => edge.mode === "consult" && edge.provider === "alpha").scoreComponents.failurePenalty > 0);

  const balance = createRegistry();
  const busy = balance.resolveRoute({ providerId: "alpha", mode: "consult", model: "alpha-model" });
  await balance.recordSuccess(balance.resolveRoute({ providerId: "zeta", mode: "consult", model: "zeta-model" }), {});
  for (let index = 0; index < 8; index += 1) await balance.recordSuccess(busy, {});
  const balanceMap = await assertParity(balance, "zeta");
  assert.equal(balanceMap.edges.find((edge) => edge.mode === "consult" && edge.provider === "alpha").scoreComponents.balancePenalty, 2);

  const biased = createRegistry({ zeta: { modeWeights: { consult: 20 } } });
  const biasMap = await assertParity(biased, "zeta");
  assert.equal(biasMap.edges.find((edge) => edge.mode === "consult" && edge.provider === "zeta").scoreComponents.modeBias, 20);
});

test("authoritative quota observations do not affect automatic ranking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-ranking-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = "THREADSPAN_RANKING_QUOTA_KEY";
  process.env[key] = "secret";
  t.after(() => { delete process.env[key]; });
  const store = new AccountStore({ path: join(root, "accounts.json") });
  const account = await store.create({ providerId: "api", label: "Quota", authKind: "api-key-env", authSourceRef: key });
  const config = createTestConfig({
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    accounts: { path: store.path, profileSources: {}, fallback: { enabled: false, maxCandidates: 1 } },
    providers: {
      mock: { enabled: false },
      api: { adapter: "openai-chat", baseUrl: "https://example.test/v1", model: "api-model", capabilities: ["consult"] },
      other: { adapter: "mock", model: "other-model", capabilities: ["consult"] },
    },
  });
  const registry = new ProviderRegistry(config, { logger: silentLogger(), accountStore: store });
  t.after(() => registry.close());
  const descriptions = [...registry.providers.entries()].map(([id, provider]) => ({
    id, accountId: id === "api" ? account.id : "unknown/default", adapter: provider.config.adapter, capabilities: provider.capabilities(), models: [{ id: provider.config.model }], health: { status: "unknown" },
  }));
  const before = await registry.routeMap(descriptions);
  const selectedBefore = registry.resolveRoute({ model: "consult/threadspan/auto" }).providerId;
  await store.observeQuota(account.id, {
    remaining: 1, resetAt: "2026-08-19T00:00:00.000Z", renewalAt: null, charge: 0,
    source: "provider-api", observedAt: "2026-08-18T20:00:00.000Z",
  });
  const after = await registry.routeMap(descriptions);
  assert.equal(registry.resolveRoute({ model: "consult/threadspan/auto" }).providerId, selectedBefore);
  for (const prior of before.edges.filter((edge) => edge.mode === "consult")) {
    const current = after.edges.find((edge) => edge.mode === prior.mode && edge.provider === prior.provider);
    assert.equal(current.priority, prior.priority);
    assert.equal(current.score, prior.score);
    for (const keyName of ["preference", "healthPenalty", "failurePenalty", "balancePenalty", "modeBias"]) {
      assert.equal(current.scoreComponents[keyName], prior.scoreComponents[keyName]);
    }
  }
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
