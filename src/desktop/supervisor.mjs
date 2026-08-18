import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export const DESKTOP_SUPERVISOR_SCHEMA_VERSION = 1;
export const DESKTOP_BOOTSTRAP_PHASES = Object.freeze([
  "prepared",
  "injected",
  "acknowledged",
  "inspector-closed",
  "attached",
  "indeterminate",
  "recovery-required",
  "rolled-back",
]);

const BOOTSTRAP_PHASE_SET = new Set(DESKTOP_BOOTSTRAP_PHASES);
const TERMINAL_RECOVERY_PHASES = new Set(["indeterminate", "recovery-required"]);
const MAX_CHANNEL_FRAME_BYTES = 64 * 1024;
const MAX_CHANNEL_RESULT_BYTES = 128 * 1024;
const MAX_HUD_ROUTES = 120;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GENERATION_PATTERN = /^electron_[a-f0-9]{32}$/;

const ALLOWED_TRANSITIONS = Object.freeze({
  prepared: new Set(["injected", "recovery-required", "rolled-back"]),
  injected: new Set(["acknowledged", "indeterminate", "recovery-required"]),
  acknowledged: new Set(["inspector-closed", "indeterminate", "recovery-required"]),
  "inspector-closed": new Set(["attached", "indeterminate", "recovery-required"]),
  attached: new Set(["recovery-required", "rolled-back"]),
  indeterminate: new Set(["recovery-required"]),
  "recovery-required": new Set(["rolled-back"]),
  "rolled-back": new Set(),
});

/** Normalize the one-time Electron bootstrap port. */
export function normalizeBootstrapPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new TypeError("Desktop bootstrap port must be an integer from 1024 through 65535");
  return port;
}

/** Create an opaque generation from public process/source identity. */
export function createElectronGeneration(identity) {
  const normalized = normalizeExpectedIdentity(identity);
  return `electron_${sha256(stableStringify(normalized)).slice(0, 32)}`;
}

/** Create a fresh per-Electron-generation successor capability. */
export function createSupervisorCapability() {
  return randomBytes(32).toString("base64url");
}

/** Return a non-secret digest suitable for private recovery state and receipts. */
export function capabilityDigest(capability) {
  assertCapability(capability);
  return sha256(`threadspan-desktop-supervisor\0${capability}`);
}

/**
 * Validate that discovery exposes exactly one node inspector target on the exact
 * loopback bootstrap port. This is deliberately stricter than choosing the
 * first debuggable target.
 */
