import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { selectTip } from "../src/core/tips.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("tip selection is deterministic, bounded, and uses only local capability signals", async () => {
  const signals = {
    mode: "consult",
    routeVerified: true,
    qualifiedFallbackCount: 0,
    compatibilityChanged: false,
    prompt: "private prompt",
    accountId: "private-account",
    credential: "private-secret",
  };
  const first = selectTip(signals);
  assert.deepEqual(selectTip(signals), first);
  assert.equal(first.id, "try-consult");
  assert.ok(first.text.length <= 180);
  assert.doesNotMatch(JSON.stringify(first), /private prompt|private-account|private-secret/);
  assert.equal(selectTip({}), null);

  assert.equal(selectTip({ mode: "delegate", routeVerified: false }).id, "route-unverified");
  assert.equal(selectTip({ mode: "delegate", routeVerified: true, qualifiedFallbackCount: 99 }).id, "qualified-fallback");
  assert.equal(selectTip({ mode: "integrated", routeVerified: true, compatibilityChanged: true }).id, "compatibility-review");

  const source = await readFile(new URL("../src/core/tips.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|ProviderRegistry|apiKey|authorization/i);
  assert.doesNotMatch(source, /Math\.random|Date\.now/);
});

test("tips configuration is disabled by default and strictly bounded", () => {
  const base = createTestConfig();
  assert.equal(base.tips.enabled, false);
  assert.equal(base.tips.cooldownMs, 86_400_000);
  assert.equal(base.tips.modelRefinement.enabled, false);
  assert.equal(base.tips.modelRefinement.privacy, "deny");
  assert.equal(base.tips.modelRefinement.maxCallsPerSession, 1);
  assert.equal(base.tips.ask.enabled, false);

  const enabled = validateConfig({ ...base, tips: { enabled: true, cooldownMs: 60_000 } });
  assert.equal(enabled.tips.enabled, true);
  assert.equal(enabled.tips.cooldownMs, 60_000);
  assert.equal(enabled.tips.modelRefinement.enabled, false);
  const modelEnabled = validateConfig({
    ...base,
    tips: {
      enabled: true,
      modelRefinement: {
        enabled: true,
        provider: "mock",
        model: "mock-model",
        privacy: "sanitized-tip-context-only",
        maxCallsPerSession: 1,
        maxOutputTokens: 64,
        maxLatencyMs: 2_000,
        cooldownMs: 60_000,
      },
      ask: { enabled: true, maxTurnsPerSession: 2, maxOutputTokens: 96, maxLatencyMs: 3_000 },
    },
  });
  assert.equal(modelEnabled.tips.modelRefinement.model, "mock-model");
  assert.equal(modelEnabled.tips.ask.maxTurnsPerSession, 2);
  assert.throws(() => validateConfig({ ...base, tips: { enabled: true, cooldownMs: 59_999 } }), /tips\.cooldownMs/);
  assert.throws(() => validateConfig({ ...base, tips: { enabled: true, cooldownMs: 60_000, prompt: "no" } }), /unsupported fields: prompt/);
  assert.throws(() => validateConfig({ ...base, tips: { modelRefinement: { maxCallsPerSession: 2 } } }), /tips\.modelRefinement\.maxCallsPerSession/);
  assert.throws(() => validateConfig({ ...base, tips: { ask: { maxTurnsPerSession: 5 } } }), /tips\.ask\.maxTurnsPerSession/);
});

