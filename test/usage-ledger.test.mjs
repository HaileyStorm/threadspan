import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  aggregateUsageEvents,
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
    model: "gpt-5.6-sol",
    mode: "integrated",
    status: "success",
    durationMs: 42,
    inputTokens: 11,
    outputTokens: 7,
    cachedInputTokens: 3,
    reasoningTokens: 2,
    evidenceClass: "live-provider",
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