export function validateInspectorTargetList(targets, options = {}) {
  if (!Array.isArray(targets)) throw new Error("Desktop bootstrap discovery did not return a target list");
  const port = normalizeBootstrapPort(options.port);
  if (targets.length !== 1) throw new Error(`Desktop bootstrap requires exactly one inspector target; observed ${targets.length}`);
  const target = targets[0];
  if (!isPlainObject(target) || target.type !== "node" || typeof target.id !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(target.id)) {
    throw new Error("Desktop bootstrap target is not one exact Node main-process target");
  }
  if (options.expectedTargetId && target.id !== options.expectedTargetId) throw new Error("Desktop bootstrap target identity changed");
  let debuggerUrl;
  try { debuggerUrl = new URL(target.webSocketDebuggerUrl); } catch { throw new Error("Desktop bootstrap target has an invalid WebSocket endpoint"); }
  if (debuggerUrl.protocol !== "ws:" || !isLoopbackHost(debuggerUrl.hostname) || Number(debuggerUrl.port) !== port) {
    throw new Error("Desktop bootstrap target is not bound to the exact loopback bootstrap port");
  }
  const pathId = decodeURIComponent(debuggerUrl.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (pathId !== target.id) throw new Error("Desktop bootstrap target ID does not match its WebSocket endpoint");
  if (typeof target.url === "string" && target.url.length > 2_048) throw new Error("Desktop bootstrap target URL is overlong");
  if (typeof target.title === "string" && target.title.length > 512) throw new Error("Desktop bootstrap target title is overlong");
  return Object.freeze({
    id: target.id,
    type: target.type,
    title: boundedString(target.title, 512),
    url: boundedString(target.url, 2_048),
    webSocketDebuggerUrl: debuggerUrl.href,
    discoveryDigest: sha256(stableStringify({ id: target.id, type: target.type, title: target.title ?? "", url: target.url ?? "", webSocketDebuggerUrl: debuggerUrl.href })),
  });
}

/** Capture exact digest-or-absence evidence for reviewed Desktop package paths. */
export async function snapshotDesktopPackages(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 16) throw new TypeError("Desktop package evidence requires one through sixteen reviewed paths");
  const seen = new Set();
  const entries = [];
  for (const rawPath of paths) {
    const path = resolve(String(rawPath));
    if (seen.has(path)) throw new Error("Desktop package evidence paths must be unique");
    seen.add(path);
    const info = await lstat(path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) {
      entries.push({ path, state: "absent" });
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Desktop package evidence path is not a regular file: ${path}`);
    const canonical = await realpath(path);
    const bytes = await readFile(canonical);
    const after = await lstat(canonical);
    if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error(`Desktop package changed while evidence was collected: ${path}`);
    }
    entries.push({ path, canonical, state: "present", size: info.size, mode: info.mode & 0o777, sha256: sha256(bytes) });
  }
  return Object.freeze({ schemaVersion: DESKTOP_SUPERVISOR_SCHEMA_VERSION, entries, digest: sha256(stableStringify(entries)) });
}

/** Prove that bootstrap/rollback did not alter reviewed Desktop packages. */
export function assertDesktopPackagesUnchanged(before, after) {
  validatePackageSnapshot(before);
  validatePackageSnapshot(after);
  if (!safeEqual(before.digest, after.digest) || stableStringify(before.entries) !== stableStringify(after.entries)) {
    throw new Error("Desktop package immutability check failed; recovery is required");
  }
  return { unchanged: true, digest: before.digest, paths: before.entries.length };
}

/**
 * Durable, cooperative exactly-once bootstrap transaction. Claims are never
 * broken from PID age; an orphaned claim requires owner review.
 */
export class DesktopBootstrapStore {
  constructor(options = {}) {
    this.statePath = resolve(String(options.statePath));
    this.claimPath = resolve(options.claimPath ?? `${this.statePath}.claim`);
    this.hostClaimPath = resolve(options.hostClaimPath ?? `${this.statePath}.host-claim`);
    this.claimGuardPath = `${this.claimPath}.guard`;
    this.hostClaimGuardPath = `${this.hostClaimPath}.guard`;
    this.capabilityPath = resolve(options.capabilityPath ?? `${this.statePath}.capability`);
    this.platform = options.platform ?? process.platform;
    this.owner = boundedRequiredString(options.owner ?? "threadspan-desktop-host", 160, "owner");
  }

  /** Read and validate current private transaction state. */
  async read() {
    try { return normalizeBootstrapState(await readPrivateJson(this.statePath)); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new Error("Desktop bootstrap state is malformed; recovery is required");
      throw error;
    }
  }

  /** Hold one cooperative Desktop-host owner across bootstrap or attachment. */
  async acquireHostClaim(input = {}) {
    const mode = boundedRequiredString(input.mode ?? "attach", 32, "host claim mode");
    if (!new Set(["attach", "launch", "rollback", "recover"]).has(mode)) throw new Error("Desktop host claim mode is unsupported");
    const nonce = randomBytes(24).toString("hex");
    await this.#withNarrowGuard(this.hostClaimGuardPath, async () => {
      await mkdir(dirname(this.hostClaimPath), { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await open(this.hostClaimPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, nonce, owner: this.owner, processId: process.pid, platform: this.platform, mode, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code === "EEXIST") throw new Error("Another Desktop host owns the cooperative attachment/bootstrap claim; no app or state action was taken");
        throw error;
      }
      await handle.close();
    });
    let released = false;
    return async () => {
      if (released) return;
      await this.#withNarrowGuard(this.hostClaimGuardPath, async () => {
        const claim = await readPrivateJson(this.hostClaimPath);
        if (claim?.nonce !== nonce) throw new Error("Desktop host claim changed; recovery is required");
        await unlink(this.hostClaimPath);
      });
      released = true;
    };
  }

  /** Inspect the exact cooperative host claim without inferring staleness. */
  async inspectHostClaim() {
    const candidates = [
      ["host-claim", this.hostClaimPath],
      ["host-guard", this.hostClaimGuardPath],
      ["transaction-claim", this.claimPath],
      ["transaction-guard", this.claimGuardPath],
    ];
    const blockers = [];
    for (const [kind, path] of candidates) {
      let claim;
      try { claim = await readPrivateJson(path); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      blockers.push({
        kind,
        digest: sha256(stableStringify(claim)),
        owner: boundedString(claim.owner, 160),
        processId: Number.isSafeInteger(claim.processId) ? claim.processId : null,
        mode: boundedString(claim.mode, 32),
        createdAt: boundedString(claim.createdAt, 64),
      });
    }
    return { present: blockers.length > 0, blockers };
  }

  /** Preserve and release only one exact owner-reviewed host claim. */
  async recoverHostClaim(expectedDigest, options = {}) {
    expectedDigest = normalizeDigest(expectedDigest, "host claim recovery digest");
    const inspected = await this.inspectHostClaim();
    const matches = inspected.blockers.filter((item) => safeEqual(item.digest, expectedDigest));
    if (matches.length !== 1) throw new Error("Desktop coordination claim recovery digest mismatch or ambiguity");
    const target = matches[0];
    const paths = {
      "host-claim": [this.hostClaimPath, this.hostClaimGuardPath],
      "transaction-claim": [this.claimPath, this.claimGuardPath],
      "host-guard": [this.hostClaimGuardPath, null],
      "transaction-guard": [this.claimGuardPath, null],
    };
    const [path, guardPath] = paths[target.kind];
    if (!guardPath && options.offlineConfirmed !== true) {
      throw new Error("Desktop guard recovery requires an explicit stop-the-world confirmation that all Desktop hosts/services are stopped");
    }
    const recover = async () => {
      const claim = await readPrivateJson(path);
      const actualDigest = sha256(stableStringify(claim));
      if (!safeEqual(actualDigest, expectedDigest)) throw new Error("Desktop coordination claim changed before recovery");
      const evidencePath = `${path}.recovered-${actualDigest}.json`;
      try { await lstat(evidencePath); throw new Error("Desktop coordination claim recovery evidence already exists"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      await rename(path, evidencePath);
      return { recovered: true, kind: target.kind, digest: actualDigest, evidenceDigest: sha256(await readFile(evidencePath)) };
    };
    return guardPath ? this.#withNarrowGuard(guardPath, recover) : recover();
  }

  /** Prepare a new exact generation, or return the identical prepared record. */
  async prepare(input) {
    const generation = normalizeGeneration(input.generation);
    const source = normalizeExpectedIdentity(input.source);
    const bootstrap = normalizeBootstrapEndpoint(input.bootstrap);
    const packageEvidence = validatePackageSnapshot(input.packageEvidence);
    const capDigest = normalizeDigest(input.capabilityDigest, "capability digest");
    return this.#withClaim(async () => {
      const current = await this.read();
      if (current) {
        if (current.generation === generation && current.phase === "prepared"
          && current.sourceDigest === sha256(stableStringify(source))
          && current.bootstrap.port === bootstrap.port
          && current.capabilityDigest === capDigest && current.packageDigest === packageEvidence.digest) return current;
        if (!current.phase || current.phase !== "rolled-back") {
          throw new Error(`Desktop bootstrap generation ${current.generation} is ${current.phase}; reviewed recovery is required before another bootstrap`);
        }
      }
      const now = new Date().toISOString();
      const state = {
        schemaVersion: DESKTOP_SUPERVISOR_SCHEMA_VERSION,
        revision: (current?.revision ?? 0) + 1,
        generation,
        phase: "prepared",
        source,
        bootstrap,
        sourceDigest: sha256(stableStringify(source)),
        capabilityDigest: capDigest,
        packageDigest: packageEvidence.digest,
        endpoint: null,
        receiptDigest: null,
        createdAt: now,
        updatedAt: now,
        recovery: null,
      };
      await atomicPrivateJson(this.statePath, state);
      return Object.freeze(state);
    });
  }

  /** Advance exactly one allowed transaction phase under revision CAS. */
  async transition(input) {
    const generation = normalizeGeneration(input.generation);
    const phase = normalizePhase(input.phase);
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    return this.#withClaim(async () => {
      const current = await this.read();
      if (!current || current.generation !== generation) throw new Error("Desktop bootstrap generation is not current");
      if (current.revision !== expectedRevision) throw new Error("Desktop bootstrap state revision changed");
      if (!ALLOWED_TRANSITIONS[current.phase]?.has(phase)) throw new Error(`Desktop bootstrap cannot transition from ${current.phase} to ${phase}`);
      const endpoint = input.endpoint === undefined ? current.endpoint : normalizeEndpointMetadata(input.endpoint);
      const receiptDigest = input.receiptDigest === undefined ? current.receiptDigest : normalizeDigest(input.receiptDigest, "receipt digest");
      const recovery = phase === "indeterminate" || phase === "recovery-required"
        ? normalizeRecovery(input.recovery)
        : phase === "rolled-back" ? normalizeRecovery(input.recovery, true) : null;
      const next = {
        ...current,
        revision: current.revision + 1,
        phase,
        endpoint,
        receiptDigest,
        updatedAt: new Date().toISOString(),
        recovery,
      };
      await atomicPrivateJson(this.statePath, next);
      return Object.freeze(next);
    });
  }

  /** Persist the raw capability only in the owner-private recovery file. */
  async saveCapability(generation, capability) {
    generation = normalizeGeneration(generation);
    assertCapability(capability);
    await this.#withClaim(async () => {
      const current = await this.read();
      if (!current || current.generation !== generation || current.capabilityDigest !== capabilityDigest(capability)) {
        throw new Error("Desktop supervisor capability does not match the prepared generation");
      }
      await atomicPrivateJson(this.capabilityPath, { schemaVersion: 1, generation, capability });
    });
  }

  /** Load the exact private capability for reconnect without publishing it. */
  async loadCapability(generation) {
    generation = normalizeGeneration(generation);
    const current = await this.read();
    if (!current || current.generation !== generation) return null;
    let document;
    try { document = await readPrivateJson(this.capabilityPath); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (document?.schemaVersion !== 1 || document.generation !== generation || typeof document.capability !== "string"
      || current.capabilityDigest !== capabilityDigest(document.capability)) throw new Error("Desktop supervisor private capability is invalid; recovery is required");
    return document.capability;
  }

  /** Remove only Threadspan's private capability during authenticated rollback. */
  async removeCapability(generation) {
    generation = normalizeGeneration(generation);
    await this.#withClaim(async () => {
      const current = await this.read();
      if (!current || current.generation !== generation) throw new Error("Desktop bootstrap generation is not current");
      await unlink(this.capabilityPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    });
  }

  async #withClaim(operation) {
    return this.#withNarrowGuard(this.claimGuardPath, async () => {
      await mkdir(dirname(this.claimPath), { recursive: true, mode: 0o700 });
      const nonce = randomBytes(24).toString("hex");
      let handle;
      try {
        handle = await open(this.claimPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, nonce, owner: this.owner, processId: process.pid, platform: this.platform, createdAt: new Date().toISOString() })}\n`);
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code === "EEXIST") throw new Error("Desktop bootstrap has an existing cooperative claim; owner review is required");
        throw error;
      }
      await handle.close();
      try { return await operation(); }
      finally {
        const claim = await readPrivateJson(this.claimPath);
        if (claim?.nonce !== nonce) throw new Error("Desktop bootstrap claim changed; recovery is required");
        await unlink(this.claimPath);
      }
    });
  }

  async #withNarrowGuard(path, operation) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(24).toString("hex");
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, nonce, owner: this.owner, processId: process.pid, platform: this.platform, createdAt: new Date().toISOString() })}\n`);
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === "EEXIST") throw new Error("Desktop coordination guard exists; exact owner recovery is required");
      throw error;
    }
    await handle.close();
    try { return await operation(); }
    finally {
      const guard = await readPrivateJson(path);
      if (guard?.nonce !== nonce) throw new Error("Desktop coordination guard changed; recovery is required");
      await unlink(path);
    }
  }
}

/** Authenticated client for the closed Electron-main successor protocol. */
export class DesktopSupervisorClient {
  constructor(options) {
    this.generation = normalizeGeneration(options.generation);
    this.capability = String(options.capability ?? "");
    assertCapability(this.capability);
    this.endpoint = normalizeEndpointMetadata(options.endpoint);
    this.connect = options.connect ?? createConnection;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 5_000, 100, 30_000, "timeoutMs");
    this.maxFrameBytes = boundedInteger(options.maxFrameBytes ?? MAX_CHANNEL_FRAME_BYTES, 1_024, MAX_CHANNEL_FRAME_BYTES, "maxFrameBytes");
    this.sequence = 0;
    this.socket = null;
    this.buffer = "";
    this.pending = new Map();
    this.closed = false;
    this.sessionNonce = null;
    this.helloWaiter = null;
    this.openPromise = null;
  }

  /** Connect to an exact private endpoint without exposing the capability. */
  async open() {
    if (this.socket && !this.socket.destroyed && this.sessionNonce) return this;
    if (this.openPromise) return this.openPromise;
    if (this.closed) throw new Error("Desktop supervisor client is closed");
    this.openPromise = this.#openSession();
    try { return await this.openPromise; }
    finally { this.openPromise = null; }
  }

  async #openSession() {
    const socket = this.connect({ host: this.endpoint.host, port: this.endpoint.port });
    this.socket = socket;
    this.buffer = "";
    this.sequence = 0;
    this.sessionNonce = null;
    const hello = new Promise((accept, reject) => { this.helloWaiter = { accept, reject }; });
    hello.catch(() => {});
    socket.setNoDelay?.(true);
    socket.setEncoding?.("utf8");
    socket.on?.("data", (chunk) => { if (this.socket === socket) this.#onData(String(chunk)); });
    socket.on?.("error", (error) => this.#fail(error, socket));
    socket.on?.("close", () => this.#fail(new Error("Desktop supervisor channel closed"), socket));
    try {
      await new Promise((accept, reject) => {
        if (socket.readyState === "open") return accept();
        const timer = setTimeout(() => reject(new Error("Desktop supervisor connection timed out")), this.timeoutMs);
        timer.unref?.();
        socket.once?.("connect", () => { clearTimeout(timer); accept(); });
        socket.once?.("error", (error) => { clearTimeout(timer); reject(error); });
      });
    } catch (error) {
      this.#fail(error, socket);
      throw error;
    }
    try {
      await Promise.race([
        hello,
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Desktop supervisor authenticated hello timed out")), this.timeoutMs); timer.unref?.(); }),
      ]);
    } catch (error) {
      this.#fail(error, socket);
      throw error;
    }
    return this;
  }

  /** Invoke one closed-schema operation with exact sequence and action identity. */
  async request(operation, payload = {}) {
    if (!new Set(["health", "identity", "sync-hud", "read-action", "teardown", "finalize-teardown"]).has(operation)) throw new Error("Unsupported Desktop supervisor operation");
    await this.open();
    if (this.pending.size >= 64) throw new Error("Desktop supervisor pending request limit reached");
    const actionId = `act_${randomBytes(16).toString("hex")}`;
    const sequence = ++this.sequence;
    const frameBody = {
      schemaVersion: DESKTOP_SUPERVISOR_SCHEMA_VERSION,
      generation: this.generation,
      sessionNonce: this.sessionNonce,
      sequence,
      actionId,
      operation,
      payload,
    };
    const frame = { ...frameBody, auth: channelAuthentication(this.capability, frameBody) };
    const encoded = `${JSON.stringify(frame)}\n`;
    if (Buffer.byteLength(encoded) > this.maxFrameBytes) throw new Error("Desktop supervisor request frame is too large");
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`Desktop supervisor timed out during ${operation}`));
      }, this.timeoutMs);
      this.pending.set(actionId, { accept, reject, timer, sequence });
      this.socket.write(encoded, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(actionId);
        reject(error);
      });
    });
  }

  /** Close only Threadspan's side of the successor channel. */
  async close() {
    this.closed = true;
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    this.#fail(new Error("Desktop supervisor client closed"), socket);
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > MAX_CHANNEL_RESULT_BYTES) return this.#fail(new Error("Desktop supervisor response buffer exceeded its bound"));
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(raw) > this.maxFrameBytes) return this.#fail(new Error("Desktop supervisor response frame is too large"));
      let response;
      try { response = JSON.parse(raw); } catch { return this.#fail(new Error("Desktop supervisor returned malformed JSON")); }
      if (response?.kind === "hello") {
        const helloBody = { schemaVersion: response.schemaVersion, generation: response.generation, kind: "hello", sessionNonce: response.sessionNonce };
        if (this.sessionNonce || response.schemaVersion !== DESKTOP_SUPERVISOR_SCHEMA_VERSION || response.generation !== this.generation
          || !/^[a-f0-9]{32}$/.test(response.sessionNonce ?? "")
          || !safeEqual(response.auth, channelAuthentication(this.capability, helloBody))) {
          return this.#fail(new Error("Desktop supervisor authenticated hello failed"));
        }
        this.sessionNonce = response.sessionNonce;
        this.helloWaiter?.accept(response.sessionNonce);
        this.helloWaiter = null;
        continue;
      }
      const pending = this.pending.get(response?.actionId);
      if (!pending) continue;
      this.pending.delete(response.actionId);
      clearTimeout(pending.timer);
      const responseBody = response?.ok === true
        ? { schemaVersion: response.schemaVersion, generation: response.generation, sessionNonce: response.sessionNonce, sequence: response.sequence, actionId: response.actionId, ok: true, result: response.result }
        : { schemaVersion: response?.schemaVersion, generation: response?.generation, sessionNonce: response?.sessionNonce, sequence: response?.sequence, actionId: response?.actionId, ok: false, error: response?.error };
      if (!safeEqual(response?.auth, channelAuthentication(this.capability, responseBody))) {
        pending.reject(new Error("Desktop supervisor response authentication failed"));
        this.socket?.destroy?.();
      } else if (response.schemaVersion !== DESKTOP_SUPERVISOR_SCHEMA_VERSION || response.generation !== this.generation || response.sessionNonce !== this.sessionNonce || response.sequence !== pending.sequence) {
        pending.reject(new Error("Desktop supervisor response identity mismatch"));
      } else if (response.ok !== true) {
        pending.reject(new Error(boundedString(response.error, 512) || "Desktop supervisor rejected the request"));
      } else {
        pending.accept(response.result);
      }
    }
  }

  #fail(error, socket = this.socket) {
    if (socket && this.socket !== socket) return;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy?.();
    this.buffer = "";
    this.sequence = 0;
    this.sessionNonce = null;
    this.helloWaiter?.reject(error instanceof Error ? error : new Error(String(error)));
    this.helloWaiter = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.pending.clear();
  }
}

/**
 * Build the single bounded main-process expression. The capability is embedded
 * only in the inspector frame and main-process memory; it is never copied to a
 * renderer, argv, environment, public receipt, or log.
 */
export function createSupervisorBootstrapExpression(options) {
  const generation = normalizeGeneration(options.generation);
  assertCapability(options.capability);
  const expected = normalizeExpectedIdentity(options.expectedIdentity);
  const configuration = {
    schemaVersion: DESKTOP_SUPERVISOR_SCHEMA_VERSION,
    generation,
    capability: options.capability,
    capabilityDigest: capabilityDigest(options.capability),
    expected,
    closeInspectorDelayMs: boundedInteger(options.closeInspectorDelayMs ?? 100, 25, 2_000, "closeInspectorDelayMs"),
    maxFrameBytes: boundedInteger(options.maxFrameBytes ?? MAX_CHANNEL_FRAME_BYTES, 1_024, MAX_CHANNEL_FRAME_BYTES, "maxFrameBytes"),
  };
  return `(${installElectronMainSupervisor.toString()})(${JSON.stringify(configuration)})`;
}

/** Validate the source-bound acknowledgement before considering injection done. */
export function validateSupervisorAcknowledgement(acknowledgement, options) {
  if (!isPlainObject(acknowledgement) || acknowledgement.schemaVersion !== DESKTOP_SUPERVISOR_SCHEMA_VERSION || acknowledgement.ready !== true) {
    throw new Error("Desktop supervisor did not return a ready acknowledgement");
  }
  const generation = normalizeGeneration(options.generation);
  if (acknowledgement.generation !== generation) throw new Error("Desktop supervisor acknowledgement generation mismatch");
  const expected = normalizeExpectedIdentity(options.expectedIdentity);
  if (!isPlainObject(acknowledgement.source)
    || acknowledgement.source.processId !== expected.processId
    || acknowledgement.source.executablePath !== expected.executablePath
    || acknowledgement.source.executableSha256 !== expected.executableSha256
    || acknowledgement.source.startIdentity !== expected.startIdentity
    || (expected.electronVersion && acknowledgement.source.electronVersion !== expected.electronVersion)) {
    throw new Error("Desktop supervisor acknowledgement source identity mismatch");
  }
  if (acknowledgement.capabilityDigest !== capabilityDigest(options.capability)) throw new Error("Desktop supervisor acknowledgement capability mismatch");
  const endpoint = normalizeEndpointMetadata(acknowledgement.endpoint);
  const receiptBody = {
    schemaVersion: acknowledgement.schemaVersion,
    generation: acknowledgement.generation,
    ready: acknowledgement.ready,
    source: acknowledgement.source,
    endpoint,
    capabilityDigest: acknowledgement.capabilityDigest,
    reused: acknowledgement.reused === true,
  };
  if (!safeEqual(acknowledgement.receiptDigest, sha256(stableStringify(receiptBody)))) throw new Error("Desktop supervisor acknowledgement receipt is not source-bound");
  return Object.freeze({ ...receiptBody, receiptDigest: acknowledgement.receiptDigest });
}

/**
 * Fetch and validate the exact target list. Non-JSON, non-200, redirects, and
 * any target multiplicity fail closed as possible port squatting.
 */
export async function discoverInspectorTarget(port, options = {}) {
  port = normalizeBootstrapPort(port);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 2_000) });
  if (!response || response.status !== 200 || !response.ok) throw new Error("Desktop bootstrap inspector discovery was unavailable or unexpected");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType && !/application\/json/i.test(contentType)) throw new Error("Desktop bootstrap discovery returned an unexpected content type");
  let targets;
  if (typeof response.text === "function") {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_CHANNEL_FRAME_BYTES) throw new Error("Desktop bootstrap discovery response is too large");
    try { targets = JSON.parse(body); } catch { throw new Error("Desktop bootstrap discovery returned malformed JSON"); }
  } else {
    targets = await response.json();
  }
  return validateInspectorTargetList(targets, { port, expectedTargetId: options.expectedTargetId });
}

/**
 * Prove both discovery and the already-open WebSocket are closed. A later
 * successful discovery is treated as inspector reappearance, never reconnect.
 */
export async function proveInspectorClosed(options) {
  const port = normalizeBootstrapPort(options.port);
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((ms) => new Promise((accept) => setTimeout(accept, ms)));
  const attempts = boundedInteger(options.attempts ?? 8, 1, 40, "attempts");
  const intervalMs = boundedInteger(options.intervalMs ?? 100, 1, 5_000, "intervalMs");
  const portProbe = options.portProbe ?? probeLoopbackPort;
  if (options.socketClosed) {
    const socketClosed = await Promise.race([
      Promise.resolve(options.socketClosed),
      new Promise((accept) => { const timer = setTimeout(() => accept(false), options.socketCloseTimeoutMs ?? 3_000); timer.unref?.(); }),
    ]);
    if (!socketClosed) throw new Error("Desktop inspector WebSocket did not close after supervisor readiness");
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const occupied = await portProbe(port, { timeoutMs: Math.min(1_000, intervalMs * 4) });
    if (occupied !== false) throw new Error("Desktop bootstrap inspector remained, reappeared, or its port was reoccupied after cutover");
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(Math.min(1_000, intervalMs * 4)) });
      if (response) throw new Error("Desktop bootstrap inspector remained, reappeared, or its port was reoccupied after cutover");
    } catch (error) {
      if (/remained, reappeared, or its port was reoccupied/.test(error?.message ?? "")) throw error;
      if (!isExplicitConnectionRefusal(error)) throw new Error("Desktop bootstrap inspector closure was ambiguous; owner recovery is required");
      if (attempt >= 1) return { closed: true, attempts: attempt + 1 };
    }
    await wait(intervalMs);
  }
  throw new Error("Desktop bootstrap inspector closure could not be proven");
}

/** Fail closed if the one-time inspector appears again after attachment. */
export async function assertInspectorStillClosed(port, options = {}) {
  port = normalizeBootstrapPort(port);
  const occupied = await (options.portProbe ?? probeLoopbackPort)(port, { timeoutMs: options.timeoutMs ?? 1_000 });
  if (occupied !== false) throw new Error("Desktop bootstrap inspector reappeared or its port was reoccupied; owner recovery is required");
  try {
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${port}/json/list`, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 1_000) });
    if (response) throw new Error("Desktop bootstrap inspector reappeared or its port was reoccupied; owner recovery is required");
  } catch (error) {
    if (/reappeared or its port was reoccupied/.test(error?.message ?? "")) throw error;
    if (!isExplicitConnectionRefusal(error)) throw new Error("Desktop bootstrap inspector closure was ambiguous; owner recovery is required");
    return { closed: true };
  }
  return { closed: true };
}

