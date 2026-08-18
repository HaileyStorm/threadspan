import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  aggregateUsageEvents,
  forecastRecentBurn,
  normalizeUsageEvent,
  resolveUsageLedgerPath,
  UsageLedger,
  USAGE_LEDGER_SCHEMA_VERSION,
} from "../src/core/usage-ledger.mjs";

function event(overrides = {}) {
  return {
    timestamp: "2026-08-17T12:00:00.000Z",
    provider: "openai",
    model: "gpt-5.6-sol",
    mode: "consult",
    status: "completed",
    durationMs: 25,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 2,
    reasoningTokens: 1,
    evidenceClass: "provider-reported",
    ...overrides,
  };
}

async function temporaryLedger(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-usage-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "portable path ü", "usage.jsonl");
  return { root, path, ledger: new UsageLedger({ path, ...options }) };
}

test("normalizes the exact privacy-minimized usage schema", async (t) => {
  const { path, ledger } = await temporaryLedger(t);
  const stored = await ledger.append({
    timestamp: "2026-08-17T12:34:56Z",
    providerId: " openai ",
    modelId: "gpt-5.6-sol",
    mode: "integrated",
    status: "success",
    duration_ms: 42,
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      cache_read_input_tokens: 3,
      reasoning_tokens: 2,
      cost_in_usd_ticks: 9001,
      model_calls: 4,
      secret: "nested-secret",
    },
    process_count: 2,
    evidence_class: "live-provider",
    prompt: "private prompt",
    taskId: "private-task",
    credential: "private-key",
    rawToolOutput: "private-output",
    source: "private-source",
  });
  await ledger.flush();

  assert.deepEqual(stored, {
    schemaVersion: USAGE_LEDGER_SCHEMA_VERSION,
    timestamp: "2026-08-17T12:34:56.000Z",
    provider: "openai",
    accountId: "unknown/default",
    model: "gpt-5.6-sol",
    mode: "integrated",
    status: "success",
    durationMs: 42,
    inputTokens: 11,
    outputTokens: 7,
    cachedInputTokens: 3,
    reasoningTokens: 2,
    evidenceClass: "live-provider",
    observedMetrics: ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "costTicks", "processCount", "turnCount"],
    costTicks: 9001,
    processCount: 2,
    turnCount: 4,
  });
  const contents = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(contents.trim()), stored);
  for (const forbidden of ["private prompt", "private-task", "private-key", "private-output", "private-source", "nested-secret"]) {
    assert.doesNotMatch(contents, new RegExp(forbidden));
  }
});

