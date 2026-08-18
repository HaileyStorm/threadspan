import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore } from "../src/core/account-store.mjs";

const ACCOUNT_STORE_MODULE = new URL("../src/core/account-store.mjs", import.meta.url).href;
const CHILD_SOURCE = String.raw`
  import { access, open } from "node:fs/promises";
  import { setTimeout as wait } from "node:timers/promises";
  const [moduleUrl, action, path, gatePath, payloadJson] = process.argv.slice(1);
  const { AccountStore } = await import(moduleUrl);
  if (action === "crash-lock") {
    const handle = await open(path + ".lock", "wx", 0o600);
    await handle.writeFile(JSON.stringify({ token: "crashed-owner", pid: process.pid, createdAt: Date.now() }), "utf8");
    await handle.sync();
    await handle.close();
    process.stdout.write("ready\n");
    process.exit(23);
  }
  const store = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  process.stdout.write("ready\n");
  while (true) {
    try { await access(gatePath); break; } catch { await wait(5); }
  }
  const payload = JSON.parse(payloadJson);
  if (action === "create") await store.create(payload);
  else if (action === "select") await store.select(payload.accountId);
  else if (action === "remove") await store.remove(payload.accountId);
  else if (action === "observeQuota") await store.observeQuota(payload.accountId, payload.observation);
  else throw new Error("Unsupported test action");
`;

test("concurrent child processes preserve every account creation", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const gatePath = join(root, "start");
  const workers = Array.from({ length: 8 }, (_, index) => launchWorker({
    action: "create",
    path,
    gatePath,
    payload: {
      providerId: "codex",
      label: `Account ${index}`,
      authKind: "cli-login",
      profileRef: `codex-profile-${index}`,
    },
  }));
  t.after(() => workers.forEach(({ child }) => child.kill()));

  await Promise.all(workers.map(({ ready }) => ready));
  await writeFile(gatePath, "start", "utf8");
  await Promise.all(workers.map(({ completed }) => completed));

  const store = new AccountStore({ path });
  assert.equal(store.list().length, workers.length);
  assert.deepEqual(new Set(store.list().map((account) => account.profileRef)), new Set(Array.from({ length: 8 }, (_, index) => `codex-profile-${index}`)));
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
  assert.equal((await readFile(path, "utf8")).includes("schemaVersion"), true);
});

test("concurrent child select and remove preserve both mutations", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-mutate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const gatePath = join(root, "start");
  const seed = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const first = await seed.create({ providerId: "codex", label: "First", authKind: "cli-login", profileRef: "codex-first" });
  await seed.create({ providerId: "codex", label: "Second", authKind: "cli-login", profileRef: "codex-second" });
  const third = await seed.create({ providerId: "codex", label: "Third", authKind: "cli-login", profileRef: "codex-third" });
  const workers = [
    launchWorker({ action: "select", path, gatePath, payload: { accountId: third.id } }),
    launchWorker({ action: "remove", path, gatePath, payload: { accountId: first.id } }),
  ];
  t.after(() => workers.forEach(({ child }) => child.kill()));

  await Promise.all(workers.map(({ ready }) => ready));
  await writeFile(gatePath, "start", "utf8");
  await Promise.all(workers.map(({ completed }) => completed));

  const store = new AccountStore({ path });
  assert.equal(store.get(first.id), undefined);
  assert.equal(store.resolve("codex").id, third.id);
  assert.equal(store.list().length, 2);
});

