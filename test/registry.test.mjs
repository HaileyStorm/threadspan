import assert from "node:assert/strict";
import test from "node:test";
import { CapabilityError, RequestError } from "../src/core/errors.mjs";
import { ProviderRegistry } from "../src/providers/registry.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("registry resolves route-prefixed and explicit provider models", () => {
  const registry = new ProviderRegistry(createTestConfig(), { logger: silentLogger() });
  const routed = registry.resolveRoute({ model: "integrated/mock/a/b" });
  assert.equal(routed.mode, "integrated");
  assert.equal(routed.providerId, "mock");
  assert.equal(routed.model, "a/b");

  const short = registry.resolveRoute({ model: "mock/other" });
  assert.equal(short.mode, "consult");
  assert.equal(short.model, "other");
});

test("registry rejects unknown providers and unsupported modes", () => {
  const config = createTestConfig({ providers: { mock: { adapter: "mock", model: "m", capabilities: ["consult"] } } });
  const registry = new ProviderRegistry(config, { logger: silentLogger() });
  assert.throws(() => registry.resolveRoute({ providerId: "missing", model: "m" }), RequestError);
  assert.throws(() => registry.resolveRoute({ providerId: "mock", mode: "delegate", model: "m" }), CapabilityError);
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