test("rejects invalid dimensions and counters before writing", async (t) => {
  const { path, ledger } = await temporaryLedger(t);
  await assert.rejects(ledger.append(event({ provider: "openai\ninjected" })), /provider/);
  await assert.rejects(ledger.append(event({ inputTokens: -1 })), /inputTokens/);
  await assert.rejects(ledger.append(event({ durationMs: 1.5 })), /durationMs/);
  await assert.rejects(ledger.append(event({ timestamp: "not-a-date" })), /timestamp/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("returns UTC daily and Monday-week aggregates by provider and model", async (t) => {
  const { ledger } = await temporaryLedger(t, { recentLimit: 3 });
  await ledger.append(event({ timestamp: "2026-08-09T23:59:59Z", provider: "cursor", model: "cursor", inputTokens: 1 }));
  await ledger.append(event({ timestamp: "2026-08-10T00:00:00Z", provider: "openai", model: "sol", inputTokens: 2, costTicks: 10 }));
  await ledger.append(event({ timestamp: "2026-08-12T01:00:00Z", provider: "openai", model: "sol", inputTokens: 3, status: "failed" }));
  await ledger.append(event({ timestamp: "2026-08-12T11:00:00Z", provider: "cursor", model: "cursor", inputTokens: 4 }));
  await ledger.append(event({ timestamp: "2026-08-13T00:00:00Z", provider: "future", model: "future", inputTokens: 100 }));

  const summary = await ledger.summarize({ now: "2026-08-12T12:00:00Z" });
  assert.equal(summary.dayStart, "2026-08-12T00:00:00.000Z");
  assert.equal(summary.weekStart, "2026-08-10T00:00:00.000Z");
  assert.equal(summary.daily.eventCount, 2);
  assert.equal(summary.daily.inputTokens, 7);
  assert.deepEqual(summary.daily.statuses, { failed: 1, completed: 1 });
  assert.equal(summary.weekly.eventCount, 3);
  assert.equal(summary.weekly.inputTokens, 9);
  assert.equal(summary.weekly.costTicks, 10);
  assert.equal(summary.providers.openai.eventCount, 2);
  assert.equal(summary.providers.cursor.eventCount, 2);
  assert.equal(summary.models.sol.inputTokens, 5);
  assert.deepEqual(summary.recentEvents.map((entry) => entry.provider), ["future", "cursor", "openai"]);
});

test("pure aggregation ignores malformed or unsanitized records", () => {
  const valid = normalizeUsageEvent(event());
  const summary = aggregateUsageEvents([
    valid,
    { ...valid, prompt: "must-not-pass" },
    { ...valid, inputTokens: -1 },
    null,
  ], { now: "2026-08-17T13:00:00Z", recentLimit: 5 });
  assert.equal(summary.scannedEvents, 1);
  assert.equal(summary.daily.inputTokens, 10);
  assert.deepEqual(summary.recentEvents, [valid]);
});

test("recent-burn forecasts distinguish no data, observed zero, and missing metrics", () => {
  const now = "2026-08-17T18:00:00Z";
  const noData = forecastRecentBurn([], {
    now,
    entitlements: [{ provider: "p", accountId: "acct_none", quota: { unit: "turns" } }],
  });
  assert.equal(noData.accounts[0].status, "no-data");
  assert.equal(noData.accounts[0].burn.amount, null);

  const zero = forecastRecentBurn([
    normalizeUsageEvent(event({ timestamp: "2026-08-17T12:00:00Z", provider: "p", accountId: "acct_zero", turnCount: 0 })),
    normalizeUsageEvent(event({ timestamp: "2026-08-17T18:00:00Z", provider: "p", accountId: "acct_zero", turnCount: 0 })),
  ], { now });
  assert.equal(zero.accounts[0].status, "zero-burn");
  assert.equal(zero.accounts[0].burn.amount, 0);
  assert.equal(zero.accounts[0].exhaustion, null);

  const missing = forecastRecentBurn([
    normalizeUsageEvent({ timestamp: now, provider: "p", accountId: "acct_missing", model: "m", mode: "consult", status: "failed", evidenceClass: "live-provider" }),
  ], {
    now,
    entitlements: [{ provider: "p", accountId: "acct_missing", quota: { unit: "tokens", remaining: 10, source: "provider-api" } }],
  });
  assert.equal(missing.accounts[0].status, "stale-or-missing-metric");
  assert.equal(missing.accounts[0].burn.amount, null);
  assert.equal(missing.accounts[0].exhaustion, null);
});

test("forecasts aggregate only identical entitlement identity, unit, and window semantics", () => {
  const now = "2026-08-17T18:00:00Z";
  const accounts = ["acct_a", "acct_b"];
  const events = accounts.flatMap((accountId) => [
    normalizeUsageEvent(event({ timestamp: "2026-08-17T12:00:00Z", provider: "p", accountId, inputTokens: 100, outputTokens: 50 })),
    normalizeUsageEvent(event({ timestamp: now, provider: "p", accountId, inputTokens: 100, outputTokens: 50 })),
  ]);
  const compatible = forecastRecentBurn(events, {
    now,
    entitlements: accounts.map((accountId) => ({ provider: "p", accountId, quota: { entitlementIdentity: "shared-pool", unit: "tokens", windowMs: 86_400_000 } })),
  });
  assert.equal(compatible.accounts.length, 2);
  assert.equal(compatible.providers.p.length, 1);
  assert.equal(compatible.combined.length, 1);
  assert.deepEqual(compatible.combined[0].scope.accountIds, accounts);
  assert.equal(compatible.combined[0].burn.amount, 600);
  assert.equal(compatible.providers.p[0].compatibilityKey.split("\u0000")[0], "shared-pool");
  assert.equal(compatible.combined[0].compatibilityKey.split("\u0000")[0], "shared-pool");

  const incompatible = forecastRecentBurn(events, {
    now,
    entitlements: [
      { provider: "p", accountId: "acct_a", quota: { entitlementIdentity: "shared-pool", unit: "tokens", windowMs: 86_400_000 } },
      { provider: "p", accountId: "acct_b", quota: { entitlementIdentity: "shared-pool", unit: "requests", windowMs: 3_600_000 } },
    ],
  });
  assert.equal(incompatible.providers.p.length, 2);
  assert.equal(incompatible.combined.length, 2);
});

test("authoritative remaining produces a conservative rounded range while bad evidence fails closed", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "15:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));
  const options = {
    now,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: { entitlementIdentity: "turn-week", unit: "turns", windowMs: 604_800_000, remaining: 20, resetAt: "2026-08-19T00:00:00Z", source: "provider-api", observedAt: now } }],
  };
  const forecast = forecastRecentBurn(events, options).accounts[0];
  assert.equal(forecast.status, "projected");
  assert.match(forecast.burn.rateLabel, /turns\/hour/);
  assert.match(forecast.exhaustion.label, /^\d+h–\d+h$/);
  assert.equal(forecast.exhaustion.relation, "before-reset-or-renewal");
  assert.equal(forecast.entitlement.source, "provider-api");
  assert.equal(forecast.entitlement.freshness.status, "fresh");

  assert.equal(forecastRecentBurn(events, { ...options, truncated: true }).accounts[0].status, "unknown");
  assert.match(forecastRecentBurn(events, { ...options, malformedLines: 1 }).accounts[0].confidence.reason, /malformed/);
  const stale = forecastRecentBurn(events, { ...options, now: "2026-08-18T18:00:01Z" }).accounts[0];
  assert.equal(stale.status, "unknown");
});