test("runtime HUD omits disabled tips and publishes one compact sanitized tip when enabled", async () => {
  const disabled = new BridgeService(createTestConfig(), { logger: silentLogger() });
  try {
    assert.equal("tip" in (await disabled.threadspanState()).hud, false);
  } finally {
    await disabled.close();
  }

  const enabled = new BridgeService(createTestConfig({ tips: { enabled: true, cooldownMs: 60_000 } }), { logger: silentLogger() });
  try {
    const tip = (await enabled.threadspanState()).hud.tip;
    assert.deepEqual(Object.keys(tip).sort(), ["cooldownMs", "glossaryHref", "id", "text"]);
    assert.equal(tip.cooldownMs, 60_000);
    assert.match(tip.glossaryHref, /^#glossary-[a-z0-9-]+$/);
    assert.ok(tip.text.length <= 180);
    assert.doesNotMatch(JSON.stringify(tip), /prompt|thread|account|credential|mock-model/i);
  } finally {
    await enabled.close();
  }
});

test("model controls publish only after explicit privacy, Consult capability, exact model, and live availability gates", async () => {
  const modelPolicy = {
    enabled: true,
    provider: "mock",
    model: "mock-model",
    privacy: "sanitized-tip-context-only",
    maxCallsPerSession: 1,
    maxOutputTokens: 64,
    maxLatencyMs: 2_000,
    cooldownMs: 60_000,
  };
  const gated = new BridgeService(createTestConfig({
    tips: {
      enabled: true,
      modelRefinement: modelPolicy,
      ask: { enabled: true, maxTurnsPerSession: 2, maxOutputTokens: 96, maxLatencyMs: 3_000 },
    },
  }), { logger: silentLogger() });
  try {
    const model = (await gated.threadspanState()).hud.tip.model;
    assert.equal(model.provider, "mock");
    assert.equal(model.model, "mock-model");
    assert.equal(model.maxCallsPerSession, 1);
    assert.equal(model.maxOutputTokens, 64);
    assert.equal(model.settings.accountRouting, "inherit-selected-provider-account");
    assert.equal(model.settings.providerAndHostSettings, "inherit");
    assert.equal(model.settings.privacy, "sanitized-tip-context-only");
    assert.equal(model.settings.web, false);
    assert.equal(model.settings.subagents, false);
    assert.equal(model.ask.maxTurnsPerSession, 2);
    assert.doesNotMatch(JSON.stringify(model), /accountId|threadId|prompt|credential/i);
  } finally {
    await gated.close();
  }

  for (const failedPolicy of [
    { ...modelPolicy, privacy: "deny" },
    { ...modelPolicy, provider: "missing" },
    { ...modelPolicy, model: "missing-model" },
  ]) {
    const service = new BridgeService(createTestConfig({ tips: { enabled: true, modelRefinement: failedPolicy } }), { logger: silentLogger() });
    try {
      assert.equal("model" in (await service.threadspanState()).hud.tip, false);
    } finally {
      await service.close();
    }
  }
});

test("tip model calls recheck gates server-side, stay ephemeral, and enforce cooldown and turn budgets", async () => {
  const serviceSource = await readFile(new URL("../src/bridge/service.mjs", import.meta.url), "utf8");
  assert.match(serviceSource, /AbortSignal\.timeout\(effectiveInput\.timeoutMs\)/);
  assert.match(serviceSource, /bridge_ephemeral_tip: true/);
  assert.match(serviceSource, /current local heuristic did not warrant this tip/);
  assert.match(serviceSource, /#scheduleTipConversationExpiry\(threadId, now\)/);
  assert.match(serviceSource, /timer\.unref\?\.\(\)/);
  const service = new BridgeService(createTestConfig({
    tips: {
      enabled: true,
      modelRefinement: {
        enabled: true,
        provider: "mock",
        model: "mock-model",
        privacy: "sanitized-tip-context-only",
        maxCallsPerSession: 1,
        maxOutputTokens: 64,
        maxLatencyMs: 2_000,
        cooldownMs: 60_000,
      },
      ask: { enabled: true, maxTurnsPerSession: 2, maxOutputTokens: 96, maxLatencyMs: 3_000 },
    },
  }), { logger: silentLogger() });
  try {
    const refinement = {
      question: "caller text is replaced server-side",
      provider: "mock",
      model: "mock-model",
      metadata: { threadspan_tip_kind: "refine", threadspan_tip_id: "try-consult" },
    };
    await assert.rejects(service.consult({ ...refinement, context: "private host prompt" }), /cannot carry account identifiers, host context/);
    const refined = await service.consult(refinement);
    assert.deepEqual(Object.keys(refined), ["text"]);
    assert.deepEqual(service.stats().sessions, { responses: 0, threads: 0, ttlMs: 60_000, maxEntries: 100 });
    await assert.rejects(service.consult(refinement), /budget or cooldown/);
    await assert.rejects(service.consult({
      question: "Wrong heuristic tip",
      provider: "mock",
      model: "mock-model",
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-delegate" },
    }), /local heuristic did not warrant/);
    await assert.rejects(service.consult({
      question: "Empty thread bypass",
      provider: "mock",
      model: "mock-model",
      threadId: "",
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    }), /threadId is malformed/);

    const first = await service.consult({
      question: "What does this boundary mean?",
      provider: "mock",
      model: "mock-model",
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    });
    assert.equal(typeof first.threadId, "string");
    assert.deepEqual(Object.keys(first).sort(), ["text", "threadId"]);
    const second = await service.consult({
      question: "When should I use it?",
      provider: "mock",
      model: "mock-model",
      threadId: first.threadId,
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    });
    assert.equal(second.threadId, first.threadId);
    await assert.rejects(service.consult({
      question: "One more",
      provider: "mock",
      model: "mock-model",
      threadId: first.threadId,
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    }), /turn budget is exhausted/);
    assert.equal(service.stats().sessions.responses, 0);
    assert.equal(service.stats().sessions.threads, 0);

    service.config.tips.modelRefinement.privacy = "deny";
    await assert.rejects(service.consult({
      question: "Privacy changed",
      provider: "mock",
      model: "mock-model",
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    }), /privacy.*gate failed/i);
    service.config.tips.enabled = false;
    await assert.rejects(service.consult({
      question: "Disabled",
      provider: "mock",
      model: "mock-model",
      metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: "try-consult" },
    }), /Tips are disabled/);
  } finally {
    await service.close();
  }
});