/** Probe exact loopback and distinguish refusal from timeout/reset ambiguity. */
export function probeLoopbackPort(port, options = {}) {
  port = normalizeBootstrapPort(port);
  return new Promise((accept, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const done = (error, occupied) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (!error) accept(occupied);
      else if (isExplicitConnectionRefusal(error)) accept(false);
      else reject(new Error("Desktop bootstrap port state is ambiguous"));
    };
    const timer = setTimeout(() => done(new Error("port probe timed out")), options.timeoutMs ?? 1_000);
    timer.unref?.();
    socket.once("connect", () => done(null, true));
    socket.once("error", (error) => done(error));
  });
}

/*
 * This function is stringified and evaluated once in Electron's main process.
 * Keep every dependency lexical to the function body.
 */
async function installElectronMainSupervisor(configuration) {
  "use strict";
  const crypto = process.getBuiltinModule("crypto");
  const fs = process.getBuiltinModule("fs");
  const net = process.getBuiltinModule("net");
  const inspector = process.getBuiltinModule("inspector");
  const moduleApi = process.getBuiltinModule("module");
  const load = moduleApi.createRequire(process.execPath);
  const closeBootstrapInspector = () => { try { inspector.close(); } catch {} };
  const failBootstrap = (message) => { closeBootstrapInspector(); throw new Error(message); };
  let electron;
  try { electron = load("electron"); }
  catch (error) { closeBootstrapInspector(); throw error; }
  const singletonKey = Symbol.for("threadspan.desktop.supervisor.v1");
  const maxResultBytes = 128 * 1024;
  const maxRoutes = 120;
  const sockets = new Set();
  const seenActionIds = new Set();
  const seenRendererActions = new Set();
  const webContentsListeners = new Map();
  const mountedWebContents = new Map();
  let lastHud = null;
  let lastHudDigest = "";
  let currentWebContentsId = null;
  let teardownStarted = false;
  let teardownComplete = false;

  const digest = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
  const stable = (value) => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const safeEqual = (left, right) => {
    const a = Buffer.from(String(left ?? ""));
    const b = Buffer.from(String(right ?? ""));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const authenticate = (value) => crypto.createHmac("sha256", configuration.capability).update(stable(value)).digest("hex");
  const boundedString = (value, max) => typeof value === "string" && value.length <= max ? value : "";
  const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

  if (!plainObject(configuration) || configuration.schemaVersion !== 1 || !/^electron_[a-f0-9]{32}$/.test(configuration.generation)
    || typeof configuration.capability !== "string" || configuration.capability.length < 32 || configuration.capability.length > 256
    || !plainObject(configuration.expected) || !Number.isSafeInteger(configuration.expected.processId)
    || typeof configuration.expected.executablePath !== "string") failBootstrap("Invalid Threadspan supervisor bootstrap configuration");
  if (process[singletonKey]) failBootstrap("Threadspan supervisor already exists; inspector reinjection is forbidden");
  const observedStartIdentity = `${process.pid}:${Math.round((Date.now() - process.uptime() * 1000) / 1000)}`;
  const observedExecutableSha256 = crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex");
  if (process.pid !== configuration.expected.processId || process.execPath !== configuration.expected.executablePath
    || observedStartIdentity !== configuration.expected.startIdentity
    || observedExecutableSha256 !== configuration.expected.executableSha256) {
    failBootstrap("Threadspan supervisor main-process source identity mismatch");
  }
  if (configuration.expected.electronVersion && process.versions.electron !== configuration.expected.electronVersion) {
    failBootstrap("Threadspan supervisor Electron version mismatch");
  }
  if (!safeEqual(configuration.capabilityDigest, digest(`threadspan-desktop-supervisor\0${configuration.capability}`))) {
    failBootstrap("Threadspan supervisor capability binding mismatch");
  }

  function selectWindow() {
    const candidates = electron.BrowserWindow.getAllWindows()
      .filter((window) => {
        try { return !window.isDestroyed() && window.isVisible() && !window.webContents.isDestroyed(); } catch { return false; }
      })
      .map((window) => {
        const bounds = window.getBounds();
        return { window, area: Math.max(0, Number(bounds.width)) * Math.max(0, Number(bounds.height)), id: Number(window.id) || 0 };
      })
      .filter((candidate) => candidate.area > 0)
      .sort((left, right) => right.area - left.area || left.id - right.id);
    return candidates[0]?.window ?? null;
  }

  function sanitizeHud(input) {
    if (!plainObject(input)) throw new Error("HUD payload must be an object");
    const routes = Array.isArray(input.routes) ? input.routes.slice(0, maxRoutes).map((route) => {
      if (!plainObject(route)) throw new Error("HUD route is malformed");
      const id = boundedString(route.id, 240);
      if (!id || !/^[A-Za-z0-9._:/@+-]+$/.test(id)) throw new Error("HUD route ID is invalid");
      return {
        id,
        mode: boundedString(route.mode, 32) || "consult",
        provider: boundedString(route.provider, 80) || "provider",
        model: boundedString(route.model, 160) || "auto",
        available: route.available === true,
        free: route.free === true,
      };
    }) : [];
    const selected = boundedString(input.selected, 240);
    if (selected && !routes.some((route) => route.id === selected)) throw new Error("HUD selection is not in the supplied route catalog");
    return {
      routes,
      selected,
      providerCount: Number.isSafeInteger(input.providerCount) && input.providerCount >= 0 && input.providerCount <= 10_000 ? input.providerCount : 0,
      status: boundedString(input.status, 80) || "connecting",
    };
  }

  function mountRendererHud(data, generation) {
    const previous = document.getElementById("threadspan-desktop-root");
    const wasOpen = previous?.dataset.open === "true";
    const mode = previous?.dataset.mode || "all";
    previous?.remove();
    const host = document.createElement("section");
    host.id = "threadspan-desktop-root";
    host.dataset.open = String(wasOpen);
    host.dataset.mode = mode;
    host.dataset.threadspanGeneration = generation;
    host.setAttribute("aria-label", "Threadspan");
    host.style.cssText = "position:fixed;z-index:2147483646;top:92px;left:50%;transform:translateX(-50%);width:min(430px,calc(100vw - 28px));font:12px/1.35 ui-sans-serif,system-ui;color:#eafdf8;pointer-events:auto";
    const root = host.attachShadow({ mode: "open" });
    const escape = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
    const render = () => {
      const routes = data.routes.filter((route) => host.dataset.mode === "all" || route.mode === host.dataset.mode);
      const selected = data.routes.find((route) => route.id === data.selected);
      root.innerHTML = `<style>*{box-sizing:border-box}button{font:inherit;color:inherit}.shell{border:1px solid rgba(65,220,186,.38);border-radius:14px;background:linear-gradient(145deg,rgba(7,24,23,.97),rgba(14,30,33,.96));box-shadow:0 16px 42px rgba(0,0,0,.38);overflow:hidden}.bar{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:9px 11px}.mark{width:9px;height:25px;border-radius:5px;background:linear-gradient(#55e6bc,#25a7b7)}.name{font-weight:780;letter-spacing:.08em}.meta{opacity:.72}.button,.tab,.route{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.055);border-radius:9px;cursor:pointer}.button{padding:6px 9px}.panel{display:${host.dataset.open === "true" ? "block" : "none"};border-top:1px solid rgba(255,255,255,.09);padding:10px}.tabs{display:flex;gap:6px;margin-bottom:8px}.tab{padding:4px 8px}.routes{display:grid;gap:5px;max-height:300px;overflow:auto}.route{display:grid;grid-template-columns:74px 1fr auto;gap:8px;text-align:left;padding:7px 8px}.route:disabled{opacity:.38}.mode{text-transform:uppercase;font-size:10px}.empty{padding:18px;text-align:center}</style><div class="shell"><div class="bar"><span class="mark"></span><div><div class="name">THREADSPAN</div><div class="meta">${escape(data.status)} · ${data.providerCount} providers · ${selected ? escape(`${selected.provider} / ${selected.model}`) : "auto"}</div></div><button class="button" data-toggle>${host.dataset.open === "true" ? "Close" : "Routes"}</button></div><div class="panel"><div class="tabs">${["all","consult","integrated","delegate"].map((item) => `<button class="tab" data-mode="${item}">${item}</button>`).join("")}</div><div class="routes">${routes.length ? routes.map((route) => `<button class="route" data-route="${escape(route.id)}" ${route.available ? "" : "disabled"}><span class="mode">${escape(route.mode)}</span><span>${escape(route.provider)} · ${escape(route.model)}</span><span>${route.free ? "FREE" : route.available ? "READY" : "OFF"}</span></button>`).join("") : '<div class="empty">No routes match this view.</div>'}</div></div></div>`;
      root.querySelector("[data-toggle]").onclick = () => { host.dataset.open = String(host.dataset.open !== "true"); render(); };
      root.querySelectorAll("[data-mode]").forEach((button) => { button.onclick = () => { host.dataset.mode = button.dataset.mode; render(); }; });
      root.querySelectorAll("[data-route]").forEach((button) => { button.onclick = () => {
        data.selected = button.dataset.route;
        const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        host.dataset.threadspanAction = JSON.stringify({ schemaVersion: 1, generation, actionId: `renderer_${random}`, type: "select-route", routeId: button.dataset.route });
        render();
      }; });
    };
    render();
    document.body.append(host);
    return { mounted: true, generation, routeCount: data.routes.length };
  }

  async function attachHud() {
    if (!lastHud || teardownStarted) return { attached: false, reason: "no-hud" };
    const window = selectWindow();
    if (!window) return { attached: false, reason: "no-visible-window" };
    const contents = window.webContents;
    if (contents.isDestroyed()) return { attached: false, reason: "destroyed-web-contents" };
    for (const [id, previousContents] of mountedWebContents) {
      if (id === contents.id) continue;
      if (previousContents.isDestroyed?.()) {
        mountedWebContents.delete(id);
        continue;
      }
      await removeHudFromContents(previousContents);
      mountedWebContents.delete(id);
    }
    const expression = `(${mountRendererHud.toString()})(${JSON.stringify(lastHud)},${JSON.stringify(configuration.generation)})`;
    const result = await contents.executeJavaScript(expression, true);
    if (result?.mounted === true) mountedWebContents.set(contents.id, contents);
    currentWebContentsId = contents.id;
    return { attached: result?.mounted === true, webContentsId: contents.id, hudDigest: lastHudDigest };
  }

  function scheduleAttach() {
    setTimeout(() => { attachHud().catch(() => {}); }, 0).unref?.();
  }

  async function removeHudFromContents(contents) {
    if (!contents || contents.isDestroyed?.()) return false;
    return await contents.executeJavaScript(`(()=>{const host=document.getElementById("threadspan-desktop-root");if(host?.dataset.threadspanGeneration===${JSON.stringify(configuration.generation)})host.remove();return true})()`, true);
  }

  function bindWebContents(contents) {
    if (!contents || contents.isDestroyed?.() || webContentsListeners.has(contents.id)) return;
    const handlers = {
      "dom-ready": scheduleAttach,
      "did-finish-load": scheduleAttach,
      "did-navigate": scheduleAttach,
      "render-process-gone": scheduleAttach,
      destroyed: () => { webContentsListeners.delete(contents.id); mountedWebContents.delete(contents.id); scheduleAttach(); },
    };
    for (const [event, handler] of Object.entries(handlers)) contents.on(event, handler);
    webContentsListeners.set(contents.id, { contents, handlers });
  }

  function onWindowCreated(_event, window) {
    bindWebContents(window?.webContents);
    scheduleAttach();
  }

  async function readRendererAction() {
    const window = selectWindow();
    if (!window || window.webContents.isDestroyed()) return null;
    if (currentWebContentsId !== null && window.webContents.id !== currentWebContentsId) await attachHud();
    const raw = await window.webContents.executeJavaScript(`(()=>{const host=document.getElementById("threadspan-desktop-root");if(!host||host.dataset.threadspanGeneration!==${JSON.stringify(configuration.generation)})return null;const raw=host.dataset.threadspanAction||"";delete host.dataset.threadspanAction;return raw})()`, true);
    if (!raw) return null;
    if (typeof raw !== "string" || raw.length > 2_048) throw new Error("Renderer action is overlong");
    let action;
    try { action = JSON.parse(raw); } catch { throw new Error("Renderer action is malformed"); }
    if (!plainObject(action) || action.schemaVersion !== 1 || action.generation !== configuration.generation
      || !/^renderer_[A-Za-z0-9._:-]{8,160}$/.test(action.actionId ?? "") || action.type !== "select-route"
      || typeof action.routeId !== "string" || action.routeId.length > 240 || !lastHud?.routes.some((route) => route.id === action.routeId)) {
      throw new Error("Renderer action failed its closed schema");
    }
    if (seenRendererActions.has(action.actionId)) throw new Error("Renderer action was duplicated or replayed");
    seenRendererActions.add(action.actionId);
    if (seenRendererActions.size > 512) seenRendererActions.delete(seenRendererActions.values().next().value);
    return { actionId: action.actionId, type: action.type, routeId: action.routeId };
  }

  async function teardown() {
    if (teardownComplete) return { removed: true, duplicate: true };
    teardownStarted = true;
    electron.app.removeListener("browser-window-created", onWindowCreated);
    for (const { contents, handlers } of webContentsListeners.values()) {
      for (const [event, handler] of Object.entries(handlers)) contents.removeListener?.(event, handler);
    }
    webContentsListeners.clear();
    const failures = [];
    for (const [id, contents] of mountedWebContents) {
      if (contents.isDestroyed?.()) {
        mountedWebContents.delete(id);
        continue;
      }
      try {
        await removeHudFromContents(contents);
        mountedWebContents.delete(id);
      } catch {
        failures.push(id);
      }
    }
    if (failures.length) throw new Error(`Desktop supervisor teardown could not remove ${failures.length} tracked renderer HUD${failures.length === 1 ? "" : "s"}`);
    currentWebContentsId = null;
    teardownComplete = true;
    return { removed: true, duplicate: false };
  }

  async function finalizeTeardown() {
    if (!teardownComplete) throw new Error("Desktop supervisor teardown is not complete");
    delete process[singletonKey];
    setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    }, 10).unref?.();
    return { finalized: true };
  }

  async function dispatch(operation, payload) {
    if (operation === "health") return { ready: !teardownStarted, generation: configuration.generation, hudAttached: currentWebContentsId !== null };
    if (teardownStarted && !["teardown", "finalize-teardown"].includes(operation)) throw new Error("Desktop supervisor teardown is pending exact reconciliation");
    if (operation === "identity") return { generation: configuration.generation, processId: process.pid, executablePath: process.execPath, electronVersion: process.versions.electron ?? "", capabilityDigest: configuration.capabilityDigest };
    if (operation === "sync-hud") {
      lastHud = sanitizeHud(payload?.hud);
      lastHudDigest = digest(lastHud);
      return await attachHud();
    }
    if (operation === "read-action") return { action: await readRendererAction() };
    if (operation === "teardown") return await teardown();
    if (operation === "finalize-teardown") return await finalizeTeardown();
    throw new Error("Unsupported Desktop supervisor operation");
  }

  async function writeResponse(socket, frame) {
    const encoded = `${JSON.stringify({ ...frame, auth: authenticate(frame) })}\n`;
    if (Buffer.byteLength(encoded) > maxResultBytes) throw new Error("Desktop supervisor result exceeded its bound");
    if (socket.write(encoded)) return;
    await new Promise((accept, reject) => {
      let settled = false;
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener("drain", onDrain);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
        error ? reject(error) : accept();
      };
      const onDrain = () => done();
      const onError = (error) => done(error);
      const onClose = () => done(new Error("Desktop supervisor output channel closed"));
      const timer = setTimeout(() => done(new Error("Desktop supervisor output backpressure timed out")), 5_000);
      timer.unref?.();
      socket.once("drain", onDrain);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
  }

  function handleConnection(socket) {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    let buffer = "";
    let lastSequence = 0;
    let chain = Promise.resolve();
    let queuedFrames = 0;
    let connectionClosed = false;
    let authenticated = false;
    const sessionNonce = crypto.randomBytes(16).toString("hex");
    const authenticationTimer = setTimeout(() => {
      if (!authenticated) {
        connectionClosed = true;
        socket.destroy();
      }
    }, 5_000);
    authenticationTimer.unref?.();
    writeResponse(socket, { schemaVersion: 1, generation: configuration.generation, kind: "hello", sessionNonce }).catch(() => socket.destroy());
    socket.on("data", (chunk) => {
      if (connectionClosed) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > configuration.maxFrameBytes) {
        connectionClosed = true;
        return socket.destroy();
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        queuedFrames += 1;
        if (queuedFrames > 32) {
          connectionClosed = true;
          socket.destroy();
          break;
        }
        socket.pause?.();
        chain = chain.then(async () => {
          if (connectionClosed) return;
          let request;
          try { request = JSON.parse(raw); } catch { connectionClosed = true; socket.destroy(); return; }
          const actionId = boundedString(request?.actionId, 160);
          const base = { schemaVersion: 1, generation: configuration.generation, sessionNonce, sequence: request?.sequence, actionId };
          try {
            const authenticatedBody = { schemaVersion: request?.schemaVersion, generation: request?.generation, sessionNonce: request?.sessionNonce, sequence: request?.sequence, actionId: request?.actionId, operation: request?.operation, payload: request?.payload };
            if (!plainObject(request) || request.schemaVersion !== 1 || request.generation !== configuration.generation
              || request.sessionNonce !== sessionNonce || !safeEqual(request.auth, authenticate(authenticatedBody)) || !Number.isSafeInteger(request.sequence)
              || request.sequence !== lastSequence + 1 || !/^act_[a-f0-9]{32}$/.test(actionId)
              || seenActionIds.has(actionId) || !plainObject(request.payload)) throw new Error("Desktop supervisor authentication, sequence, or schema rejected");
            lastSequence = request.sequence;
            authenticated = true;
            clearTimeout(authenticationTimer);
            seenActionIds.add(actionId);
            if (seenActionIds.size > 1_024) seenActionIds.delete(seenActionIds.values().next().value);
            await writeResponse(socket, { ...base, ok: true, result: await dispatch(request.operation, request.payload) });
          } catch (error) {
            await writeResponse(socket, { ...base, ok: false, error: boundedString(error?.message, 512) || "Desktop supervisor request rejected" });
          }
        }).catch(() => { connectionClosed = true; socket.destroy(); }).finally(() => {
          queuedFrames -= 1;
          if (!connectionClosed && queuedFrames === 0) socket.resume?.();
        });
      }
    });
    socket.on("close", () => { connectionClosed = true; clearTimeout(authenticationTimer); sockets.delete(socket); });
    socket.on("error", () => { connectionClosed = true; clearTimeout(authenticationTimer); sockets.delete(socket); });
  }

  const server = net.createServer(handleConnection);
  server.maxConnections = 8;
  let endpoint;
  try {
    endpoint = await new Promise((accept, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.removeListener("error", reject);
        const address = server.address();
        if (!address || typeof address === "string" || address.address !== "127.0.0.1") return reject(new Error("Desktop supervisor did not bind exact loopback"));
        accept({
          transport: "tcp-loopback",
          host: "127.0.0.1",
          port: address.port,
          aclEvidence: process.platform === "win32" ? "token-authenticated-native-acl-unverified" : "token-authenticated-loopback-no-native-acl",
        });
      });
    });
  } catch (error) {
    try { server.close(); } catch {}
    closeBootstrapInspector();
    throw error;
  }

  const onServerLifecycleError = () => {
    Promise.resolve(teardown()).catch(() => {}).finally(() => {
      delete process[singletonKey];
      for (const socket of sockets) socket.destroy();
      try { server.close(); } catch {}
    });
  };
  server.on("error", onServerLifecycleError);

  try {
    for (const window of electron.BrowserWindow.getAllWindows()) bindWebContents(window.webContents);
    electron.app.on("browser-window-created", onWindowCreated);
    const source = { processId: process.pid, executablePath: process.execPath, executableSha256: observedExecutableSha256, startIdentity: observedStartIdentity, electronVersion: process.versions.electron ?? "" };
    const receiptBody = { schemaVersion: 1, generation: configuration.generation, ready: true, source, endpoint, capabilityDigest: configuration.capabilityDigest, reused: false };
    const acknowledgement = { ...receiptBody, receiptDigest: digest(receiptBody) };
    process[singletonKey] = { generation: configuration.generation, endpoint, capabilityDigest: configuration.capabilityDigest, teardown };
    setTimeout(() => closeBootstrapInspector(), configuration.closeInspectorDelayMs).unref?.();
    return acknowledgement;
  } catch (error) {
    electron.app.removeListener?.("browser-window-created", onWindowCreated);
    for (const { contents, handlers } of webContentsListeners.values()) {
      for (const [event, handler] of Object.entries(handlers)) contents.removeListener?.(event, handler);
    }
    webContentsListeners.clear();
    delete process[singletonKey];
    try { server.close(); } catch {}
    closeBootstrapInspector();
    throw error;
  }
}

