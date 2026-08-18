import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  DesktopBootstrapStore,
  DesktopSupervisorClient,
  assertDesktopPackagesUnchanged,
  assertInspectorStillClosed,
  capabilityDigest,
  createElectronGeneration,
  createSupervisorBootstrapExpression,
  createSupervisorCapability,
  discoverInspectorTarget,
  normalizeBootstrapPort,
  probeLoopbackPort,
  proveInspectorClosed,
  snapshotDesktopPackages,
  validateSupervisorAcknowledgement,
} from "./supervisor.mjs";

export const DEFAULT_DESKTOP_BOOTSTRAP_PORT = 9224;
export const DEFAULT_DESKTOP_INSPECT_PORT = DEFAULT_DESKTOP_BOOTSTRAP_PORT;
const ROLLBACK_PENDING_REASON = "Authenticated supervisor rollback was journaled but is not yet proven complete";

/** Build the explicit owner-approved launch plan for one-time bootstrap. */
export function createDesktopLaunchPlan({ platform = process.platform, executable, bootstrapPort, inspectPort } = {}) {
  const path = executable || discoverDesktopExecutable(platform);
  if (!path) throw new Error(`Could not locate ChatGPT Desktop for ${platform}; pass --app PATH`);
  const port = normalizeBootstrapPort(bootstrapPort ?? inspectPort ?? DEFAULT_DESKTOP_BOOTSTRAP_PORT);
  return {
    command: path,
    args: [`--inspect=127.0.0.1:${port}`],
    options: { detached: true, stdio: "ignore", windowsHide: false },
    bootstrap: { host: "127.0.0.1", port, oneTime: true },
  };
}

/** Project daemon state into the closed, credential-free renderer schema. */
export function sanitizeDesktopHudState(state = {}) {
  const routes = (Array.isArray(state.pickerRoutes) ? state.pickerRoutes : [])
    .filter((route) => route && typeof route.id === "string")
    .slice(0, 120)
    .map((route) => ({
      id: route.id.slice(0, 240),
      mode: String(route.mode ?? route.id.split("/")[0] ?? "consult").slice(0, 32),
      provider: String(route.provider ?? route.id.split("/")[1] ?? "provider").slice(0, 80),
      model: String(route.model ?? route.id.split("/").at(-1) ?? "auto").slice(0, 160),
      available: route.availability !== "unavailable",
      free: route.free === true,
    }));
  const selected = String(state.desktopRouteSelection?.routeId ?? state.route?.id ?? "").slice(0, 240);
  return {
    routes,
    selected: routes.some((route) => route.id === selected) ? selected : "",
    providerCount: Math.min(10_000, Math.max(0, Array.isArray(state.providers) ? state.providers.length : state.routeMap?.nodes?.length ?? 0)),
    status: String(state.status ?? "connecting").slice(0, 80),
  };
}

export class DesktopHost {
  constructor(config, options = {}) {
    this.config = config;
    const configuredBootstrapPort = options.bootstrapPort ?? options.inspectPort;
    this.bootstrapPortExplicit = configuredBootstrapPort !== undefined && configuredBootstrapPort !== null;
    this.bootstrapPort = normalizeBootstrapPort(configuredBootstrapPort ?? DEFAULT_DESKTOP_BOOTSTRAP_PORT);
    this.appPath = options.appPath;
    this.baseUrl = `http://${formatHost(config.server.host)}:${config.server.port}`;
    this.token = options.token;
    this.pollIntervalMs = Math.max(1_000, Number(options.pollIntervalMs ?? 3_000));
    this.selectionPath = resolve(options.selectionPath ?? join(dirname(config.configPath), "state", "desktop-route.json"));
    this.statePath = resolve(options.statePath ?? join(dirname(config.configPath), "state", "desktop-bootstrap.json"));
    this.packagePaths = options.packagePaths ?? null;
    this.launchProcess = options.launchProcess ?? spawn;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.portProbe = options.portProbe ?? probeLoopbackPort;
    this.store = options.store ?? new DesktopBootstrapStore({ statePath: this.statePath, platform: options.platform });
    this.clientFactory = options.clientFactory ?? ((input) => new DesktopSupervisorClient(input));
    this.processPresenceProbe = options.processPresenceProbe ?? electronProcessPresent;
    this.client = null;
    this.lastStateDigest = "";
    this.lastError = "";
    this.tickCount = 0;
    this.lastFullState = null;
    this.selectedRouteId = null;
    this.packageEvidence = null;
  }

