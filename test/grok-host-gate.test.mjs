import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import {
  GrokHostGate,
  grokHostGateContract,
} from "../src/core/grok-host-gate.mjs";
import { runCapturedProcess } from "../src/core/managed-process.mjs";

const require = createRequire(import.meta.url);
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
const sqliteTest = DatabaseSync ? test : test.skip;

async function createPythonShapedGate(root, options = {}) {
  await chmod(root, 0o700);
  const path = join(root, "grok-host.sqlite3");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE grok_host_gates (
      provider TEXT NOT NULL,
      account_class TEXT NOT NULL,
      contract_hash TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL,
      state TEXT NOT NULL,
      detail TEXT,
      updated_at TEXT NOT NULL,
      source_evidence_hash TEXT,
      authorization_expires_at ${options.authorizationDefinition ?? "TEXT NOT NULL DEFAULT ''"},
      revocation_epoch INTEGER NOT NULL DEFAULT 0,
      allowance_state TEXT NOT NULL DEFAULT '',
      billing_mode TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(provider, account_class)
    );
    CREATE TABLE grok_host_slots (
      token ${options.tokenDefinition ?? "TEXT PRIMARY KEY"},
      provider TEXT NOT NULL,
      account_class TEXT NOT NULL,
      owner_root_hash TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      contact_started_at TEXT,
      expires_at TEXT NOT NULL,
      gate_epoch ${options.gateEpochDefinition ?? "INTEGER NOT NULL DEFAULT 0"}
    );
    CREATE INDEX idx_grok_host_slots_gate ON grok_host_slots(${options.indexColumns ?? "provider, account_class, expires_at"});
    PRAGMA user_version=${options.userVersion ?? 2};
    ${options.extraSql ?? ""}
  `);
  const maxConcurrency = options.maxConcurrency ?? 1;
  const epoch = options.epoch ?? 7;
  db.prepare(`INSERT INTO grok_host_gates(
      provider, account_class, contract_hash, max_concurrency, state, detail, updated_at,
      source_evidence_hash, authorization_expires_at, revocation_epoch, allowance_state, billing_mode
    ) VALUES (?, ?, ?, ?, 'healthy', NULL, ?, ?, ?, ?, ?, ?)`)
    .run(
      "xai_grok_build",
      "subscription",
      grokHostGateContract(maxConcurrency).hash,
      maxConcurrency,
      new Date().toISOString(),
      "1".repeat(64),
      options.authorizationExpiresAt ?? "2099-01-01T00:00:00+00:00",
      epoch,
      options.allowanceState ?? "available",
      options.billingMode ?? "subscription_included",
    );
  db.close();
  await chmod(path, options.mode ?? 0o600);
  return path;
}

test("Grok host gate contract matches Python sorted compact JSON", () => {
  const contract = grokHostGateContract(1);
  assert.equal(contract.canonical, "{\"account_class\":\"subscription\",\"adapter\":\"grok_exec\",\"max_concurrency\":1,\"model\":\"grok-4.6\",\"provider\":\"xai_grok_build\",\"reported_model\":\"grok-4.6-build\",\"schema_version\":2}");
  assert.equal(contract.hash, "799d2e0caa53606f254891cb0b1bb36786844d081a0e5555e15ad3443a9223ad");
  assert.equal(grokHostGateContract(12).hash, "6056d2f218e838a76beb09b7179c61fe4e34883871065463e2ed2a8ab31934c2");
});

test("ambient NODE_TEST_CONTEXT values never authorize alternate or disabled gates", () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    for (const value of ["1", "0"]) {
      process.env.NODE_TEST_CONTEXT = value;
      assert.throws(() => new GrokHostGate({ disabled: true }), /explicit internal test options/);
      assert.throws(() => new GrokHostGate({ path: "/tmp/not-canonical-grok-gate.sqlite3" }), /canonical host gate/);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

sqliteTest("Python-shaped gate enforces shared cap, TTL purge, epoch, and transactional revoke", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const first = new GrokHostGate({ path, ownerIdentity: "first", testContext: true });
  const second = new GrokHostGate({ path, ownerIdentity: "second", testContext: true });
  assert.deepEqual(first.inspect(), {
    enabled: true,
    ready: true,
    state: "healthy",
    maxConcurrency: 1,
    authorizationExpiresAt: "2099-01-01T00:00:00+00:00",
    allowanceState: "available",
    billingMode: "subscription_included",
    schemaVersion: 2,
  });
  const slot = first.acquire({ timeoutMs: 1_000 });
  assert.equal(slot.gateEpoch, 7);
  assert.throws(() => second.acquire({ timeoutMs: 1_000 }), /concurrent-call cap/);

  const db = new DatabaseSync(path);
  db.prepare("UPDATE grok_host_slots SET expires_at='2000-01-01T00:00:00+00:00' WHERE token=?").run(slot.token);
  db.close();
  const replacement = second.acquire({ timeoutMs: 1_000 });
  assert.notEqual(replacement.token, slot.token);
  assert.deepEqual(second.settle(replacement, { terminalProven: true }), { released: true, reconcileRequired: false });

  first.revoke("fixture allowance exhausted");
  assert.throws(() => second.acquire({ timeoutMs: 1_000 }), /revoked/);
  const read = new DatabaseSync(path, { readOnly: true });
  const gate = read.prepare("SELECT state, detail, revocation_epoch, allowance_state, billing_mode FROM grok_host_gates").get();
  read.close();
  assert.equal(gate.state, "revoked");
  assert.equal(gate.revocation_epoch, 8);
  assert.equal(gate.allowance_state, "unavailable");
  assert.equal(gate.billing_mode, "blocked");
  assert.match(gate.detail, /allowance exhausted/);
});

sqliteTest("expired authorization and non-included billing revoke before contact", async (t) => {
  for (const scenario of [
    { name: "expired", authorizationExpiresAt: "2000-01-01T00:00:00+00:00" },
    { name: "billed", billingMode: "billed" },
    { name: "allowance", allowanceState: "exhausted" },
  ]) {
    const root = await mkdtemp(join(tmpdir(), `threadspan-grok-${scenario.name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = await createPythonShapedGate(root, scenario);
    const gate = new GrokHostGate({ path, testContext: true });
    assert.throws(() => gate.acquire({ timeoutMs: 1_000 }), /transactionally revoked/);
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT state, revocation_epoch FROM grok_host_gates").get();
    db.close();
    assert.equal(row.state, "revoked");
    assert.equal(row.revocation_epoch, 8);
  }
});