function normalizeExpectedIdentity(value) {
  if (!isPlainObject(value)) throw new TypeError("Electron source identity is required");
  const processId = positiveInteger(value.processId, "processId");
  const executablePath = resolve(boundedRequiredString(value.executablePath, 4_096, "executablePath"));
  const executableSha256 = value.executableSha256 === undefined || value.executableSha256 === null
    ? null : normalizeDigest(value.executableSha256, "executableSha256");
  const startIdentity = boundedRequiredString(value.startIdentity, 256, "startIdentity");
  const electronVersion = value.electronVersion === undefined || value.electronVersion === null || value.electronVersion === ""
    ? null : boundedRequiredString(value.electronVersion, 80, "electronVersion");
  return Object.freeze({ processId, executablePath, executableSha256, startIdentity, electronVersion });
}

function normalizeBootstrapState(value) {
  if (!isPlainObject(value) || value.schemaVersion !== DESKTOP_SUPERVISOR_SCHEMA_VERSION) throw new Error("Unsupported Desktop bootstrap state schema");
  const generation = normalizeGeneration(value.generation);
  const phase = normalizePhase(value.phase);
  const source = normalizeExpectedIdentity(value.source);
  const state = {
    schemaVersion: DESKTOP_SUPERVISOR_SCHEMA_VERSION,
    revision: positiveInteger(value.revision, "revision"),
    generation,
    phase,
    source,
    bootstrap: normalizeBootstrapEndpoint(value.bootstrap),
    sourceDigest: normalizeDigest(value.sourceDigest, "sourceDigest"),
    capabilityDigest: normalizeDigest(value.capabilityDigest, "capabilityDigest"),
    packageDigest: normalizeDigest(value.packageDigest, "packageDigest"),
    endpoint: value.endpoint === null ? null : normalizeEndpointMetadata(value.endpoint),
    receiptDigest: value.receiptDigest === null ? null : normalizeDigest(value.receiptDigest, "receiptDigest"),
    createdAt: normalizeTimestamp(value.createdAt, "createdAt"),
    updatedAt: normalizeTimestamp(value.updatedAt, "updatedAt"),
    recovery: value.recovery === null ? null : normalizeRecovery(value.recovery, phase === "rolled-back"),
  };
  if (state.sourceDigest !== sha256(stableStringify(source))) throw new Error("Desktop bootstrap source digest is invalid");
  if (TERMINAL_RECOVERY_PHASES.has(phase) && !state.recovery) throw new Error("Desktop bootstrap recovery phase lacks recovery truth");
  return Object.freeze(state);
}