test("January-2025 quota snapshots retain fresh burn but suppress stale exhaustion projections", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "15:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));
  const result = forecastRecentBurn(events, {
    now,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: {
      entitlementIdentity: "turn-week",
      unit: "turns",
      windowMs: 604_800_000,
      remaining: 20,
      resetAt: "2026-08-19T00:00:00Z",
      source: "provider-api",
      observedAt: "2025-01-15T00:00:00Z",
    } }],
  });

  for (const forecast of [result.accounts[0], result.providers.p[0], result.combined[0]]) {
    assert.equal(forecast.status, "rate-only");
    assert.equal(forecast.exhaustion, null);
    assert.equal(forecast.freshness.status, "fresh");
    assert.equal(forecast.confidence.level, "medium");
    assert.equal(forecast.limitKnown, true);
    assert.equal(forecast.entitlement.freshness.status, "stale");
    assert.match(forecast.entitlement.freshness.reason, /freshness threshold/);
  }
});

test("elapsed reset or renewal snapshots downgrade to rate-only with an explicit reason", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "15:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));

  for (const boundary of ["resetAt", "renewalAt"]) {
    const forecast = forecastRecentBurn(events, {
      now,
      entitlements: [{ provider: "p", accountId: "acct_a", quota: {
        unit: "turns",
        remaining: 20,
        source: "provider-api",
        observedAt: "2026-08-17T17:50:00Z",
        [boundary]: "2026-08-17T17:55:00Z",
      } }],
    }).accounts[0];
    assert.equal(forecast.status, "rate-only");
    assert.equal(forecast.exhaustion, null);
    assert.equal(forecast.freshness.status, "fresh");
    assert.equal(forecast.entitlement.freshness.status, "stale");
    assert.match(forecast.entitlement.freshness.reason, /elapsed after the entitlement observation/);
  }
});

test("compatible pooled forecasts fail closed when any member quota snapshot is stale", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["acct_a", "acct_b"].flatMap((accountId) => ["12:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId, turnCount: 10,
  }))));
  const result = forecastRecentBurn(events, {
    now,
    entitlements: [
      { provider: "p", accountId: "acct_a", quota: { entitlementIdentity: "shared-turn-pool", unit: "turns", remaining: 20, source: "provider-api", observedAt: now } },
      { provider: "p", accountId: "acct_b", quota: { entitlementIdentity: "shared-turn-pool", unit: "turns", remaining: 20, source: "provider-api", observedAt: "2025-01-15T00:00:00Z" } },
    ],
  });

  assert.equal(result.accounts.find((forecast) => forecast.scope.accountId === "acct_a").status, "projected");
  assert.equal(result.accounts.find((forecast) => forecast.scope.accountId === "acct_b").status, "rate-only");
  for (const forecast of [result.providers.p[0], result.combined[0]]) {
    assert.equal(forecast.status, "rate-only");
    assert.equal(forecast.exhaustion, null);
    assert.equal(forecast.entitlement.freshness.status, "stale");
    assert.equal(forecast.compatibilityKey.split("\u0000")[0], "shared-turn-pool");
  }
});