sqliteTest("synchronous spawn guard blocks a revoke race and records successful contact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-spawn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const gate = new GrokHostGate({ path, testContext: true });
  const marker = join(root, "contacted");
  const stale = gate.acquire({ timeoutMs: 1_000 });
  gate.revoke("race winner");
  await assert.rejects(runCapturedProcess({
    command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'contact')`],
    spawnGuard: gate.spawnGuard(stale),
  }), /revoked/);
  await assert.rejects(async () => import("node:fs/promises").then(({ access }) => access(marker)));
  assert.deepEqual(gate.settle(stale, { terminalProven: false }), { released: true, reconcileRequired: false });

  const db = new DatabaseSync(path);
  db.prepare("UPDATE grok_host_gates SET state='healthy', detail=NULL, revocation_epoch=9, authorization_expires_at='2099-01-01T00:00:00+00:00', allowance_state='available', billing_mode='subscription_included'").run();
  db.close();
  const live = gate.acquire({ timeoutMs: 1_000 });
  const result = await runCapturedProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    spawnGuard: gate.spawnGuard(live),
  });
  assert.equal(result.stdout, "ok");
  const inspect = new DatabaseSync(path, { readOnly: true });
  assert.ok(inspect.prepare("SELECT contact_started_at FROM grok_host_slots WHERE token=?").get(live.token).contact_started_at);
  inspect.close();
  assert.deepEqual(gate.settle(live, { terminalProven: true }), { released: true, reconcileRequired: false });
});

sqliteTest("async child spawn failure rolls back contact instead of consuming the slot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-async-spawn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const gate = new GrokHostGate({ path, testContext: true });
  const slot = gate.acquire({ timeoutMs: 1_000 });
  await assert.rejects(runCapturedProcess({
    command: join(root, "missing-executable"),
    spawnGuard: gate.spawnGuard(slot),
    timeoutMs: 1_000,
  }), /failed before provider contact started|ENOENT/);
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT contact_started_at FROM grok_host_slots WHERE token=?").get(slot.token);
  db.close();
  assert.equal(row.contact_started_at, null);
  assert.deepEqual(gate.settle(slot, { terminalProven: false }), { released: true, reconcileRequired: false });
});

sqliteTest("post-spawn contact persistence failure retains the slot until TTL across processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-reconcile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const gate = new GrokHostGate({
    path,
    testContext: true,
    testHooks: { beforeContactCommit() { throw new Error("fixture commit failure"); } },
  });
  const slot = gate.acquire({ timeoutMs: 1_000 });
  let failure;
  try {
    await runCapturedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      spawnGuard: gate.spawnGuard(slot),
      timeoutMs: 2_000,
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.details?.reconcileRequired, true);
  assert.deepEqual(gate.settle(slot, {
    terminalProven: false,
    reconcileRequired: failure.details.reconcileRequired,
  }), { released: false, reconcileRequired: true });
  const inspect = new DatabaseSync(path, { readOnly: true });
  const retained = inspect.prepare("SELECT contact_started_at FROM grok_host_slots WHERE token=?").get(slot.token);
  inspect.close();
  assert.equal(retained.contact_started_at, null);
  assert.equal(await runGateContender(path, "blocked"), 0);

  const expire = new DatabaseSync(path);
  expire.prepare("UPDATE grok_host_slots SET expires_at='2000-01-01T00:00:00+00:00' WHERE token=?").run(slot.token);
  expire.close();
  assert.equal(await runGateContender(path, "available"), 0);
});

sqliteTest("gate lock wait is capped by the end-to-end request deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const blocker = new DatabaseSync(path);
  blocker.exec("PRAGMA busy_timeout=1000");
  blocker.exec("BEGIN IMMEDIATE");
  const gate = new GrokHostGate({ path, testContext: true });
  const startedAt = Date.now();
  try {
    assert.throws(() => gate.acquire({ timeoutMs: 60, deadlineAt: Date.now() + 60 }), /end-to-end request deadline/);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }
  assert.ok(Date.now() - startedAt < 500, "SQLite lock wait exceeded the bounded request budget");
});

sqliteTest("two independent Node processes cannot exceed one Python-shaped slot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const moduleUrl = new URL("../src/core/grok-host-gate.mjs", import.meta.url).href;
  const holderSource = `
    import { GrokHostGate } from ${JSON.stringify(moduleUrl)};
    const gate = new GrokHostGate({path:${JSON.stringify(path)},testContext:true,ownerIdentity:'holder'});
    const slot = gate.acquire({timeoutMs:1000});
    process.stdout.write('held\\n');
    setTimeout(() => { gate.settle(slot,{terminalProven:true}); process.exit(0); }, 1000);
  `;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", holderSource], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForLine(holder.stdout, "held");
  const contenderSource = `
    import { GrokHostGate } from ${JSON.stringify(moduleUrl)};
    try { new GrokHostGate({path:${JSON.stringify(path)},testContext:true,ownerIdentity:'contender'}).acquire({timeoutMs:1000}); process.exit(2); }
    catch (error) { if (!String(error.message).includes('concurrent-call cap')) throw error; }
  `;
  const contender = spawn(process.execPath, ["--input-type=module", "-e", contenderSource], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await exitCode(contender), 0);
  assert.equal(await exitCode(holder), 0);
});

sqliteTest("cross-process Grok provider instances share the Python-shaped slot cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-provider-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root);
  const lockDirectory = join(root, "fake-lock");
  const counterPath = join(root, "invocations.jsonl");
  const providerUrl = new URL("../src/providers/grok-build.mjs", import.meta.url).href;
  const fixture = new URL("./fixtures/fake-grok.mjs", import.meta.url).pathname;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", providerProcessSource({
    providerUrl, fixture, gatePath: path, lockDirectory, counterPath, role: "holder",
  })], { stdio: ["ignore", "pipe", "pipe"] });
  await waitForGateContact(path, holder);
  const contender = spawn(process.execPath, ["--input-type=module", "-e", providerProcessSource({
    providerUrl, fixture, gatePath: path, counterPath, role: "contender",
  })], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(await exitCode(contender), 0);
  assert.equal(await exitCode(holder), 0);
  const gateState = new DatabaseSync(path, { readOnly: true });
  const revoked = gateState.prepare("SELECT state, detail FROM grok_host_gates").get();
  gateState.close();
  assert.equal(revoked.state, "revoked");
  assert.match(revoked.detail, /modelUsage/);
  assert.throws(() => new GrokHostGate({ path, testContext: true }).acquire({ timeoutMs: 1_000 }), /revoked/);
  const lines = (await import("node:fs/promises").then(({ readFile }) => readFile(counterPath, "utf8")))
    .trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter((args) => args.includes("--prompt-file")).length, 1);
});

sqliteTest("gate rejects permissive files and dangling or non-dangling symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = await createPythonShapedGate(root, { mode: 0o644 });
  const permissive = new GrokHostGate({ path, testContext: true });
  assert.throws(() => permissive.acquire({ timeoutMs: 1_000 }), /group or other permissions/);
  await chmod(path, 0o600);
  const linked = join(root, "linked.sqlite3");
  await symlink(path, linked);
  assert.throws(() => new GrokHostGate({ path: linked, testContext: true }).acquire(), /symbolic link/);
  const dangling = join(root, "dangling.sqlite3");
  await symlink(join(root, "missing.sqlite3"), dangling);
  assert.throws(() => new GrokHostGate({ path: dangling, testContext: true }).acquire(), /symbolic link/);
});

sqliteTest("gate rejects user_version, column, index, and schema-object drift", async (t) => {
  const scenarios = [
    { name: "old-version", options: { userVersion: 1 }, message: /user_version=2/ },
    { name: "future-version", options: { userVersion: 3 }, message: /user_version=2/ },
    { name: "wrong-default", options: { authorizationDefinition: "TEXT NOT NULL DEFAULT 'wrong'" }, message: /invalid definition/ },
    { name: "wrong-type-notnull", options: { gateEpochDefinition: "TEXT DEFAULT 0" }, message: /invalid definition/ },
    { name: "wrong-pk-metadata", options: { tokenDefinition: "TEXT NOT NULL PRIMARY KEY" }, message: /invalid definition/ },
    { name: "wrong-index", options: { indexColumns: "owner_root_hash" }, message: /slot index definition/ },
    { name: "extra-table", options: { extraSql: "CREATE TABLE future_table(value TEXT);" }, message: /user tables/ },
    { name: "extra-view", options: { extraSql: "CREATE VIEW future_view AS SELECT * FROM grok_host_gates;" }, message: /views or triggers/ },
    { name: "extra-trigger", options: { extraSql: "CREATE TRIGGER future_trigger AFTER INSERT ON grok_host_slots BEGIN SELECT 1; END;" }, message: /views or triggers/ },
    { name: "extra-index", options: { extraSql: "CREATE INDEX future_index ON grok_host_slots(owner_root_hash);" }, message: /user indexes/ },
  ];
  for (const scenario of scenarios) {
    const root = await mkdtemp(join(tmpdir(), `threadspan-grok-schema-${scenario.name}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = await createPythonShapedGate(root, scenario.options);
    const gate = new GrokHostGate({ path, testContext: true });
    assert.throws(() => gate.inspect(), scenario.message, scenario.name);
  }
});

