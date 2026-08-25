import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
let DatabaseSyncImplementation;

export const GROK_HOST_GATE_SCHEMA_VERSION = 2;
export const GROK_HOST_GATE_PROVIDER = "xai_grok_build";
export const GROK_HOST_GATE_ACCOUNT_CLASS = "subscription";
export const GROK_HOST_GATE_MODEL = "grok-4.6";
export const GROK_HOST_GATE_REPORTED_MODEL = "grok-4.6-build";
export const DEFAULT_GROK_HOST_GATE_PATH = resolve(homedir(), ".codex", "state", "model-work-queue-grok-host.sqlite3");
export const GROK_HOST_GATE_TEST_OPTIONS = Symbol("threadspan.grokHostGate.testOptions");

const GATE_COLUMNS = Object.freeze({
  provider: ["TEXT", 1, null, 1],
  account_class: ["TEXT", 1, null, 2],
  contract_hash: ["TEXT", 1, null, 0],
  max_concurrency: ["INTEGER", 1, null, 0],
  state: ["TEXT", 1, null, 0],
  detail: ["TEXT", 0, null, 0],
  updated_at: ["TEXT", 1, null, 0],
  source_evidence_hash: ["TEXT", 0, null, 0],
  authorization_expires_at: ["TEXT", 1, "''", 0],
  revocation_epoch: ["INTEGER", 1, "0", 0],
  allowance_state: ["TEXT", 1, "''", 0],
  billing_mode: ["TEXT", 1, "''", 0],
});
const SLOT_COLUMNS = Object.freeze({
  token: ["TEXT", 0, null, 1],
  provider: ["TEXT", 1, null, 0],
  account_class: ["TEXT", 1, null, 0],
  owner_root_hash: ["TEXT", 1, null, 0],
  acquired_at: ["TEXT", 1, null, 0],
  contact_started_at: ["TEXT", 0, null, 0],
  expires_at: ["TEXT", 1, null, 0],
  gate_epoch: ["INTEGER", 1, "0", 0],
});
const USER_TABLES = Object.freeze(["grok_host_gates", "grok_host_slots"]);
const SLOT_INDEX = "idx_grok_host_slots_gate";
const SLOT_INDEX_COLUMNS = Object.freeze(["provider", "account_class", "expires_at"]);
const IMAGE_GATE_DETAIL = /^image-read-v1:[0-9a-f]{64}$/u;

/** Fail-closed shared-gate error with bounded lifecycle metadata. */
export class GrokHostGateError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "GrokHostGateError";
    this.code = options.code ?? "grok_host_gate_unavailable";
    this.contacted = options.contacted === true;
    this.reconcileRequired = options.reconcileRequired === true;
  }
}

