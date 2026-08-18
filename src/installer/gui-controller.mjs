import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyInstallerPlan, createInstallerPlan, previewInstallerPlan } from "./index.mjs";
import { ALL_COMPONENT_IDS, COMPONENT_IDS, EXPLICIT_ONLY_COMPONENT_IDS, OPTIONAL_COMPONENT_IDS, readInstalledVoiceConfig } from "./components.mjs";
import { DEFAULT_VOICE_PROFILE_ID, voicePresetCards } from "../core/voice-profiles.mjs";
import { InstallerRecoveryStore } from "./recovery-store.mjs";
import { notifyNativeOrigin } from "./origin-recovery.mjs";
import { relaunchUpdatedInstaller } from "./companion-launch.mjs";
import { InstallerStableUpdater } from "./update-check.mjs";
import { listHostSurfaces } from "../core/host-surfaces.mjs";
import { listCodexTaskGroups } from "../codex/tasks.mjs";
import { KeyedSerialQueue } from "../core/keyed-serial-queue.mjs";

const SESSION_TTL_MS = 2 * 60 * 60_000;
const HEARTBEAT_GRACE_MS = 45_000;
const notificationDeliveries = new KeyedSerialQueue();
const stableUpdateChecks = new KeyedSerialQueue();
const OFFER_AVAILABILITY = Object.freeze({
  "agentrouter-free": Object.freeze({ offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, requiresLiveCardlessCheck: true, lastLiveProbeDate: "2026-08-18" }),
  "mistral-api-free": Object.freeze({ offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, requiresLiveCardlessCheck: true, lastLiveProbeDate: null }),
  "groqcloud-free": Object.freeze({ offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, requiresLiveCardlessCheck: true, lastLiveProbeDate: null }),
  "cloudflare-workers-ai-free": Object.freeze({ offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, requiresLiveCardlessCheck: true, lastLiveProbeDate: null }),
  "gemini-api-free": Object.freeze({ offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, requiresLiveCardlessCheck: true, lastLiveProbeDate: null }),
});

export class InstallerGuiController {
  constructor(config, options = {}) {
    this.config = config;
    this.environment = options.environment ?? process.env;
    this.sessions = new Map();
    this.recovery = options.recoveryStore ?? new InstallerRecoveryStore({
      root: options.recoveryRoot ?? resolve(homedir(), ".threadspan", "state", "installer"),
    });
    this.listTasks = options.listTasks ?? (() => listCodexTaskGroups({ command: config.codex?.command ?? "codex" }));
    this.pauseTasks = options.pauseTasks;
    this.notifyOrigin = options.notifyOrigin ?? notifyNativeOrigin;
    this.browserPath = options.browserPath;
    this.stableUpdater = options.stableUpdater ?? new InstallerStableUpdater({
      currentRoot: fileURLToPath(new URL("../../", import.meta.url)),
      relaunch: options.relaunchUpdatedInstaller ?? relaunchUpdatedInstaller,
    });
    this.ready = this.#rehydrate();
    const weakController = new WeakRef(this);
    const timer = setInterval(() => {
      const controller = weakController.deref();
      if (controller) void controller.#sweep();
      else clearInterval(timer);
    }, 15_000);
    this.timer = timer;
    this.timer.unref?.();
  }

  dispose() {
    clearInterval(this.timer);
  }

  async createSession(input = {}) {
    await this.ready;
    const nonce = randomBytes(32).toString("base64url");
    const sessionId = `install-${randomBytes(12).toString("hex")}`;
    const installRoot = resolve(input.installRoot ?? resolve(homedir(), ".threadspan"));
    const origin = normalizeOrigin(input.origin);
    const now = Date.now();
    const session = {
      nonce,
      sessionId,
      installRoot,
      origin,
      createdAt: now,
      lastHeartbeatAt: now,
      state: "update-check",
      plan: null,
      closeIntent: null,
      cancelController: new AbortController(),
    };
    this.sessions.set(nonce, session);
    await this.recovery.create({ sessionId, origin });
    return {
      sessionId,
      url: `http://${this.config.server.host}:${this.config.server.port}/threadspan/install/#session=${encodeURIComponent(nonce)}`,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
  }

  authorize(nonce) {
    const session = this.sessions.get(String(nonce ?? ""));
    if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) throw new Error("Installer GUI session is missing or expired");
    return session;
  }