sqliteTest("gate rejects an ancestor replaced by a symlink after client construction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-grok-late-ancestor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "late-parent");
  const state = join(parent, "state");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = await createPythonShapedGate(state);
  const gate = new GrokHostGate({ path, testContext: true });
  const preserved = join(root, "preserved-parent");
  const target = join(root, "late-target");
  await rename(parent, preserved);
  await mkdir(target, { mode: 0o700 });
  await symlink(target, parent, "dir");
  assert.throws(() => gate.inspect(), /symbolic-link ancestors/);
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(target, "state", "grok-host.sqlite3"))));
});

function waitForLine(stream, expected) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), 3000);
    stream.on("data", (chunk) => {
      text += chunk.toString();
      if (text.includes(expected)) { clearTimeout(timer); resolve(); }
    });
  });
}

function exitCode(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function runGateContender(path, expectation) {
  const moduleUrl = new URL("../src/core/grok-host-gate.mjs", import.meta.url).href;
  const source = `
    import { GrokHostGate } from ${JSON.stringify(moduleUrl)};
    const gate=new GrokHostGate({path:${JSON.stringify(path)},testContext:true,ownerIdentity:'contender-${expectation}'});
    try {
      const slot=gate.acquire({timeoutMs:1000});
      if (${JSON.stringify(expectation)} !== 'available') process.exitCode=2;
      else gate.settle(slot,{terminalProven:true});
    } catch (error) {
      if (${JSON.stringify(expectation)} !== 'blocked' || !String(error.message).includes('concurrent-call cap')) throw error;
    }
  `;
  return exitCode(spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] }));
}