test("persistent reader observes child-process creation, selection, and removal", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-reader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const reader = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const first = await reader.create({ providerId: "codex", label: "First", authKind: "cli-login", profileRef: "codex-first" });
  const second = await reader.create({ providerId: "codex", label: "Second", authKind: "cli-login", profileRef: "codex-second" });

  const createGate = join(root, "create-start");
  const creator = launchWorker({
    action: "create",
    path,
    gatePath: createGate,
    payload: { providerId: "codex", label: "Third", authKind: "cli-login", profileRef: "codex-third" },
  });
  t.after(() => creator.child.kill());
  await creator.ready;
  await writeFile(createGate, "start", "utf8");
  await creator.completed;
  assert.deepEqual(reader.list().map((account) => account.profileRef), ["codex-first", "codex-second", "codex-third"]);

  const selectGate = join(root, "select-start");
  const selector = launchWorker({ action: "select", path, gatePath: selectGate, payload: { accountId: second.id } });
  t.after(() => selector.child.kill());
  await selector.ready;
  await writeFile(selectGate, "start", "utf8");
  await selector.completed;
  assert.equal(reader.resolve("codex").id, second.id);

  const removeGate = join(root, "remove-start");
  const remover = launchWorker({ action: "remove", path, gatePath: removeGate, payload: { accountId: first.id } });
  t.after(() => remover.child.kill());
  await remover.ready;
  await writeFile(removeGate, "start", "utf8");
  await remover.completed;
  assert.equal(reader.get(first.id), undefined);
  assert.deepEqual(reader.list().map((account) => account.profileRef), ["codex-second", "codex-third"]);
});

test("simultaneous stale-lock reclaimers never unlink a successor lock", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-reclaim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const gatePath = join(root, "start");
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, "{", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  const workers = Array.from({ length: 8 }, (_, index) => launchWorker({
    action: "create",
    path,
    gatePath,
    payload: { providerId: "codex", label: `Reclaimer ${index}`, authKind: "cli-login", profileRef: `reclaimer-${index}` },
  }));
  t.after(() => workers.forEach(({ child }) => child.kill()));

  await Promise.all(workers.map(({ ready }) => ready));
  await writeFile(gatePath, "start", "utf8");
  await Promise.all(workers.map(({ completed }) => completed));

  assert.equal(new AccountStore({ path }).list().length, workers.length);
  await assert.rejects(access(lockPath), { code: "ENOENT" });
  assert.equal((await readdir(root)).some((entry) => entry.includes(".lock.quarantine-")), false);
});

test("quota observation from a child persists and refreshes a persistent reader", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const gatePath = join(root, "start");
  const reader = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const account = await reader.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" });
  const observation = {
    remaining: 17,
    resetAt: "2026-08-18T00:00:00Z",
    renewalAt: null,
    charge: null,
    source: "provider-api",
    observedAt: "2026-08-17T13:00:00Z",
  };
  const worker = launchWorker({ action: "observeQuota", path, gatePath, payload: { accountId: account.id, observation } });
  t.after(() => worker.child.kill());

  await worker.ready;
  await writeFile(gatePath, "start", "utf8");
  await worker.completed;

  assert.deepEqual(reader.list()[0].quota, { ...observation, resetAt: "2026-08-18T00:00:00.000Z", observedAt: "2026-08-17T13:00:00.000Z" });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).accounts[0].quota, reader.list()[0].quota);
});

test("a child crash leaves durable state intact and its abandoned lock recoverable", { timeout: 20_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-process-crash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const store = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const seed = await store.create({ providerId: "codex", label: "Seed", authKind: "cli-login", profileRef: "seed" });
  const worker = launchWorker({ action: "crash-lock", path, gatePath: join(root, "unused"), payload: {} });
  t.after(() => worker.child.kill());

  await worker.ready;
  await assert.rejects(worker.completed, /failed \(23\)/);
  const recovered = await store.create({ providerId: "codex", label: "Recovered", authKind: "cli-login", profileRef: "recovered" });

  assert.deepEqual(store.list().map((account) => account.id), [seed.id, recovered.id]);
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});

function launchWorker({ action, path, gatePath, payload }) {
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    CHILD_SOURCE,
    ACCOUNT_STORE_MODULE,
    action,
    path,
    gatePath,
    JSON.stringify(payload),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let markedReady = false;
  const ready = new Promise((resolveReady, rejectReady) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!markedReady && stdout.includes("ready\n")) {
        markedReady = true;
        resolveReady();
      }
    });
    child.once("error", rejectReady);
    child.once("exit", (code) => {
      if (!markedReady) rejectReady(new Error(`AccountStore child exited before ready (${code}): ${stderr}`));
    });
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolveCompleted, rejectCompleted) => {
    child.once("error", rejectCompleted);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveCompleted();
      else rejectCompleted(new Error(`AccountStore child failed (${code ?? signal}): ${stderr}`));
    });
  });
  return { child, ready, completed };
}