test("unknown reset timing still requires a fresh authoritative observation", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "15:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));
  const entitlement = { provider: "p", accountId: "acct_a", quota: { unit: "turns", remaining: 20, source: "provider-api" } };
  const missingObservation = forecastRecentBurn(events, { now, entitlements: [entitlement] }).accounts[0];
  assert.equal(missingObservation.status, "rate-only");
  assert.equal(missingObservation.exhaustion, null);
  assert.equal(missingObservation.entitlement.freshness.status, "unknown");
  assert.match(missingObservation.entitlement.freshness.reason, /observation time is unknown/);

  const freshObservation = forecastRecentBurn(events, {
    now,
    entitlements: [{ ...entitlement, quota: { ...entitlement.quota, observedAt: now } }],
  }).accounts[0];
  assert.equal(freshObservation.status, "projected");
  assert.equal(freshObservation.entitlement.freshness.status, "fresh");
  assert.equal(freshObservation.exhaustion.relation, "reset-or-renewal-unknown");
});

test("unknown or invalid quota units cannot borrow a local metric for exhaustion", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));
  for (const unit of [undefined, "private-provider-units"]) {
    const forecast = forecastRecentBurn(events, {
      now,
      entitlements: [{ provider: "p", accountId: "acct_a", quota: { unit, remaining: 20, source: "provider-api", observedAt: now } }],
    }).accounts[0];
    assert.equal(forecast.burn.unit, "turns");
    assert.equal(forecast.entitlement.unit, null);
    assert.equal(forecast.status, "rate-only");
    assert.equal(forecast.exhaustion, null);
  }
});

test("fresh quota observations use a deterministic conservative threshold", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["12:00:00", "15:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 10,
  })));
  const quota = { unit: "turns", remaining: 20, resetAt: "2026-08-19T00:00:00Z", source: "provider-api" };
  const atThreshold = forecastRecentBurn(events, {
    now,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: { ...quota, observedAt: "2026-08-17T17:45:00Z" } }],
  }).accounts[0];
  assert.equal(atThreshold.entitlement.freshness.thresholdMs, 15 * 60 * 1000);
  assert.equal(atThreshold.entitlement.freshness.status, "fresh");
  assert.equal(atThreshold.status, "projected");
  assert.ok(atThreshold.exhaustion);

  const beyondThreshold = forecastRecentBurn(events, {
    now,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: { ...quota, observedAt: "2026-08-17T17:44:59.999Z" } }],
  }).accounts[0];
  assert.equal(beyondThreshold.entitlement.freshness.status, "stale");
  assert.equal(beyondThreshold.status, "rate-only");
  assert.equal(beyondThreshold.exhaustion, null);
});

test("exhaustion ranges never begin before now and classify reset straddles", () => {
  const now = "2026-08-17T18:07:00Z";
  const immediateEvents = ["12:07:00", "18:07:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 100,
  })));
  const immediate = forecastRecentBurn(immediateEvents, {
    now,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: { unit: "turns", remaining: 0.1, source: "provider-api", observedAt: now } }],
  }).accounts[0].exhaustion;
  assert.equal(immediate.earliestAt, "2026-08-17T18:07:00.000Z");
  assert.ok(Date.parse(immediate.latestAt) >= Date.parse(immediate.earliestAt));

  const straddleNow = "2026-08-17T18:00:00Z";
  const straddleEvents = ["12:00:00", "14:00:00", "16:00:00", "18:00:00"].map((time) => normalizeUsageEvent(event({
    timestamp: `2026-08-17T${time}Z`, provider: "p", accountId: "acct_a", turnCount: 15,
  })));
  const straddle = forecastRecentBurn(straddleEvents, {
    now: straddleNow,
    entitlements: [{ provider: "p", accountId: "acct_a", quota: {
      unit: "turns",
      remaining: 15,
      resetAt: "2026-08-17T19:30:00Z",
      source: "provider-api",
      observedAt: straddleNow,
    } }],
  }).accounts[0].exhaustion;
  assert.equal(straddle.earliestAt, "2026-08-17T19:15:00.000Z");
  assert.equal(straddle.latestAt, "2026-08-17T20:00:00.000Z");
  assert.equal(straddle.relation, "straddles-reset-or-renewal");
});