/** Canonical compact JSON and SHA-256 contract shared with the Python queue owner. */
export function grokHostGateContract(maxConcurrency) {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 12) {
    throw new GrokHostGateError("Grok host gate max_concurrency must be an integer from 1 through 12", { code: "grok_host_gate_contract" });
  }
  const document = {
    account_class: GROK_HOST_GATE_ACCOUNT_CLASS,
    adapter: "grok_exec",
    max_concurrency: maxConcurrency,
    model: GROK_HOST_GATE_MODEL,
    provider: GROK_HOST_GATE_PROVIDER,
    reported_model: GROK_HOST_GATE_REPORTED_MODEL,
    schema_version: GROK_HOST_GATE_SCHEMA_VERSION,
  };
  const canonical = JSON.stringify(document);
  return {
    document,
    canonical,
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

/**
 * Linux client for the owner-armed canonical Grok saved-session gate.
 * It never creates schema, authorizes a route, or clears a revocation.
 */
export class GrokHostGate {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.testContext = options.testContext === true;
    this.disabled = options.disabled === true;
    if (options.testHooks !== undefined && !this.testContext) {
      throw new GrokHostGateError("Grok host gate test hooks require explicit internal test options", { code: "grok_host_gate_config" });
    }
    this.testHooks = this.testContext && options.testHooks && typeof options.testHooks === "object" ? options.testHooks : undefined;
    this.path = resolve(options.path ?? DEFAULT_GROK_HOST_GATE_PATH);
    this.ownerIdentity = String(options.ownerIdentity ?? `${process.cwd()}\0${process.pid}`);
    if (this.platform !== "linux") {
      this.disabled = true;
      return;
    }
    if (this.disabled && !this.testContext) {
      throw new GrokHostGateError("The Linux Grok saved-session route cannot disable the canonical shared host gate outside explicit internal test options", { code: "grok_host_gate_config" });
    }
    if (!this.testContext && this.path !== DEFAULT_GROK_HOST_GATE_PATH) {
      throw new GrokHostGateError(`The Linux Grok saved-session route requires the canonical host gate at ${DEFAULT_GROK_HOST_GATE_PATH}`, { code: "grok_host_gate_config" });
    }
    loadDatabaseSync();
  }

  /** Acquire one epoch-fenced host slot without contacting Grok. */
  acquire(options = {}) {
    if (this.disabled) return undefined;
    const timeoutMs = positiveInteger(options.timeoutMs, 30 * 60 * 1000);
    const deadlineAt = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : Date.now() + timeoutMs;
    const now = new Date();
    const nowText = utcText(now);
    const expiresAt = utcText(new Date(now.getTime() + Math.max(60_000, timeoutMs + 120_000)));
    const db = this.#openChecked({ busyTimeoutMs: remainingBudgetMs(deadlineAt) });
    try {
      beginImmediate(db, deadlineAt);
      const gate = this.#validatedHealthyGate(db, now);
      if (options.requireImage === true && !IMAGE_GATE_DETAIL.test(String(gate.detail ?? ""))) {
        db.exec("ROLLBACK");
        throw new GrokHostGateError("Grok image contact requires an owner-armed image-read-v1 receipt", { code: "grok_host_gate_image" });
      }
      db.prepare("DELETE FROM grok_host_slots WHERE provider=? AND account_class=? AND julianday(expires_at) <= julianday(?)")
        .run(GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS, nowText);
      const active = db.prepare("SELECT COUNT(*) AS count FROM grok_host_slots WHERE provider=? AND account_class=?")
        .get(GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS);
      if (Number(active?.count ?? 0) >= gate.max_concurrency) {
        db.exec("ROLLBACK");
        throw new GrokHostGateError("Grok host-wide concurrent-call cap is active", { code: "grok_host_gate_full" });
      }
      const token = randomUUID().replaceAll("-", "");
      const ownerRootHash = createHash("sha256").update(this.ownerIdentity, "utf8").digest("hex");
      db.prepare(`INSERT INTO grok_host_slots(
          token, provider, account_class, owner_root_hash, acquired_at, contact_started_at, expires_at, gate_epoch
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`)
        .run(token, GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS, ownerRootHash, nowText, expiresAt, gate.revocation_epoch);
      db.exec("COMMIT");
      return Object.freeze({
        token,
        gateEpoch: gate.revocation_epoch,
        ownerRootHash,
        expiresAt,
        ...(options.requireImage === true ? { requiredImageDetail: gate.detail } : {}),
      });
    } catch (error) {
      rollbackQuietly(db);
      throw normalizeGateError(error);
    } finally {
      closeQuietly(db);
      this.#assertPrivateGateFiles();
    }
  }

  /**
   * Return a synchronous spawn guard that holds BEGIN IMMEDIATE across the actual child creation.
   * `runCapturedProcess` invokes this around `spawnManagedChild`, not as later telemetry.
   */
  spawnGuard(slot, options = {}) {
    if (this.disabled) return undefined;
    if (!slot?.token || !Number.isSafeInteger(slot.gateEpoch) || !/^[0-9a-f]{64}$/.test(slot.ownerRootHash ?? "")) {
      throw new GrokHostGateError("Grok host slot identity is invalid", { code: "grok_host_gate_slot" });
    }
    const deadlineAt = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : Date.now() + 30 * 60 * 1000;
    return (spawnChild) => {
      const db = this.#openChecked({ busyTimeoutMs: remainingBudgetMs(deadlineAt) });
      let child;
      try {
        beginImmediate(db, deadlineAt);
        const now = new Date();
        const gate = this.#validatedHealthyGate(db, now);
        if (slot.requiredImageDetail !== undefined
          && (!IMAGE_GATE_DETAIL.test(String(gate.detail ?? "")) || gate.detail !== slot.requiredImageDetail)) {
          throw new GrokHostGateError("Grok image receipt changed or is unavailable before provider contact", { code: "grok_host_gate_image" });
        }
        if (gate.revocation_epoch !== slot.gateEpoch) {
          throw new GrokHostGateError("Grok host slot belongs to a stale revocation epoch", { code: "grok_host_gate_epoch" });
        }
        const row = db.prepare(`SELECT token, contact_started_at, expires_at, gate_epoch FROM grok_host_slots
          WHERE token=? AND provider=? AND account_class=? AND owner_root_hash=?`)
          .get(slot.token, GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS, slot.ownerRootHash);
        if (!row || row.gate_epoch !== slot.gateEpoch || Date.parse(row.expires_at) <= now.getTime()) {
          throw new GrokHostGateError("Grok host slot expired before provider contact", { code: "grok_host_gate_slot" });
        }
        if (row.contact_started_at !== null) {
          throw new GrokHostGateError("Grok host slot has already started provider contact", { code: "grok_host_gate_slot" });
        }
        remainingBudgetMs(deadlineAt);
        child = spawnChild();
      } catch (error) {
        rollbackQuietly(db);
        closeQuietly(db);
        this.#assertPrivateGateFiles();
        throw normalizeGateError(error);
      }

      const ready = new Promise((resolveReady, rejectReady) => {
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          child.off("spawn", onSpawn);
          child.off("error", onError);
          closeQuietly(db);
          try {
            this.#assertPrivateGateFiles();
            callback();
          } catch (error) {
            rejectReady(normalizeGateError(error));
          }
        };
        const onSpawn = () => {
          try {
            db.prepare("UPDATE grok_host_slots SET contact_started_at=? WHERE token=? AND gate_epoch=?")
              .run(utcText(new Date()), slot.token, slot.gateEpoch);
            this.testHooks?.beforeContactCommit?.({ token: slot.token, gateEpoch: slot.gateEpoch });
            db.exec("COMMIT");
            finish(resolveReady);
          } catch (error) {
            rollbackQuietly(db);
            try { child.kill("SIGTERM"); } catch {}
            finish(() => rejectReady(new GrokHostGateError("Grok contact started but the shared gate could not durably record it; reconciliation is required until slot TTL", {
              code: "grok_host_gate_reconcile_required",
              contacted: true,
              reconcileRequired: true,
              cause: error,
            })));
          }
        };
        const onError = (error) => {
          rollbackQuietly(db);
          finish(() => rejectReady(new GrokHostGateError("Grok child failed before provider contact started", {
            code: "grok_host_gate_spawn",
            cause: error,
          })));
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      return { child, ready };
    };
  }

  /** Release only a proven-terminal or definitely-pre-contact slot. */
  settle(slot, options = {}) {
    if (this.disabled || !slot) return { released: true, reconcileRequired: false };
    const db = this.#openChecked();
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT contact_started_at, gate_epoch FROM grok_host_slots WHERE token=? AND owner_root_hash=?")
        .get(slot.token, slot.ownerRootHash);
      if (!row) {
        db.exec(options.reconcileRequired === true ? "ROLLBACK" : "COMMIT");
        return options.reconcileRequired === true
          ? { released: false, reconcileRequired: true }
          : { released: true, reconcileRequired: false };
      }
      if (row.gate_epoch !== slot.gateEpoch) {
        db.exec("ROLLBACK");
        return { released: false, reconcileRequired: true };
      }
      if (options.reconcileRequired === true) {
        db.exec("ROLLBACK");
        return { released: false, reconcileRequired: true };
      }
      if (options.terminalProven === true || row.contact_started_at === null) {
        db.prepare("DELETE FROM grok_host_slots WHERE token=? AND gate_epoch=? AND owner_root_hash=?")
          .run(slot.token, slot.gateEpoch, slot.ownerRootHash);
        db.exec("COMMIT");
        return { released: true, reconcileRequired: false };
      }
      db.exec("ROLLBACK");
      return { released: false, reconcileRequired: true };
    } catch (error) {
      rollbackQuietly(db);
      throw normalizeGateError(error);
    } finally {
      closeQuietly(db);
      this.#assertPrivateGateFiles();
    }
  }

  /** Transactionally revoke without deleting active/uncertain slots or authorizing a replacement. */
  revoke(detail) {
    if (this.disabled) return;
    const db = this.#openChecked();
    try {
      db.exec("BEGIN IMMEDIATE");
      const gate = this.#readGate(db);
      if (!gate) throw new GrokHostGateError("Grok host gate is not armed", { code: "grok_host_gate_unarmed" });
      this.#revokeInTransaction(db, gate, detail);
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw normalizeGateError(error);
    } finally {
      closeQuietly(db);
      this.#assertPrivateGateFiles();
    }
  }

  /** Return a sanitized, non-authorizing readiness projection for doctor/status surfaces. */
  inspect() {
    if (this.disabled) return { enabled: false, ready: false, state: "test-disabled" };
    const db = this.#openChecked();
    try {
      const gate = this.#readGate(db);
      if (!gate) return { enabled: true, ready: false, state: "unarmed" };
      const invalid = gate.state === "healthy" ? validateHealthyGateRow(gate, new Date()) : undefined;
      return {
        enabled: true,
        ready: gate.state === "healthy" && invalid === undefined,
        state: gate.state === "healthy" && invalid ? "invalid" : String(gate.state),
        maxConcurrency: Number.isSafeInteger(gate.max_concurrency) ? gate.max_concurrency : undefined,
        authorizationExpiresAt: typeof gate.authorization_expires_at === "string" ? gate.authorization_expires_at : undefined,
        allowanceState: typeof gate.allowance_state === "string" ? gate.allowance_state : undefined,
        billingMode: typeof gate.billing_mode === "string" ? gate.billing_mode : undefined,
        imageReady: IMAGE_GATE_DETAIL.test(String(gate.detail ?? "")),
        schemaVersion: GROK_HOST_GATE_SCHEMA_VERSION,
      };
    } finally {
      closeQuietly(db);
      this.#assertPrivateGateFiles();
    }
  }

  #validatedHealthyGate(db, now) {
    const gate = this.#readGate(db);
    if (!gate) throw new GrokHostGateError("Grok host gate is not armed; owner reauthorization is required", { code: "grok_host_gate_unarmed" });
    if (gate.state !== "healthy") {
      throw new GrokHostGateError("Grok host gate is revoked; owner reauthorization is required", { code: "grok_host_gate_revoked" });
    }
    const invalid = validateHealthyGateRow(gate, now);
    if (invalid) {
      this.#revokeInTransaction(db, gate, invalid);
      db.exec("COMMIT");
      throw new GrokHostGateError(`${invalid}; Grok host gate was transactionally revoked`, { code: "grok_host_gate_revoked" });
    }
    return gate;
  }

  #readGate(db) {
    return db.prepare("SELECT * FROM grok_host_gates WHERE provider=? AND account_class=?")
      .get(GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS);
  }

  #revokeInTransaction(db, gate, detail) {
    const epoch = Number.isSafeInteger(gate.revocation_epoch) && gate.revocation_epoch >= 0 ? gate.revocation_epoch + 1 : 1;
    db.prepare(`UPDATE grok_host_gates SET state='revoked', detail=?, updated_at=?, authorization_expires_at='', revocation_epoch=?, allowance_state='unavailable', billing_mode='blocked'
      WHERE provider=? AND account_class=?`)
      .run(boundedDetail(detail), utcText(new Date()), epoch, GROK_HOST_GATE_PROVIDER, GROK_HOST_GATE_ACCOUNT_CLASS);
  }

  #openChecked(options = {}) {
    this.#assertPrivateGateFiles();
    let db;
    try {
      const DatabaseSync = loadDatabaseSync();
      assertNoSymlinkAncestors(this.path);
      db = new DatabaseSync(this.path);
      const busyTimeoutMs = Math.max(1, Math.min(10_000, Math.floor(options.busyTimeoutMs ?? 10_000)));
      db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
      const journal = db.prepare("PRAGMA journal_mode").get();
      if (String(journal?.journal_mode ?? "").toLowerCase() !== "wal") {
        throw new GrokHostGateError("Grok host gate must already use SQLite WAL mode", { code: "grok_host_gate_schema" });
      }
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
      if (version !== GROK_HOST_GATE_SCHEMA_VERSION) {
        throw new GrokHostGateError(`Grok host gate requires exact PRAGMA user_version=${GROK_HOST_GATE_SCHEMA_VERSION}`, { code: "grok_host_gate_schema" });
      }
      assertExactSchemaObjects(db);
      assertTableColumns(db, "grok_host_gates", GATE_COLUMNS);
      assertTableColumns(db, "grok_host_slots", SLOT_COLUMNS);
      this.#assertPrivateGateFiles();
      return db;
    } catch (error) {
      closeQuietly(db);
      throw normalizeGateError(error);
    }
  }

  #assertPrivateGateFiles() {
    assertNoSymlinkAncestors(this.path);
    assertOwnerOnlyDirectory(dirname(this.path), "Grok host gate directory");
    assertOwnerOnlyRegularFile(this.path, "Grok host gate database");
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${this.path}${suffix}`;
      try {
        assertOwnerOnlyRegularFile(sidecar, `Grok host gate ${suffix.slice(1).toUpperCase()} file`);
      } catch (error) {
        if (error?.cause?.code !== "ENOENT") throw error;
      }
    }
  }
}

function validateHealthyGateRow(gate, now) {
  if (!Number.isSafeInteger(gate.max_concurrency) || gate.max_concurrency < 1 || gate.max_concurrency > 12) return "Grok host gate max_concurrency is invalid";
  if (!Number.isSafeInteger(gate.revocation_epoch) || gate.revocation_epoch < 1) return "Grok host gate revocation_epoch is invalid";
  if (gate.contract_hash !== grokHostGateContract(gate.max_concurrency).hash) return "Grok host gate contract hash does not match schema version 2";
  const authorizationText = gate.authorization_expires_at;
  const authorizationExpiry = typeof authorizationText === "string" && /(?:Z|[+-]\d{2}:\d{2})$/i.test(authorizationText)
    ? Date.parse(authorizationText)
    : Number.NaN;
  if (!Number.isFinite(authorizationExpiry) || authorizationExpiry <= now.getTime()) return "Grok host gate authorization is missing, malformed, or expired";
  if (gate.allowance_state !== "available") return "Grok saved-session allowance is not available";
  if (gate.billing_mode !== "subscription_included") return "Grok saved-session billing mode is not subscription_included";
  return undefined;
}

function assertTableColumns(db, table, expected) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  const actual = Object.fromEntries(rows.map((row) => [row.name, [String(row.type).toUpperCase(), Number(row.notnull), row.dflt_value ?? null, Number(row.pk)]]));
  const names = Object.keys(actual).sort();
  const wanted = Object.keys(expected).sort();
  if (names.length !== wanted.length || names.some((name, index) => name !== wanted[index])) {
    throw new GrokHostGateError(`Grok host gate table '${table}' has unknown or missing columns`, { code: "grok_host_gate_schema" });
  }
  for (const name of wanted) {
    if (JSON.stringify(actual[name]) !== JSON.stringify(expected[name])) {
      throw new GrokHostGateError(`Grok host gate table '${table}' column '${name}' has an invalid definition`, { code: "grok_host_gate_schema" });
    }
  }
}

function assertExactSchemaObjects(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
  if (JSON.stringify(tables) !== JSON.stringify([...USER_TABLES].sort())) {
    throw new GrokHostGateError("Grok host gate database has unknown or missing user tables", { code: "grok_host_gate_schema" });
  }
  const forbidden = db.prepare("SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger') LIMIT 1").get();
  if (forbidden) throw new GrokHostGateError("Grok host gate database has forbidden views or triggers", { code: "grok_host_gate_schema" });
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
    .all().map((row) => row.name);
  if (indexes.length !== 1 || indexes[0] !== SLOT_INDEX) {
    throw new GrokHostGateError("Grok host gate database has unknown or missing user indexes", { code: "grok_host_gate_schema" });
  }
  const columns = db.prepare(`PRAGMA index_info(${SLOT_INDEX})`).all().map((row) => row.name);
  if (JSON.stringify(columns) !== JSON.stringify(SLOT_INDEX_COLUMNS)) {
    throw new GrokHostGateError("Grok host gate slot index definition is invalid", { code: "grok_host_gate_schema" });
  }
}

function assertNoSymlinkAncestors(path) {
  let candidate = dirname(path);
  while (true) {
    let entry;
    try {
      entry = lstatSync(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw new GrokHostGateError("Grok host gate ancestor could not be inspected", { code: "grok_host_gate_permissions", cause: error });
    }
    if (entry?.isSymbolicLink()) {
      throw new GrokHostGateError("Grok host gate path must not have symbolic-link ancestors", { code: "grok_host_gate_permissions" });
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
}

function assertOwnerOnlyDirectory(path, label) {
  const entry = safeLstat(path, label);
  if (entry.isSymbolicLink()) throw new GrokHostGateError(`${label} must not be a symbolic link`, { code: "grok_host_gate_permissions" });
  if (!entry.isDirectory()) throw new GrokHostGateError(`${label} must be a regular directory`, { code: "grok_host_gate_permissions" });
  assertOwnerOnly(entry, label, { singleLink: false });
}

function assertOwnerOnlyRegularFile(path, label) {
  const entry = safeLstat(path, label);
  if (entry.isSymbolicLink()) throw new GrokHostGateError(`${label} must not be a symbolic link`, { code: "grok_host_gate_permissions" });
  if (!entry.isFile()) throw new GrokHostGateError(`${label} must be a regular file`, { code: "grok_host_gate_permissions" });
  assertOwnerOnly(entry, label);
}

function safeLstat(path, label) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new GrokHostGateError(`${label} is unavailable`, { code: "grok_host_gate_permissions", cause: error });
  }
}

function assertOwnerOnly(entry, label, options = {}) {
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    throw new GrokHostGateError(`${label} is not owned by the current user`, { code: "grok_host_gate_permissions" });
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new GrokHostGateError(`${label} must not grant group or other permissions`, { code: "grok_host_gate_permissions" });
  }
  if (options.singleLink !== false && entry.nlink !== 1) {
    throw new GrokHostGateError(`${label} must have exactly one filesystem link`, { code: "grok_host_gate_permissions" });
  }
}

function loadDatabaseSync() {
  if (DatabaseSyncImplementation) return DatabaseSyncImplementation;
  try {
    ({ DatabaseSync: DatabaseSyncImplementation } = require("node:sqlite"));
  } catch (error) {
    throw new GrokHostGateError("The Linux Grok saved-session host gate requires node:sqlite (Node.js 22.5 or newer); no in-memory fallback is permitted", {
      code: "grok_host_gate_runtime",
      cause: error,
    });
  }
  if (typeof DatabaseSyncImplementation !== "function") {
    throw new GrokHostGateError("The Linux Grok saved-session host gate requires node:sqlite DatabaseSync; no in-memory fallback is permitted", {
      code: "grok_host_gate_runtime",
    });
  }
  return DatabaseSyncImplementation;
}

function utcText(value) {
  return value.toISOString().replace(/Z$/, "+00:00");
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function remainingBudgetMs(deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return 10_000;
  const remaining = Math.floor(Number(deadlineAt) - Date.now());
  if (remaining <= 0) {
    throw new GrokHostGateError("Grok host gate exhausted the end-to-end request deadline", { code: "grok_host_gate_timeout" });
  }
  return Math.max(1, Math.min(10_000, remaining));
}

function beginImmediate(db, deadlineAt) {
  if (Number.isFinite(deadlineAt)) db.exec(`PRAGMA busy_timeout=${remainingBudgetMs(deadlineAt)}`);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (Number.isFinite(deadlineAt) && /locked|busy/i.test(String(error?.message ?? error))) {
      throw new GrokHostGateError("Grok host gate lock wait exhausted the end-to-end request deadline", {
        code: "grok_host_gate_timeout",
        cause: error,
      });
    }
    throw error;
  }
}

function boundedDetail(value) {
  return String(value ?? "Grok host gate revoked").replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").slice(0, 240);
}

function normalizeGateError(error) {
  return error instanceof GrokHostGateError
    ? error
    : new GrokHostGateError(error instanceof Error ? error.message : String(error), { cause: error });
}

function rollbackQuietly(db) {
  try { if (db?.isTransaction) db.exec("ROLLBACK"); } catch {}
}

function closeQuietly(db) {
  try { db?.close(); } catch {}
}