  /**
   * Attach to an existing exact supervisor or bootstrap only after an explicit
   * canonical launch. Attach mode never launches, restarts, kills, signals,
   * focuses, or navigates Desktop.
   */
  async run({ launch = false, signal } = {}) {
    const release = this.store.acquireHostClaim ? await this.store.acquireHostClaim({ mode: launch ? "launch" : "attach" }) : async () => {};
    try { return await this.#runClaimed({ launch, signal }); }
    finally { await release(); }
  }

  async #runClaimed({ launch, signal }) {
    this.token ??= await resolveDesktopToken(this.config);
    if (!this.token) throw new Error("Desktop HUD requires the owner token through the configured environment or owner-only token file");
    this.selectedRouteId = await readSelectedRoute(this.selectionPath);
    let transaction = await this.store.read();
    if (transaction?.phase === "rolled-back" && launch) {
      await this.#finalizeRolledBack(transaction);
      if (await this.processPresenceProbe(transaction.source)) throw new Error("Prior rolled-back Desktop process may still be present; close it before a new canonical launch");
      transaction = await this.#launchAndBootstrap();
    } else if (transaction) {
      try { transaction = await this.#reconnect(transaction); }
      catch (error) {
        const latest = await this.store.read();
        const callerMismatch = /does not match the exact persisted generation/.test(boundedError(error));
        if (!callerMismatch && latest?.generation === transaction.generation && latest.phase !== "recovery-required" && latest.phase !== "indeterminate" && latest.phase !== "rolled-back") {
          transaction = await this.store.transition({
            generation: latest.generation,
            expectedRevision: latest.revision,
            phase: "recovery-required",
            recovery: { reason: boundedError(error), ownerAction: "Use the detachable sidecar and perform reviewed Desktop bootstrap recovery; do not relaunch automatically", inspectorRestored: false },
          });
        }
        throw error;
      }
    } else if (launch) {
      transaction = await this.#launchAndBootstrap();
    } else {
      throw new Error("Desktop has no usable authenticated HUD supervisor; attach mode preserves the daemon and sidecar without disturbing Desktop. Use `threadspan desktop launch` in an owner-approved quiet window");
    }
    if (transaction.phase !== "attached" || !this.client) throw new Error(`Desktop bootstrap is ${transaction.phase}; owner recovery is required`);

    try {
      while (!signal?.aborted) {
        try {
          await this.#tick();
          if (++this.tickCount % 10 === 0) await assertInspectorStillClosed(this.bootstrapPort, { fetchImpl: this.fetchImpl, portProbe: this.portProbe });
          this.lastError = "";
        } catch (error) {
          const message = boundedError(error);
          if (message !== this.lastError) process.stderr.write(`Threadspan Desktop: ${message}\n`);
          this.lastError = message;
          if (/inspector reappeared|identity mismatch|authentication|generation/i.test(message)) throw error;
        }
        await abortableDelay(this.pollIntervalMs, signal);
      }
    } finally {
      await this.client?.close().catch(() => {});
      this.client = null;
    }
  }

  /** Authenticated rollback removes only the injected supervisor and private capability. */
  async rollback(reason = "Owner-requested Threadspan Desktop supervisor rollback") {
    const release = this.store.acquireHostClaim ? await this.store.acquireHostClaim({ mode: "rollback" }) : async () => {};
    try { return await this.#rollbackClaimed(reason); }
    finally { await release(); }
  }

  async #rollbackClaimed(reason) {
    let transaction = await this.store.read();
    if (!transaction) throw new Error("Desktop supervisor rollback requires an exact generation");
    if (transaction.phase === "rolled-back") return this.#finalizeRolledBack(transaction);
    const resuming = transaction.phase === "recovery-required" && transaction.recovery?.reason === ROLLBACK_PENDING_REASON;
    if (transaction.phase !== "attached" && !resuming) throw new Error("Desktop supervisor rollback requires an attached or exact rollback-recovery generation");
    if (!this.client) {
      if (resuming) await this.#connectRollbackRecovery(transaction);
      else await this.#reconnect(transaction);
    }
    this.bootstrapPort = transaction.bootstrap.port;
    await assertInspectorStillClosed(this.bootstrapPort, { fetchImpl: this.fetchImpl, portProbe: this.portProbe });
    const canonicalExecutable = await realpath(transaction.source.executablePath);
    const before = await snapshotDesktopPackages(resolvePackagePaths(canonicalExecutable, this.packagePaths));
    if (before.digest !== transaction.packageDigest) throw new Error("Desktop package evidence changed before rollback; recovery is required");
    if (!resuming) {
      transaction = await this.store.transition({
        generation: transaction.generation,
        expectedRevision: transaction.revision,
        phase: "recovery-required",
        recovery: { reason: ROLLBACK_PENDING_REASON, ownerAction: "Reconcile the exact private generation; never restore or reopen the inspector", inspectorRestored: false },
      });
    }
    const result = await this.client.request("teardown", {});
    if (result?.removed !== true) throw new Error("Desktop supervisor teardown was not acknowledged");
    const after = await snapshotDesktopPackages(resolvePackagePaths(canonicalExecutable, this.packagePaths));
    assertDesktopPackagesUnchanged(before, after);
    await proveInspectorClosed({ port: this.bootstrapPort, fetchImpl: this.fetchImpl, portProbe: this.portProbe });
    const rolledBack = await this.store.transition({
      generation: transaction.generation,
      expectedRevision: transaction.revision,
      phase: "rolled-back",
      recovery: { reason, ownerAction: "Use the daemon and detachable sidecar; a later bootstrap requires another explicit canonical launch", inspectorRestored: false, supervisorRemoved: true },
    });
    const finalized = await this.client.request("finalize-teardown", {});
    if (finalized?.finalized !== true) throw new Error("Desktop supervisor teardown finalization was not acknowledged");
    await this.client.close().catch(() => {});
    this.client = null;
    await this.store.removeCapability(transaction.generation);
    return { generation: rolledBack.generation, phase: rolledBack.phase, supervisorRemoved: true, inspectorRestored: false, packageDigest: after.digest };
  }

  /** Reconcile an exact dead generation without signaling or relaunching Desktop. */
  async recoverDeadGeneration(reason = "Owner-reviewed dead Electron generation recovery") {
    const release = this.store.acquireHostClaim ? await this.store.acquireHostClaim({ mode: "recover" }) : async () => {};
    try {
      let transaction = await this.store.read();
      if (!transaction) throw new Error("Desktop bootstrap has no generation to recover");
      if (transaction.phase === "rolled-back") return { ...(await this.#finalizeRolledBack(transaction)), recovered: true };
      if (await this.processPresenceProbe(transaction.source)) throw new Error("Exact Desktop process may still be present; dead-generation recovery was refused");
      this.bootstrapPort = transaction.bootstrap.port;
      await proveInspectorClosed({ port: this.bootstrapPort, fetchImpl: this.fetchImpl, portProbe: this.portProbe });
      const canonicalExecutable = await realpath(transaction.source.executablePath).catch(() => transaction.source.executablePath);
      const packages = await snapshotDesktopPackages(resolvePackagePaths(canonicalExecutable, this.packagePaths));
      const packageChanged = packages.digest !== transaction.packageDigest;
      if (transaction.phase === "injected") {
        transaction = await this.store.transition({ generation: transaction.generation, expectedRevision: transaction.revision, phase: "indeterminate", recovery: { reason: "Electron exited while supervisor injection was uncertain", ownerAction: "Complete reviewed dead-generation reconciliation", inspectorRestored: false } });
      }
      if (transaction.phase !== "recovery-required") {
        transaction = await this.store.transition({ generation: transaction.generation, expectedRevision: transaction.revision, phase: "recovery-required", recovery: { reason, ownerAction: "The next app generation may start only through explicit canonical desktop launch", inspectorRestored: false } });
      }
      transaction = await this.store.transition({ generation: transaction.generation, expectedRevision: transaction.revision, phase: "rolled-back", recovery: { reason, ownerAction: "Use explicit desktop launch for a new generation", inspectorRestored: false, supervisorRemoved: true } });
      await this.store.removeCapability(transaction.generation);
      return { phase: transaction.phase, recovered: true, inspectorRestored: false, packageChanged };
    } finally {
      await release();
    }
  }

  async inspectHostClaim() { return this.store.inspectHostClaim ? this.store.inspectHostClaim() : { present: false }; }

  async recoverHostClaim(digest, options = {}) {
    if (!this.store.recoverHostClaim) throw new Error("Desktop host claim recovery is unavailable");
    return this.store.recoverHostClaim(digest, options);
  }

  async #connectRollbackRecovery(transaction) {
    const capability = await this.store.loadCapability(transaction.generation);
    if (!capability || capabilityDigest(capability) !== transaction.capabilityDigest || !transaction.endpoint) throw new Error("Desktop rollback recovery capability is incomplete");
    this.client = this.clientFactory({ generation: transaction.generation, capability, endpoint: transaction.endpoint });
    await this.client.open();
    const health = await this.client.request("health", {});
    if (health?.generation !== transaction.generation) throw new Error("Desktop rollback recovery generation mismatch");
  }

  async #finalizeRolledBack(transaction) {
    const capability = await this.store.loadCapability(transaction.generation).catch(() => null);
    if (!capability) return { phase: "rolled-back", supervisorRemoved: true, inspectorRestored: false };
    if (!transaction.endpoint) {
      await this.store.removeCapability(transaction.generation);
      return { phase: "rolled-back", supervisorRemoved: true, inspectorRestored: false };
    }
    this.client = this.clientFactory({ generation: transaction.generation, capability, endpoint: transaction.endpoint });
    try {
      await this.client.open();
      const teardown = await this.client.request("teardown", {});
      if (teardown?.removed !== true) throw new Error("Desktop rollback tombstone did not confirm renderer cleanup");
      const finalized = await this.client.request("finalize-teardown", {});
      if (finalized?.finalized !== true) throw new Error("Desktop rollback tombstone did not finalize");
    } catch (error) {
      if (await this.portProbe(transaction.endpoint.port) !== false) throw error;
    } finally {
      await this.client?.close().catch(() => {});
      this.client = null;
    }
    await this.store.removeCapability(transaction.generation);
    return { phase: "rolled-back", supervisorRemoved: true, inspectorRestored: false };
  }

  async #launchAndBootstrap() {
    if (await this.portProbe(this.bootstrapPort)) throw new Error("Desktop bootstrap port is already occupied; refusing possible port squatting or an unreviewed running inspector");
    const plan = createDesktopLaunchPlan({ executable: this.appPath, bootstrapPort: this.bootstrapPort });
    const expectedExecutable = await realpath(resolve(plan.command));
    const child = this.launchProcess(plan.command, plan.args, plan.options);
    child.once?.("error", (error) => { process.stderr.write(`Threadspan Desktop launch failed: ${error.message}\n`); });
    child.unref?.();
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error("Desktop canonical launch did not return a process identity");
    const target = await waitForInspector(this.bootstrapPort, { fetchImpl: this.fetchImpl });
    const inspector = await BootstrapInspectorClient.connect(target, { webSocketFactory: this.webSocketFactory });
    let transaction;
    let generation = null;
    try {
      const observed = await inspector.readIdentity();
      const canonicalObserved = await realpath(resolve(observed.executablePath));
      if (observed.processId !== child.pid || canonicalObserved !== expectedExecutable) throw new Error("Desktop inspector source does not match the canonical launched process");
      const executableSha256 = sha256(await readFile(canonicalObserved));
      const source = { ...observed, executableSha256 };
      generation = createElectronGeneration(source);
      const capability = createSupervisorCapability();
      const packageEvidence = await snapshotDesktopPackages(resolvePackagePaths(canonicalObserved, this.packagePaths));
      transaction = await this.store.prepare({ generation, source, bootstrap: { host: "127.0.0.1", port: this.bootstrapPort }, capabilityDigest: capabilityDigest(capability), packageEvidence });
      await this.store.saveCapability(generation, capability);
      transaction = await this.store.transition({ generation, expectedRevision: transaction.revision, phase: "injected" });
      let rawAcknowledgement;
      try {
        rawAcknowledgement = await inspector.bootstrap(createSupervisorBootstrapExpression({ generation, capability, expectedIdentity: source }));
      } catch (error) {
        await this.#markIndeterminate(transaction, error);
        throw error;
      }
      const acknowledgement = validateSupervisorAcknowledgement(rawAcknowledgement, { generation, capability, expectedIdentity: source });
      transaction = await this.store.transition({ generation, expectedRevision: transaction.revision, phase: "acknowledged", endpoint: acknowledgement.endpoint, receiptDigest: acknowledgement.receiptDigest });
      await proveInspectorClosed({ port: this.bootstrapPort, fetchImpl: this.fetchImpl, portProbe: this.portProbe, socketClosed: inspector.closed });
      transaction = await this.store.transition({ generation, expectedRevision: transaction.revision, phase: "inspector-closed" });
      this.client = this.clientFactory({ generation, capability, endpoint: transaction.endpoint });
      await this.client.open();
      await this.#validateSuccessorIdentity(transaction, capability);
      await this.#syncHud();
      const after = await snapshotDesktopPackages(resolvePackagePaths(canonicalObserved, this.packagePaths));
      assertDesktopPackagesUnchanged(packageEvidence, after);
      transaction = await this.store.transition({ generation, expectedRevision: transaction.revision, phase: "attached" });
      this.packageEvidence = after;
      return transaction;
    } catch (error) {
      let closureReason = "";
      if (generation) {
        const latest = await this.store.read().catch(() => null);
        if (latest?.generation === generation && latest.phase === "prepared") await inspector.closeBootstrapInspector().catch(() => {});
        try {
          await proveInspectorClosed({ port: this.bootstrapPort, fetchImpl: this.fetchImpl, portProbe: this.portProbe, socketClosed: inspector.closed });
        } catch (closureError) {
          closureReason = `; inspector closure unproven: ${boundedError(closureError)}`;
        }
        if (latest?.generation === generation && !["indeterminate", "recovery-required", "rolled-back", "attached"].includes(latest.phase)) {
          const phase = latest.phase === "injected" ? "indeterminate" : "recovery-required";
          await this.store.transition({
            generation,
            expectedRevision: latest.revision,
            phase,
            recovery: { reason: `${boundedError(error)}${closureReason}`.slice(0, 512), ownerAction: "Use the daemon and detachable sidecar; reconcile the exact generation without reinjection or app restart", inspectorRestored: false },
          }).catch(() => {});
        } else if (latest?.generation === generation && latest.phase === "indeterminate" && closureReason) {
          await this.store.transition({
            generation,
            expectedRevision: latest.revision,
            phase: "recovery-required",
            recovery: { reason: `${boundedError(error)}${closureReason}`.slice(0, 512), ownerAction: "Close the explicitly launched app and reconcile the exact generation; do not reinject", inspectorRestored: false },
          }).catch(() => {});
        }
      }
      throw error;
    } finally {
      await inspector.close().catch(() => {});
    }
  }