  async bootstrap(nonce, options = {}) {
    await this.ready;
    const session = this.authorize(nonce);
    session.lastHeartbeatAt = Date.now();
    const update = await this.#checkStableRelease(nonce, session, options.signal);
    throwIfSessionCancelled(session);
    if (update.status === "relaunching") {
      return {
        sessionId: session.sessionId,
        installRoot: session.installRoot,
        origin: session.origin,
        update,
        components: [],
        hostSurfaces: [],
        taskGroups: [],
        taskEvidence: { trusted: false, total: 0, active: 0, notLoaded: 0 },
        taskControl: { pauseSupported: false },
        defaults: [],
        usageEstimate: estimateInstallationUsage([]),
        rollback: { enabled: true, policy: "preimage-backup-and-manifest" },
        donation: { show: false },
      };
    }
    let taskGroups = [];
    let taskEvidence = { trusted: false, total: 0, active: 0, notLoaded: 0 };
    let taskInventoryError = null;
    try {
      const inventory = await this.listTasks();
      taskGroups = Array.isArray(inventory) ? inventory : inventory.groups ?? [];
      taskEvidence = Array.isArray(inventory) ? { trusted: true, total: taskGroups.length, active: taskGroups.flatMap((group) => group.tasks).length, notLoaded: 0 } : inventory.evidence ?? taskEvidence;
      if (!taskEvidence.trusted) taskInventoryError = `${taskEvidence.notLoaded} stored tasks are not loaded in this App Server; automatic protection is unavailable.`;
    } catch (error) { taskInventoryError = error instanceof Error ? error.message : String(error); }
    throwIfSessionCancelled(session);
    session.taskGroups = taskGroups;
    session.taskEvidence = taskEvidence;
    const installedVoice = readInstalledVoiceConfig(session.installRoot);
    const donation = { show: await this.recovery.claimDonation(session.sessionId) };
    throwIfSessionCancelled(session);
    return {
      sessionId: session.sessionId,
      installRoot: session.installRoot,
      origin: session.origin,
      update,
      components: componentPresentation(),
      hostSurfaces: listHostSurfaces(),
      taskGroups,
      taskEvidence,
      taskControl: { pauseSupported: typeof this.pauseTasks === "function" },
      taskInventoryError,
      defaults: defaultComponents(),
      voice: { selectedProfile: installedVoice.selectedProfile ?? DEFAULT_VOICE_PROFILE_ID, profiles: installedVoice.profiles, presets: voicePresetCards() },
      usageEstimate: estimateInstallationUsage(defaultComponents()),
      rollback: { enabled: true, policy: "preimage-backup-and-manifest" },
      donation,
    };
  }

  async plan(nonce, input) {
    await this.ready;
    const session = this.authorize(nonce);
    if (["applying", "complete", "cancelled", "update-relaunching"].includes(session.state)) throw new Error(`Installer session cannot plan while ${session.state}`);
    const selected = Array.isArray(input.components) ? input.components : defaultComponents();
    const plan = createInstallerPlan({
      installRoot: session.installRoot,
      selection: selected,
      longContextProfiles: input.longContextProfiles ?? [],
      ...(selected.includes("voice-profiles") ? { voice: input.voice ?? { selectedProfile: DEFAULT_VOICE_PROFILE_ID, profiles: [] } } : {}),
      planId: session.sessionId,
      environment: this.environment,
    });
    session.plan = plan;
    session.planIssuedAt = new Date().toISOString();
    const defaultTaskIds = (session.taskGroups ?? []).flatMap((group) => group.tasks.map((task) => task.id));
    session.taskProtection = normalizeTaskProtection(input.taskProtection ?? { taskIds: defaultTaskIds, disposition: "wait" }, session.taskGroups ?? []);
    session.taskReceipt = null;
    session.state = "planned";
    session.lastHeartbeatAt = Date.now();
    const recoveryRecord = await this.recovery.read(session.sessionId);
    await this.recovery.update(session.sessionId, {
      state: "planned",
      selectedComponents: plan.selectedComponents,
      planDigest: plan.digest,
      result: { ...(recoveryRecord.result ?? {}), taskProtection: null },
    });
    return { plan, preview: previewInstallerPlan(plan), usageEstimate: estimateInstallationUsage(plan.selectedComponents) };
  }

