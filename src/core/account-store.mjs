import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ConfigError, RequestError } from "./errors.mjs";

export const ACCOUNT_STORE_SCHEMA_VERSION = 1;
export const UNKNOWN_ACCOUNT_ID = "unknown/default";
export const ACCOUNT_AUTH_KINDS = Object.freeze([
  "native-oauth",
  "device-login",
  "cli-login",
  "api-key-env",
  "secret-file-ref",
]);

const ACCOUNT_INPUT_KEYS = new Set(["providerId", "provider", "label", "authKind", "authSourceRef", "profileRef"]);
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MAX_ACCOUNT_STORE_BYTES = 1_048_576;
const WINDOWS_REPLACE_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);

/** Machine-local, privacy-minimized account descriptors and active selections. */
export class AccountStore {
  /**
   * @param {{
   *   path?: string|null,
   *   now?: () => Date|number|string,
   *   lockTimeoutMs?: number,
   *   lockRetryMs?: number,
   *   staleLockMs?: number,
   * }} [options]
   */
  constructor(options = {}) {
    this.path = resolveAccountStorePath(options.path);
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockRetryMs = positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, "lockRetryMs");
    this.staleLockMs = positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, "staleLockMs");
    this.state = loadState(this.path);
    this.tail = Promise.resolve();
  }

  /** Return safe +Account choices. These descriptors never request a credential value. */
  creationDescriptors() {
    return ACCOUNT_CREATION_DESCRIPTORS.map((descriptor) => structuredClone(descriptor));
  }

  /** Return public descriptors with active selection and authoritative observed quota facts. */
  list(options = {}) {
    this.#refresh();
    const providerId = optionalDimension(options.providerId, "providerId");
    return this.state.accounts
      .filter((account) => !providerId || account.providerId === providerId)
      .map((account) => publicAccount(account, this.state.activeByProvider[account.providerId] === account.id));
  }

  /** Return a persisted account descriptor by opaque id. */
  get(accountId) {
    if (accountId === UNKNOWN_ACCOUNT_ID) return legacyAccount();
    this.#refresh();
    return this.state.accounts.find((account) => account.id === accountId);
  }

  /** Resolve an explicit account or the provider's persisted active account. */
  resolve(providerId, requestedAccountId) {
    this.#refresh();
    const provider = dimension(providerId, "providerId");
    if (!requestedAccountId || requestedAccountId === UNKNOWN_ACCOUNT_ID) {
      const activeId = this.state.activeByProvider[provider];
      if (!activeId) return legacyAccount(provider);
      const active = this.state.accounts.find((account) => account.id === activeId);
      if (!active || active.providerId !== provider) throw new ConfigError(`Active account '${activeId}' is invalid for provider '${provider}'`);
      return active;
    }
    const requestedId = dimension(requestedAccountId, "accountId");
    const account = this.state.accounts.find((candidate) => candidate.id === requestedId);
    if (!account) throw new RequestError(`Unknown account '${requestedAccountId}'`);
    if (account.providerId !== provider) throw new RequestError(`Account '${requestedAccountId}' is bound to provider '${account.providerId}', not '${provider}'`);
    return account;
  }

  /** Return other accounts for the same provider in deterministic persisted order. */
  fallbackCandidates(providerId, excludedAccountId) {
    this.#refresh();
    const excluded = this.state.accounts.find((account) => account.id === excludedAccountId);
    const seenSources = new Set();
    const excludedSource = accountIsolationSource(excluded);
    if (excludedSource) seenSources.add(excludedSource);
    return this.state.accounts.filter((account) => {
      if (account.providerId !== providerId || account.id === excludedAccountId) return false;
      const source = accountIsolationSource(account);
      if (source && seenSources.has(source)) return false;
      if (source) seenSources.add(source);
      return true;
    });
  }

  /** Persist one closed account descriptor. Credential values and identity data are rejected. */
  create(input) {
    return this.#enqueue(async () => {
      const account = normalizeNewAccount(input, this.now);
      return withAccountStoreLock(this.path, this, async () => {
        const candidate = loadState(this.path);
        const source = accountIsolationSource(account);
        if (source && candidate.accounts.some((existing) => accountIsolationSource(existing) === source)) {
          throw new RequestError(`Account source '${account.authSourceRef ?? account.profileRef}' is already registered`);
        }
        candidate.accounts.push(account);
        candidate.activeByProvider[account.providerId] ??= account.id;
        await persistState(this.path, candidate);
        this.state = candidate;
        return publicAccount(account, candidate.activeByProvider[account.providerId] === account.id);
      });
    });
  }

  /** Persist the active account for its bound provider. */
  select(accountId) {
    return this.#enqueue(async () => {
      const id = dimension(accountId, "accountId");
      return withAccountStoreLock(this.path, this, async () => {
        const candidate = loadState(this.path);
        const account = candidate.accounts.find((item) => item.id === id);
        if (!account) throw new RequestError(`Unknown account '${id}'`);
        candidate.activeByProvider[account.providerId] = account.id;
        await persistState(this.path, candidate);
        this.state = candidate;
        return publicAccount(account, true);
      });
    });
  }

  /** Capture a privacy-safe generation binding for one exact active provider account. */
  createSelectionBinding(providerId, expectedAccountId) {
    this.#refresh();
    const provider = dimension(providerId, "providerId");
    const account = this.resolve(provider, expectedAccountId);
    if (this.state.activeByProvider[provider] !== account.id) {
      throw new RequestError(`Account '${account.id}' is not the active account for provider '${provider}'`);
    }
    return selectionBinding(account);
  }

  /** Hold the account-store generation while an exact read-only bound operation commits. */
  withSelectionBinding(binding, operation) {
    if (typeof operation !== "function") throw new TypeError("Account selection binding operation is required");
    const expected = normalizeSelectionBinding(binding);
    return this.#enqueue(() => withAccountStoreLock(this.path, this, async () => {
      const candidate = loadState(this.path);
      const activeId = candidate.activeByProvider[expected.providerId];
      const account = candidate.accounts.find((item) => item.id === activeId);
      if (!account || selectionBinding(account).digest !== expected.digest) {
        throw new RequestError(`Active account binding changed for provider '${expected.providerId}'`);
      }
      this.state = candidate;
      return operation(structuredClone(expected));
    }));
  }

  /** Remove one descriptor and deterministically advance or clear its provider selection. */
  remove(accountId) {
    return this.#enqueue(async () => {
      const id = dimension(accountId, "accountId");
      return withAccountStoreLock(this.path, this, async () => {
        const candidate = loadState(this.path);
        const index = candidate.accounts.findIndex((account) => account.id === id);
        if (index < 0) throw new RequestError(`Unknown account '${id}'`);
        const [removed] = candidate.accounts.splice(index, 1);
        if (candidate.activeByProvider[removed.providerId] === id) {
          const next = candidate.accounts.find((account) => account.providerId === removed.providerId);
          if (next) candidate.activeByProvider[removed.providerId] = next.id;
          else delete candidate.activeByProvider[removed.providerId];
        }
        await persistState(this.path, candidate);
        this.state = candidate;
        return publicAccount(removed, false);
      });
    });
  }

  /** Persist one closed, authoritative quota observation for an existing account. */
  observeQuota(accountId, observation) {
    return this.#enqueue(async () => {
      const id = dimension(accountId, "accountId");
      const quota = normalizeQuotaObservation(observation, RequestError);
      return withAccountStoreLock(this.path, this, async () => {
        const candidate = loadState(this.path);
        const account = candidate.accounts.find((item) => item.id === id);
        if (!account) throw new RequestError(`Unknown account '${id}'`);
        account.quota = quota;
        await persistState(this.path, candidate);
        this.state = candidate;
        return publicAccount(account, candidate.activeByProvider[account.providerId] === account.id);
      });
    });
  }

  /** Count-only diagnostics. */
  stats() {
    this.#refresh();
    return { accounts: this.state.accounts.length, activeProviders: Object.keys(this.state.activeByProvider).length };
  }

  #refresh() {
    this.state = refreshState(this.path, this.state);
  }

  #enqueue(operation) {
    const execution = this.tail.catch(() => undefined).then(operation);
    this.tail = execution.then(() => undefined, () => undefined);
    return execution;
  }
}

