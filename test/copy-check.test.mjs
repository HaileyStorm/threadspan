import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import {
  COPY_CHECK_ADAPTERS,
  COPY_CHECK_DISCLAIMER,
  COPY_CHECK_NO_PARTNERSHIP,
  DEFAULT_COPY_CHECK_OPTIONS,
  checkCopy,
  describeCopyCheck,
  recordPangramResult,
  resolveCopyCheckPolicy,
  sanitizeCopyCheckRecord,
  startPangramHandoff,
} from "../src/core/copy-check.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { naturalizeCopy } from "../src/core/copy-naturalizer.mjs";
import { reviewReleaseCopy } from "../src/core/release-copy-review.mjs";
import { EXPLICIT_ONLY_COMPONENT_IDS, createInstallerPlan } from "../src/installer/components.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

const NOW = "2026-08-18T12:00:00.000Z";
const SAMPLE = "Plain selected copy for an explicit user-started check.";

function enabledPolicy(overrides = {}) {
  return {
    permissionMode: "allow-manual-or-release",
    maxInputChars: 12_000,
    timeoutMs: 1_000,
    now: NOW,
    releaseScope: { localReview: true, externalChecks: true, adapters: ["pangram", "sapling", "winston"] },
    adapters: {
      pangram: { enabled: true },
      sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
      winston: { enabled: true, apiKeyEnv: "WINSTON_API_KEY" },
    },
    environment: {},
    ...overrides,
  };
}

function saplingFetch(score = 0.8) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ score, sentence_scores: [{ sentence: "secret-source", score: 1 }], text: "secret-source" }),
    };
  };
  return { fetchImpl, calls };
}

function winstonFetch(humanScore = 72) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ score: humanScore, credits_used: 12 }) };
  };
  return { fetchImpl, calls };
}

test("external copy-check defaults off and credentials do not enable it", async () => {
  assert.equal(DEFAULT_COPY_CHECK_OPTIONS.permissionMode, "off");
  assert.equal(DEFAULT_COPY_CHECK_OPTIONS.adapters.pangram.enabled, false);
  assert.equal(DEFAULT_COPY_CHECK_OPTIONS.adapters.sapling.enabled, false);
  assert.equal(DEFAULT_COPY_CHECK_OPTIONS.adapters.winston.enabled, false);
  const described = describeCopyCheck({
    environment: { SAPLING_API_KEY: "present-secret", WINSTON_API_KEY: "present-secret" },
  });
  assert.equal(described.permissionMode, "off");
  assert.equal(described.enabled, false);
  assert.equal(described.credentialsEnableFeature, false);
  assert.equal(described.automaticRuns, false);
  assert.equal(described.partnership, false);
  assert.equal(described.adapters.sapling.configured, false);
  assert.doesNotMatch(JSON.stringify(described), /present-secret/);
  const result = await checkCopy(SAMPLE, {
    permissionMode: "off",
    trigger: "manual",
    now: NOW,
    environment: { SAPLING_API_KEY: "present-secret" },
    adapters: { sapling: { enabled: false, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true } },
    fetch: async () => { throw new Error("must not fetch while off"); },
  });
  assert.equal(result.results[0].status, "disabled");
  assert.equal(result.failsRelease, false);
  assert.equal(result.averaged, false);
  assert.equal(result.provesAuthorship, false);
  assert.equal(result.controlsRewrite, false);
});

test("only manual or release triggers run; typing startup focus timer poll background are rejected", async () => {
  for (const trigger of ["typing", "startup", "focus", "timer", "poll", "background", "automatic"]) {
    await assert.rejects(checkCopy(SAMPLE, { ...enabledPolicy(), trigger }), /cannot run from typing, startup, focus, timer, poll, or background/i);
  }
  await assert.rejects(checkCopy(SAMPLE, { ...enabledPolicy(), trigger: "idle" }), /cannot run/);
});