  async apply(nonce, input) {
    await this.ready;
    const session = this.authorize(nonce);
    if (session.state !== "planned") throw new Error(`Installer session cannot apply while ${session.state}`);
    if (!session.plan) throw new Error("Preview a plan before applying it");
    if (input.approvedDigest !== session.plan.digest) throw new Error("Approved digest does not match the previewed plan");
    const refreshedPlan = createInstallerPlan({
      installRoot: session.installRoot,
      selection: session.plan.selectedComponents,
      longContextProfiles: session.plan.selectedLongContextProfiles ?? [],
      ...(session.plan.voice ? { voice: session.plan.voice } : {}),
      planId: session.plan.planId,
      environment: this.environment,
    });
    if (refreshedPlan.digest !== session.plan.digest) {
      throw new Error("Installer targets or prerequisites changed after review; create and approve a fresh plan");
    }
    if (session.plan.hasChanges === false || session.plan.operations.length === 0) {
      const result = {
        status: session.plan.exclusions?.length > 0 ? "preserved" : "unchanged",
        planId: session.plan.planId,
        digest: session.plan.digest,
        written: [],
        unchanged: session.plan.unchanged ?? [],
        exclusions: session.plan.exclusions ?? [],
      };
      session.state = "complete";
      await this.recovery.update(session.sessionId, { state: "complete", result: sanitizeResult(result) });
      return result;
    }
    if (input.desktopClosureApproved !== true) throw new Error("Desktop closure approval is required before apply");
    const manualTaskFallback = session.taskEvidence?.trusted === false;
    if (manualTaskFallback && input.manualTaskConfirmation !== true) throw new Error("Task inventory is incomplete; manual task confirmation is required");
    if (!manualTaskFallback) assertTaskProtectionReceipt(session);
    session.state = "applying";
    await this.recovery.update(session.sessionId, { state: "applying" });
    try {
      const applied = await applyInstallerPlan(session.plan, { approvedDigest: input.approvedDigest, environment: this.environment });
      const result = { status: "applied", ...applied };
      session.state = "complete";
      await this.recovery.update(session.sessionId, { state: "complete", result: sanitizeResult(result) });
      return result;
    } catch (error) {
      session.state = "planned";
      await this.recovery.update(session.sessionId, { state: "planned" });
      throw error;
    }
  }

  async heartbeat(nonce) {
    await this.ready;
    const session = this.authorize(nonce);
    session.lastHeartbeatAt = Date.now();
    await this.recovery.update(session.sessionId, { lastHeartbeatAt: new Date().toISOString() });
    return { ok: true, state: session.state };
  }

  async close(nonce, intent) {
    await this.ready;
    const session = this.authorize(nonce);
    if (session.state === "complete") return { ok: true, intent: "complete" };
    if (session.closeIntent === "cancel" || session.state === "cancelled") return { ok: true, intent: "cancel" };
    if (intent === "cancel") {
      session.closeIntent = "cancel";
      session.state = "cancelled";
      session.cancelController.abort(new Error("Installer session was cancelled"));
      await this.recovery.update(session.sessionId, { state: "cancelled", closeIntent: "cancel" });
      return { ok: true, intent: "cancel" };
    }
    session.closeIntent = "relaunch";
    await this.recovery.update(session.sessionId, { state: session.state, closeIntent: session.closeIntent });
    if (session.closeIntent === "relaunch") await this.#notify(session);
    return { ok: true, intent: session.closeIntent };
  }

  async protect(nonce, input) {
    await this.ready;
    const session = this.authorize(nonce);
    if (!session.plan) throw new Error("Preview a plan before protecting tasks");
    if (session.state !== "planned") throw new Error(`Installer session cannot protect tasks while ${session.state}`);
    if (session.plan.hasChanges === false || session.plan.operations.length === 0) {
      return { sessionId: session.sessionId, planDigest: session.plan.digest, taskIds: [], disposition: "none", noChanges: true };
    }
    const protection = normalizeTaskProtection(input, session.taskGroups ?? []);
    let inventory;
    try {
      inventory = await this.listTasks();
    } catch {
      inventory = { groups: [], evidence: { trusted: false, total: 0, active: 0, notLoaded: 1 } };
    }
    const groups = Array.isArray(inventory) ? inventory : inventory.groups ?? [];
    const observedAt = new Date().toISOString();
    const nativeInventory = summarizeTaskInventory(inventory, groups, observedAt);
    session.taskEvidence = nativeInventory;
    if (!nativeInventory.trusted) {
      session.taskProtection = protection;
      session.taskReceipt = null;
      const manual = { sessionId: session.sessionId, planDigest: session.plan.digest, disposition: protection.disposition, taskIds: [...protection.taskIds], nativeInventory, manualConfirmationRequired: true };
      const recoveryRecord = await this.recovery.read(session.sessionId);
      await this.recovery.update(session.sessionId, { result: { ...(recoveryRecord.result ?? {}), taskProtection: manual } });
      return manual;
    }
    if (protection.disposition === "pause") {
      if (typeof this.pauseTasks !== "function") throw new Error("Native pause control is unavailable for this host session");
      await this.pauseTasks(protection.taskIds);
    }
    if (protection.disposition === "wait" && protection.taskIds.length > 0) {
      const active = new Set(groups.flatMap((group) => group.tasks.map((task) => task.id)));
      const remaining = protection.taskIds.filter((id) => active.has(id));
      if (remaining.length > 0) throw new Error(`${remaining.length} selected task(s) are still active`);
    }
    session.taskProtection = protection;
    session.taskReceipt = {
      sessionId: session.sessionId,
      planDigest: session.plan.digest,
      disposition: protection.disposition,
      taskIds: [...protection.taskIds],
      nativeInventory,
      issuedAt: observedAt,
    };
    const recoveryRecord = await this.recovery.read(session.sessionId);
    await this.recovery.update(session.sessionId, { result: { ...(recoveryRecord.result ?? {}), taskProtection: session.taskReceipt } });
    return session.taskReceipt;
  }

