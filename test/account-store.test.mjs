import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountStore, replaceAccountStoreFile } from "../src/core/account-store.mjs";

test("account store persists opaque ref-only descriptors and active provider selection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-accounts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const store = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const first = await store.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" });
  const second = await store.create({ providerId: "codex", label: "Research", authKind: "device-login", profileRef: "codex-research" });
  assert.match(first.id, /^acct_[0-9a-f-]{36}$/);
  assert.equal(store.resolve("codex").id, first.id);
  await store.select(second.id);
  assert.equal(new AccountStore({ path }).resolve("codex").id, second.id);
  const persisted = await readFile(path, "utf8");
  assert.doesNotMatch(persisted, /auth\.json|cookie|token|@example|\/home\/|C:\\/i);
  assert.deepEqual(store.list().map((item) => item.quota.remaining), [null, null]);
  assert.ok(store.creationDescriptors().every((item) => item.collectsSecrets === false));
});

test("account store persists only validated authoritative quota observations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-quota-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const store = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
  const account = await store.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" });
  const observation = {
    remaining: 42.5,
    resetAt: "2026-08-18T12:00:00Z",
    renewalAt: null,
    charge: 1.25,
    source: "provider-api",
    observedAt: "2026-08-17T13:00:00Z",
  };

  const observed = await store.observeQuota(account.id, observation);
  assert.deepEqual(observed.quota, { ...observation, resetAt: "2026-08-18T12:00:00.000Z", observedAt: "2026-08-17T13:00:00.000Z" });
  assert.deepEqual(new AccountStore({ path }).list()[0].quota, observed.quota);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).accounts[0].quota, observed.quota);

  await assert.rejects(store.observeQuota(account.id, { ...observation, remaining: -1 }), /finite nonnegative/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, charge: Number.POSITIVE_INFINITY }), /finite nonnegative/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, resetAt: "later" }), /valid timestamp/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, source: "/home/me/quota.json" }), /opaque source label/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, token: "secret" }), /unsupported fields/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, observedAt: null }), /valid timestamp/);
  await assert.rejects(store.observeQuota(account.id, { ...observation, observedAt: undefined }), /valid timestamp/);
});

test("failed create, select, remove, and quota persistence leave live account state unchanged", async (t) => {
  for (const operation of ["create", "select", "remove", "observeQuota"]) {
    await t.test(operation, async (subtest) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-account-${operation}-failure-`));
      subtest.after(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "accounts.json");
      const store = new AccountStore({ path, now: () => "2026-08-17T12:00:00Z" });
      const first = await store.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" });
      const second = await store.create({ providerId: "codex", label: "Research", authKind: "cli-login", profileRef: "codex-research" });
      const accountsBefore = store.list();
      const activeBefore = store.resolve("codex").id;

      await rename(path, `${path}.persisted`);
      await mkdir(path);
      const mutation = operation === "create"
        ? store.create({ providerId: "codex", label: "Third", authKind: "cli-login", profileRef: "codex-third" })
        : operation === "select"
          ? store.select(second.id)
          : operation === "remove"
            ? store.remove(first.id)
            : store.observeQuota(first.id, {
              remaining: 5,
              resetAt: null,
              renewalAt: null,
              charge: 1,
              source: "provider-api",
              observedAt: "2026-08-17T13:00:00Z",
            });

      await assert.rejects(mutation);
      assert.deepEqual(store.list(), accountsBefore);
      assert.equal(store.resolve("codex").id, activeBefore);
    });
  }
});

test("account store rejects credential values, emails, raw paths, and unknown fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AccountStore({ path: join(root, "accounts.json") });
  await assert.rejects(store.create({ providerId: "codex", label: "person@example.test", authKind: "cli-login" }), /email-like/);
  await assert.rejects(store.create({ providerId: "codex", label: "Alt", authKind: "cli-login", profileRef: "/home/me/.codex-alt" }), /opaque local reference/);
  await assert.rejects(store.create({ providerId: "openai", label: "API", authKind: "api-key-env", authSourceRef: "sk-secret" }), /environment-variable name/);
  await assert.rejects(store.create({ providerId: "openai", label: "API", authKind: "api-key-env", authSourceRef: "OPENAI_ALT_KEY", token: "secret" }), /unsupported fields/);
  await store.create({ providerId: "openai", label: "Primary API", authKind: "api-key-env", authSourceRef: "OPENAI_ALT_KEY" });
  await assert.rejects(store.create({ providerId: "openai", label: "Duplicate API", authKind: "api-key-env", authSourceRef: "OPENAI_ALT_KEY" }), /already registered/);
});

test("account store reclaims an old malformed lock and removes its owned lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-stale-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const lockPath = `${path}.lock`;
  await writeFile(lockPath, "{", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const store = new AccountStore({ path, staleLockMs: 10, lockTimeoutMs: 1_000 });
  await store.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" });

  await assert.rejects(access(lockPath), { code: "ENOENT" });
  assert.equal(new AccountStore({ path }).list().length, 1);
});

test("account store does not reclaim an old lock owned by a live process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-account-live-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "accounts.json");
  const lockPath = `${path}.lock`;
  const owner = { token: "live-owner", pid: process.pid, createdAt: Date.now() - 60_000 };
  await writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  const store = new AccountStore({ path, staleLockMs: 10, lockTimeoutMs: 30, lockRetryMs: 5 });
  await assert.rejects(
    store.create({ providerId: "codex", label: "Primary", authKind: "cli-login", profileRef: "codex-primary" }),
    /Timed out acquiring account store lock/,
  );
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), owner);
  assert.deepEqual(store.list(), []);
});

test("Windows atomic replacement retries transient sharing failures without a delete fallback", async () => {
  const calls = [];
  const waits = [];
  await replaceAccountStoreFile("candidate.tmp", "accounts.json", {
    platform: "win32",
    attempts: 3,
    retryMs: 7,
    delay: async (milliseconds) => waits.push(milliseconds),
    renameFile: async (source, destination) => {
      calls.push([source, destination]);
      if (calls.length === 1) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    },
  });
  assert.deepEqual(calls, [
    ["candidate.tmp", "accounts.json"],
    ["candidate.tmp", "accounts.json"],
  ]);
  assert.deepEqual(waits, [7]);
});