async function waitForGateContact(path, child) {
  const deadline = Date.now() + 3000;
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Grok provider holder exited before contact (${child.exitCode}): ${stderr}`);
    let db;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT contact_started_at FROM grok_host_slots WHERE contact_started_at IS NOT NULL LIMIT 1").get();
      if (row) return;
    } catch (error) {
      if (!/locked|busy/i.test(String(error?.message ?? error))) throw error;
    } finally {
      try { db?.close(); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for Grok provider contact: ${stderr}`);
}

function providerProcessSource({ providerUrl, fixture, gatePath, lockDirectory, counterPath, role }) {
  return `
    import { GrokBuildProvider } from ${JSON.stringify(providerUrl)};
    const logger={child(){return this;},warn(){},info(){},error(){},debug(){}};
    const provider = new GrokBuildProvider('grok-${role}', {
      adapter:'grok-build', capabilities:['consult','delegate'], command:process.execPath,
      commandArgs:[${JSON.stringify(fixture)}], versionArgs:['--version'], versionPattern:'^grok\\\\s',
      model:'grok-4.6', models:['grok-4.6'], strictModelList:true,
      allowedEfforts:['low','medium','high'], maxTurnsCeiling:24, inheritEnv:false, envAllowlist:[],
      noAutoUpdate:true, allowSubagents:true, noMemory:true, allowWebSearch:true,
      admission:{maxActive:1,minStartIntervalMs:0,maxUnitsPerWindow:10,windowMs:1000},
      ledger:{enabled:false}, consult:{workspaceStrategy:'none',profile:'diagnose',reasoningEffort:'high',maxTurns:8,expectedTurns:2},
      delegate:{profile:'balanced',maxTurns:16,expectedTurns:4}, grokHostGate:{path:${JSON.stringify(gatePath)},testContext:true},
      env:{FAKE_GROK_COUNTER_PATH:${JSON.stringify(counterPath)}${lockDirectory ? `,FAKE_GROK_LOCK_DIR:${JSON.stringify(lockDirectory)},FAKE_GROK_LOCK_DELAY_MS:'1200'` : ""}}
    }, {logger});
    try {
      for await (const _event of provider.run({mode:'consult',model:'grok-4.6',messages:[{role:'user',content:'public synthetic'}],metadata:{bridge_payload_classification:'public_synthetic',bridge_payload_disclosed:true}})) {}
      ${role === "contender" ? "process.exitCode=3;" : ""}
    } catch (error) {
      const message=String(error?.message ?? error);
      if (${role === "contender" ? "!message.includes('concurrent-call cap')" : "!message.includes('terminal modelUsage')"}) throw error;
    } finally { await provider.close(); }
  `;
}