test("ask-every-time skips without confirmation", async () => {
  const result = await checkCopy(SAMPLE, {
    ...enabledPolicy({ permissionMode: "ask-every-time" }),
    trigger: "manual",
    fetch: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(result.results[0].status, "skipped");
  assert.match(result.results[0].displayText, /ask-every-time/i);
});

test("Pangram is a manual handoff that copies, opens the official URL, and never fetches", async () => {
  const clipboard = [];
  const opened = [];
  let fetched = 0;
  const result = await checkCopy(SAMPLE, {
    ...enabledPolicy(),
    trigger: "manual",
    action: "pangram-handoff",
    writeClipboard: async (text) => { clipboard.push(text); },
    openUrl: async (url) => { opened.push(url); },
    fetch: async () => { fetched += 1; throw new Error("Pangram must not be submitted"); },
  });
  assert.deepEqual(clipboard, [SAMPLE]);
  assert.deepEqual(opened, [COPY_CHECK_ADAPTERS.pangram.officialUrl]);
  assert.equal(COPY_CHECK_ADAPTERS.pangram.officialUrl, "https://www.pangram.com/");
  assert.equal(fetched, 0);
  assert.equal(result.results[0].adapter, "pangram");
  assert.equal(result.results[0].status, "handoff");
  assert.doesNotMatch(JSON.stringify(result), /https:\/\/www\.pangram\.com/);
  assert.match(result.results[0].displayText, /does not submit or read the page/i);
});

test("Pangram default network and clipboard effect is zero until effects are injected", async () => {
  const handoff = await startPangramHandoff(SAMPLE, { permissionMode: "allow-manual-or-release", now: NOW });
  assert.equal(handoff.status, "handoff");
  assert.match(handoff.displayText, /manual handoff/i);
});

test("Pangram paste-back records a short score and rejects Copyleaks sandbox numbers", async () => {
  const recorded = await checkCopy(SAMPLE, {
    ...enabledPolicy(),
    trigger: "manual",
    action: "pangram-record",
    pangramResult: "12% AI",
  });
  assert.equal(recorded.results[0].status, "recorded");
  assert.equal(recorded.results[0].score, 0.12);
  assert.doesNotMatch(JSON.stringify(recorded), /12% AI/);
  const sandbox = recordPangramResult("Copyleaks sandbox score 87");
  assert.equal(sandbox.status, "error");
  assert.match(sandbox.displayText, /sandbox/i);
  assert.equal(sanitizeCopyCheckRecord({
    adapter: "copyleaks",
    status: "ok",
    score: 0.87,
    checkedAt: NOW,
    displayText: "Copyleaks sandbox 87",
  }), null);
});

test("Sapling requires retention acknowledgement and uses only the injected fetch plus env key", async () => {
  const { fetchImpl, calls } = saplingFetch(0.8);
  const skipped = await checkCopy(SAMPLE, {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: false },
        winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    trigger: "manual",
    requestedAdapters: ["sapling"],
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: fetchImpl,
  });
  assert.equal(skipped.results[0].status, "skipped");
  assert.match(skipped.results[0].displayText, /stored and used to improve/i);
  assert.equal(calls.length, 0);

  const ok = await checkCopy(SAMPLE, {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
        winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    trigger: "manual",
    requestedAdapters: ["sapling"],
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: fetchImpl,
  });
  assert.equal(ok.results[0].status, "ok");
  assert.equal(ok.results[0].score, 0.8);
  assert.equal(calls[0].url, "https://api.sapling.ai/api/v1/aidetect");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, SAMPLE);
  assert.equal(body.key, "sapling-secret");
  assert.equal(body.sent_scores, false);
  assert.doesNotMatch(JSON.stringify(ok), /sapling-secret|secret-source|sentence_scores/);
  assert.match(ok.results[0].displayText, /advisory/i);
});