  async #reconnect(transaction) {
    if (transaction.phase === "rolled-back") throw new Error("Desktop supervisor was rolled back; an explicit canonical launch is required");
    if (["prepared", "injected", "indeterminate", "recovery-required"].includes(transaction.phase)) {
      throw new Error(`Desktop bootstrap is ${transaction.phase}; blind reinjection or replay is forbidden`);
    }
    if (this.bootstrapPortExplicit && this.bootstrapPort !== transaction.bootstrap.port) throw new Error("Desktop bootstrap port does not match the exact persisted generation");
    this.bootstrapPort = transaction.bootstrap.port;
    const capability = await this.store.loadCapability(transaction.generation);
    if (!capability || capabilityDigest(capability) !== transaction.capabilityDigest || !transaction.endpoint) throw new Error("Desktop supervisor recovery state is incomplete");
    const canonicalExecutable = await realpath(transaction.source.executablePath);
    const packageEvidence = await snapshotDesktopPackages(resolvePackagePaths(canonicalExecutable, this.packagePaths));
    if (packageEvidence.digest !== transaction.packageDigest) throw new Error("Desktop package identity changed; the current generation cannot reconnect");
    this.client = this.clientFactory({ generation: transaction.generation, capability, endpoint: transaction.endpoint });
    await this.client.open();
    await this.#validateSuccessorIdentity(transaction, capability);
    if (transaction.phase === "acknowledged") {
      await proveInspectorClosed({ port: this.bootstrapPort, fetchImpl: this.fetchImpl, portProbe: this.portProbe });
      transaction = await this.store.transition({ generation: transaction.generation, expectedRevision: transaction.revision, phase: "inspector-closed" });
    } else {
      await assertInspectorStillClosed(this.bootstrapPort, { fetchImpl: this.fetchImpl, portProbe: this.portProbe });
    }
    if (transaction.phase === "inspector-closed") {
      await this.#syncHud();
      transaction = await this.store.transition({ generation: transaction.generation, expectedRevision: transaction.revision, phase: "attached" });
    }
    this.packageEvidence = packageEvidence;
    return transaction;
  }

  async #validateSuccessorIdentity(transaction, capability) {
    const identity = await this.client.request("identity", {});
    if (identity?.generation !== transaction.generation || identity?.processId !== transaction.source.processId
      || identity?.executablePath !== transaction.source.executablePath || identity?.capabilityDigest !== capabilityDigest(capability)) {
      throw new Error("Desktop supervisor successor identity mismatch");
    }
    const health = await this.client.request("health", {});
    if (health?.ready !== true || health.generation !== transaction.generation) throw new Error("Desktop supervisor is not ready");
  }

  async #tick() {
    const actionResult = await this.client.request("read-action", {});
    if (actionResult?.action) {
      await this.#handleAction(actionResult.action);
      return;
    }
    await this.#syncHud();
  }

  async #syncHud() {
    let state = await this.#request("/v1/desktop/state", { timeoutMs: 5_000 });
    if (this.tickCount === 0 || this.tickCount % 10 === 0) {
      try { this.lastFullState = await this.#request("/threadspan/state", { timeoutMs: 5_000 }); } catch {}
    }
    if (this.lastFullState) state = this.lastFullState;
    if (this.selectedRouteId && state.desktopRouteSelection?.routeId !== this.selectedRouteId) {
      await this.#request("/v1/desktop/route", { method: "POST", body: { routeId: this.selectedRouteId } });
      state = await this.#request("/v1/desktop/state", { timeoutMs: 5_000 });
    }
    const hud = sanitizeDesktopHudState(state);
    const digest = sha256(JSON.stringify(hud));
    if (digest !== this.lastStateDigest) {
      const result = await this.client.request("sync-hud", { hud });
      if (result?.attached !== true && result?.reason !== "no-visible-window") throw new Error("Desktop supervisor could not attach the HUD");
      this.lastStateDigest = digest;
    }
  }

  async #handleAction(action) {
    if (action?.type !== "select-route" || typeof action.routeId !== "string" || !action.actionId) throw new Error("Desktop supervisor returned a malformed renderer action");
    await this.#request("/v1/desktop/route", { method: "POST", body: { routeId: action.routeId } });
    this.selectedRouteId = action.routeId;
    await writeSelectedRoute(this.selectionPath, action.routeId);
    this.lastStateDigest = "";
  }

  async #markIndeterminate(transaction, error) {
    await this.store.transition({
      generation: transaction.generation,
      expectedRevision: transaction.revision,
      phase: "indeterminate",
      recovery: { reason: boundedError(error), ownerAction: "Use the daemon and detachable sidecar; inspect the exact private generation before any recovery", inspectorRestored: false },
    });
  }

  async #request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { authorization: `Bearer ${this.token}`, ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? `Threadspan HTTP ${response.status}`);
    return body;
  }
}

