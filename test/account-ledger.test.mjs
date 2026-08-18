import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsageEvents, forecastRecentBurn, normalizeUsageEvent, USAGE_LEDGER_SCHEMA_VERSION } from "../src/core/usage-ledger.mjs";

const legacy = {
  schemaVersion: 1,
  timestamp: "2026-08-17T12:00:00.000Z",
  provider: "codex",
  model: "m",
  mode: "delegate",
  status: "completed",
  durationMs: 1,
  inputTokens: 2,
  outputTokens: 3,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  evidenceClass: "live-provider",
};

test("schema-v1 usage remains readable under unknown/default while v2 groups opaque accounts", () => {
  const current = normalizeUsageEvent({ ...legacy, schemaVersion: undefined, accountId: "acct_00000000-0000-0000-0000-000000000001", attemptGroupId: "attempt_group_1" });
  assert.equal(current.schemaVersion, USAGE_LEDGER_SCHEMA_VERSION);
  const summary = aggregateUsageEvents([legacy, current], { now: "2026-08-17T13:00:00Z" });
  assert.equal(summary.accounts["unknown/default"].eventCount, 1);
  assert.equal(summary.recentEvents.find((event) => event.accountId === "unknown/default").schemaProvenance, "schema-v1-unknown-default");
  assert.equal(summary.accounts[current.accountId].eventCount, 1);
  assert.equal(summary.combined.eventCount, 2);
  assert.equal(summary.combined.inputTokens, 4);
});

test("unknown quota and charge are not inferred from token telemetry", () => {
  const event = normalizeUsageEvent({ provider: "p", model: "m", mode: "consult", status: "completed", evidenceClass: "live-provider", usage: { inputTokens: 1000, outputTokens: 2000 } });
  assert.equal("quota" in event, false);
  assert.equal("renewalAt" in event, false);
  assert.equal("charge" in event, false);
  assert.deepEqual(event.observedMetrics, ["inputTokens", "outputTokens"]);
});

test("quota freshness output preserves the closed privacy boundary", () => {
  const now = "2026-08-17T18:00:00Z";
  const events = ["17:00:00", "18:00:00"].map((time) => normalizeUsageEvent({
    timestamp: `2026-08-17T${time}Z`,
    provider: "p",
    accountId: "acct_opaque",
    model: "m",
    mode: "consult",
    status: "completed",
    evidenceClass: "live-provider",
    turnCount: 1,
  }));
  const forecast = forecastRecentBurn(events, {
    now,
    entitlements: [{ provider: "p", accountId: "acct_opaque", quota: {
      unit: "turns",
      remaining: 10,
      source: "provider-api",
      observedAt: now,
      credential: "private-key",
      ownerEmail: "private@example.test",
      rawProviderPayload: { secret: true },
    } }],
  }).accounts[0];
  const serialized = JSON.stringify(forecast.entitlement);
  for (const forbidden of ["private-key", "private@example.test", "rawProviderPayload", "secret"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
  assert.deepEqual(Object.keys(forecast.entitlement).sort(), [
    "allowance", "freshness", "identity", "observedAt", "remaining", "renewalAt", "resetAt", "source", "unit", "windowKind", "windowMs",
  ]);
});