  async #sweep() {
    const now = Date.now();
    for (const [nonce, session] of this.sessions) {
      if (["complete", "cancelled"].includes(session.state)) {
        if (now - session.lastHeartbeatAt > SESSION_TTL_MS) this.sessions.delete(nonce);
        continue;
      }
      if ((session.closeIntent && session.closeIntent !== "unexpected") || now - session.lastHeartbeatAt <= HEARTBEAT_GRACE_MS) continue;
      session.closeIntent = "unexpected";
      session.state = "gui-lost";
      await this.#notify(session, { state: "gui-lost", closeIntent: "unexpected" });
    }
  }

  async #checkStableRelease(nonce, session, signal) {
    const key = `${this.recovery.root}\0${session.sessionId}`;
    const operationSignal = signal
      ? AbortSignal.any([signal, session.cancelController.signal])
      : session.cancelController.signal;
    return stableUpdateChecks.run(key, operationSignal, async () => {
      throwIfSessionCancelled(session);
      session.state = "update-check";
      await this.recovery.update(session.sessionId, { state: "update-check", lastHeartbeatAt: new Date().toISOString() });
      throwIfSessionCancelled(session);
      let result;
      try {
        result = await this.stableUpdater.checkAndUpdate({
          sessionId: session.sessionId,
          nonce,
          installRoot: session.installRoot,
          daemonBaseUrl: `http://${formatHost(this.config.server.host)}:${this.config.server.port}`,
          browserPath: this.browserPath,
          signal: operationSignal,
          ...(session.updateRoot ? { currentRoot: session.updateRoot } : {}),
        });
      } catch (error) {
        throwIfSessionCancelled(session);
        result = {
          status: "blocked",
          reason: "update-check-failed",
          canContinueCurrent: true,
          retryable: true,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      throwIfSessionCancelled(session);
      if (typeof result.preparedRoot === "string") session.updateRoot = resolve(result.preparedRoot);
      result = publicUpdateResult(result);
      const recoveryRecord = await this.recovery.read(session.sessionId);
      throwIfSessionCancelled(session);
      session.update = result;
      session.state = result.status === "relaunching" ? "update-relaunching" : "ready-current";
      await this.recovery.update(session.sessionId, {
        state: session.state,
        result: { ...(recoveryRecord.result ?? {}), stableUpdate: sanitizeUpdateResult(result) },
      });
      throwIfSessionCancelled(session);
      return result;
    });
  }

  async #notify(session, statePatch = {}) {
    if (session.origin?.kind === "direct") return { notified: false, kind: "direct", reason: "no-resumable-origin" };
    const key = `${this.recovery.root}\0${session.sessionId}`;
    return notificationDeliveries.run(key, undefined, async () => {
      const current = await this.recovery.read(session.sessionId);
      if (current.notificationSentAt) return current.result?.originNotification ?? { notified: true, kind: session.origin?.kind };
      const claimedAt = new Date().toISOString();
      await this.recovery.update(session.sessionId, { ...statePatch, notificationClaimedAt: claimedAt });
      let result;
      try {
        result = await this.notifyOrigin(session.origin, { cwd: session.origin.project ?? undefined, notificationId: session.sessionId });
      } catch (error) {
        result = { notified: false, error: error instanceof Error ? error.message : String(error) };
      }
      const notified = result?.notified === true;
      await this.recovery.update(session.sessionId, {
        result: { ...(current.result ?? {}), originNotification: result },
        notificationClaimedAt: notified ? claimedAt : null,
        notificationSentAt: notified ? new Date().toISOString() : null,
      });
      return result;
    });
  }

  async #rehydrate() {
    const records = await this.recovery.list();
    for (const record of records) {
      if (["complete", "cancelled"].includes(record.state) || record.origin?.kind === "direct" || record.notificationSentAt) continue;
      await this.#notify(record, { state: "gui-lost", closeIntent: "daemon-restart" });
    }
  }
}

function normalizeOrigin(value = {}) {
  const kind = ["codex", "grok", "cursor", "hermes", "direct"].includes(value.kind) ? value.kind : "direct";
  return { kind, id: value.id ? String(value.id) : null, project: value.project ? resolve(String(value.project)) : null };
}

function defaultComponents() {
  return COMPONENT_IDS.filter((id) => id !== "claude-code");
}

function componentPresentation() {
  const labels = {
    daemon: ["Core", "One daemon shared by every host."],
    cursor: ["Cursor", "Cursor CLI/SDK routes and MCP."],
    "grok-build": ["Grok", "Grok Build workers and MCP."],
    "claude-code": ["Claude Code", "Optional preview host; not live-certified."],
    "agentrouter-free": ["AgentRouter", "Optional Claude Code gateway; checked live before setup."],
    "mistral-api-free": ["Mistral API", "Optional API route; checked before setup."],
    "groqcloud-free": ["GroqCloud", "Optional API route; checked before setup."],
    "cloudflare-workers-ai-free": ["Cloudflare Workers AI", "Optional API route; checked before setup."],
    "gemini-api-free": ["Google Gemini API", "Optional API route; checked before setup."],
    nous: ["Nous", "Consult, Integrated, and bounded Delegate."],
    openrouter: ["OpenRouter", "Catalog and current free-model discovery."],
    "codex-native": ["Codex", "Native Codex routes and profiles."],
    "monitoring-fallback": ["Routing monitor", "Live availability, usage, and fallback."],
    "sidecar-ui": ["Companion HUD", "Picker, usage, routes, and status."],
    "installer-gui": ["Setup window", "Preview, install, verify, and roll back."],
    "host-surfaces": ["Host surfaces", "Codex, Grok, Cursor, and preview Hermes integrations."],
    "context-profiles": ["Context profiles", "Default, Spark, 600k, and 1M profiles."],
    continuity: ["Continuity", "Checkpoints and safe context rollover."],
    "compatibility-watch": ["Compatibility Watch", "Detect breakage, repair safely, and learn from fixes."],
    "voice-profiles": ["Voice", "Choose how Threadspan sounds and reports progress."],
    beads: ["Beads", "Optional issue tracking and continuous-work scheduling."],
    "project-bootstrap": ["Project bootstrap", "Optional policy, tests, tracking, and CI setup."],
    "maximum-utilization": ["Maximum utilization", "Optional near-limit Codex scheduling, gated by live quota."],
    tips: ["Tips", "Optional quiet hints; off by default."],
    "codex-full-access": ["Codex full access", "Optional Full Access: no command approval pauses or sandbox."],
  };
  return ALL_COMPONENT_IDS.map((id) => {
    const availability = OFFER_AVAILABILITY[id];
    const resolved = availability ? resolveOfferVisibility(availability) : undefined;
    return {
      id,
      label: labels[id][0],
      description: labels[id][1],
      optional: id === "claude-code" || OPTIONAL_COMPONENT_IDS.includes(id) || EXPLICIT_ONLY_COMPONENT_IDS.includes(id),
      ...(availability ? { ...availability, readiness: resolved.readiness, availabilityLabel: resolved.label, hidden: resolved.hidden } : {}),
    };
  }).filter((component) => component.hidden !== true);
}

/** Resolve volatile offer visibility from dated evidence without claiming current availability indefinitely. */
export function resolveOfferVisibility(policy, now = Date.now()) {
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(current)) throw new TypeError("now must be a Date or timestamp");
  const freshnessDays = Number(policy?.visibilityFreshnessDays);
  if (!Number.isFinite(freshnessDays) || freshnessDays <= 0) throw new TypeError("visibilityFreshnessDays must be positive");
  const probe = policy.lastLiveProbeDate ? Date.parse(`${policy.lastLiveProbeDate}T00:00:00Z`) : Number.NaN;
  const end = policy.offerEndDate ? Date.parse(`${policy.offerEndDate}T23:59:59.999Z`) : Number.NaN;
  const fresh = Number.isFinite(probe) && current >= probe && current - probe <= freshnessDays * 86_400_000;
  const afterEnd = Number.isFinite(end) && current > end;
  const freshAfterEnd = fresh && probe > end;
  if (afterEnd && !freshAfterEnd) return { hidden: true, readiness: "unavailable", label: "Offer ended — fresh proof required" };
  return fresh
    ? { hidden: false, readiness: "available", label: "Recently live-probed" }
    : { hidden: false, readiness: "unknown", label: "Check availability" };
}

function estimateInstallationUsage(components) {
  const providers = components.filter((id) => ["cursor", "grok-build", "nous", "openrouter", "claude-code", "agentrouter-free", "mistral-api-free", "groqcloud-free", "cloudflare-workers-ai-free", "gemini-api-free"].includes(id)).length;
  return {
    deterministicSetupTokens: 0,
    acceptanceModelTokens: { low: providers * 8_000, likely: providers * 28_000, high: providers * 75_000 },
    note: "Setup itself is deterministic. Model usage comes from optional live acceptance and repair work; provider-reported usage is reconciled when available.",
  };
}

function sanitizeResult(result) {
  return {
    status: result.status,
    manifestPath: result.manifestPath,
    written: result.written,
    unchanged: result.unchanged,
    exclusions: result.exclusions,
  };
}

function sanitizeUpdateResult(result) {
  return {
    status: result.status,
    reason: result.reason,
    currentVersion: result.currentVersion,
    latestVersion: result.latestVersion,
    sourceKind: result.sourceKind,
    releaseUrl: result.releaseUrl,
    canContinueCurrent: result.canContinueCurrent === true,
    retryable: result.retryable === true,
  };
}

function publicUpdateResult(result) {
  const { preparedRoot: _preparedRoot, ...safe } = result;
  return safe;
}

function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/** Keep explicit Cancel terminal across every asynchronous stable-check/bootstrap boundary. */
function throwIfSessionCancelled(session) {
  if (session.closeIntent === "cancel" || session.state === "cancelled") {
    throw session.cancelController?.signal.reason ?? new Error("Installer session was cancelled");
  }
}

function normalizeTaskProtection(value = {}, groups = []) {
  const known = new Set(groups.flatMap((group) => group.tasks.map((task) => task.id)));
  const taskIds = [...new Set(Array.isArray(value.taskIds) ? value.taskIds.map(String) : [])].sort();
  for (const id of taskIds) if (!known.has(id)) throw new Error(`Unknown task id '${id}'`);
  const disposition = value.disposition === "pause" ? "pause" : "wait";
  return { taskIds, disposition };
}

function summarizeTaskInventory(inventory, groups, observedAt) {
  const evidence = Array.isArray(inventory)
    ? { trusted: true, total: groups.length, active: groups.flatMap((group) => group.tasks).length, notLoaded: 0 }
    : inventory.evidence ?? {};
  return {
    observedAt,
    trusted: evidence.trusted === true,
    total: Number.isSafeInteger(evidence.total) ? evidence.total : groups.length,
    active: Number.isSafeInteger(evidence.active) ? evidence.active : groups.flatMap((group) => group.tasks).length,
    notLoaded: Number.isSafeInteger(evidence.notLoaded) ? evidence.notLoaded : 0,
  };
}

function assertTaskProtectionReceipt(session) {
  const protection = session.taskProtection ?? { taskIds: [], disposition: "wait" };
  if (protection.taskIds.length === 0) return;
  const receipt = session.taskReceipt;
  const taskIds = [...protection.taskIds].sort();
  const observedAt = Date.parse(receipt?.nativeInventory?.observedAt);
  const planIssuedAt = Date.parse(session.planIssuedAt);
  const valid = receipt
    && receipt.sessionId === session.sessionId
    && receipt.planDigest === session.plan.digest
    && receipt.disposition === protection.disposition
    && Array.isArray(receipt.taskIds)
    && receipt.taskIds.length === taskIds.length
    && receipt.taskIds.every((id, index) => id === taskIds[index])
    && receipt.nativeInventory?.trusted === true
    && Number.isFinite(observedAt)
    && Number.isFinite(planIssuedAt)
    && observedAt >= planIssuedAt
    && receipt.issuedAt === receipt.nativeInventory.observedAt;
  if (!valid) throw new Error("Selected tasks require a matching server-issued protection receipt for this session and plan");
}