test("bounds retention, repairs malformed tails, and leaves atomic artifacts cleaned", async (t) => {
  const { root, path, ledger } = await temporaryLedger(t, {
    maxEvents: 3,
    maxFileBytes: 4096,
    maxLineBytes: 1024,
  });
  for (let index = 0; index < 5; index += 1) {
    await ledger.append(event({ timestamp: `2026-08-17T12:00:0${index}Z`, inputTokens: index }));
  }
  assert.deepEqual((await ledger.read()).map((entry) => entry.inputTokens), [2, 3, 4]);

  await appendFile(path, "{\"truncated\":", "utf8");
  await ledger.append(event({ timestamp: "2026-08-17T12:00:05Z", inputTokens: 5 }));
  const retained = await ledger.read();
  assert.deepEqual(retained.map((entry) => entry.inputTokens), [3, 4, 5]);
  assert.ok((await stat(path)).size <= 4096);
  assert.equal((await readFile(path, "utf8")).trim().split("\n").every((line) => JSON.parse(line)), true);
  assert.deepEqual((await readdir(join(root, "portable path ü"))).sort(), ["usage.jsonl"]);
});

test("applies age retention and fails closed on an abandoned lock", async (t) => {
  const { path, ledger } = await temporaryLedger(t, {
    retentionMs: 1000,
    now: () => "2026-08-17T12:00:10Z",
    lockTimeoutMs: 30,
    lockRetryMs: 2,
  });
  await ledger.append(event({ timestamp: "2026-08-17T12:00:00Z" }));
  assert.deepEqual(await ledger.read(), []);
  await ledger.append(event({ timestamp: "2026-08-17T12:00:10Z" }));
  assert.equal((await ledger.read()).length, 1);
  await ledger.rotate();

  const lockPath = `${path}.lock`;
  await writeFile(lockPath, JSON.stringify({ token: "abandoned" }), "utf8");
  await assert.rejects(ledger.append(event()), /Timed out acquiring usage ledger lock/);
  await rm(lockPath, { force: true });
  await ledger.append(event({ timestamp: "2026-08-17T12:00:10Z", inputTokens: 99 }));
  assert.equal((await ledger.read()).at(-1).inputTokens, 99);
});

test("retries confirmed Windows EPERM contention on an owned lock file", async (t) => {
  let path;
  let attempts = 0;
  const lockRuntime = {
    platform: "win32",
    open: async (candidate, ...args) => {
      attempts += 1;
      assert.equal(candidate, `${path}.lock`);
      if (attempts === 1) {
        await writeFile(candidate, JSON.stringify({ token: "concurrent-owner" }), "utf8");
        throw windowsOpenPermissionError(candidate);
      }
      await rm(candidate, { force: true });
      return open(candidate, ...args);
    },
  };
  const temporary = await temporaryLedger(t, { lockRetryMs: 1, lockRuntime });
  path = temporary.path;

  await temporary.ledger.append(event({ inputTokens: 77 }));

  assert.equal(attempts, 2);
  assert.equal(JSON.parse((await readFile(path, "utf8")).trim()).inputTokens, 77);
  await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
});

test("bounds confirmed Windows EPERM retries without stealing the owner lock", async (t) => {
  let attempts = 0;
  const owner = JSON.stringify({ token: "persistent-owner" });
  const temporary = await temporaryLedger(t, {
    lockTimeoutMs: 10,
    lockRetryMs: 1,
    lockRuntime: {
      platform: "win32",
      open: async (candidate) => {
        attempts += 1;
        await writeFile(candidate, owner, "utf8");
        throw windowsOpenPermissionError(candidate);
      },
    },
  });

  await assert.rejects(temporary.ledger.append(event()), /Timed out acquiring usage ledger lock/);
  assert.ok(attempts > 1);
  assert.equal(await readFile(`${temporary.path}.lock`, "utf8"), owner);
});