function normalizeEndpointMetadata(value) {
  if (!isPlainObject(value) || value.transport !== "tcp-loopback" || value.host !== "127.0.0.1") throw new Error("Desktop supervisor endpoint must be exact TCP loopback");
  const port = boundedInteger(value.port, 1, 65_535, "endpoint.port");
  const aclEvidence = boundedRequiredString(value.aclEvidence, 120, "endpoint.aclEvidence");
  if (!new Set(["token-authenticated-native-acl-unverified", "token-authenticated-loopback-no-native-acl"]).has(aclEvidence)) {
    throw new Error("Desktop supervisor endpoint ACL evidence is unsupported");
  }
  return Object.freeze({ transport: "tcp-loopback", host: "127.0.0.1", port, aclEvidence });
}

function normalizeBootstrapEndpoint(value) {
  if (!isPlainObject(value) || value.host !== "127.0.0.1") throw new Error("Desktop bootstrap endpoint must be exact loopback");
  return Object.freeze({ host: "127.0.0.1", port: normalizeBootstrapPort(value.port) });
}

function normalizeRecovery(value, rollback = false) {
  if (!isPlainObject(value)) throw new Error("Desktop bootstrap recovery details are required");
  const reason = boundedRequiredString(value.reason, 512, "recovery.reason");
  const ownerAction = boundedRequiredString(value.ownerAction, 512, "recovery.ownerAction");
  const inspectorRestored = value.inspectorRestored === true;
  if (inspectorRestored) throw new Error("Desktop rollback must not restore a persistent inspector");
  return Object.freeze({
    reason,
    ownerAction,
    inspectorRestored: false,
    ...(rollback ? { supervisorRemoved: value.supervisorRemoved === true } : {}),
  });
}