test("Winston normalizes the human score and names a limited expiring trial", async () => {
  const { fetchImpl, calls } = winstonFetch(72);
  const longText = `${"Readable sentence. ".repeat(20)}`;
  const ok = await checkCopy(longText, {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: false, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: false },
        winston: { enabled: true, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    trigger: "manual",
    requestedAdapters: ["winston"],
    environment: { WINSTON_API_KEY: "winston-secret" },
    fetch: fetchImpl,
  });
  assert.equal(ok.results[0].status, "ok");
  assert.equal(ok.results[0].score, 0.28);
  assert.equal(calls[0].url, "https://api.gowinston.ai/v1/ai-content-detection");
  assert.equal(calls[0].init.headers.authorization, "Bearer winston-secret");
  assert.match(ok.results[0].displayText, /limited and expiring, not permanently free/i);
  assert.doesNotMatch(JSON.stringify(ok), /winston-secret|credits_used/);
  const short = await checkCopy("Too short.", {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: false, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: false },
        winston: { enabled: true, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    trigger: "manual",
    requestedAdapters: ["winston"],
    environment: { WINSTON_API_KEY: "winston-secret" },
    fetch: fetchImpl,
  });
  assert.equal(short.results[0].status, "skipped");
  assert.match(short.results[0].displayText, /300/);
});

test("GPTZero and Copyleaks stay unsupported later and are not working free APIs", async () => {
  assert.equal(COPY_CHECK_ADAPTERS.gptzero.runnable, false);
  assert.equal(COPY_CHECK_ADAPTERS.gptzero.advertisedAsWorkingFreeApi, false);
  assert.equal(COPY_CHECK_ADAPTERS.copyleaks.sandboxNumbersNeverReal, true);
  const result = await checkCopy(SAMPLE, {
    ...enabledPolicy(),
    trigger: "manual",
    requestedAdapters: ["gptzero", "copyleaks"],
    fetch: async () => { throw new Error("must not fetch unsupported adapters"); },
  });
  assert.equal(result.results[0].status, "unsupported");
  assert.equal(result.results[1].status, "unsupported");
  assert.match(result.results[0].displayText, /conditional\/later|not a working/i);
});

test("external timeout or missing fetch cannot fail a release review", async () => {
  const timed = await checkCopy(SAMPLE, {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
        winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
      },
      timeoutMs: 250,
    }),
    trigger: "release",
    requestedAdapters: ["sapling"],
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), 600);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(Object.assign(new Error("timeout"), { name: "TimeoutError", code: "timeout" }));
        }, { once: true });
      });
      return { ok: true, json: async () => ({ score: 0.1 }) };
    },
  });
  assert.equal(timed.failsRelease, false);
  assert.ok(["timeout", "error"].includes(timed.results[0].status));
  const release = await reviewReleaseCopy(SAMPLE, {
    userStarted: true,
    copyNaturalizer: { enabled: true, profile: "human", maxInputChars: 12_000, maxPasses: 1, timeoutMs: 180_000 },
    copyCheck: enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
        winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: async () => { throw new Error("upstream down"); },
  });
  assert.equal(release.releaseFailed, false);
  assert.equal(release.externalChecksFailRelease, false);
  assert.equal(release.averaged, false);
  assert.notEqual(release.local.status, undefined);
  assert.ok(["error", "timeout"].includes(release.external.results[0].status));
});

