import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createExampleConfig, deepMerge, expandEnvironment, parseJsonc, validateConfig } from "../src/core/config.mjs";
import { ConfigError } from "../src/core/errors.mjs";
import { createTestConfig } from "./helpers.mjs";

test("parseJsonc handles comments, quoted comment markers, and trailing commas", () => {
  const parsed = parseJsonc(`{
    // line
    "url": "https://example.test/a//b",
    "nested": { "value": 1, },
    /* block */
    "list": [1, 2,],
  }`);
  assert.deepEqual(parsed, { url: "https://example.test/a//b", nested: { value: 1 }, list: [1, 2] });
});

test("environment expansion is recursive and missing variables become empty", () => {
  assert.deepEqual(expandEnvironment({ a: "${ONE}", b: ["x-${TWO}", "${MISSING}"] }, { ONE: "1", TWO: "2" }), {
    a: "1",
    b: ["x-2", ""],
  });
});

test("deepMerge replaces arrays and merges plain objects", () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, list: [1] }, { a: { c: 3 }, list: [2] }), {
    a: { b: 1, c: 3 },
    list: [2],
  });
});

test("validateConfig rejects invalid concurrency and provider ids", () => {
  const valid = createTestConfig();
  assert.throws(() => validateConfig({ ...valid, server: { ...valid.server, maxConcurrentRequests: 0 } }), ConfigError);
  assert.throws(() => validateConfig({ ...valid, providers: { "bad id": { adapter: "mock" } } }), ConfigError);
});

test("validateConfig rejects invalid modes, origins, sessions, and command settings", () => {
  const valid = createTestConfig();
  assert.throws(() => validateConfig({ ...valid, defaults: { ...valid.defaults, mode: "ask" } }), /defaults\.mode/);
  assert.throws(() => validateConfig({ ...valid, server: { ...valid.server, allowedOrigins: [""] } }), /allowedOrigins/);
  assert.throws(() => validateConfig({ ...valid, sessions: { ...valid.sessions, ttlMs: 0 } }), /sessions\.ttlMs/);
  assert.throws(() => validateConfig({
    ...valid,
    providers: { command: { adapter: "command", capabilities: ["consult"] } },
  }), /requires a non-empty command/);
  assert.throws(() => validateConfig({
    ...valid,
    providers: { command: { adapter: "command", command: "node", capabilities: ["ask"] } },
  }), /unsupported mode 'ask'/);
});

test("validateConfig rejects malformed provider lifecycle and endpoint options", () => {
  const base = {
    server: {
      host: "127.0.0.1",
      port: 8743,
      authTokenEnv: "TOKEN",
      allowUnauthenticatedLoopback: true,
      maxBodyBytes: 1024,
      requestTimeoutMs: 1000,
      maxConcurrentRequests: 1,
      allowedOrigins: [],
    },
    responses: { exposeReasoning: false },
    logging: { level: "silent", logBodies: false },
    sessions: { ttlMs: 1000, maxEntries: 10 },
    defaults: { provider: "p", mode: "consult", model: "m" },
    providers: { p: { adapter: "command", command: "node", outputFormat: "jsonl", capabilities: ["consult"], model: "m" } },
  };

  assert.throws(() => validateConfig({ ...base, server: { ...base.server, allowedOrigins: ["http://localhost:3000/path"] } }), /exact http\(s\) origins/);
  assert.throws(() => validateConfig({ ...base, providers: { p: { ...base.providers.p, outputFormat: "yaml" } } }), /outputFormat/);
  assert.throws(() => validateConfig({ ...base, providers: { p: { ...base.providers.p, consult: { snapshotMaxFiles: 0 } } } }), /snapshotMaxFiles/);
  assert.throws(() => validateConfig({ ...base, providers: { p: { ...base.providers.p, consult: { copyInternalSymlinks: "yes" } } } }), /copyInternalSymlinks/);
  assert.throws(() => validateConfig({ ...base, providers: { p: { ...base.providers.p, models: ["m", { id: "m" }] } } }), /duplicate ids/);
  assert.throws(() => validateConfig({ ...base, defaults: { ...base.defaults, provider: "missing" } }), /unknown or disabled provider/);
});