class BootstrapInspectorClient {
  static async connect(target, options = {}) {
    const socket = (options.webSocketFactory ?? ((url) => new WebSocket(url)))(target.webSocketDebuggerUrl);
    try {
      await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error("Desktop bootstrap inspector connection timed out")), 3_000);
        socket.onopen = () => { clearTimeout(timeout); accept(); };
        socket.onerror = (error) => { clearTimeout(timeout); reject(error instanceof Error ? error : new Error("Desktop bootstrap inspector connection failed")); };
      });
    } catch (error) {
      socket.onopen = null;
      socket.onerror = null;
      try { socket.close(); } catch {}
      throw error;
    }
    return new BootstrapInspectorClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = new Promise((accept) => { this.acceptClosed = accept; });
    socket.onmessage = (event) => {
      let message;
      const raw = String(event.data ?? "");
      if (Buffer.byteLength(raw) > 256 * 1024) {
        socket.close();
        for (const accept of this.pending.values()) accept({ result: { exceptionDetails: { text: "Desktop bootstrap inspector response exceeded its bound" } } });
        this.pending.clear();
        return;
      }
      try { message = JSON.parse(raw); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending(message);
    };
    socket.onclose = () => {
      this.acceptClosed(true);
      for (const accept of this.pending.values()) accept({ result: { exceptionDetails: { text: "Desktop bootstrap inspector disconnected" } } });
      this.pending.clear();
    };
  }

  async readIdentity() {
    const expression = `(()=>{const started=Math.round((Date.now()-process.uptime()*1000)/1000);return {processId:process.pid,executablePath:process.execPath,electronVersion:process.versions.electron??null,startIdentity:String(process.pid)+":"+String(started)}})()`;
    return this.#evaluate(expression, "identity");
  }

  async bootstrap(expression) { return this.#evaluate(expression, "bootstrap"); }

  async closeBootstrapInspector() {
    return this.#evaluate(`(()=>{const timer=setTimeout(()=>process.getBuiltinModule("inspector").close(),25);timer.unref?.();return true})()`, "inspector-close");
  }

  async #evaluate(expression, label) {
    const message = await this.#call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text ?? `Desktop ${label} evaluation failed`);
    return message.result?.result?.value;
  }

  #call(method, params) {
    return new Promise((accept, reject) => {
      const id = ++this.nextId;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Desktop bootstrap inspector timed out during ${method}`)); }, 10_000);
      this.pending.set(id, (message) => { clearTimeout(timeout); accept(message); });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() { if (this.socket.readyState < 2) this.socket.close(); }
}

async function resolveDesktopToken(config) {
  if (config.server.authTokenFile && existsSync(resolve(config.server.authTokenFile))) return (await readFile(resolve(config.server.authTokenFile), "utf8")).trim();
  const envName = config.server.authTokenEnv;
  if (envName && process.env[envName]) return process.env[envName];
  const envFile = join(dirname(config.configPath), "secrets", "main.env");
  if (existsSync(envFile)) {
    const fallbackName = envName ?? "THREADSPAN_TOKEN";
    const line = (await readFile(envFile, "utf8")).split(/\r?\n/).find((item) => item.startsWith(`${fallbackName}=`));
    if (line) return line.slice(fallbackName.length + 1).replace(/^(["'])(.*)\1$/, "$2");
  }
  const path = resolve(join(dirname(config.configPath), "secrets", "main.token"));
  return existsSync(path) ? (await readFile(path, "utf8")).trim() : null;
}

async function readSelectedRoute(path) {
  try { const value = JSON.parse(await readFile(path, "utf8")); return typeof value?.routeId === "string" && value.routeId ? value.routeId : null; }
  catch { return null; }
}

async function writeSelectedRoute(path, routeId) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, routeId }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function discoverDesktopExecutable(platform) {
  if (process.env.THREADSPAN_CHATGPT_PATH) return process.env.THREADSPAN_CHATGPT_PATH;
  if (platform === "linux") return "/usr/bin/chatgpt";
  if (platform === "win32") {
    try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation + '\\app\\ChatGPT.exe'"], { encoding: "utf8", windowsHide: true }).trim(); }
    catch { return null; }
  }
  if (platform === "darwin") return "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  return null;
}

async function waitForInspector(port, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let lastError;
  while (Date.now() < deadline) {
    try { return await discoverInspectorTarget(port, { fetchImpl: options.fetchImpl }); }
    catch (error) {
      lastError = error;
      if (String(error?.message ?? "").startsWith("Desktop bootstrap")) {
        throw new Error(`Desktop bootstrap target was refused: ${boundedError(error)}. Close the explicitly launched app to remove the untrusted inspector before recovery`);
      }
    }
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error(`ChatGPT Desktop did not expose one valid Threadspan bootstrap target: ${boundedError(lastError)}`);
}

function resolvePackagePaths(executablePath, explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit.map((path) => resolve(path));
  const resources = join(dirname(executablePath), "resources");
  return [resolve(executablePath), join(resources, "app.asar"), join(resources, "app", "package.json")];
}

async function electronProcessPresent(source) {
  if (process.platform === "linux") {
    try { await realpath(`/proc/${source.processId}/exe`); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }
  try { process.kill(source.processId, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; if (error?.code === "EPERM") return true; throw error; }
}

function abortableDelay(ms, signal) {
  return new Promise((accept) => {
    if (signal?.aborted) return accept();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); accept(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function boundedError(error) { return String(error instanceof Error ? error.message : error ?? "unknown error").slice(0, 512); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function formatHost(host) { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }
