import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { resolveExecutablePath } from "../core/executable.mjs";
import { runCapturedProcess } from "../core/managed-process.mjs";

const SCHEMA_VERSION = 1;
const OBSERVATION_FILE = "observations.json";
const ACCEPTED_OBSERVATION_FILE = "accepted-observations.json";
const TRANSITION_INDEX_FILE = "transition-index.json";
const TRANSITION_DIRECTORY = "transitions";
const CLAIM_DIRECTORY = "claims";
const ROLLBACK_DIRECTORY = "rollbacks";
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PRODUCT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SECRET_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:^|[^A-Za-z0-9])[_A-Za-z0-9.-]*(?:api[_-]?key|private[_-]?key|access[_-]?key|token|secret|password|authorization|cookie)\s*["']?\s*[:=]/im;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const PROBE_NAMES = Object.freeze(["attach", "protocol", "routing", "provider", "settings"]);
const PROBE_STATUSES = new Set(["pass", "fail", "not-run", "unsupported", "unknown"]);
const PROBE_SOURCES = new Set(["manual", "passive"]);
const EVIDENCE_CLASSES = new Set(["synthetic", "native-manual", "native-passive"]);
const TRANSITION_BINDING = Symbol("desktop-transition-binding");

export const DEFAULT_DESKTOP_UPDATE_LIMITS = Object.freeze({
  maxProducts: 8,
  maxCandidatesPerProduct: 16,
  processTimeoutMs: 5_000,
  maxProcessOutputBytes: 64 * 1024,
  maxArtifactBytes: 512 * 1024 * 1024,
  maxMetadataBytes: 128 * 1024,
  maxStateBytes: 1024 * 1024,
  maxRepairOperations: 16,
  maxRepairBytes: 4 * 1024 * 1024,
  maxRollbackFiles: 16,
  maxRollbackBytes: 4 * 1024 * 1024,
  minPollIntervalMs: 60_000,
  maxPollIntervalMs: 24 * 60 * 60 * 1000,
});

export const NATIVE_DESKTOP_MIGRATION_CANDIDATES = Object.freeze({
  surfaces: Object.freeze(["settings", "usage"]),
  status: "migration-candidates-only",
  capabilityDetectionRequired: true,
  threadspanHudPolicy: "retain-during-measured-coexistence",
  automaticSunset: false,
  undocumentedInternalsAllowed: false,
  sunsetRequirements: Object.freeze(["stable-native-settings", "stable-native-usage", "linux-parity", "windows-parity", "verified-rollback"]),
  weakerOrUnstableNativePolicy: "retain-threadspan-hud-indefinitely",
});

/**
 * Evaluate future native Settings/Usage contribution points without enabling or modifying them.
 * A passing result permits only a measured sunset review; it never removes Threadspan HUD controls.
 * @param {{settings?:string, usage?:string, linuxParity?:boolean, windowsParity?:boolean, rollbackVerified?:boolean}} [capabilities]
 */
export function assessNativeDesktopMigration(capabilities = {}) {
  const blockers = [];
  if (capabilities.settings !== "stable") blockers.push("stable-native-settings");
  if (capabilities.usage !== "stable") blockers.push("stable-native-usage");
  if (capabilities.linuxParity !== true) blockers.push("linux-parity");
  if (capabilities.windowsParity !== true) blockers.push("windows-parity");
  if (capabilities.rollbackVerified !== true) blockers.push("verified-rollback");
  return {
    status: blockers.length === 0 ? "eligible-for-measured-sunset-review" : "retain-threadspan-hud",
    migrationCandidates: [...NATIVE_DESKTOP_MIGRATION_CANDIDATES.surfaces],
    blockers,
    threadspanHudPolicy: blockers.length === 0
      ? "retain-during-measured-coexistence"
      : "retain-indefinitely",
    automaticSunset: false,
    undocumentedInternalsAllowed: false,
  };
}

/**
 * Return the product-local state directory used by the compatibility watch.
 * No application or authentication directory is inspected to derive this path.
 * @param {{platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv}} [options]
 */
export function defaultDesktopUpdateStateRoot(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  if (platform === "win32") {
    const base = environment.LOCALAPPDATA
      ?? (environment.USERPROFILE ? join(environment.USERPROFILE, "AppData", "Local") : undefined)
      ?? join(homedir(), "AppData", "Local");
    return join(base, "Threadspan", "compatibility-watch");
  }
  if (platform === "linux") {
    const base = environment.XDG_STATE_HOME
      ?? join(environment.HOME ?? homedir(), ".local", "state");
    return join(base, "threadspan", "compatibility-watch");
  }
  throw new Error(`Desktop Compatibility Watch supports Linux and Windows, not '${platform}'`);
}

/**
 * Build bounded, exact-path probes for Codex CLI/Desktop and ChatGPT Desktop.
 * Desktop executables are never launched: their exact artifacts are only fingerprinted.
 * @param {{platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv}} [options]
 */
export function createDefaultDesktopProducts(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  if (!new Set(["linux", "win32"]).has(platform)) {
    throw new Error(`Desktop Compatibility Watch supports Linux and Windows, not '${platform}'`);
  }

  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const localAppData = environment.LOCALAPPDATA
    ?? (environment.USERPROFILE ? join(environment.USERPROFILE, "AppData", "Local") : undefined);
  const programFiles = environment.ProgramFiles ?? environment.PROGRAMFILES;
  const roots = (...values) => [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];

  const codexDesktopCandidates = platform === "win32"
    ? roots(
      localAppData && join(localAppData, "Programs", "Codex", "Codex.exe"),
      localAppData && join(localAppData, "Codex", "Codex.exe"),
      programFiles && join(programFiles, "Codex", "Codex.exe"),
    )
    : roots(
      join(home, ".local", "share", "applications", "codex.desktop"),
      "/usr/share/applications/codex.desktop",
      "/opt/Codex/codex",
      "/opt/codex/codex",
    );
  const chatgptDesktopCandidates = platform === "win32"
    ? roots(
      localAppData && join(localAppData, "Programs", "ChatGPT", "ChatGPT.exe"),
      localAppData && join(localAppData, "ChatGPT", "ChatGPT.exe"),
      programFiles && join(programFiles, "ChatGPT", "ChatGPT.exe"),
    )
    : roots(
      join(home, ".local", "share", "applications", "chatgpt.desktop"),
      "/usr/share/applications/chatgpt.desktop",
      "/opt/ChatGPT/chatgpt",
      "/opt/chatgpt/chatgpt",
    );

  const desktopVersionFiles = (product) => platform === "win32"
    ? roots(
      localAppData && join(localAppData, "Programs", product, "resources", "app", "package.json"),
      localAppData && join(localAppData, product, "resources", "app", "package.json"),
      programFiles && join(programFiles, product, "resources", "app", "package.json"),
    )
    : roots(
      `/opt/${product}/resources/app/package.json`,
      `/opt/${product.toLowerCase()}/resources/app/package.json`,
    );

  return [
    {
      id: "codex-cli",
      label: "Codex CLI",
      kind: "command",
      commands: ["codex"],
      versionArgs: ["--version"],
    },
    {
      id: "codex-desktop",
      label: "Codex Desktop",
      kind: "artifact",
      candidates: codexDesktopCandidates,
      versionFiles: desktopVersionFiles("Codex"),
    },
    {
      id: "chatgpt-desktop",
      label: "ChatGPT Desktop",
      kind: "artifact",
      candidates: chatgptDesktopCandidates,
      versionFiles: desktopVersionFiles("ChatGPT"),
    },
  ];
}

/** Compute the deterministic SHA-256 identity of a repair plan. */
export function computeRepairPlanDigest(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new TypeError("Repair plan must be an object");
  const { digest: _digest, ...payload } = plan;
  return sha256Text(stableStringify(payload));
}

/**
 * Optional, local-only compatibility observer and explicitly gated repair planner.
 * The default instance performs no IO because it is disabled.
 */
export class DesktopCompatibilityWatch {
  /**
   * @param {{
   *   enabled?: boolean,
   *   readOnly?: boolean,
   *   applyEnabled?: boolean,
   *   pollingEnabled?: boolean,
   *   pollIntervalMs?: number,
   *   platform?: NodeJS.Platform,
   *   environment?: NodeJS.ProcessEnv,
   *   stateRoot?: string,
   *   products?: Array<Record<string, any>>,
   *   limits?: Partial<typeof DEFAULT_DESKTOP_UPDATE_LIMITS>,
   *   now?: () => number,
   *   resolveExecutable?: typeof resolveExecutablePath,
   *   runProcess?: typeof runCapturedProcess,
   *   setIntervalFn?: typeof setInterval,
   *   clearIntervalFn?: typeof clearInterval,
   * }} [options]
   */
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.readOnly = options.readOnly !== false;
    this.applyEnabled = options.applyEnabled === true;
    this.pollingEnabled = options.pollingEnabled === true;
    this.platform = options.platform ?? process.platform;
    this.environment = options.environment ?? process.env;
    this.stateRoot = resolve(options.stateRoot ?? defaultDesktopUpdateStateRoot({
      platform: this.platform,
      environment: this.environment,
    }));
    this.limits = validateLimits({ ...DEFAULT_DESKTOP_UPDATE_LIMITS, ...(options.limits ?? {}) });
    this.products = normalizeProducts(
      options.products ?? createDefaultDesktopProducts({ platform: this.platform, environment: this.environment }),
      this.limits,
    );
    this.now = options.now ?? Date.now;
    this.resolveExecutable = options.resolveExecutable ?? resolveExecutablePath;
    this.runProcess = options.runProcess ?? runCapturedProcess;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.pollIntervalMs = normalizeInteger(
      options.pollIntervalMs ?? 15 * 60_000,
      this.limits.minPollIntervalMs,
      this.limits.maxPollIntervalMs,
      "pollIntervalMs",
    );
    this.pollHandle = undefined;
    this.doctorPromise = undefined;
  }

  /** Inspect installed product evidence once and persist a secret-free local observation. */
  async doctor(options = {}) {
    if (!this.enabled) return disabledReport(this.platform, options.reason ?? "manual");
    if (this.doctorPromise) return this.doctorPromise;
    this.doctorPromise = this.#doctorOnce(options).finally(() => { this.doctorPromise = undefined; });
    return this.doctorPromise;
  }

  /** Explicit one-shot path intended to run after a Desktop or CLI update. */
  doctorAfterUpdate(options = {}) {
    return this.doctor({ ...options, reason: "after-update" });
  }

  /**
   * Start optional single-flight polling. Polling only calls doctor; it never prepares or applies repairs.
   * @param {(report: Record<string, any>) => void|Promise<void>} [onReport]
   * @param {{runImmediately?: boolean, onError?: (error:Record<string, any>) => void|Promise<void>}} [options]
   */
  startPolling(onReport, options = {}) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    if (!this.pollingEnabled) throw new Error("Desktop Compatibility Watch polling is disabled");
    if (this.pollHandle) throw new Error("Desktop Compatibility Watch polling is already running");
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return { skipped: true, reason: "previous-poll-still-running" };
      inFlight = true;
      try {
        const report = await this.doctor({ reason: "poll" });
        await onReport?.(report);
        return report;
      } finally {
        inFlight = false;
      }
    };
    const reportError = async (error) => {
      try {
        await options.onError?.({
          status: "error",
          reason: "poll",
          error: boundedMessage(error, 500),
        });
      } catch {}
    };
    const timer = this.setIntervalFn(() => { void tick().catch(reportError); }, this.pollIntervalMs);
    timer?.unref?.();
    this.pollHandle = { timer, tick };
    if (options.runImmediately === true) void tick().catch(reportError);
    return {
      intervalMs: this.pollIntervalMs,
      runNow: tick,
      stop: () => this.stopPolling(),
    };
  }

  /** Stop this instance's polling timer. */
  stopPolling() {
    if (!this.pollHandle) return false;
    this.clearIntervalFn(this.pollHandle.timer);
    this.pollHandle = undefined;
    return true;
  }

  async #doctorOnce(options) {
    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: true });
    const statePath = boundedPath(stateRoot, OBSERVATION_FILE);
    const previous = await readOptionalJson(statePath, this.limits.maxStateBytes);
    const acceptedPath = boundedPath(stateRoot, ACCEPTED_OBSERVATION_FILE);
    const accepted = await readOptionalJson(acceptedPath, this.limits.maxStateBytes);
    if (previous && (previous.schemaVersion !== SCHEMA_VERSION || previous.platform !== this.platform)) {
      throw new Error("Observed compatibility state does not match this watcher platform/schema");
    }
    if (accepted && (accepted.schemaVersion !== SCHEMA_VERSION || accepted.platform !== this.platform)) {
      throw new Error("Accepted compatibility state does not match this watcher platform/schema");
    }
    const products = [];
    for (const product of this.products) products.push(await this.#inspectProduct(product));
    const observedAt = new Date(this.now()).toISOString();
    const changes = compareObservations(previous?.products, products);
    let acceptedState = accepted;
    let baselineCreated = false;
    const transitions = [];
    if (!acceptedState) {
      const baselineOwner = sha256Text(stableStringify({ platform: this.platform, observedAt, products: products.map(persistedObservation) }));
      const baseline = await withStateFileClaim(stateRoot, "accepted-observations", baselineOwner, this.limits, async () => {
        const existing = await readOptionalJson(acceptedPath, this.limits.maxStateBytes);
        if (existing) return { state: existing, created: false };
        const state = {
          schemaVersion: SCHEMA_VERSION,
          acceptedAt: observedAt,
          platform: this.platform,
          products: products.map(persistedObservation),
        };
        await atomicJsonWrite(acceptedPath, state, 0o600);
        return { state, created: true };
      });
      acceptedState = baseline.state;
      baselineCreated = baseline.created;
      if (acceptedState.schemaVersion !== SCHEMA_VERSION || acceptedState.platform !== this.platform) {
        throw new Error("Accepted compatibility state does not match this watcher platform/schema");
      }
    }
    if (!baselineCreated) {
      const acceptedProducts = Array.isArray(acceptedState?.products) ? acceptedState.products : [];
      for (const current of products) {
        const prior = acceptedProducts.find((item) => item?.id === current.id);
        if (!isExactDetectedObservation(prior) || !isExactDetectedObservation(current)) continue;
        if (sameExactObservation(prior, current)) continue;
        transitions.push(transitionIndexEntry(await persistObservedTransition(stateRoot, {
          platform: this.platform,
          product: current.id,
          N: exactObservationIdentity(prior),
          "N+1": exactObservationIdentity(current),
        }, current.label, observedAt, this.limits)));
      }
    }
    const state = {
      schemaVersion: SCHEMA_VERSION,
      observedAt,
      platform: this.platform,
      products: products.map(persistedObservation),
    };
    await atomicJsonWrite(statePath, state, 0o600);
    return {
      status: products.some((item) => item.status === "error") ? "attention" : "ok",
      mode: "read-only",
      reason: options.reason ?? "manual",
      observedAt,
      platform: this.platform,
      executionPlatform: process.platform,
      products,
      changes,
      transitions: transitions.length > 0 ? transitions : await readTransitionIndex(stateRoot, this.limits),
      changed: changes.length > 0,
      networkPolicy: "threadspan-does-not-request-network",
      processNetworkIsolation: "not-enforced",
      mutation: "product-local-state-only",
    };
  }

  async #inspectProduct(product) {
    try {
      return product.kind === "command"
        ? await this.#inspectCommandProduct(product)
        : await this.#inspectArtifactProduct(product);
    } catch (error) {
      return {
        id: product.id,
        label: product.label,
        kind: product.kind,
        status: "error",
        error: classifyProbeError(error),
      };
    }
  }

  async #inspectCommandProduct(product) {
    let executable;
    for (const command of product.commands) {
      executable = await this.resolveExecutable(command, {
        platform: this.platform,
        environment: this.environment,
      });
      if (executable) break;
    }
    if (!executable) return missingObservation(product);

    const artifactPath = await canonicalCommandPath(executable);
    const artifact = await fingerprintFile(artifactPath, this.limits.maxArtifactBytes);
    const extensions = new Set([extname(executable).toLowerCase(), extname(artifactPath).toLowerCase()]);
    if (this.platform === "win32" && [...extensions].some((extension) => new Set([".cmd", ".bat"]).has(extension))) {
      return detectedObservation(product, artifactPath, artifact, undefined, "command-wrapper-artifact");
    }
    const result = await this.runProcess({
      command: artifactPath,
      args: product.versionArgs,
      timeoutMs: this.limits.processTimeoutMs,
      maxStdoutBytes: this.limits.maxProcessOutputBytes,
      maxStderrBytes: this.limits.maxProcessOutputBytes,
      env: probeEnvironment(this.environment),
      shell: false,
      windowsHide: true,
      killTree: true,
    });
    if (result.exitCode !== 0) throw new Error(`Version probe exited with code ${result.exitCode}`);
    const version = normalizeVersion(result.stdout || result.stderr);
    if (!version) throw new Error("Version probe returned no usable version");
    const after = await fingerprintFile(artifactPath, this.limits.maxArtifactBytes);
    if (after.sha256 !== artifact.sha256 || after.bytes !== artifact.bytes) throw new Error("Version-probed command artifact changed during inspection");
    return detectedObservation(product, artifactPath, after, version, "command-version+artifact");
  }

  async #inspectArtifactProduct(product) {
    let artifactPath;
    for (const candidate of product.candidates) {
      if (await isSafeExistingRegularFile(candidate)) {
        artifactPath = resolve(candidate);
        break;
      }
    }
    if (!artifactPath) return missingObservation(product);
    const artifact = await fingerprintFile(artifactPath, this.limits.maxArtifactBytes);
    let version;
    let versionIdentity;
    for (const candidate of product.versionFiles) {
      if (!await isSafeExistingRegularFile(candidate)) continue;
      const raw = await readBoundedFile(candidate, this.limits.maxMetadataBytes);
      const metadata = JSON.parse(UTF8_DECODER.decode(raw));
      if (typeof metadata?.version === "string" && metadata.version.trim()) {
        version = normalizeVersion(metadata.version);
        versionIdentity = { path: candidate, sha256: sha256Bytes(raw), bytes: raw.length };
        break;
      }
    }
    const after = await fingerprintFile(artifactPath, this.limits.maxArtifactBytes);
    if (after.sha256 !== artifact.sha256 || after.bytes !== artifact.bytes) {
      throw new Error("Desktop artifact changed while version metadata was inspected");
    }
    if (versionIdentity) {
      const raw = await readBoundedFile(versionIdentity.path, this.limits.maxMetadataBytes);
      if (sha256Bytes(raw) !== versionIdentity.sha256 || raw.length !== versionIdentity.bytes) {
        throw new Error("Desktop version metadata changed during inspection");
      }
    }
    return detectedObservation(product, artifactPath, after, version, version ? "artifact+metadata" : "artifact");
  }

  /**
   * Record externally performed, non-mutating compatibility checks for one exact N -> N+1 artifact transition.
   * This method only re-fingerprints the configured product and writes Threadspan-local evidence. It never
   * attaches to Desktop, invokes a provider, changes routing/settings/auth, or accepts inferred outcomes.
   * @param {{transitionId:string, claimId:string, source:"manual"|"passive", outcomes:Record<string,{status:string,evidenceClass:string,summary?:string}>}} options
   */
  async recordTransitionProbe(options) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    const transitionId = normalizeDigest(options?.transitionId, "transitionId");
    const claimId = normalizePlanId(options?.claimId);
    const source = normalizeProbeSource(options?.source);
    const outcomes = normalizeProbeOutcomes(options?.outcomes, source);
    const probeDigest = sha256Text(stableStringify({ transitionId, source, outcomes }));
    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: false });
    let transition = await readTransitionRecord(stateRoot, transitionId, this.limits);
    validateTransitionRecord(transition, transitionId);
    if (transition.identity.platform !== this.platform) throw new Error("Transition platform does not match this watcher");
    if (transition.status === "accepted") {
      if (transition.probe?.digest !== probeDigest) throw new Error("Accepted transition cannot be replaced by different probe evidence");
      await acceptTransitionObservation(stateRoot, transition, this.limits, this.now);
      await updateTransitionIndex(stateRoot, transition, this.limits);
      const completedClaim = transitionClaimPath(stateRoot, transition.targetKey);
      if (await safeLstat(completedClaim)) await releaseExactClaim(completedClaim, transitionId, claimId, this.limits);
      return structuredClone(transition);
    }
    if (!new Set(["probes-pending", "probe-interrupted", "repair-needed", "repair-applied-awaiting-probes"]).has(transition.status)) {
      throw new Error(`Transition cannot record probe evidence from status '${transition.status}'`);
    }

    const claimPath = transitionClaimPath(stateRoot, transition.targetKey);
    await acquireTransitionClaim(claimPath, { transitionId, claimId, probeDigest, claimedAt: new Date(this.now()).toISOString() }, this.limits);
    const attempt = Number.isSafeInteger(transition.attempt) ? transition.attempt + 1 : 1;
    transition = {
      ...transition,
      status: "probing",
      updatedAt: new Date(this.now()).toISOString(),
      attempt,
      retryPolicy: "blocked-while-claim-in-flight",
      probe: { source, outcomes, digest: probeDigest, startedAt: new Date(this.now()).toISOString() },
    };
    await writeTransitionRecord(stateRoot, transition, this.limits);
    await updateTransitionIndex(stateRoot, transition, this.limits);

    let acceptanceCommitted = false;
    try {
      const product = this.products.find((item) => item.id === transition.identity.product);
      if (!product) throw new Error(`Transition product '${transition.identity.product}' is not configured`);
      const before = await this.#inspectProduct(product);
      assertObservationMatchesIdentity(before, transition.identity["N+1"]);
      const after = await this.#inspectProduct(product);
      assertObservationMatchesIdentity(after, transition.identity["N+1"]);

      const actionable = PROBE_NAMES.filter((name) => outcomes[name].status === "fail");
      const diagnostics = PROBE_NAMES.filter((name) => outcomes[name].status !== "pass" && outcomes[name].status !== "fail");
      const allPassed = actionable.length === 0 && diagnostics.length === 0;
      transition = {
        ...transition,
        status: allPassed ? "accepted" : actionable.length > 0 ? "repair-needed" : "probes-pending",
        updatedAt: new Date(this.now()).toISOString(),
        retryPolicy: allPassed ? "terminal" : actionable.length > 0 ? "repair-or-new-reviewed-probe" : "complete-missing-probes",
        actionable,
        diagnostics,
        probe: { ...transition.probe, completedAt: new Date(this.now()).toISOString() },
        acceptanceScope: allPassed && transition.identity.platform === this.platform && this.platform === process.platform
          && PROBE_NAMES.every((name) => outcomes[name].evidenceClass === (source === "manual" ? "native-manual" : "native-passive"))
          ? "native-declared"
          : allPassed ? "synthetic" : "not-accepted",
      };
      await writeTransitionRecord(stateRoot, transition, this.limits);
      if (allPassed) {
        await acceptTransitionObservation(stateRoot, transition, this.limits, this.now);
        acceptanceCommitted = true;
      }
      await releaseExactClaim(claimPath, transitionId, claimId, this.limits);
      await updateTransitionIndex(stateRoot, transition, this.limits);
      return structuredClone(transition);
    } catch (error) {
      let claimReleased = false;
      if (!acceptanceCommitted) {
        claimReleased = await releaseExactClaim(claimPath, transitionId, claimId, this.limits).then(() => true, () => false);
      }
      transition = {
        ...transition,
        status: acceptanceCommitted ? "accepted" : "probe-interrupted",
        updatedAt: new Date(this.now()).toISOString(),
        retryPolicy: acceptanceCommitted
          ? "accepted-claim-reconciliation-required"
          : claimReleased ? "retry-with-new-exclusive-claim" : "claim-reconciliation-required",
        diagnostic: classifyProbeError(error),
      };
      await writeTransitionRecord(stateRoot, transition, this.limits).catch(() => undefined);
      await updateTransitionIndex(stateRoot, transition, this.limits).catch(() => undefined);
      throw error;
    }
  }

  /** Read one durable transition without probing or mutating product/app state. */
  async transitionState(transitionId) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    const normalized = normalizeDigest(transitionId, "transitionId");
    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: false });
    const transition = await readTransitionRecord(stateRoot, normalized, this.limits);
    validateTransitionRecord(transition, normalized);
    return structuredClone(transition);
  }

  /**
   * Prepare a repair bound to the exact failing transition and failed probe digest.
   * The older standalone planner remains available for non-transition Threadspan-owned maintenance.
   */
  async prepareTransitionRepairPlan(options) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    const transitionId = normalizeDigest(options?.transitionId, "transitionId");
    const failedProbeDigest = normalizeDigest(options?.failedProbeDigest, "failedProbeDigest");
    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: false });
    const transition = await readTransitionRecord(stateRoot, transitionId, this.limits);
    validateTransitionRecord(transition, transitionId);
    if (transition.status !== "repair-needed") throw new Error(`Transition repair requires repair-needed status, not '${transition.status}'`);
    if (transition.probe?.digest !== failedProbeDigest) throw new Error("Transition repair requires the exact failed probe digest");
    return this.prepareRepairPlan({
      ...options,
      [TRANSITION_BINDING]: {
        transitionId,
        transitionDigest: transition.identityDigest,
        failedProbeDigest,
        targetKey: transition.targetKey,
      },
    });
  }

  /**
   * Prepare an exact repair plan and bounded, private rollback snapshot without changing a repair target.
   * Only regular, secret-free text files under the supplied repair root may be planned.
   * @param {{
   *   planId: string,
   *   repairRoot: string,
   *   operations: Array<{relativePath:string, content:string, mode?:number}>,
   *   shutdownProducts?: string[],
   *   restartProducts?: string[],
   * }} options
   */
  async prepareRepairPlan(options) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    const transitionBinding = options?.[TRANSITION_BINDING];
    const planId = normalizePlanId(options?.planId);
    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: true });
    const repairRoot = await canonicalDirectoryRoot(options?.repairRoot, { create: false });
    const operations = normalizeRepairOperations(options?.operations, this.limits);
    const shutdownProducts = normalizeProductList(options?.shutdownProducts);
    const restartProducts = normalizeProductList(options?.restartProducts);
    const snapshotRoot = boundedPath(stateRoot, join(ROLLBACK_DIRECTORY, planId));
    if (await safeLstat(snapshotRoot)) throw new Error(`Repair plan '${planId}' already has a rollback snapshot`);
    await assertSafeTargetPath(stateRoot, snapshotRoot, { directoryTarget: true });

    const entries = [];
    let rollbackBytes = 0;
    try {
      await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
      await assertSafeTargetPath(stateRoot, snapshotRoot, { directoryTarget: true });
      for (const [index, operation] of operations.entries()) {
        const target = boundedPath(repairRoot, operation.relativePath);
        await assertSafeTargetPath(repairRoot, target);
        const current = await safeLstat(target);
        if (current?.isSymbolicLink()) throw new Error(`Repair target is a symbolic link: ${operation.relativePath}`);
        if (current && !current.isFile()) throw new Error(`Repair target is not a regular file: ${operation.relativePath}`);
        let original;
        if (current) {
          original = await readBoundedFile(target, this.limits.maxRollbackBytes - rollbackBytes);
          assertSecretFreeText(original, `rollback source '${operation.relativePath}'`);
          rollbackBytes += original.length;
          if (rollbackBytes > this.limits.maxRollbackBytes) throw new Error("Rollback snapshot exceeds maxRollbackBytes");
        }
        const backup = current ? `${String(index).padStart(3, "0")}.bak` : undefined;
        if (backup) await atomicWrite(boundedPath(snapshotRoot, backup), original, 0o600);
        entries.push({
          relativePath: operation.relativePath,
          existed: Boolean(current),
          ...(current ? {
            originalSha256: sha256Bytes(original),
            originalBytes: original.length,
            originalMode: current.mode & 0o777,
            backup,
          } : {}),
          desiredSha256: sha256Text(operation.content),
          desiredBytes: Buffer.byteLength(operation.content),
        });
      }

      const basePlan = {
        schemaVersion: SCHEMA_VERSION,
        kind: "desktop-compatibility-repair",
        planId,
        createdAt: new Date(this.now()).toISOString(),
        repairRoot,
        rollbackSnapshot: relative(stateRoot, snapshotRoot),
        operations: operations.map((operation, index) => ({ ...operation, ...entries[index] })),
        ...(transitionBinding ? { transition: structuredClone(transitionBinding) } : {}),
        shutdownProducts,
        restartProducts,
        prompts: repairPrompts(shutdownProducts, restartProducts),
      };
      const plan = { ...basePlan, digest: computeRepairPlanDigest(basePlan) };
      const manifest = {
        schemaVersion: SCHEMA_VERSION,
        planId,
        planDigest: plan.digest,
        createdAt: plan.createdAt,
        status: "prepared",
        repairRoot,
        entries,
        ...(transitionBinding ? { transition: structuredClone(transitionBinding) } : {}),
        totalBytes: rollbackBytes,
      };
      await atomicJsonWrite(boundedPath(snapshotRoot, "manifest.json"), manifest, 0o600);
      return plan;
    } catch (error) {
      await removeOwnedSnapshot(stateRoot, snapshotRoot).catch(() => undefined);
      throw error;
    }
  }

  /** Render the exact repair identity, writes, rollback location, and manual app prompts. */
  previewRepairPlan(plan) {
    validateRepairPlan(plan, this.limits);
    const lines = [
      `Threadspan Desktop Compatibility repair plan ${plan.planId}`,
      `Repair root: ${plan.repairRoot}`,
      `Rollback snapshot: ${plan.rollbackSnapshot}`,
      "Writes:",
      ...plan.operations.map((operation) => `  ${operation.relativePath} (${operation.desiredBytes} bytes, sha256 ${operation.desiredSha256})`),
      "Before apply:",
      ...(plan.prompts.beforeApply.length > 0 ? plan.prompts.beforeApply.map((item) => `  ${item}`) : ["  No app shutdown requested."]),
      "After apply:",
      ...plan.prompts.afterApply.map((item) => `  ${item}`),
      `Approval plan ID: ${plan.planId}`,
      `Approval digest: ${plan.digest}`,
    ];
    return { planId: plan.planId, digest: plan.digest, text: `${lines.join("\n")}\n`, prompts: structuredClone(plan.prompts) };
  }

  /**
   * Apply an exact previewed plan. This method never stops, restarts, installs, or upgrades an app.
   * Manual shutdown confirmations are required before any target write.
   * @param {Record<string, any>} plan
   * @param {{applyEnabled?:boolean, approvedPlanId?:string, approvedDigest?:string, confirmedStoppedProducts?:string[]}} approval
   */
  async applyRepairPlan(plan, approval = {}) {
    if (!this.enabled) throw new Error("Desktop Compatibility Watch is disabled");
    if (this.readOnly) throw new Error("Desktop Compatibility Watch is read-only");
    if (!this.applyEnabled || approval.applyEnabled !== true) {
      throw new Error("Desktop Compatibility Watch apply requires applyEnabled in configuration and approval");
    }
    validateRepairPlan(plan, this.limits);
    if (approval.approvedPlanId !== plan.planId) throw new Error("Repair apply requires the exact preview plan ID");
    if (approval.approvedDigest !== plan.digest) throw new Error("Repair apply requires the exact preview digest");
    const confirmedStopped = new Set(normalizeProductList(approval.confirmedStoppedProducts));
    const notStopped = plan.shutdownProducts.filter((product) => !confirmedStopped.has(product));
    if (notStopped.length > 0) {
      throw new Error(`Repair apply requires manual shutdown confirmation for: ${notStopped.join(", ")}`);
    }

    const stateRoot = await canonicalDirectoryRoot(this.stateRoot, { create: false });
    const repairRoot = await canonicalDirectoryRoot(plan.repairRoot, { create: false });
    const snapshotRoot = boundedPath(stateRoot, plan.rollbackSnapshot);
    await assertSafeTargetPath(stateRoot, snapshotRoot, { directoryTarget: true });
    const manifestPath = boundedPath(snapshotRoot, "manifest.json");
    let manifest = await readRequiredJson(manifestPath, this.limits.maxStateBytes);
    validateRollbackManifest(manifest, plan);

    let boundTransition;
    if (plan.transition) {
      boundTransition = await readTransitionRecord(stateRoot, plan.transition.transitionId, this.limits);
      validateTransitionBinding(plan.transition, boundTransition);
      if (boundTransition.identity.platform !== this.platform) throw new Error("Bound transition platform does not match this watcher");
      if (boundTransition.status !== "repair-needed") {
        throw new Error(`Bound transition cannot apply from status '${boundTransition.status}'`);
      }
      const product = this.products.find((item) => item.id === boundTransition.identity.product);
      if (!product) throw new Error(`Transition product '${boundTransition.identity.product}' is not configured`);
      assertObservationMatchesIdentity(await this.#inspectProduct(product), boundTransition.identity["N+1"]);
    }

    const targetGuards = new Map();
    for (const operation of plan.operations) {
      const target = boundedPath(repairRoot, operation.relativePath);
      await assertSafeTargetPath(repairRoot, target);
      await assertTargetMatchesPlan(target, operation);
      targetGuards.set(operation.relativePath, await captureTargetGuard(repairRoot, target));
    }
    await verifyRollbackBackups(snapshotRoot, plan.operations);

    let transitionOperationClaim;
    if (boundTransition) {
      transitionOperationClaim = {
        path: transitionClaimPath(stateRoot, boundTransition.targetKey),
        claimId: `repair-${plan.planId}`,
      };
      await acquireTransitionClaim(transitionOperationClaim.path, {
        transitionId: boundTransition.transitionId,
        claimId: transitionOperationClaim.claimId,
        probeDigest: plan.transition.failedProbeDigest,
        claimedAt: new Date(this.now()).toISOString(),
      }, this.limits);
      try {
        boundTransition = await readTransitionRecord(stateRoot, plan.transition.transitionId, this.limits);
        validateTransitionBinding(plan.transition, boundTransition);
        if (boundTransition.status !== "repair-needed") throw new Error(`Bound transition cannot apply from status '${boundTransition.status}'`);
        const product = this.products.find((item) => item.id === boundTransition.identity.product);
        if (!product) throw new Error(`Transition product '${boundTransition.identity.product}' is not configured`);
        assertObservationMatchesIdentity(await this.#inspectProduct(product), boundTransition.identity["N+1"]);
        boundTransition = {
          ...boundTransition,
          status: "repair-claimed",
          updatedAt: new Date(this.now()).toISOString(),
          repair: { planId: plan.planId, planDigest: plan.digest, status: "claimed" },
        };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits);
      } catch (error) {
        await releaseExactClaim(transitionOperationClaim.path, boundTransition.transitionId, transitionOperationClaim.claimId, this.limits).catch(() => undefined);
        throw error;
      }
    }

    const targetClaims = [];
    try {
      for (const operation of [...plan.operations].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
        const claimPath = repairTargetClaimPath(stateRoot, repairRoot, operation.relativePath, this.platform);
        const claim = await acquireRepairTargetClaim(claimPath, plan, operation, this.limits, this.now);
        targetClaims.push({ path: claimPath, created: claim.created });
      }
    } catch (error) {
      for (const claim of targetClaims.filter((item) => item.created)) {
        await releaseRepairTargetClaim(claim.path, plan, this.limits).catch(() => undefined);
      }
      if (transitionOperationClaim) {
        boundTransition = { ...boundTransition, status: "repair-needed", updatedAt: new Date(this.now()).toISOString(), repair: { planId: plan.planId, planDigest: plan.digest, status: "target-claim-failed" } };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await releaseExactClaim(transitionOperationClaim.path, boundTransition.transitionId, transitionOperationClaim.claimId, this.limits).catch(() => undefined);
      }
      throw error;
    }

    const claimPath = boundedPath(snapshotRoot, "apply.claim.json");
    await createExclusiveJson(claimPath, {
      schemaVersion: SCHEMA_VERSION,
      planId: plan.planId,
      planDigest: plan.digest,
      claimedAt: new Date(this.now()).toISOString(),
    }, 0o600).catch(async (error) => {
      if (transitionOperationClaim) {
        for (const claim of targetClaims.filter((item) => item.created)) {
          await releaseRepairTargetClaim(claim.path, plan, this.limits).catch(() => undefined);
        }
        boundTransition = { ...boundTransition, status: "repair-needed", updatedAt: new Date(this.now()).toISOString(), repair: { planId: plan.planId, planDigest: plan.digest, status: "apply-claim-failed" } };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await releaseExactClaim(transitionOperationClaim.path, boundTransition.transitionId, transitionOperationClaim.claimId, this.limits).catch(() => undefined);
      }
      if (error?.code === "EEXIST") throw new Error(`Repair plan '${plan.planId}' is already claimed for apply`);
      throw error;
    });

    try {
      manifest = await readRequiredJson(manifestPath, this.limits.maxStateBytes);
      validateRollbackManifest(manifest, plan);
      for (const operation of plan.operations) {
        const target = boundedPath(repairRoot, operation.relativePath);
        await assertTargetGuard(targetGuards.get(operation.relativePath));
        await assertTargetMatchesPlan(target, operation);
      }
      await verifyRollbackBackups(snapshotRoot, plan.operations);

      if (boundTransition) {
        boundTransition = { ...boundTransition, status: "repair-applying", updatedAt: new Date(this.now()).toISOString(), repair: { planId: plan.planId, planDigest: plan.digest, status: "applying" } };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits);
      }
      manifest.status = "applying";
      manifest.applyStartedAt = new Date(this.now()).toISOString();
      await atomicJsonWrite(manifestPath, manifest, 0o600);
    } catch (error) {
      manifest.status = "recovery-required";
      manifest.error = sanitizePersistedError(error, [repairRoot, stateRoot, snapshotRoot]);
      await atomicJsonWrite(manifestPath, manifest, 0o600).catch(() => undefined);
      if (boundTransition) {
        boundTransition = { ...boundTransition, status: "repair-recovery-required", updatedAt: new Date(this.now()).toISOString(), repair: { planId: plan.planId, planDigest: plan.digest, status: "recovery-required" } };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits).catch(() => undefined);
      }
      throw error;
    }
    const written = [];
    try {
      for (const operation of plan.operations) {
        const target = boundedPath(repairRoot, operation.relativePath);
        const guard = targetGuards.get(operation.relativePath);
        await assertTargetGuard(guard);
        await assertTargetMatchesPlan(target, operation);
        await atomicWrite(target, operation.content, operation.mode, { beforeCommit: () => assertTargetGuard(guard) });
        written.push(operation);
        await assertTargetGuard(guard);
      }
      manifest.status = "applied";
      manifest.appliedAt = new Date(this.now()).toISOString();
      await atomicJsonWrite(manifestPath, manifest, 0o600);
      if (boundTransition) {
        boundTransition = { ...boundTransition, status: "repair-applied-awaiting-probes", updatedAt: new Date(this.now()).toISOString(), repair: { ...boundTransition.repair, status: "applied", appliedAt: manifest.appliedAt } };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits);
      }
      for (const claim of targetClaims) await releaseRepairTargetClaim(claim.path, plan, this.limits);
      if (transitionOperationClaim) await releaseExactClaim(transitionOperationClaim.path, boundTransition.transitionId, transitionOperationClaim.claimId, this.limits);
    } catch (error) {
      const rollbackErrors = await restoreWrittenTargets(repairRoot, snapshotRoot, written);
      manifest.status = rollbackErrors.length === 0 ? "rolled-back-after-error" : "rollback-incomplete";
      manifest.error = sanitizePersistedError(error, [repairRoot, stateRoot, snapshotRoot]);
      if (rollbackErrors.length > 0) manifest.rollbackErrors = rollbackErrors;
      await atomicJsonWrite(manifestPath, manifest, 0o600).catch(() => undefined);
      if (boundTransition) {
        boundTransition = {
          ...boundTransition,
          status: rollbackErrors.length === 0 ? "repair-needed" : "rollback-incomplete",
          updatedAt: new Date(this.now()).toISOString(),
          repair: { ...boundTransition.repair, status: manifest.status },
        };
        await writeTransitionRecord(stateRoot, boundTransition, this.limits).catch(() => undefined);
        await updateTransitionIndex(stateRoot, boundTransition, this.limits).catch(() => undefined);
      }
      if (rollbackErrors.length === 0) {
        for (const claim of targetClaims) await releaseRepairTargetClaim(claim.path, plan, this.limits).catch(() => undefined);
        if (transitionOperationClaim) await releaseExactClaim(transitionOperationClaim.path, boundTransition.transitionId, transitionOperationClaim.claimId, this.limits).catch(() => undefined);
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error], `Repair failed and rollback was incomplete for: ${rollbackErrors.map((item) => item.relativePath).join(", ")}`);
      }
      throw error;
    }

    return {
      status: "applied",
      planId: plan.planId,
      digest: plan.digest,
      written: written.map((operation) => operation.relativePath),
      rollbackSnapshot: plan.rollbackSnapshot,
      ...(plan.transition ? { transitionId: plan.transition.transitionId, transitionStatus: "repair-applied-awaiting-probes" } : {}),
      prompts: structuredClone(plan.prompts),
      appLifecycleActionsPerformed: false,
      nextAction: "Manually restart requested apps, then run doctorAfterUpdate().",
    };
  }
}

function disabledReport(platform, reason) {
  return {
    status: "disabled",
    mode: "read-only",
    reason,
    platform,
    products: [],
    changes: [],
    changed: false,
    networkAccess: false,
    mutation: "none",
  };
}

function validateLimits(limits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (limits.maxRollbackFiles > limits.maxRepairOperations) {
    limits.maxRollbackFiles = limits.maxRepairOperations;
  }
  if (limits.minPollIntervalMs > limits.maxPollIntervalMs) throw new Error("Polling interval limits are inverted");
  return Object.freeze(limits);
}

function normalizeProducts(products, limits) {
  if (!Array.isArray(products) || products.length > limits.maxProducts) {
    throw new TypeError(`products must contain at most ${limits.maxProducts} entries`);
  }
  const seen = new Set();
  return products.map((product) => {
    if (!product || !PRODUCT_ID_PATTERN.test(product.id ?? "") || seen.has(product.id)) {
      throw new TypeError(`Invalid or duplicate product id '${String(product?.id)}'`);
    }
    seen.add(product.id);
    const kind = product.kind;
    if (!new Set(["command", "artifact"]).has(kind)) throw new TypeError(`Unsupported product kind '${String(kind)}'`);
    const label = normalizeDisplayText(product.label ?? product.id, 120, "product label");
    if (kind === "command") {
      const commands = normalizeBoundedStrings(product.commands, limits.maxCandidatesPerProduct, "commands");
      const versionArgs = normalizeBoundedStrings(product.versionArgs ?? ["--version"], 8, "versionArgs", { allowEmpty: true });
      if (versionArgs.some((argument) => /(?:^|[-_/])(update|upgrade|install|login|auth)(?:$|[-_/])/i.test(argument))) {
        throw new Error("Version probe arguments must not request update, install, or authentication actions");
      }
      return Object.freeze({ id: product.id, label, kind, commands, versionArgs });
    }
    const candidates = normalizeAbsolutePaths(product.candidates, limits.maxCandidatesPerProduct, "candidates");
    const versionFiles = normalizeAbsolutePaths(product.versionFiles ?? [], limits.maxCandidatesPerProduct, "versionFiles", { allowEmpty: true });
    return Object.freeze({ id: product.id, label, kind, candidates, versionFiles });
  });
}

function normalizeBoundedStrings(value, maximum, name, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > maximum) {
    throw new TypeError(`${name} must contain ${options.allowEmpty ? "0" : "1"}..${maximum} strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024 || entry.includes("\0")) {
      throw new TypeError(`${name} contains an invalid value`);
    }
    return entry;
  });
}

function normalizeAbsolutePaths(value, maximum, name, options = {}) {
  const paths = normalizeBoundedStrings(value, maximum, name, options);
  for (const path of paths) {
    if (!isAbsolute(path)) throw new TypeError(`${name} must use absolute paths`);
  }
  return paths.map((path) => resolve(path));
}

function normalizeDisplayText(value, maximum, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim().replace(CONTROL_PATTERN, "").slice(0, maximum);
}

function normalizeVersion(value) {
  const line = String(value ?? "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return line ? line.replace(CONTROL_PATTERN, "").slice(0, 256) : undefined;
}

function probeEnvironment(environment) {
  const allowed = [
    "PATH", "Path", "path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "NODE_PATH",
  ];
  return Object.fromEntries(allowed.filter((name) => typeof environment[name] === "string").map((name) => [name, environment[name]]));
}

function missingObservation(product) {
  return { id: product.id, label: product.label, kind: product.kind, status: "missing" };
}

function detectedObservation(product, path, artifact, version, evidence) {
  return {
    id: product.id,
    label: product.label,
    kind: product.kind,
    status: "detected",
    ...(version ? { version } : {}),
    artifactName: basename(path),
    artifactPathSha256: sha256Text(resolve(path)),
    artifactSha256: artifact.sha256,
    artifactBytes: artifact.bytes,
    evidence,
  };
}

function persistedObservation(observation) {
  const allowed = [
    "id", "label", "kind", "status", "version", "artifactName", "artifactPathSha256",
    "artifactSha256", "artifactBytes", "evidence", "error",
  ];
  return Object.fromEntries(allowed.filter((key) => observation[key] !== undefined).map((key) => [key, observation[key]]));
}

function compareObservations(previous, current) {
  const priorById = new Map(Array.isArray(previous) ? previous.map((item) => [item?.id, item]) : []);
  const currentById = new Map(current.map((item) => [item.id, item]));
  const changes = [];
  for (const item of current) {
    const prior = priorById.get(item.id);
    if (!prior) {
      changes.push({ productId: item.id, kind: "baseline", current: persistedObservation(item) });
    } else if (stableStringify(persistedObservation(prior)) !== stableStringify(persistedObservation(item))) {
      changes.push({ productId: item.id, kind: "changed", previous: persistedObservation(prior), current: persistedObservation(item) });
    }
  }
  for (const prior of priorById.values()) {
    if (prior?.id && !currentById.has(prior.id)) changes.push({ productId: prior.id, kind: "removed" });
  }
  return changes;
}

function isExactDetectedObservation(value) {
  return value?.status === "detected"
    && typeof value.id === "string"
    && /^[0-9a-f]{64}$/.test(value.artifactPathSha256 ?? "")
    && /^[0-9a-f]{64}$/.test(value.artifactSha256 ?? "")
    && Number.isSafeInteger(value.artifactBytes)
    && value.artifactBytes >= 0;
}

function exactObservationIdentity(observation) {
  if (!isExactDetectedObservation(observation)) throw new Error("Exact transition identity requires a detected artifact");
  return {
    version: normalizeVersion(observation.version) ?? null,
    kind: observation.kind,
    artifactName: observation.artifactName,
    artifactPathSha256: observation.artifactPathSha256,
    artifactSha256: observation.artifactSha256,
    artifactBytes: observation.artifactBytes,
    evidence: observation.evidence,
  };
}

function sameExactObservation(observation, identityOrObservation) {
  const right = Object.hasOwn(identityOrObservation ?? {}, "artifactPathSha256") && !Object.hasOwn(identityOrObservation ?? {}, "status")
    ? identityOrObservation
    : exactObservationIdentity(identityOrObservation);
  return stableStringify(exactObservationIdentity(observation)) === stableStringify(right);
}

function assertObservationMatchesIdentity(observation, identity) {
  if (!isExactDetectedObservation(observation) || !sameExactObservation(observation, identity)) {
    throw new Error("Exact N+1 artifact/version identity changed; refusing transition operation");
  }
}

async function persistObservedTransition(stateRoot, identity, productLabel, observedAt, limits) {
  const identityDigest = sha256Text(stableStringify(identity));
  const transitionId = identityDigest;
  const targetKey = sha256Text(`${identity.platform}\0${identity.product}`);
  const transition = {
    schemaVersion: SCHEMA_VERSION,
    kind: "desktop-compatibility-transition",
    transitionId,
    identityDigest,
    targetKey,
    identity,
    productLabel: normalizeDisplayText(productLabel ?? identity.product, 120, "product label"),
    status: "probes-pending",
    acceptanceScope: "not-accepted",
    actionable: [],
    diagnostics: [...PROBE_NAMES],
    observedAt,
    updatedAt: observedAt,
    preservation: { N: "last-known-working", sidecar: "retained" },
  };
  const path = transitionRecordPath(stateRoot, transitionId);
  try {
    await createExclusiveJson(path, transition, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readRequiredJson(path, limits.maxStateBytes);
    validateTransitionRecord(existing, transitionId);
    if (existing.identityDigest !== identityDigest) throw new Error("Transition identity collision");
    await updateTransitionIndex(stateRoot, existing, limits);
    return existing;
  }
  await updateTransitionIndex(stateRoot, transition, limits);
  return transition;
}

function transitionRecordPath(stateRoot, transitionId) {
  return boundedPath(stateRoot, join(TRANSITION_DIRECTORY, normalizeDigest(transitionId, "transitionId"), "transition.json"));
}

async function readTransitionRecord(stateRoot, transitionId, limits) {
  return readRequiredJson(transitionRecordPath(stateRoot, transitionId), limits.maxStateBytes);
}

async function writeTransitionRecord(stateRoot, transition, limits) {
  validateTransitionRecord(transition, transition.transitionId);
  const text = JSON.stringify(transition);
  if (Buffer.byteLength(text) > limits.maxStateBytes) throw new Error("Transition record exceeds maxStateBytes");
  await atomicJsonWrite(transitionRecordPath(stateRoot, transition.transitionId), transition, 0o600);
}

function validateTransitionRecord(transition, transitionId) {
  if (!transition || transition.schemaVersion !== SCHEMA_VERSION || transition.kind !== "desktop-compatibility-transition") {
    throw new Error("Invalid Desktop Compatibility transition record");
  }
  const expected = normalizeDigest(transitionId, "transitionId");
  if (transition.transitionId !== expected || transition.identityDigest !== expected) throw new Error("Transition identity mismatch");
  if (!transition.identity || !new Set(["linux", "win32"]).has(transition.identity.platform)) throw new Error("Invalid transition platform");
  if (!PRODUCT_ID_PATTERN.test(transition.identity.product ?? "")) throw new Error("Invalid transition product");
  normalizeDisplayText(transition.productLabel, 120, "transition product label");
  for (const generation of ["N", "N+1"]) validateExactIdentity(transition.identity[generation]);
  if (sha256Text(stableStringify(transition.identity)) !== expected) throw new Error("Transition identity digest mismatch");
  if (transition.targetKey !== sha256Text(`${transition.identity.platform}\0${transition.identity.product}`)) throw new Error("Transition target mismatch");
  const statuses = new Set(["probes-pending", "probing", "probe-interrupted", "repair-needed", "repair-claimed", "repair-applying", "repair-recovery-required", "repair-applied-awaiting-probes", "rollback-incomplete", "accepted"]);
  if (!statuses.has(transition.status)) throw new Error("Invalid transition status");
  if (!new Set(["not-accepted", "synthetic", "native-declared"]).has(transition.acceptanceScope)) throw new Error("Invalid transition acceptance scope");
  for (const field of ["actionable", "diagnostics"]) {
    if (!Array.isArray(transition[field]) || transition[field].some((name) => !PROBE_NAMES.includes(name))) throw new Error(`Invalid transition ${field}`);
  }
  if (transition.probe !== undefined) {
    const source = normalizeProbeSource(transition.probe.source);
    const outcomes = normalizeProbeOutcomes(transition.probe.outcomes, source);
    const digest = sha256Text(stableStringify({ transitionId: expected, source, outcomes }));
    if (transition.probe.digest !== digest) throw new Error("Transition probe digest mismatch");
  }
  if (transition.status === "accepted" && (!transition.probe || PROBE_NAMES.some((name) => transition.probe.outcomes[name].status !== "pass"))) {
    throw new Error("Accepted transition lacks complete passing probes");
  }
}

function validateExactIdentity(identity) {
  if (!identity || !new Set(["command", "artifact"]).has(identity.kind)) throw new Error("Invalid exact artifact identity");
  if (identity.version !== null && (typeof identity.version !== "string" || identity.version.length > 256)) throw new Error("Invalid exact version identity");
  if (!/^[0-9a-f]{64}$/.test(identity.artifactPathSha256 ?? "") || !/^[0-9a-f]{64}$/.test(identity.artifactSha256 ?? "")) {
    throw new Error("Invalid exact artifact digest");
  }
  if (!Number.isSafeInteger(identity.artifactBytes) || identity.artifactBytes < 0) throw new Error("Invalid exact artifact size");
}

function transitionIndexEntry(transition) {
  const outcomes = {};
  for (const name of PROBE_NAMES) {
    const outcome = transition.probe?.outcomes?.[name];
    if (outcome) outcomes[name] = { status: outcome.status, evidenceClass: outcome.evidenceClass };
  }
  return {
    transitionId: transition.transitionId,
    platform: transition.identity.platform,
    executionPlatform: process.platform,
    product: transition.identity.product,
    productLabel: transition.productLabel,
    N: transition.identity.N.version,
    "N+1": transition.identity["N+1"].version,
    status: transition.status,
    acceptanceScope: transition.acceptanceScope,
    observedAt: transition.observedAt,
    updatedAt: transition.updatedAt,
    outcomes,
    actionable: Array.isArray(transition.actionable) ? transition.actionable.slice(0, PROBE_NAMES.length) : [],
    diagnostics: Array.isArray(transition.diagnostics) ? transition.diagnostics.slice(0, PROBE_NAMES.length) : [],
    repairStatus: transition.repair?.status,
    oldWorkingSurface: true,
    sidecarRetained: true,
  };
}

async function updateTransitionIndex(stateRoot, transition, limits) {
  await withStateFileClaim(stateRoot, "transition-index", transition.transitionId, limits, async () => {
    const path = boundedPath(stateRoot, TRANSITION_INDEX_FILE);
    const current = await readOptionalJson(path, limits.maxStateBytes);
    const entries = Array.isArray(current?.transitions) ? current.transitions : [];
    const next = [transitionIndexEntry(transition), ...entries.filter((entry) => entry?.transitionId !== transition.transitionId)]
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, 20);
    await atomicJsonWrite(path, { schemaVersion: SCHEMA_VERSION, transitions: next }, 0o600);
  });
}

async function readTransitionIndex(stateRoot, limits) {
  const value = await readOptionalJson(boundedPath(stateRoot, TRANSITION_INDEX_FILE), limits.maxStateBytes);
  return Array.isArray(value?.transitions) ? value.transitions.slice(0, 20) : [];
}

function normalizeDigest(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${name} must be a SHA-256 digest`);
  return value;
}

function normalizeProbeSource(value) {
  if (!PROBE_SOURCES.has(value)) throw new TypeError("Probe source must be manual or passive");
  return value;
}

function normalizeProbeOutcomes(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Probe outcomes must be an object");
  const extra = Object.keys(value).filter((name) => !PROBE_NAMES.includes(name));
  if (extra.length > 0) throw new TypeError(`Unsupported probe outcome: ${extra[0]}`);
  return Object.fromEntries(PROBE_NAMES.map((name) => {
    const outcome = value[name];
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || !PROBE_STATUSES.has(outcome.status)) {
      throw new TypeError(`Probe outcome '${name}' is missing or invalid`);
    }
    if (!EVIDENCE_CLASSES.has(outcome.evidenceClass)) throw new TypeError(`Probe evidence class '${name}' is invalid`);
    if (source === "manual" && outcome.evidenceClass === "native-passive") throw new Error("Manual probes cannot claim native-passive evidence");
    if (source === "passive" && outcome.evidenceClass === "native-manual") throw new Error("Passive probes cannot claim native-manual evidence");
    const summary = outcome.summary === undefined ? undefined : normalizeDisplayText(outcome.summary, 160, `${name} summary`);
    if (summary !== undefined) assertSecretFreeText(summary, `${name} summary`);
    return [name, { status: outcome.status, evidenceClass: outcome.evidenceClass, ...(summary ? { summary } : {}) }];
  }));
}

function transitionClaimPath(stateRoot, targetKey) {
  return boundedPath(stateRoot, join(CLAIM_DIRECTORY, "transitions", `${normalizeDigest(targetKey, "targetKey")}.json`));
}

async function acquireTransitionClaim(path, claim, limits) {
  try {
    await createExclusiveJson(path, { schemaVersion: SCHEMA_VERSION, kind: "desktop-transition-claim", ...claim }, 0o600);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readRequiredJson(path, limits.maxStateBytes);
    if (existing.kind !== "desktop-transition-claim") throw new Error("Desktop transition claim is malformed");
    throw new Error("Desktop transition target is already claimed by another operation");
  }
}

async function releaseExactClaim(path, transitionId, claimId, limits) {
  const existing = await readRequiredJson(path, limits.maxStateBytes);
  if (existing.transitionId !== transitionId || existing.claimId !== claimId) throw new Error("Refusing to release a different transition claim");
  await rm(path, { force: false });
}

async function acceptTransitionObservation(stateRoot, transition, limits, now) {
  await withStateFileClaim(stateRoot, "accepted-observations", transition.transitionId, limits, async () => {
    const path = boundedPath(stateRoot, ACCEPTED_OBSERVATION_FILE);
    const accepted = await readRequiredJson(path, limits.maxStateBytes);
    const products = Array.isArray(accepted.products) ? accepted.products.filter((item) => item?.id !== transition.identity.product) : [];
    const next = transition.identity["N+1"];
    products.push({
      id: transition.identity.product,
      label: transition.productLabel,
      kind: next.kind,
      status: "detected",
      ...(next.version ? { version: next.version } : {}),
      artifactName: next.artifactName,
      artifactPathSha256: next.artifactPathSha256,
      artifactSha256: next.artifactSha256,
      artifactBytes: next.artifactBytes,
      evidence: next.evidence,
    });
    await atomicJsonWrite(path, { schemaVersion: SCHEMA_VERSION, acceptedAt: new Date(now()).toISOString(), platform: transition.identity.platform, products }, 0o600);
  });
}

async function withStateFileClaim(stateRoot, name, owner, limits, operation) {
  normalizePlanId(name);
  const claimPath = boundedPath(stateRoot, join(CLAIM_DIRECTORY, "state-files", `${name}.json`));
  const claim = { schemaVersion: SCHEMA_VERSION, kind: "desktop-state-file-claim", name, owner: normalizeDigest(owner, "state claim owner") };
  let acquired = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await createExclusiveJson(claimPath, claim, 0o600);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt === 199) throw new Error(`Desktop state file '${name}' remains claimed`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
  }
  if (!acquired) throw new Error(`Desktop state file '${name}' could not be claimed`);
  try {
    return await operation();
  } finally {
    const existing = await readRequiredJson(claimPath, limits.maxStateBytes);
    if (existing.kind !== claim.kind || existing.name !== name || existing.owner !== claim.owner) throw new Error("Refusing to release a different Desktop state-file claim");
    await rm(claimPath, { force: false });
  }
}

function normalizeTransitionBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new Error("Invalid repair transition binding");
  return {
    transitionId: normalizeDigest(binding.transitionId, "transitionId"),
    transitionDigest: normalizeDigest(binding.transitionDigest, "transitionDigest"),
    failedProbeDigest: normalizeDigest(binding.failedProbeDigest, "failedProbeDigest"),
    targetKey: normalizeDigest(binding.targetKey, "targetKey"),
  };
}

function validateTransitionBinding(binding, transition) {
  const normalized = normalizeTransitionBinding(binding);
  validateTransitionRecord(transition, normalized.transitionId);
  if (normalized.transitionDigest !== transition.identityDigest || normalized.targetKey !== transition.targetKey || normalized.failedProbeDigest !== transition.probe?.digest) {
    throw new Error("Repair plan does not match the exact failing transition");
  }
}

function repairTargetClaimPath(stateRoot, repairRoot, relativePath, platform) {
  const identity = platform === "win32"
    ? `${repairRoot.toLocaleLowerCase("en-US")}\0${relativePath.toLocaleLowerCase("en-US")}`
    : `${repairRoot}\0${relativePath}`;
  return boundedPath(stateRoot, join(CLAIM_DIRECTORY, "repair-targets", `${sha256Text(identity)}.json`));
}

async function acquireRepairTargetClaim(path, plan, operation, limits, now) {
  const claim = {
    schemaVersion: SCHEMA_VERSION,
    kind: "desktop-repair-target-claim",
    planId: plan.planId,
    planDigest: plan.digest,
    targetPreimage: operation.existed ? operation.originalSha256 : "absent",
    transitionId: plan.transition?.transitionId ?? null,
    claimedAt: new Date(now()).toISOString(),
  };
  try {
    await createExclusiveJson(path, claim, 0o600);
    return { created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readRequiredJson(path, limits.maxStateBytes);
    if (existing.kind !== claim.kind || existing.planId !== claim.planId || existing.planDigest !== claim.planDigest || existing.targetPreimage !== claim.targetPreimage || existing.transitionId !== claim.transitionId) {
      throw new Error("Repair target is already claimed by another plan");
    }
    return { created: false };
  }
}

async function releaseRepairTargetClaim(path, plan, limits) {
  const existing = await readRequiredJson(path, limits.maxStateBytes);
  if (existing.planId !== plan.planId || existing.planDigest !== plan.digest) throw new Error("Refusing to release a different repair target claim");
  await rm(path, { force: false });
}

function normalizePlanId(value) {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) throw new TypeError("planId contains unsupported characters");
  return value;
}

function normalizeRepairOperations(operations, limits) {
  const maximum = Math.min(limits.maxRepairOperations, limits.maxRollbackFiles);
  if (!Array.isArray(operations) || operations.length === 0 || operations.length > maximum) {
    throw new TypeError(`operations must contain 1..${maximum} entries`);
  }
  const seen = new Set();
  let totalBytes = 0;
  return operations.map((operation) => {
    if (!operation || typeof operation.content !== "string") throw new TypeError("Repair operation content must be text");
    const relativePath = normalizeRelativePath(operation.relativePath);
    if (seen.has(relativePath)) throw new Error(`Duplicate repair target: ${relativePath}`);
    seen.add(relativePath);
    assertSecretFreeText(operation.content, `repair content '${relativePath}'`);
    const bytes = Buffer.byteLength(operation.content);
    totalBytes += bytes;
    if (totalBytes > limits.maxRepairBytes) throw new Error("Repair content exceeds maxRepairBytes");
    const mode = operation.mode ?? 0o600;
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) throw new TypeError(`Invalid mode for '${relativePath}'`);
    return { relativePath, content: operation.content, mode };
  });
}

function normalizeProductList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) throw new TypeError("Product prompt list must contain at most 16 ids");
  const normalized = value.map((item) => {
    if (typeof item !== "string" || !PRODUCT_ID_PATTERN.test(item)) throw new TypeError("Product prompt list contains an invalid id");
    return item;
  });
  return [...new Set(normalized)];
}

function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\0")) {
    throw new Error(`Unsafe relative path '${String(value)}'`);
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe relative path '${value}'`);
  return parts.join("/");
}

function repairPrompts(shutdownProducts, restartProducts) {
  return {
    beforeApply: shutdownProducts.map((product) => `Close ${product} manually, then confirm it is stopped.`),
    afterApply: [
      ...restartProducts.map((product) => `Restart ${product} manually.`),
      "Run doctorAfterUpdate() after the update or restart to record fresh compatibility evidence.",
    ],
  };
}

function validateRepairPlan(plan, limits) {
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION || plan.kind !== "desktop-compatibility-repair") {
    throw new TypeError("Invalid Desktop Compatibility repair plan");
  }
  normalizePlanId(plan.planId);
  if (typeof plan.repairRoot !== "string" || !isAbsolute(plan.repairRoot)) throw new TypeError("Repair root must be absolute");
  normalizeRelativePath(plan.rollbackSnapshot);
  const operations = normalizeRepairOperations(plan.operations, limits);
  if (operations.length !== plan.operations.length) throw new TypeError("Invalid repair operations");
  for (const [index, operation] of plan.operations.entries()) {
    const normalized = operations[index];
    if (operation.relativePath !== normalized.relativePath || operation.mode !== normalized.mode) throw new Error("Repair operation normalization changed");
    if (!/^[0-9a-f]{64}$/.test(operation.desiredSha256 ?? "") || sha256Text(operation.content) !== operation.desiredSha256) {
      throw new Error(`Repair desired hash mismatch for '${operation.relativePath}'`);
    }
    if (operation.existed === true) {
      if (!/^[0-9a-f]{64}$/.test(operation.originalSha256 ?? "") || !Number.isSafeInteger(operation.originalBytes)) {
        throw new TypeError(`Repair preimage is invalid for '${operation.relativePath}'`);
      }
      normalizeRelativePath(operation.backup);
    } else if (operation.existed !== false) {
      throw new TypeError(`Repair existence state is invalid for '${operation.relativePath}'`);
    }
  }
  const shutdownProducts = normalizeProductList(plan.shutdownProducts);
  const restartProducts = normalizeProductList(plan.restartProducts);
  if (plan.transition !== undefined) normalizeTransitionBinding(plan.transition);
  if (stableStringify(plan.prompts) !== stableStringify(repairPrompts(shutdownProducts, restartProducts))) {
    throw new Error("Repair prompts do not match the plan's app lifecycle requirements");
  }
  if (computeRepairPlanDigest(plan) !== plan.digest) throw new Error("Repair plan integrity check failed");
}

function validateRollbackManifest(manifest, plan) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.planId !== plan.planId || manifest.planDigest !== plan.digest) {
    throw new Error("Rollback snapshot does not match the approved repair plan");
  }
  if (manifest.status !== "prepared") throw new Error(`Repair plan cannot apply from rollback status '${String(manifest.status)}'`);
  if (manifest.repairRoot !== plan.repairRoot || stableStringify(manifest.entries) !== stableStringify(plan.operations.map(planEntry))) {
    throw new Error("Rollback snapshot entries do not match the approved repair plan");
  }
  if (stableStringify(manifest.transition ?? null) !== stableStringify(plan.transition ?? null)) {
    throw new Error("Rollback snapshot transition binding does not match the approved repair plan");
  }
}

function planEntry(operation) {
  return {
    relativePath: operation.relativePath,
    existed: operation.existed,
    ...(operation.existed ? {
      originalSha256: operation.originalSha256,
      originalBytes: operation.originalBytes,
      originalMode: operation.originalMode,
      backup: operation.backup,
    } : {}),
    desiredSha256: operation.desiredSha256,
    desiredBytes: operation.desiredBytes,
  };
}

async function assertTargetMatchesPlan(path, operation) {
  const current = await safeLstat(path);
  if (!operation.existed) {
    if (current) throw new Error(`Repair target appeared after planning: ${operation.relativePath}`);
    return;
  }
  if (!current?.isFile() || current.isSymbolicLink()) throw new Error(`Repair target changed type after planning: ${operation.relativePath}`);
  if ((current.mode & 0o777) !== operation.originalMode) throw new Error(`Repair target mode changed after planning: ${operation.relativePath}`);
  let content;
  try {
    content = await readBoundedFile(path, operation.originalBytes);
  } catch {
    throw new Error(`Repair target changed after planning: ${operation.relativePath}`);
  }
  if (content.length !== operation.originalBytes || sha256Bytes(content) !== operation.originalSha256) {
    throw new Error(`Repair target changed after planning: ${operation.relativePath}`);
  }
}

async function verifyRollbackBackups(snapshotRoot, operations) {
  for (const operation of operations) {
    if (!operation.existed) continue;
    const backup = boundedPath(snapshotRoot, operation.backup);
    let original;
    try {
      original = await readBoundedFile(backup, operation.originalBytes);
    } catch {
      throw new Error(`Rollback backup does not match repair preimage: ${operation.relativePath}`);
    }
    if (original.length !== operation.originalBytes || sha256Bytes(original) !== operation.originalSha256) {
      throw new Error(`Rollback backup does not match repair preimage: ${operation.relativePath}`);
    }
  }
}

async function captureTargetGuard(root, target) {
  const paths = [root];
  const offset = relative(root, dirname(target));
  let cursor = root;
  for (const part of offset.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    paths.push(cursor);
  }
  const identities = [];
  for (const path of paths) {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe repair parent directory: ${path}`);
    identities.push({ path, dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs });
  }
  return identities;
}

async function assertTargetGuard(guard) {
  for (const expected of guard) {
    const current = await lstat(expected.path);
    if (current.isSymbolicLink() || !current.isDirectory() || !sameFileIdentity(expected, current)) {
      throw new Error(`Repair parent directory identity changed: ${expected.path}`);
    }
  }
}

async function restoreWrittenTargets(repairRoot, snapshotRoot, written) {
  const errors = [];
  for (const operation of [...written].reverse()) {
    const target = boundedPath(repairRoot, operation.relativePath);
    try {
      await assertSafeTargetPath(repairRoot, target);
      const current = await readBoundedFile(target, operation.desiredBytes);
      if (current.length !== operation.desiredBytes || sha256Bytes(current) !== operation.desiredSha256) {
        throw new Error("Repair target changed after write; refusing to overwrite during rollback");
      }
      if (operation.existed) {
        const backup = boundedPath(snapshotRoot, operation.backup);
        const original = await readBoundedFile(backup, operation.originalBytes);
        if (sha256Bytes(original) !== operation.originalSha256) throw new Error("Rollback backup hash mismatch");
        await atomicWrite(target, original, operation.originalMode ?? 0o600);
      } else {
        await rm(target, { force: true });
      }
    } catch (error) {
      errors.push({
        relativePath: operation.relativePath,
        error: sanitizePersistedError(error, [repairRoot, snapshotRoot], 300),
      });
    }
  }
  return errors;
}

function assertSecretFreeText(value, label) {
  let text;
  try {
    text = typeof value === "string" ? value : UTF8_DECODER.decode(value);
  } catch {
    throw new Error(`${label} must be UTF-8 text`);
  }
  if (SECRET_PATTERN.test(text)) throw new Error(`${label} appears to contain credentials or authentication material`);
}

function boundedMessage(error, maximum) {
  const value = error instanceof Error ? error.message : String(error);
  const sanitized = value.replace(CONTROL_PATTERN, " ");
  return sanitized.length <= maximum ? sanitized : `${sanitized.slice(0, maximum)}…`;
}

function classifyProbeError(error) {
  const message = boundedMessage(error, 1_000);
  if (/symbolic link|junction/i.test(message)) return "Refusing symbolic link or junction in product artifact path";
  if (/byte limit|grew beyond/i.test(message)) return "Product artifact exceeds configured byte limit";
  if (/timed out|timeout/i.test(message)) return "Product version probe timed out";
  if (/regular file|non-regular/i.test(message)) return "Product artifact is not a regular file";
  if (/version probe|version command/i.test(message)) return "Product version probe failed";
  if (/JSON|UTF-8/i.test(message)) return "Product version metadata is malformed";
  return "Product inspection failed";
}

function sanitizePersistedError(error, roots, maximum = 500) {
  let message = boundedMessage(error, maximum * 2);
  for (const root of [...roots].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(root, "<product-local-root>");
  }
  const home = homedir();
  if (home) message = message.replaceAll(home, "<home>");
  return message.length <= maximum ? message : `${message.slice(0, maximum)}…`;
}

function normalizeInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Resolve a relative path under a canonical root and reject escapes. */
function boundedPath(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const target = resolve(root, normalized);
  const offset = relative(root, target);
  if (!offset || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error(`Path escapes product-local root: ${relativePath}`);
  }
  return target;
}

async function canonicalDirectoryRoot(value, options) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new TypeError("Directory root must be an absolute path");
  const path = resolve(value);
  await assertPathComponents(path, { allowMissing: options.create === true });
  if (options.create === true) await mkdir(path, { recursive: true, mode: 0o700 });
  await assertPathComponents(path, { allowMissing: false, requireFinalDirectory: true });
  const canonical = await realpath(path);
  const stats = await lstat(canonical);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Directory root is not a regular directory: ${path}`);
  return canonical;
}

async function assertPathComponents(path, options = {}) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    const stats = await safeLstat(cursor);
    if (!stats) {
      if (options.allowMissing === true) return;
      const error = new Error(`Path does not exist: ${cursor}`);
      error.code = "ENOENT";
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Refusing path through symbolic link or junction: ${cursor}`);
    const final = index === parts.length - 1;
    if ((!final || options.requireFinalDirectory) && !stats.isDirectory()) throw new Error(`Path component is not a directory: ${cursor}`);
  }
}

async function assertSafeTargetPath(root, target, options = {}) {
  const offset = relative(root, target);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("Target escapes approved root");
  const end = options.directoryTarget ? target : dirname(target);
  const parts = relative(root, end).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const stats = await safeLstat(cursor);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Refusing target path through symbolic link or junction: ${cursor}`);
    if (!stats.isDirectory()) throw new Error(`Target parent is not a directory: ${cursor}`);
  }
  const existing = await safeLstat(target);
  if (existing?.isSymbolicLink()) throw new Error(`Refusing symbolic-link target: ${target}`);
}

async function isSafeExistingRegularFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Artifact path must be absolute");
  try {
    await assertPathComponents(path, { allowMissing: false });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`Refusing symbolic-link artifact: ${path}`);
  if (!stats.isFile()) throw new Error(`Artifact is not a regular file: ${path}`);
  return true;
}

async function canonicalCommandPath(path) {
  const canonical = await realpath(resolve(path));
  await assertPathComponents(canonical, { allowMissing: false });
  const stats = await lstat(canonical);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Resolved command is not a regular file: ${canonical}`);
  return canonical;
}

async function fingerprintFile(path, maximum) {
  const { handle, size } = await openBoundedRegularFile(path, maximum);
  const hash = createHash("sha256");
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw new Error(`File grew beyond byte limit (${maximum}): ${path}`);
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== size) throw new Error(`File size changed during fingerprint: ${path}`);
    return { sha256: hash.digest("hex"), bytes: total };
  } finally {
    await handle.close();
  }
}

async function readBoundedFile(path, maximum) {
  const { handle } = await openBoundedRegularFile(path, maximum);
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximum) throw new Error(`File grew beyond byte limit (${maximum}): ${path}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

async function openBoundedRegularFile(path, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError("File byte limit must be a nonnegative safe integer");
  await assertPathComponents(path, { allowMissing: false });
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error(`Refusing to read symbolic link: ${path}`);
  if (!before.isFile()) throw new Error(`Refusing to read non-regular file: ${path}`);
  if (before.size > maximum) throw new Error(`File exceeds byte limit (${maximum}): ${path}`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    if (!opened.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw new Error(`File identity changed during safe open: ${path}`);
    }
    if (opened.size > maximum) throw new Error(`File exceeds byte limit (${maximum}): ${path}`);
    return { handle, size: opened.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameFileIdentity(left, right) {
  if (typeof left.ino === "bigint" || typeof right.ino === "bigint") return left.dev === right.dev && left.ino === right.ino;
  if (Number(left.ino) === 0 || Number(right.ino) === 0) return left.size === right.size && left.mtimeMs === right.mtimeMs;
  return left.dev === right.dev && left.ino === right.ino;
}

async function readOptionalJson(path, maximum) {
  try {
    return JSON.parse(UTF8_DECODER.decode(await readBoundedFile(path, maximum)));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readRequiredJson(path, maximum) {
  return JSON.parse(UTF8_DECODER.decode(await readBoundedFile(path, maximum)));
}

async function atomicJsonWrite(path, value, mode) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertSecretFreeText(text, `state file '${basename(path)}'`);
  return atomicWrite(path, text, mode);
}

async function atomicWrite(path, content, mode = 0o600, options = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertPathComponents(dirname(path), { allowMissing: false, requireFinalDirectory: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode).catch(() => undefined);
    const target = await safeLstat(path);
    if (target?.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${path}`);
    await options.beforeCommit?.();
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createExclusiveJson(path, value, mode) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  assertSecretFreeText(text, `state file '${basename(path)}'`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertPathComponents(dirname(path), { allowMissing: false, requireFinalDirectory: true });
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, mode);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode).catch(() => undefined);
}

async function safeLstat(path) {
  return lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
}

async function removeOwnedSnapshot(stateRoot, snapshotRoot) {
  const offset = relative(stateRoot, snapshotRoot);
  const parts = offset.split(sep).filter(Boolean);
  if (parts.length !== 2 || parts[0] !== ROLLBACK_DIRECTORY || !PLAN_ID_PATTERN.test(parts[1])) {
    throw new Error("Refusing to remove a snapshot outside the owned rollback path");
  }
  const stats = await safeLstat(snapshotRoot);
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Refusing to remove a non-directory rollback snapshot");
  await rm(snapshotRoot, { recursive: true, force: false });
}