/** Resolve an explicit or per-user machine-local account state path. */
export function resolveAccountStorePath(configuredPath) {
  if (typeof configuredPath === "string" && configuredPath.trim()) return resolve(expandHome(configuredPath.trim()));
  return join(homedir(), ".threadspan", "accounts.json");
}

function loadState(path) {
  let descriptor;
  let source;
  try {
    descriptor = openSync(path, "r");
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("Account state path is not a regular file");
    if (metadata.size > MAX_ACCOUNT_STORE_BYTES) throw new Error(`Account state exceeds ${MAX_ACCOUNT_STORE_BYTES} bytes`);
    source = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new ConfigError(`Could not read machine-local account state: ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed;
  try { parsed = JSON.parse(source); } catch (error) {
    throw new ConfigError(`Could not parse machine-local account state: ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== ACCOUNT_STORE_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported or malformed account state: ${path}`);
  }
  const expectedStateKeys = new Set(["schemaVersion", "accounts", "activeByProvider"]);
  if (Object.keys(parsed).some((key) => !expectedStateKeys.has(key))) throw new ConfigError(`Account state contains unsupported fields: ${path}`);
  if (!Array.isArray(parsed.accounts) || !isObject(parsed.activeByProvider)) throw new ConfigError(`Malformed account state: ${path}`);
  const accounts = parsed.accounts.map(normalizeStoredAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) throw new ConfigError(`Duplicate account ids in ${path}`);
  const activeByProvider = {};
  for (const [providerId, accountId] of Object.entries(parsed.activeByProvider)) {
    const account = accounts.find((candidate) => candidate.id === accountId);
    if (!account || account.providerId !== providerId) throw new ConfigError(`Invalid active account binding for provider '${providerId}'`);
    activeByProvider[providerId] = accountId;
  }
  return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION, accounts, activeByProvider };
}

function refreshState(path, current) {
  try {
    if (!statSync(path).isFile()) return current;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new ConfigError(`Could not inspect machine-local account state: ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  return loadState(path);
}

function normalizeNewAccount(input, now) {
  if (!isObject(input)) throw new RequestError("Account descriptor must be an object");
  const unknownKeys = Object.keys(input).filter((key) => !ACCOUNT_INPUT_KEYS.has(key));
  if (unknownKeys.length > 0) throw new RequestError(`Account descriptor contains unsupported fields: ${unknownKeys.join(", ")}`);
  const providerId = dimension(input.providerId ?? input.provider, "providerId");
  const label = accountLabel(input.label);
  const authKind = dimension(input.authKind, "authKind");
  if (!ACCOUNT_AUTH_KINDS.includes(authKind)) throw new RequestError(`Unsupported account auth kind '${authKind}'`);
  const authSourceRef = optionalReference(input.authSourceRef, "authSourceRef");
  const profileRef = optionalReference(input.profileRef, "profileRef");
  if (["api-key-env", "secret-file-ref"].includes(authKind) && !authSourceRef) {
    throw new RequestError(`${authKind} accounts require authSourceRef`);
  }
  if (authKind === "api-key-env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authSourceRef)) {
    throw new RequestError("api-key-env authSourceRef must be an environment-variable name");
  }
  const timestamp = new Date(now()).toISOString();
  return { id: `acct_${randomUUID()}`, providerId, label, authKind, ...(authSourceRef ? { authSourceRef } : {}), ...(profileRef ? { profileRef } : {}), createdAt: timestamp, updatedAt: timestamp };
}

function normalizeStoredAccount(input) {
  if (!isObject(input)) throw new ConfigError("Stored account must be an object");
  const expected = new Set(["id", "providerId", "label", "authKind", "authSourceRef", "profileRef", "createdAt", "updatedAt", "quota"]);
  if (Object.keys(input).some((key) => !expected.has(key))) throw new ConfigError("Stored account contains unsupported fields");
  const id = dimension(input.id, "account.id");
  if (!/^acct_[0-9a-f-]{36}$/i.test(id)) throw new ConfigError(`Stored account id '${id}' is not opaque Threadspan account id`);
  const providerId = dimension(input.providerId, "account.providerId");
  const label = accountLabel(input.label, ConfigError);
  const authKind = dimension(input.authKind, "account.authKind");
  if (!ACCOUNT_AUTH_KINDS.includes(authKind)) throw new ConfigError(`Stored account has unsupported auth kind '${authKind}'`);
  const authSourceRef = optionalReference(input.authSourceRef, "account.authSourceRef", ConfigError);
  const profileRef = optionalReference(input.profileRef, "account.profileRef", ConfigError);
  if (["api-key-env", "secret-file-ref"].includes(authKind) && !authSourceRef) throw new ConfigError(`Stored ${authKind} account requires authSourceRef`);
  if (authKind === "api-key-env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(authSourceRef)) throw new ConfigError("Stored api-key-env account reference must be an environment-variable name");
  const createdAt = validTimestamp(input.createdAt, "account.createdAt");
  const updatedAt = validTimestamp(input.updatedAt, "account.updatedAt");
  const quota = input.quota === undefined ? undefined : normalizeQuotaObservation(input.quota, ConfigError);
  return { id, providerId, label, authKind, ...(authSourceRef ? { authSourceRef } : {}), ...(profileRef ? { profileRef } : {}), createdAt, updatedAt, ...(quota ? { quota } : {}) };
}

function normalizeQuotaObservation(input, ErrorType) {
  if (!isObject(input)) throw new ErrorType("Quota observation must be an object");
  const expected = new Set(["remaining", "resetAt", "renewalAt", "charge", "source", "observedAt"]);
  const unknownKeys = Object.keys(input).filter((key) => !expected.has(key));
  if (unknownKeys.length > 0) throw new ErrorType(`Quota observation contains unsupported fields: ${unknownKeys.join(", ")}`);
  for (const key of expected) {
    if (!Object.hasOwn(input, key)) throw new ErrorType(`Quota observation requires '${key}'`);
  }
  return {
    remaining: nullableNonnegativeFinite(input.remaining, "quota.remaining", ErrorType),
    resetAt: nullableTimestamp(input.resetAt, "quota.resetAt", ErrorType),
    renewalAt: nullableTimestamp(input.renewalAt, "quota.renewalAt", ErrorType),
    charge: nullableNonnegativeFinite(input.charge, "quota.charge", ErrorType),
    source: quotaSource(input.source, ErrorType),
    observedAt: validTimestamp(input.observedAt, "quota.observedAt", ErrorType),
  };
}

function publicAccount(account, active = false) {
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    authKind: account.authKind,
    ...(account.authSourceRef ? { authSourceRef: account.authSourceRef } : {}),
    ...(account.profileRef ? { profileRef: account.profileRef } : {}),
    active,
    quota: { ...unknownQuota(account.updatedAt ?? account.createdAt), ...(account.quota ?? {}) },
  };
}

function legacyAccount(providerId) {
  return { id: UNKNOWN_ACCOUNT_ID, providerId, label: "Default / unknown account", authKind: "legacy-provider-default", legacy: true };
}

function unknownQuota(observedAt) {
  return { remaining: null, resetAt: null, renewalAt: null, charge: null, source: "not-observed", observedAt };
}

function accountIsolationSource(account) {
  if (!account) return undefined;
  if (["api-key-env", "secret-file-ref"].includes(account.authKind) && account.authSourceRef) {
    return `${account.providerId}\u0000${account.authKind}\u0000${account.authSourceRef}`;
  }
  return account.profileRef ? `${account.providerId}\u0000profile\u0000${account.profileRef}` : undefined;
}

async function persistState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await replaceAccountStoreFile(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Atomically replace an account-store file, retrying transient Windows sharing failures.
 * The injectable operations keep the platform-specific path deterministic in offline tests.
 */
export async function replaceAccountStoreFile(source, destination, options = {}) {
  const renameFile = options.renameFile ?? rename;
  const wait = options.delay ?? delay;
  const platform = options.platform ?? process.platform;
  const attempts = positiveInteger(options.attempts ?? 20, "attempts");
  const retryMs = positiveInteger(options.retryMs ?? 10, "retryMs");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      const retryable = platform === "win32" && WINDOWS_REPLACE_RETRY_CODES.has(error?.code);
      if (!retryable || attempt === attempts) throw error;
      await wait(retryMs);
    }
  }
}

/** Serialize account mutations across processes through one owner-local lock file. */
async function withAccountStoreLock(path, options, operation) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + options.lockTimeoutMs;
  while (true) {
    try {
      await createOwnedLock(lockPath, token);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeAbandonedLock(lockPath, options.staleLockMs)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring account store lock: ${lockPath}`);
      await delay(options.lockRetryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockPath, token);
  }
}

/** Create and flush ownership metadata before treating the lock as acquired. */
async function createOwnedLock(lockPath, token) {
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
      handle = undefined;
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Reclaim only a dead owner or an old malformed lock left before metadata was flushed. */
async function removeAbandonedLock(lockPath, staleLockMs) {
  let contents;
  let metadata;
  try {
    [contents, metadata] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  }
  let owner;
  try { owner = JSON.parse(contents); } catch {}
  if (validLockOwner(owner)) {
    if (processIsAlive(owner.pid)) return false;
    return quarantineAndRemoveMatchingLock(lockPath, contents, metadata);
  }
  if (Date.now() - metadata.mtimeMs < staleLockMs) return false;
  return quarantineAndRemoveMatchingLock(lockPath, contents, metadata);
}

/** Remove only the lock token created by this caller. */
async function releaseOwnedLock(lockPath, token) {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8"));
    if (owner?.token === token) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/** Claim one exact stale lock inode before unlinking its public lock name. */
async function quarantineAndRemoveMatchingLock(lockPath, contents, metadata) {
  const fingerprint = createHash("sha256")
    .update(contents)
    .update(`\0${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`)
    .digest("hex");
  const quarantinePath = `${lockPath}.quarantine-${fingerprint}`;
  let quarantined = false;
  try {
    await link(lockPath, quarantinePath);
    quarantined = true;
    const [currentMetadata, quarantineMetadata, currentContents] = await Promise.all([
      stat(lockPath),
      stat(quarantinePath),
      readFile(lockPath, "utf8"),
    ]);
    const sameFile = currentMetadata.dev === quarantineMetadata.dev && currentMetadata.ino === quarantineMetadata.ino;
    if (!sameFile || currentContents !== contents) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    return false;
  } finally {
    if (quarantined) await unlink(quarantinePath).catch(() => undefined);
  }
}

function validLockOwner(owner) {
  return isObject(owner) && typeof owner.token === "string" && owner.token.length > 0 && Number.isSafeInteger(owner.pid) && owner.pid > 0;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Flush the parent directory where supported so the replacement survives a crash. */
async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function emptyState() {
  return { schemaVersion: ACCOUNT_STORE_SCHEMA_VERSION, accounts: [], activeByProvider: {} };
}

function selectionBinding(account) {
  const value = {
    kind: "account-selection-binding",
    providerId: account.providerId,
    accountId: account.id,
    authKind: account.authKind,
    authSourceRef: account.authSourceRef ?? null,
    profileRef: account.profileRef ?? null,
  };
  return { ...value, digest: createHash("sha256").update(stableStringify(value)).digest("hex") };
}

function normalizeSelectionBinding(value) {
  if (!isObject(value) || value.kind !== "account-selection-binding"
    || typeof value.providerId !== "string" || typeof value.accountId !== "string"
    || typeof value.authKind !== "string" || !/^[a-f0-9]{64}$/.test(value.digest ?? "")) {
    throw new TypeError("Malformed account selection binding");
  }
  const expected = selectionBinding({
    providerId: value.providerId,
    id: value.accountId,
    authKind: value.authKind,
    authSourceRef: value.authSourceRef ?? undefined,
    profileRef: value.profileRef ?? undefined,
  });
  if (expected.digest !== value.digest) throw new TypeError("Malformed account selection binding digest");
  return expected;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function accountLabel(value, ErrorType = RequestError) {
  const label = dimension(value, "label", ErrorType);
  if (label.length > 80 || label.includes("@") || /[\r\n]/.test(label)) throw new ErrorType("Account label must be at most 80 characters and must not contain email-like identity data");
  return label;
}

function optionalReference(value, label, ErrorType = RequestError) {
  if (value === undefined || value === null || value === "") return undefined;
  const reference = dimension(value, label, ErrorType);
  if (!REFERENCE_PATTERN.test(reference)) throw new ErrorType(`${label} must be an opaque local reference, not a path or credential value`);
  return reference;
}

function dimension(value, label, ErrorType = RequestError) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new ErrorType(`${label} must be a non-empty printable string of at most 160 characters`);
  return value.trim();
}

function optionalDimension(value, label) {
  return value === undefined || value === null || value === "" ? undefined : dimension(value, label);
}

function quotaSource(value, ErrorType) {
  const source = dimension(value, "quota.source", ErrorType);
  if (!REFERENCE_PATTERN.test(source)) throw new ErrorType("quota.source must be an opaque source label, not a path, identity, or credential value");
  return source;
}

function nullableNonnegativeFinite(value, label, ErrorType) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new ErrorType(`${label} must be a finite nonnegative number or null`);
  return value;
}

function nullableTimestamp(value, label, ErrorType) {
  return value === null ? null : validTimestamp(value, label, ErrorType);
}

function validTimestamp(value, label, ErrorType = ConfigError) {
  if (value === null) throw new ErrorType(`${label} must be a valid timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ErrorType(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

const ACCOUNT_CREATION_DESCRIPTORS = Object.freeze([
  { authKind: "native-oauth", label: "Native OAuth", requires: ["label", "providerId"], optional: ["profileRef"], collectsSecrets: false, instructions: "Complete sign-in in the provider's native app or CLI. Threadspan records only an optional opaque profile reference." },
  { authKind: "device-login", label: "Device login", requires: ["label", "providerId"], optional: ["profileRef"], collectsSecrets: false, instructions: "Start the provider's native device-login flow outside Threadspan, then record only an optional opaque profile reference." },
  { authKind: "cli-login", label: "CLI login", requires: ["label", "providerId"], optional: ["profileRef"], collectsSecrets: false, instructions: "Run the provider CLI login command in a terminal. Threadspan never asks for the login token or raw profile path." },
  { authKind: "api-key-env", label: "API key environment", requires: ["label", "providerId", "authSourceRef"], optional: [], collectsSecrets: false, instructions: "Set the API key in the named environment variable before starting Threadspan; enter only the variable name." },
  { authKind: "secret-file-ref", label: "Owner-selected secret file", requires: ["label", "providerId", "authSourceRef"], optional: [], collectsSecrets: false, instructions: "Configure the secret file path in machine-local provider accountSources, then enter only its opaque reference name." },
]);