test("release companion requires an explicit user start and saved release scope", async () => {
  await assert.rejects(reviewReleaseCopy(SAMPLE, { userStarted: false }), /only when a user starts it/);
  const blocked = await reviewReleaseCopy(SAMPLE, {
    userStarted: true,
    copyCheck: enabledPolicy({ releaseScope: { localReview: true, externalChecks: false, adapters: [] } }),
    fetch: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(blocked.external.results[0].status, "skipped");
  assert.match(blocked.external.results[0].displayText, /release scope/i);
});

test("explicit empty and out-of-scope selections never expand to enabled adapters", async () => {
  let fetched = 0;
  const policy = enabledPolicy({
    releaseScope: { localReview: true, externalChecks: true, adapters: ["sapling"] },
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: async () => { fetched += 1; return { ok: true, json: async () => ({ score: 0.5 }) }; },
  });
  const empty = await checkCopy(SAMPLE, { ...policy, trigger: "manual", requestedAdapters: [] });
  assert.deepEqual(empty.results, []);
  const outOfScope = await checkCopy(SAMPLE, { ...policy, trigger: "release", requestedAdapters: ["winston"] });
  assert.deepEqual(outOfScope.results, []);
  assert.equal(fetched, 0);
});

test("Pangram permission is checked before clipboard or browser effects", async () => {
  let copied = 0;
  let opened = 0;
  const result = await checkCopy(SAMPLE, {
    ...enabledPolicy({ permissionMode: "off" }),
    trigger: "manual",
    action: "pangram-handoff",
    writeClipboard: async () => { copied += 1; },
    openUrl: async () => { opened += 1; },
  });
  assert.equal(result.results[0].status, "disabled");
  assert.equal(copied, 0);
  assert.equal(opened, 0);
});

test("Pangram human percentages invert and ambiguous percentages stay unscored", () => {
  assert.equal(recordPangramResult("87% human", { checkedAt: NOW }).score, 0.13);
  assert.equal(recordPangramResult("12% AI", { checkedAt: NOW }).score, 0.12);
  assert.equal(recordPangramResult("42%", { checkedAt: NOW }).score, null);
});

test("already-aborted API checks send no fetch and safe unsupported feedback survives", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  let fetched = 0;
  await assert.rejects(checkCopy(SAMPLE, {
    ...enabledPolicy({
      adapters: {
        pangram: { enabled: false },
        sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
        winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
      },
    }),
    trigger: "manual",
    requestedAdapters: ["sapling"],
    environment: { SAPLING_API_KEY: "sapling-secret" },
    fetch: async () => { fetched += 1; throw new Error("must not fetch"); },
    signal: controller.signal,
  }), /stop/);
  assert.equal(fetched, 0);
  const unsupported = await checkCopy(SAMPLE, { ...enabledPolicy(), trigger: "manual", requestedAdapters: ["copyleaks"] });
  assert.equal(unsupported.results[0].status, "unsupported");
  assert.match(unsupported.results[0].displayText, /Copyleaks/i);
});

test("external scores stay advisory and never decide a rewrite", async () => {
  const rewrite = await naturalizeCopy("It is important to note that this is really useful.", {
    enabled: true,
    rewriteAdapter: async () => "This is useful.",
  });
  assert.equal(rewrite.status, "suggested");
  assert.notEqual(rewrite.suggestion, rewrite.original);
  const described = describeCopyCheck(enabledPolicy());
  assert.equal(described.disclaimer, COPY_CHECK_DISCLAIMER);
  assert.match(described.partnershipNote, /no partnership/i);
  assert.equal(COPY_CHECK_NO_PARTNERSHIP.includes("no partnership"), true);
});

test("sanitized records keep only status score adapter timestamp and safe display text", () => {
  const raw = {
    adapter: "sapling",
    status: "ok",
    score: 0.4,
    checkedAt: NOW,
    displayText: "Sapling advisory AI-likelihood 0.40. Advisory only; cannot prove authorship.",
    text: SAMPLE,
    key: "secret",
    raw: { score: 0.4, text: SAMPLE },
    url: "https://api.sapling.ai/api/v1/aidetect?key=secret",
  };
  assert.deepEqual(sanitizeCopyCheckRecord(raw), {
    adapter: "sapling",
    status: "ok",
    score: 0.4,
    checkedAt: NOW,
    displayText: raw.displayText,
  });
  assert.equal(sanitizeCopyCheckRecord({
    adapter: "sapling",
    status: "ok",
    score: 0.4,
    checkedAt: NOW,
    displayText: "See https://api.sapling.ai/api/v1/aidetect?key=secret",
  }), null);
});

test("config rejects unknown copyCheck fields and keeps 180s rewrite timeout untouched", () => {
  const valid = createTestConfig();
  assert.equal(valid.copyCheck.permissionMode, "off");
  assert.equal(valid.copyNaturalizer.timeoutMs, 180_000);
  assert.throws(() => validateConfig({ ...valid, copyCheck: { permissionMode: "always" } }), /permissionMode/);
  assert.throws(() => validateConfig({ ...valid, copyCheck: { apiKey: "secret" } }), /unsupported fields/);
  assert.throws(() => validateConfig({
    ...valid,
    copyCheck: { adapters: { sapling: { enabled: true, apiKey: "secret", acknowledgedRetention: false } } },
  }), /unsupported fields/);
});

test("BridgeService owner check stores sanitized results and does not persist source text", async (t) => {
  const { fetchImpl } = saplingFetch(0.55);
  const copyCheckConfig = enabledPolicy({
    adapters: {
      pangram: { enabled: false },
      sapling: { enabled: true, apiKeyEnv: "SAPLING_API_KEY", acknowledgedRetention: true },
      winston: { enabled: false, apiKeyEnv: "WINSTON_API_KEY" },
    },
  });
  delete copyCheckConfig.now;
  delete copyCheckConfig.environment;
  const service = new BridgeService(createTestConfig({
    copyCheck: copyCheckConfig,
  }), {
    logger: silentLogger(),
    copyCheckEffects: { fetch: fetchImpl, environment: { SAPLING_API_KEY: "sapling-secret" } },
  });
  t.after(() => service.close());
  const checked = await service.checkCopy({ text: SAMPLE, trigger: "manual", adapters: ["sapling"] });
  assert.equal(checked.results[0].status, "ok");
  const state = await service.threadspanState();
  assert.equal(state.copyCheck.permissionMode, "allow-manual-or-release");
  assert.equal(state.copyCheck.lastResults[0].adapter, "sapling");
  assert.doesNotMatch(JSON.stringify(state.copyCheck), /sapling-secret|Plain selected copy/);
});

test("copy-check HTTP is owner-only and accepts only explicit POST actions", async (t) => {
  process.env.THREADSPAN_COPY_OWNER = "owner-only";
  process.env.THREADSPAN_COPY_CONNECTOR = "connector-only";
  t.after(() => {
    delete process.env.THREADSPAN_COPY_OWNER;
    delete process.env.THREADSPAN_COPY_CONNECTOR;
  });
  const calls = [];
  const service = {
    checkCopy: async (input) => { calls.push(["check", input]); return { status: "ok", results: [], failsRelease: false }; },
    reviewReleaseCopy: async (input) => { calls.push(["release", input]); return { releaseFailed: false, userStarted: input.userStarted }; },
  };
  const server = createHttpServer(service, {
    server: {
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: "THREADSPAN_COPY_OWNER",
      connectorTokenEnv: "THREADSPAN_COPY_CONNECTOR",
      allowUnauthenticatedLoopback: false,
      maxBodyBytes: 4096,
      requestTimeoutMs: 5000,
      maxConcurrentRequests: 4,
      allowedOrigins: [],
    },
  });
  t.after(() => closeHttpServer(server));
  const bound = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${bound.port}`;
  const owner = { authorization: "Bearer owner-only", "content-type": "application/json" };
  assert.equal((await fetch(`${base}/v1/copy/check`)).status, 401);
  assert.equal((await fetch(`${base}/v1/copy/check`, { headers: { authorization: "Bearer connector-only" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/copy/check`, { method: "GET", headers: owner })).status, 405);
  const checked = await fetch(`${base}/v1/copy/check`, { method: "POST", headers: owner, body: JSON.stringify({ text: SAMPLE, trigger: "manual" }) });
  assert.equal(checked.status, 200);
  const released = await fetch(`${base}/v1/copy/release-review`, { method: "POST", headers: owner, body: JSON.stringify({ text: SAMPLE }) });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).userStarted, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["check", "release"]);
});

test("selection=all never installs copy-check; the component stays explicit-only", () => {
  assert.equal(EXPLICIT_ONLY_COMPONENT_IDS.includes("copy-check"), true);
  const plan = createInstallerPlan({ installRoot: "/tmp/threadspan-copy-check-plan", selection: "all", planId: "all-copy-check" });
  assert.equal(plan.selectedComponents.includes("copy-check"), false);
});

test("resolveCopyCheckPolicy rejects unknown adapter config", () => {
  assert.throws(() => resolveCopyCheckPolicy({ adapters: { gptzero: { enabled: true } } }), /unsupported fields/);
});