function validatePackageSnapshot(value) {
  if (!isPlainObject(value) || value.schemaVersion !== DESKTOP_SUPERVISOR_SCHEMA_VERSION || !Array.isArray(value.entries)
    || value.entries.length === 0 || value.entries.length > 16 || !SHA256_PATTERN.test(value.digest ?? "")) throw new Error("Desktop package evidence is invalid");
  for (const entry of value.entries) {
    if (!isPlainObject(entry) || typeof entry.path !== "string" || !["present", "absent"].includes(entry.state)) throw new Error("Desktop package evidence entry is invalid");
    if (entry.state === "present" && (typeof entry.canonical !== "string" || !SHA256_PATTERN.test(entry.sha256 ?? "") || !Number.isSafeInteger(entry.size))) {
      throw new Error("Desktop package digest evidence is invalid");
    }
  }
  if (sha256(stableStringify(value.entries)) !== value.digest) throw new Error("Desktop package evidence digest mismatch");
  return value;
}

async function atomicPrivateJson(path, value) {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(parent);
  const destination = resolve(canonicalParent, basename(path));
  if (destination !== resolve(path)) throw new Error("Desktop bootstrap state parent changed");
  const temporary = resolve(canonicalParent, `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  await chmod(destination, 0o600);
  if (process.platform !== "win32") {
    const directory = await open(canonicalParent, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

async function readPrivateJson(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Desktop bootstrap private state is not a regular file");
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) throw new Error("Desktop bootstrap private state is not owner-only");
  const bytes = await readFile(path);
  if (bytes.byteLength > 256 * 1024) throw new Error("Desktop bootstrap private state is overlong");
  const after = await lstat(path);
  if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error("Desktop bootstrap private state changed while reading");
  }
  return JSON.parse(bytes.toString("utf8"));
}

function normalizeGeneration(value) {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) throw new TypeError("Invalid Electron generation");
  return value;
}

function normalizePhase(value) {
  if (typeof value !== "string" || !BOOTSTRAP_PHASE_SET.has(value)) throw new TypeError("Invalid Desktop bootstrap phase");
  return value;
}

function normalizeDigest(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

function assertCapability(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Invalid Desktop supervisor capability");
}

function normalizeTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`Invalid ${name}`);
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  return number;
}

function positiveInteger(value, name) { return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name); }

function boundedRequiredString(value, maximum, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) throw new TypeError(`Invalid ${name}`);
  return value;
}

function boundedString(value, maximum) { return typeof value === "string" && value.length <= maximum ? value : ""; }

function isPlainObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }

function isLoopbackHost(value) { return value === "127.0.0.1" || value === "localhost" || value === "[::1]" || value === "::1"; }

function isExplicitConnectionRefusal(error, depth = 0) {
  if (!error || depth > 4) return false;
  if (error.code === "ECONNREFUSED" || /\bECONNREFUSED\b/.test(error.message ?? "")) return true;
  if (isExplicitConnectionRefusal(error.cause, depth + 1)) return true;
  return Array.isArray(error.errors) && error.errors.some((item) => isExplicitConnectionRefusal(item, depth + 1));
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function channelAuthentication(capability, value) { return createHmac("sha256", capability).update(stableStringify(value)).digest("hex"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
