import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createExampleConfig, deepMerge, expandEnvironment, loadConfig, parseJsonc, validateConfig } from "../src/core/config.mjs";
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

test("configuration defaults to Technical partner and preserves custom Voice extensions", () => {
  const defaults = createTestConfig();
  assert.equal(defaults.voice.selectedProfile, "technical-partner");
  const configured = validateConfig({
    ...defaults,
    voice: {
      selectedProfile: "custom",
      futureConfig: true,
      profiles: [{
        id: "custom",
        name: "Custom",
        userPromise: "A bounded custom voice.",
        parameters: { directness: 4, warmth: 4, technicalDepth: 5, progressCadence: 2, uncertaintyDisclosure: 5, correctionExplicitness: 5, futureParameter: 8 },
        preferredTerms: ["evidence"],
        avoidedTerms: [],
        futureProfile: { retained: true },
      }],
    },
  });
  assert.equal(configured.voice.futureConfig, true);
  assert.equal(configured.voice.profiles[0].parameters.futureParameter, 8);
  assert.deepEqual(configured.voice.profiles[0].futureProfile, { retained: true });
});

test("installer-managed Voice is a lower-precedence runtime layer", () => {
  const root = mkdtempSync(join(tmpdir(), "threadspan-voice-config-"));
  try {
    const configPath = join(root, "config.jsonc");
    const componentDirectory = join(root, "threadspan", "components");
    mkdirSync(componentDirectory, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(createExampleConfig(), null, 2)}\n`);
    writeFileSync(join(componentDirectory, "voice-profiles.json"), `${JSON.stringify({ schemaVersion: 1, component: "voice-profiles", selectedProfile: "calm-guide", profiles: [] }, null, 2)}\n`);
    assert.equal(loadConfig(configPath).voice.selectedProfile, "calm-guide");
    const explicit = createExampleConfig();
    explicit.voice = { selectedProfile: "concise-operator", profiles: [] };
    writeFileSync(configPath, `${JSON.stringify(explicit, null, 2)}\n`);
    assert.equal(loadConfig(configPath).voice.selectedProfile, "concise-operator");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validateConfig rejects invalid concurrency and provider ids", () => {
  const valid = createTestConfig();
  assert.throws(() => validateConfig({ ...valid, server: { ...valid.server, maxConcurrentRequests: 0 } }), ConfigError);
  assert.throws(() => validateConfig({ ...valid, providers: { "bad id": { adapter: "mock" } } }), ConfigError);
  assert.throws(() => validateConfig({
    ...valid,
    server: { ...valid.server, authTokenFile: resolve("same-token"), connectorTokenFile: resolve("same-token") },
  }), /must identify distinct files/);
  const normalized = validateConfig({
    ...valid,
    accounts: { ...valid.accounts, fallback: { enabled: true, maxCandidates: 16 } },
  });
  assert.equal(normalized.accounts.fallback.maxCandidates, 1, "legacy values cannot authorize more than one alternate");
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

test("provider web metadata accepts only strict credential-free HTTPS URLs", () => {
  const valid = createTestConfig();
  const configured = validateConfig({
    ...valid,
    providers: {
      ...valid.providers,
      mock: {
        ...valid.providers.mock,
        officialUrl: "https://provider.example",
        accountUrl: "https://provider.example/account",
        usageUrl: "https://provider.example/usage",
      },
    },
  });
  assert.equal(configured.providers.mock.officialUrl, "https://provider.example");
  assert.equal(configured.providers.mock.accountUrl, "https://provider.example/account");
  assert.equal(configured.providers.mock.usageUrl, "https://provider.example/usage");
  const omitted = validateConfig({
    ...valid,
    providers: { ...valid.providers, mock: { ...valid.providers.mock } },
  });
  for (const key of ["officialUrl", "accountUrl", "usageUrl"]) {
    assert.equal(Object.hasOwn(omitted.providers.mock, key), false, `${key} remains absent after validation when omitted`);
    for (const value of [
      "",
      "http://provider.example",
      "https:provider.example/account",
      "https://provider.example\\account",
      "https://user:secret@provider.example/account",
      "https://@provider.example/account",
      "https://provider.example/account?token=secret",
      "https://provider.example/account?",
      "https://provider.example/account#billing",
      "https://provider.example/\u0085account",
      "/provider/account",
      " https://provider.example/account",
    ]) {
      assert.throws(() => validateConfig({
        ...valid,
        providers: { ...valid.providers, mock: { ...valid.providers.mock, [key]: value } },
      }), new RegExp(`${key}.*(?:HTTPS|credentials|query string|bounded)`));
    }
  }
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

test("provider examples keep cardless discovery candidates disabled and value-free", () => {
  const examples = parseJsonc(readFileSync(resolve("config/providers.examples.jsonc"), "utf8"));
  const candidates = [
    ["mistral-api-free-candidate", "MISTRAL_API_KEY"],
    ["groqcloud-free-candidate", "GROQ_API_KEY"],
    ["cloudflare-workers-ai-free-candidate", "CLOUDFLARE_API_TOKEN"],
    ["gemini-api-free-candidate", "GEMINI_API_KEY"],
  ];
  for (const [id, envName] of candidates) {
    const provider = examples.providers[id];
    assert.equal(provider.enabled, false);
    assert.equal(provider.adapter, "openai-chat");
    assert.equal(provider.apiKeyEnv, envName);
    assert.equal(provider.paidUpgradeAllowed, false);
    assert.equal(provider.requiresLiveCardlessCheck, true);
    assert.equal(provider.offerEndDate, null);
    assert.equal(provider.visibilityFreshnessDays, 7);
    assert.match(provider.officialUrl, /^https:\/\//);
  }
  assert.equal(Object.hasOwn(examples.providers, "openrouter"), false, "OpenRouter is already live elsewhere and is not duplicated as a scout candidate");
  assert.doesNotMatch(JSON.stringify(examples), /apiKey\s*[:=]\s*["'][^$]/i);
});

test("branching policy is bounded, convergence-stopped, and preserves native routing defaults", () => {
  const valid = createTestConfig();
  const configured = validateConfig({
    ...valid,
    branching: { maxBranches: 2, maxTurnsPerBranch: 5, maxCostUsd: 1.25 },
  });
  assert.equal(configured.defaults.provider, valid.defaults.provider);
  assert.equal(configured.defaults.model, valid.defaults.model);
  assert.equal(configured.branching.maxBranches, 2);
  assert.equal(configured.branching.synthesisOwner, "caller");
  assert.deepEqual(configured.branching.activationReasons, ["independent-evidence", "divergent-ideation", "disjoint-writes"]);
  for (const factor of ["capability", "live-availability", "quota", "credit", "privacy", "latency", "diversity-value"]) {
    assert.ok(configured.branching.routingFactors.includes(factor));
  }
  assert.throws(() => validateConfig({ ...valid, branching: { stopOnConvergence: false } }), /stopOnConvergence/);
  assert.throws(() => validateConfig({ ...valid, branching: { routingFactors: ["capability"] } }), /routingFactors/);
  assert.throws(() => validateConfig({ ...valid, branching: { toolPolicy: "always" } }), /decision-useful-only/);
  assert.throws(() => validateConfig({ ...valid, branching: { synthesisOwner: "branch" } }), /caller/);
});

test("Codex native worker permits visible overrides but rejects hidden argv settings", () => {
  const valid = createTestConfig();
  const provider = {
    adapter: "codex-native-worker",
    model: "gpt-5.6-sol",
    models: ["gpt-5.6-sol"],
    capabilities: ["delegate"],
  };
  const configured = validateConfig({
    ...valid,
    defaults: { provider: "native", mode: "delegate", model: "gpt-5.6-sol" },
    providers: { native: provider },
  });
  assert.equal(configured.providers.native.sandbox, undefined);
  assert.equal(configured.providers.native.approvalPolicy, undefined);
  for (const argument of ["--ignore-user-config", "--sandbox=read-only", "--dangerously-bypass-approvals-and-sandbox", "--config=approval_policy=\"never\""]) {
    assert.throws(() => validateConfig({
      ...valid,
      defaults: { provider: "native", mode: "delegate", model: "gpt-5.6-sol" },
      providers: { native: { ...provider, commandArgs: [argument] } },
    }), /hidden profile, provider, base, or execution-settings override/);
  }
});

test("connection recovery remains bounded, adapter-specific, and gate-preserving", () => {
  const valid = createTestConfig();
  const configured = validateConfig({
    ...valid,
    connectionRecovery: { maxReconnectAttempts: 2, maxRebindAttempts: 1, maxHandleAudits: 1 },
  });
  assert.equal(configured.connectionRecovery.maxReconnectAttempts, 2);
  assert.equal(configured.connectionRecovery.reroutePolicy, "existing-gates-only");
  assert.equal(configured.connectionRecovery.reauthPolicy, "provider-native-only");
  assert.equal(configured.connectionRecovery.auditHandlesOnParentInterruption, true);
  assert.equal(configured.selfHeal.subsystemOwner, "compatibility-watch");
  assert.deepEqual(configured.selfHeal.phases, ["repair", "meta", "meta-meta"]);
  assert.equal(configured.selfHeal.maxAnalysisDepth, 2);
  assert.equal(configured.selfHeal.immediateRecoveryFirst, true);
  assert.equal(configured.selfHeal.contributionPolicy, "sanitized-proposal-only");
  assert.equal(configured.selfHeal.localMonitorReview, "required");
  assert.equal(configured.selfHeal.autoMerge, false);
  assert.throws(() => validateConfig({ ...valid, connectionRecovery: { maxReconnectAttempts: 9 } }), /maxReconnectAttempts/);
  assert.throws(() => validateConfig({ ...valid, connectionRecovery: { preserveResumableState: false } }), /preserveResumableState/);
  assert.throws(() => validateConfig({ ...valid, connectionRecovery: { reroutePolicy: "any-provider" } }), /existing-gates-only/);
  assert.throws(() => validateConfig({ ...valid, selfHeal: { maxAnalysisDepth: 3 } }), /must remain 2/);
  assert.throws(() => validateConfig({ ...valid, selfHeal: { subsystemOwner: "self-heal" } }), /compatibility-watch/);
  assert.throws(() => validateConfig({ ...valid, selfHeal: { immediateRecoveryFirst: false } }), /immediateRecoveryFirst/);
  assert.throws(() => validateConfig({ ...valid, selfHeal: { autoMerge: true } }), /autoMerge:false/);
});

test("config environment and secret-file sources preserve canonical account isolation", () => {
  const root = mkdtempSync(join(tmpdir(), "threadspan-config-isolation-"));
  try {
    const activeCodexHome = join(root, "active-codex");
    mkdirSync(activeCodexHome);
    const valid = createTestConfig();
    assert.throws(() => validateConfig({
      ...valid,
      accounts: { ...valid.accounts, profileSources: { same: { kind: "codex-home", root: activeCodexHome } } },
    }, "injected", { environment: { ...process.env, CODEX_HOME: activeCodexHome } }), /must not target the current\/default Codex profile root/);

    const secretPath = join(root, "provider.key");
    const provider = { adapter: "mock", model: "m", capabilities: ["consult"], accountSources: { primary: { kind: "secret-file", path: secretPath } } };
    const normalized = validateConfig({
      ...valid,
      defaults: { provider: "one", mode: "consult", model: "m" },
      providers: { one: provider },
    });
    assert.equal(normalized.providers.one.accountSources.primary.path, resolve(secretPath));
    assert.throws(() => validateConfig({
      ...valid,
      defaults: { provider: "one", mode: "consult", model: "m" },
      providers: { one: provider, two: { ...provider, accountSources: { secondary: { kind: "secret-file", path: secretPath } } } },
    }), /duplicates secret-file path/);
    assert.throws(() => validateConfig({
      ...valid,
      defaults: { provider: "one", mode: "consult", model: "m" },
      providers: { one: { ...provider, accountSources: { primary: { kind: "secret-file", path: "relative.key" } } } },
    }), /path must be absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