test("DeepSeek and Nous adapters may use their documented default endpoints", () => {
  const valid = createTestConfig();
  for (const adapter of ["deepseek", "nous"]) {
    const configured = validateConfig({
      ...valid,
      defaults: { provider: adapter, mode: "consult", model: "model" },
      providers: {
        [adapter]: { adapter, model: "model", capabilities: ["consult", "integrated"] },
      },
    });
    assert.equal(configured.providers[adapter].baseUrl, undefined);
  }
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "generic", mode: "consult", model: "model" },
    providers: { generic: { adapter: "openai-chat", model: "model", capabilities: ["consult"] } },
  }), /requires baseUrl/);
});

test("the commented example config stays in sync with config init", () => {
  const fileConfig = parseJsonc(readFileSync(resolve("config/config.example.jsonc"), "utf8"));
  assert.deepEqual(fileConfig, createExampleConfig());
});


test("Grok Build configuration enforces agent-mode and finite-run boundaries", () => {
  const valid = createTestConfig();
  const provider = {
    adapter: "grok-build",
    command: "grok",
    model: "grok-4.6",
    models: ["grok-4.6"],
    capabilities: ["consult", "delegate"],
    allowedEfforts: ["low", "medium", "high"],
    maxTurnsCeiling: 24,
    profiles: { balanced: { reasoningEffort: "medium", maxTurns: 16, expectedTurns: 4 } },
    admission: { maxActive: 6, minStartIntervalMs: 1400, maxStartsPerWindow: 18, maxTurnsPerWindow: 18, windowMs: 60000 },
    delegate: { profile: "balanced", requireLinkedWorktree: true, denyBranches: ["main"] },
  };
  const configured = validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: { grok: provider },
  });
  assert.equal(configured.providers.grok.adapter, "grok-build");
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "integrated", model: "grok-4.6" },
    providers: { grok: { ...provider, capabilities: ["consult", "integrated"] } },
  }), /cannot enable Integrated mode/);
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: { grok: { ...provider, profiles: { deep: { reasoningEffort: "maximum", maxTurns: 16 } } } },
  }), /reasoningEffort must be low, medium, or high/);
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: { grok: { ...provider, pin: { sha256: "bad" } } },
  }), /64-character SHA-256/);
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: { grok: { ...provider, allowSubagents: true, noSubagents: true } },
  }), /conflicting allowSubagents\/noSubagents/);
  assert.throws(() => validateConfig({
    ...valid,
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: { grok: { ...provider, allowWebSearch: false, disableWebSearch: false } },
  }), /conflicting allowWebSearch\/disableWebSearch/);
});

test("the multi-coordinator fleet preset is valid and centralizes one nine-slot Grok controller", () => {
  const fleet = parseJsonc(readFileSync(resolve("examples/fleet/bridge.config.jsonc"), "utf8"));
  const configured = validateConfig(fleet, "examples/fleet/bridge.config.jsonc");
  assert.equal(configured.server.maxConcurrentRequests, 32);
  assert.equal(configured.server.allowUnauthenticatedLoopback, false);
  assert.equal(configured.providers["grok-build"].enabled, true);
  assert.equal(configured.providers["grok-build"].allowSubagents, true);
  assert.equal(configured.providers["grok-build"].allowWebSearch, true);
  assert.equal(configured.providers["grok-build"].noMemory, true);
  assert.equal(configured.providers["grok-build"].admission.maxActive, 9);
  assert.equal(configured.providers["grok-build"].admission.maxUnitsPerWindow, 18);
  assert.equal(configured.providers["cursor-ultra"].delegate.maxAgents, 16);
});