test("does not retry unconfirmed or non-Windows EPERM failures", async (t) => {
  for (const scenario of [
    { name: "missing lock path", platform: "win32", owner: undefined },
    { name: "malformed lock owner", platform: "win32", owner: "{}" },
    { name: "non-Windows platform", platform: "linux", owner: JSON.stringify({ token: "concurrent-owner" }) },
  ]) {
    await t.test(scenario.name, async (t) => {
      let path;
      let attempts = 0;
      const failure = windowsOpenPermissionError("pending");
      const temporary = await temporaryLedger(t, {
        lockRuntime: {
          platform: scenario.platform,
          open: async (candidate) => {
            attempts += 1;
            failure.path = candidate;
            if (scenario.owner !== undefined) await writeFile(candidate, scenario.owner, "utf8");
            throw failure;
          },
        },
      });
      path = temporary.path;

      await assert.rejects(temporary.ledger.append(event()), (error) => error === failure);
      assert.equal(attempts, 1);
      assert.equal(failure.path, `${path}.lock`);
    });
  }
});

test("bounds reads and recent sanitized output", async (t) => {
  const { path, ledger } = await temporaryLedger(t, { recentLimit: 2, maxReadBytes: 1024 });
  for (let index = 0; index < 8; index += 1) {
    await ledger.append(event({ timestamp: `2026-08-17T12:00:0${index}Z`, inputTokens: index }));
  }
  assert.deepEqual((await ledger.recent(50)).map((entry) => entry.inputTokens), [7, 6]);
  const summary = await ledger.summarize({ now: "2026-08-17T13:00:00Z", maxBytes: 300 });
  assert.equal(summary.truncated, true);
  assert.ok(summary.scannedEvents <= 1);
  assert.ok(summary.recentEvents.length <= 2);
  assert.ok((await stat(path)).size > 300);
});

test("serializes append integrity across independent processes", async (t) => {
  const { path } = await temporaryLedger(t);
  const moduleUrl = pathToFileURL(join(process.cwd(), "src/core/usage-ledger.mjs")).href;
  const childSource = `
    import { UsageLedger } from ${JSON.stringify(moduleUrl)};
    const [path, prefix] = process.argv.slice(1);
    const ledger = new UsageLedger({ path, maxEvents: 500, maxFileBytes: 1024 * 1024, lockTimeoutMs: 20000 });
    for (let index = 0; index < 15; index += 1) {
      await ledger.append({
        timestamp: new Date(Date.UTC(2026, 7, 17, 12, Number(prefix), index)).toISOString(),
        provider: "child-" + prefix,
        model: "model",
        mode: "delegate",
        status: "completed",
        durationMs: index,
        inputTokens: index,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        turnCount: 1,
        evidenceClass: "synthetic-test"
      });
    }
    await ledger.flush();
  `;
  await Promise.all(Array.from({ length: 4 }, (_, index) => runChild(childSource, path, String(index))));

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 60);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(new Set(records.map((record) => `${record.provider}:${record.timestamp}`)).size, 60);
  assert.deepEqual([...new Set(records.map((record) => record.provider))].sort(), ["child-0", "child-1", "child-2", "child-3"]);
});

test("disabled mode is filesystem-silent and paths remain portable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-disabled-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "never created", "usage.jsonl");
  const ledger = new UsageLedger({ enabled: false, path });
  assert.equal(ledger.path, undefined);
  assert.equal(await ledger.append(event()), undefined);
  assert.deepEqual(await ledger.read(), []);
  assert.deepEqual((await ledger.summarize()).recentEvents, []);
  await ledger.compact();
  await ledger.flush();
  await assert.rejects(stat(join(root, "never created")), { code: "ENOENT" });

  assert.equal(resolveUsageLedgerPath(path), path);
  assert.equal(resolveUsageLedgerPath("~/threadspan usage.jsonl"), join(homedir(), "threadspan usage.jsonl"));
});

/** Run one portable Node child and surface bounded diagnostics on failure. */
function runChild(source, path, prefix) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, path, prefix], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`usage ledger child ${prefix} exited ${code}: ${stderr}`));
    });
  });
}

function windowsOpenPermissionError(path) {
  return Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), {
    code: "EPERM",
    syscall: "open",
    path,
  });
}
