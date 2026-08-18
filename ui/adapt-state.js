/**
 * Threadspan sidecar state adapter.
 *
 * The static UI ships synthetic data. Live JSON from the local daemon can be
 * passed through `adaptThreadspanState` without changing render code.
 * Missing fields fail closed to explicit empty or error states.
 */
(function bindThreadspanState(root) {
  const MODES = ["consult", "integrated", "delegate"];
  const PICKER_PREFERENCE_SCHEMA_VERSION = 1;
  const PICKER_DEFAULT_FILTERS = Object.freeze({
    query: "",
    mode: "all",
    provider: "all",
    model: "all",
    freeOnly: false,
    favoritesOnly: false,
    showHiddenUnavailable: false,
  });
  const CREDIT_STATES = ["unknown", "normal", "low", "exhausted"];
  const EXPIRY_STATES = ["unknown", "current", "approaching", "expired"];

  const MODE_NOTES = {
    consult: "Secondary output is advisory. The primary agent owns judgment and execution.",
    integrated: "The calling client owns tools. The secondary is raw model inference.",
    delegate: "The secondary provider's agent owns a bounded execution task.",
  };

  const SYNTHETIC_STATE = {
    status: "ready",
    product: {
      name: "Threadspan",
      tagline: "One task. Every model.",
    },
    hud: {
      assumedInjection: false,
      placeholder:
        "Host agent status — documented Desktop HUD injection is not assumed. This sidecar can sit beneath a Codex/ChatGPT HUD when the host provides one.",
    },
    thread: {
      id: "thread_7f3a",
      title: "Characterize parser failures",
    },
    continuity: {
      enabled: true,
      controlEnabled: true,
      provider: "codex",
      evidence: "native-app-server",
      note: "The logical task stays visible while older generations remain nested.",
      capabilities: { rename: true, rollover: true, nativeChatListGrouping: false },
      tasks: [{
        handle: "demo-continuity-handle-01",
        title: "Characterize parser failures",
        project: "Threadspan",
        selected: true,
        enrolled: true,
        action: "Rollover",
        pendingRecovery: false,
        current: { generation: 3, status: "idle", goalStatus: "active" },
        generations: [
          { index: 1, role: "origin", label: "Origin task", status: "archived", archived: true },
          { index: 2, role: "previous", label: "Generation 2", status: "archived", archived: true },
          { index: 3, role: "current", label: "Current generation", status: "idle", archived: false },
        ],
      }],
    },
    actionItems: {
      schemaVersion: 1,
      total: 1,
      global: {
        count: 1,
        items: [{
          handle: "act_0123456789abcdef0123456789abcdef",
          projectKey: null,
          projectLabel: null,
          title: "Review the bounded owner action",
          summary: "Only actionable owner work appears here by default.",
          status: "open",
          revision: 1,
          createdAt: "2026-08-17T20:00:00.000Z",
          updatedAt: "2026-08-17T20:00:00.000Z",
          completedAt: null,
        }],
      },
      projects: [],
    },
    route: {
      id: "delegate/grok-build/grok-4.6",
      mode: "delegate",
      provider: "grok-build",
      accountId: "unknown/default",
      model: "grok-4.6",
      verified: true,
      verifiedAt: "2026-08-17T20:00:00Z",
      verificationSource: "offline capability matrix, not live entitlement",
    },
    pickerRoutes: [
      { id: "delegate/grok-build/grok-4.6", mode: "delegate", provider: "grok-build", model: "grok-4.6", availability: "available", reason: "Verified Delegate worker route." },
      { id: "consult/cursor-ultra/auto", mode: "consult", provider: "cursor-ultra", model: "auto", availability: "available", reason: "Advisory route on a disposable snapshot." },
      { id: "delegate/cursor-ultra/auto", mode: "delegate", provider: "cursor-ultra", model: "auto", availability: "available", reason: "Bounded repository worker route." },
      { id: "integrated/deepseek/deepseek-v4-pro", mode: "integrated", provider: "deepseek", model: "deepseek-v4-pro", availability: "available", reason: "Raw inference with caller-owned tools." },
      { id: "consult/deepseek/deepseek-v4-pro", mode: "consult", provider: "deepseek", model: "deepseek-v4-pro", availability: "available", reason: "Advisory reasoning route." },
      { id: "integrated/openrouter/free/model:free", mode: "integrated", provider: "openrouter", model: "free/model:free", free: true, availability: "available", reason: "Explicitly marked free by provider metadata." },
      { id: "delegate/claude-code/sonnet", mode: "delegate", provider: "claude-code", model: "sonnet", availability: "unavailable", setupReason: "Install and authenticate Claude Code before using this route." },
    ],
    accounts: { descriptors: [], accounts: [], combined: { eventCount: 0, inputTokens: 0, outputTokens: 0 } },
    quota: {
      label: "Consumer week remaining",
      percentRemaining: 62,
      note: "Manual meter. Local token telemetry cannot reconstruct provider weekly usage.",
    },
    forecast: {
      status: "rate-only",
      source: "sanitized-usage-ledger",
      evidenceClass: "live-provider",
      observedAt: "2026-08-17T20:00:00Z",
      windowMs: 21600000,
      sampleInterval: { start: "2026-08-17T14:00:00Z", end: "2026-08-17T20:00:00Z", durationMs: 21600000 },
      coverage: { ratio: 1, eventCount: 6, scannedEventCount: 6 },
      freshness: { status: "fresh", ageMs: 0 },
      confidence: { level: "high", reason: "recent samples span at least half the window" },
      burn: { unit: "turns", amount: 9, ratePerHour: 1.5, rateLabel: "1.5 turns/hour" },
      limitKnown: false,
      limitLabel: "limit unknown",
      entitlement: { allowance: null, remaining: null, resetAt: null, renewalAt: null, source: "not-observed", observedAt: null },
      exhaustion: null,
    },
    context: {
      usedTokens: 52428,
      windowTokens: 128000,
    },
    fallbacks: [
      {
        id: "consult/cursor-ultra/auto",
        mode: "consult",
        provider: "cursor-ultra",
        model: "auto",
        qualified: true,
        reason: "Advisory second opinion on a disposable snapshot. Not a Delegate substitute.",
      },
      {
        id: "integrated/deepseek/deepseek-v4-pro",
        mode: "integrated",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        qualified: true,
        reason: "Caller-owned tools with a raw model. Cursor SDK and Grok Build cannot be Integrated.",
      },
    ],
    checkpoint: {
      id: "ckpt_18f2",
      at: "2026-08-17T19:58:00Z",
      summary: "Admission reserved; worker not started.",
    },
    utilization: [
      {
        id: "grok-build",
        label: "Grok outer workers",
        used: 3,
        limit: 6,
        note: "Configurable fleet canary, not a provider guarantee.",
      },
      {
        id: "cursor",
        label: "Retained Cursor agents",
        used: 2,
        limit: 4,
        note: "Daemon-keyed local agents, not an official Cloud Agent pool.",
      },
    ],
    history: [
      {
        at: "2026-08-17T19:40:00Z",
        route: "consult/cursor-ultra/auto",
        mode: "consult",
        event: "consult-complete",
        verified: true,
      },
      {
        at: "2026-08-17T19:51:00Z",
        route: "delegate/grok-build/grok-4.6",
        mode: "delegate",
        event: "delegate-admit",
        verified: true,
      },
    ],
    reroute: {
      at: "2026-08-17T20:02:00Z",
      from: "delegate/grok-build/grok-4.6",
      to: "delegate/cursor-ultra/auto",
      actor: "operator",
      reason: "Quota policy. Threadspan does not apply automatic failover.",
    },
    filters: {
      mode: "delegate",
      verifiedOnly: true,
    },
    routeMap: {
      nodes: [
        { id: "grok", label: "Grok Build", intelligence: 92, availability: "available", modes: ["consult", "delegate"], specialties: ["coding", "research", "delegation"], usage: { requests: 8, failures: 0 } },
        { id: "cursor", label: "Cursor", intelligence: 90, availability: "available", modes: ["consult", "delegate"], specialties: ["repository", "coding", "delegation"], usage: { requests: 6, failures: 0 } },
        { id: "nous", label: "Nous", intelligence: 86, availability: "available", modes: ["consult", "integrated"], specialties: ["reasoning", "coding", "integrated"], usage: { requests: 4, failures: 0 } },
      ],
      edges: [
        { mode: "consult", provider: "cursor", priority: 1, weight: 0 },
        { mode: "integrated", provider: "nous", priority: 1, weight: 0 },
        { mode: "delegate", provider: "grok", priority: 1, weight: 0 },
      ],
    },
    compatibility: { status: "ok", changed: false, observedAt: "2026-08-17T20:00:00Z", products: [{ id: "codex-cli", label: "Codex CLI", status: "detected", version: "0.147.0" }], changes: [] },
    maximumUtilization: {
      phase: "disabled",
      readiness: "disabled",
      epoch: 0,
      quota: { usedRatio: null, observedAt: null, resetAt: null },
      counts: { protectedTasks: 0, notices: 0, inboxPending: 0, suspendedMonitors: 0, overruns: 0, provisionalOutputs: 0 },
      statuses: { pendingActions: 0, unsupportedActions: 0, executedActions: 0, manifest: "not-requested", fastCanary: "not-requested", recovery: "unconfirmed" },
      automatic: { enabled: false, active: false, scope: null },
      manual: { active: false, scope: null, manifestCount: 0 },
    },
    automaticTakeover: { phase: "idle", counts: { targets: 1, monitors: 1, queued: 0, active: 1, unsupported: 0, blocked: 0 }, monitors: [{ handle: "monitor_demo000000000000000001", phase: "replacement-active" }] },
  };

  /**
   * @param {unknown} value
   * @returns {value is Record<string, any>}
   */
  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * @param {unknown} value
   * @returns {string}
   */
  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function safeProviderUrl(value) {
    const candidate = text(value);
    if (!candidate || candidate.length > 2048 || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  /** Normalize reviewed provider web metadata without deriving URLs or account state. */
  function normalizeProviderWebMetadata(raw) {
    const source = isObject(raw) ? raw : {};
    const metadata = isObject(source.metadata) ? source.metadata : {};
    const links = isObject(source.providerLinks) ? source.providerLinks
      : isObject(metadata.providerLinks) ? metadata.providerLinks
        : {};
    const pick = (key) => source[key] ?? links[key] ?? metadata[key];
    const credit = text(pick("creditState")).toLowerCase();
    const expiry = text(pick("expiryState")).toLowerCase();
    return {
      providerLinks: {
        officialUrl: safeProviderUrl(pick("officialUrl")),
        accountUrl: safeProviderUrl(pick("accountUrl")),
        usageUrl: safeProviderUrl(pick("usageUrl")),
      },
      creditState: CREDIT_STATES.includes(credit) ? credit : "unknown",
      expiryState: EXPIRY_STATES.includes(expiry) ? expiry : "unknown",
    };
  }

  /**
   * @param {unknown} value
   * @param {number} fallback
   * @returns {number | null}
   */
  function finiteNumber(value, fallback = null) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value == null) return fallback;
    return null;
  }

  /**
   * @param {string} routeId
   * @returns {{mode: string, provider: string, accountId: string, model: string}}
   */
  function parseRouteId(routeId) {
    const parts = routeId.split("/");
    const accountId = parts[2]?.startsWith("@") ? parts[2].slice(1) : "";
    return {
      mode: text(parts[0]).toLowerCase(),
      provider: text(parts[1]),
      accountId,
      model: parts.slice(accountId ? 3 : 2).join("/") || "",
    };
  }

  /**
   * @param {unknown} raw
   * @returns {Record<string, any>}
   */
  function adaptFallback(raw) {
    if (!isObject(raw)) return null;
    const id = text(raw.id);
    if (!id) return null;
    const parsed = parseRouteId(id);
    const mode = text(raw.mode).toLowerCase() || parsed.mode;
    return {
      id,
      mode: MODES.includes(mode) ? mode : "",
      provider: text(raw.provider) || parsed.provider,
      model: text(raw.model) || parsed.model,
      qualified: raw.qualified === true,
      reason: text(raw.reason) || "Qualification reason not supplied.",
      ...normalizeProviderWebMetadata(raw),
    };
  }

  /**
   * Normalize live or synthetic JSON into a render model.
   * @param {unknown} raw Incoming JSON-like state.
   * @returns {{status: string, message: string, product: object, hud: object, thread: object, route: object | null, quota: object | null, context: object | null, fallbacks: object[], checkpoint: object | null, utilization: object[], history: object[], reroute: object | null, filters: object, modeNote: string}}
   */
  function adaptThreadspanState(raw) {
    if (raw == null) {
      return emptyModel("No route state is available.");
    }
    if (!isObject(raw)) {
      return errorModel("State is not a JSON object.");
    }
    if (text(raw.status).toLowerCase() === "error") {
      return errorModel(text(raw.message) || "Provider state could not be read.");
    }
    if (text(raw.status).toLowerCase() === "loading") {
      const loading = emptyModel("Loading route…");
      loading.status = "loading";
      loading.product = productOf(raw);
      loading.hud = hudOf(raw);
      return loading;
    }

    const route = adaptRoute(raw.route);
    if (!route) {
      const empty = emptyModel("No current route is published.");
      empty.product = productOf(raw);
      empty.hud = hudOf(raw);
      empty.thread = threadOf(raw);
      return empty;
    }

    const fallbacks = Array.isArray(raw.fallbacks)
      ? raw.fallbacks.map(adaptFallback).filter(Boolean).slice(0, 2)
      : [];

    const filters = isObject(raw.filters) ? raw.filters : {};
    const filterMode = text(filters.mode).toLowerCase();
    const routeMap = adaptRouteMap(raw.routeMap);

    return {
      status: "ready",
      message: "",
      product: productOf(raw),
      hud: hudOf(raw),
      thread: threadOf(raw),
      route,
      accounts: adaptAccounts(raw.accounts, route),
      quota: adaptQuota(raw.quota),
      forecast: adaptForecast(raw.forecast),
      context: adaptContext(raw.context),
      fallbacks,
      checkpoint: adaptCheckpoint(raw.checkpoint),
      continuity: adaptContinuity(raw.continuity),
      actionItems: adaptActionItems(raw.actionItems),
      utilization: adaptUtilization(raw.utilization),
      history: adaptHistory(raw.history),
      reroute: adaptReroute(raw.reroute),
      filters: {
        mode: MODES.includes(filterMode) ? filterMode : "all",
        verifiedOnly: filters.verifiedOnly === true,
      },
      modeNote: MODE_NOTES[route.mode] || "Mode authority is unspecified.",
      routeMap,
      pickerRoutes: adaptPickerRoutes(raw.pickerRoutes ?? raw.routes, route, fallbacks, routeMap),
      compatibility: adaptCompatibility(raw.compatibility),
      maximumUtilization: adaptMaximumUtilization(raw.maximumUtilization),
      automaticTakeover: adaptAutomaticTakeover(raw.automaticTakeover),
      copyCheck: adaptCopyCheck(raw.copyCheck),
    };
  }

  /**
   * @param {unknown} raw
   */
  function productOf(raw) {
    const product = isObject(raw) && isObject(raw.product) ? raw.product : {};
    return {
      name: text(product.name) || "Threadspan",
      tagline: text(product.tagline) || "One task. Every model.",
    };
  }

  /**
   * @param {unknown} raw
   */
  function hudOf(raw) {
    const hud = isObject(raw) && isObject(raw.hud) ? raw.hud : {};
    return {
      assumedInjection: hud.assumedInjection === true,
      placeholder: text(hud.placeholder) ||
        "Host agent status — documented Desktop HUD injection is not assumed.",
    };
  }

  /**
   * @param {unknown} raw
   */
  function threadOf(raw) {
    const thread = isObject(raw) && isObject(raw.thread) ? raw.thread : {};
    return {
      id: text(thread.id),
      title: text(thread.title),
    };
  }

  /**
   * @param {unknown} raw
   */
  function adaptRoute(raw) {
    if (!isObject(raw)) return null;
    const id = text(raw.id);
    if (!id) return null;
    const parsed = parseRouteId(id);
    const mode = text(raw.mode).toLowerCase() || parsed.mode;
    if (!MODES.includes(mode)) return null;
    return {
      id,
      mode,
      provider: text(raw.provider) || parsed.provider || "unspecified",
      accountId: text(raw.accountId) || parsed.accountId || "unknown/default",
      model: text(raw.model) || parsed.model || "unspecified",
      verified: raw.verified === true,
      verifiedAt: text(raw.verifiedAt),
      verificationSource: text(raw.verificationSource) || "Unspecified source.",
      ...normalizeProviderWebMetadata(raw),
    };
  }

  /**
   * @param {unknown} raw
   */
  function adaptQuota(raw) {
    if (!isObject(raw)) return null;
    const percentRemaining = finiteNumber(raw.percentRemaining);
    const allowance = nonNegativeNumber(raw.allowance);
    const remaining = nonNegativeNumber(raw.remaining);
    const resetAt = timestamp(raw.resetAt);
    const renewalAt = timestamp(raw.renewalAt);
    if (percentRemaining == null && allowance == null && remaining == null && !resetAt && !renewalAt) return null;
    const derivedPercent = percentRemaining ?? (allowance && remaining != null ? (remaining / allowance) * 100 : null);
    return {
      label: text(raw.label) || "Quota remaining",
      percentRemaining: derivedPercent == null ? null : Math.max(0, Math.min(100, Math.round(derivedPercent))),
      allowance,
      remaining,
      unit: boundedText(raw.unit, 40) || "units",
      resetAt,
      renewalAt,
      source: boundedText(raw.source, 120) || "unspecified",
      observedAt: timestamp(raw.observedAt),
      note: text(raw.note) || "Quota source is unspecified.",
    };
  }

  /** Keep forecast evidence closed and separate from authoritative quota facts. */
  function adaptForecast(raw) {
    if (!isObject(raw)) return null;
    const burn = isObject(raw.burn) ? raw.burn : {};
    const confidence = isObject(raw.confidence) ? raw.confidence : {};
    const coverage = isObject(raw.coverage) ? raw.coverage : {};
    const freshness = isObject(raw.freshness) ? raw.freshness : {};
    const sample = isObject(raw.sampleInterval) ? raw.sampleInterval : {};
    const entitlement = isObject(raw.entitlement) ? raw.entitlement : {};
    const exhaustion = isObject(raw.exhaustion) ? raw.exhaustion : null;
    const unit = boundedText(burn.unit, 40) || "units";
    const ratePerHour = nonNegativeNumber(burn.ratePerHour);
    const amount = nonNegativeNumber(burn.amount);
    const eventCount = nonNegativeNumber(coverage.eventCount);
    const scannedEventCount = nonNegativeNumber(coverage.scannedEventCount);
    const ratio = finiteNumber(coverage.ratio);
    return {
      status: boundedText(raw.status, 40) || "unknown",
      source: boundedText(raw.source, 120) || "unknown",
      evidenceClass: boundedText(raw.evidenceClass, 80) || null,
      observedAt: timestamp(raw.observedAt),
      windowMs: nonNegativeNumber(raw.windowMs),
      sampleInterval: { start: timestamp(sample.start), end: timestamp(sample.end), durationMs: nonNegativeNumber(sample.durationMs) },
      coverage: { ratio: ratio == null ? null : Math.max(0, Math.min(1, ratio)), eventCount, scannedEventCount },
      freshness: { status: boundedText(freshness.status, 40) || "unknown", ageMs: nonNegativeNumber(freshness.ageMs) },
      confidence: { level: boundedText(confidence.level, 40) || "unknown", reason: boundedText(confidence.reason, 240) || "No confidence reason supplied." },
      burn: { unit, amount, ratePerHour, rateLabel: ratePerHour == null ? "rate unknown" : `${formatRoundedNumber(ratePerHour)} ${unit}/hour` },
      limitKnown: raw.limitKnown === true,
      limitLabel: raw.limitKnown === true ? "authoritative limit snapshot" : "limit unknown",
      entitlement: {
        allowance: nonNegativeNumber(entitlement.allowance), remaining: nonNegativeNumber(entitlement.remaining),
        resetAt: timestamp(entitlement.resetAt), renewalAt: timestamp(entitlement.renewalAt),
        source: boundedText(entitlement.source, 120) || "not-observed", observedAt: timestamp(entitlement.observedAt),
      },
      exhaustion: exhaustion ? {
        earliestAt: timestamp(exhaustion.earliestAt), latestAt: timestamp(exhaustion.latestAt),
        label: boundedText(exhaustion.label, 80) || "range unknown", relation: boundedText(exhaustion.relation, 80) || "reset-or-renewal-unknown",
      } : null,
    };
  }

  function nonNegativeNumber(value) {
    const number = finiteNumber(value);
    return number != null && number >= 0 ? number : null;
  }

  function timestamp(value) {
    const candidate = text(value);
    if (!candidate) return "";
    const date = new Date(candidate);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
  }

  function boundedText(value, maximum) {
    return text(value).slice(0, maximum);
  }

  function formatRoundedNumber(value) {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }

  /**
   * @param {unknown} raw
   */
  function adaptContext(raw) {
    if (!isObject(raw)) return null;
    const usedTokens = finiteNumber(raw.usedTokens);
    const windowTokens = finiteNumber(raw.windowTokens);
    if (usedTokens == null || windowTokens == null || windowTokens <= 0) return null;
    const percentUsed = Math.max(0, Math.min(100, Math.round((usedTokens / windowTokens) * 100)));
    return { usedTokens, windowTokens, percentUsed };
  }

  /**
   * @param {unknown} raw
   */
  function adaptCheckpoint(raw) {
    if (!isObject(raw)) return null;
    const id = text(raw.id);
    if (!id) return null;
    return {
      id,
      at: text(raw.at),
      summary: text(raw.summary) || "No checkpoint summary.",
    };
  }

  /** Keep native task and Goal identifiers server-side; accept only opaque handles and bounded labels. */
  function adaptContinuity(raw) {
    if (!isObject(raw) || raw.enabled !== true) return { enabled: false, controlEnabled: false, tasks: [], reason: boundedText(raw?.reason, 160) || "disabled" };
    const tasks = Array.isArray(raw.tasks) ? raw.tasks.slice(0, 200).map((task) => {
      if (!isObject(task) || !/^[A-Za-z0-9-]{16,80}$/.test(text(task.handle))) return null;
      const generations = Array.isArray(task.generations) ? task.generations.slice(0, 128).map((generation) => {
        if (!isObject(generation)) return null;
        const role = ["origin", "current", "previous", "prepared"].includes(text(generation.role)) ? text(generation.role) : "previous";
        return {
          index: Math.max(1, Math.trunc(finiteNumber(generation.index, 1))),
          role,
          label: boundedText(generation.label, 120) || `Generation ${generation.index ?? ""}`.trim(),
          status: boundedText(generation.status, 40) || "unknown",
          archived: generation.archived === true,
        };
      }).filter(Boolean) : [];
      const recoverySource = isObject(task.pendingRecovery) ? task.pendingRecovery : isObject(task.recovery) ? task.recovery : {};
      const pendingRecovery = task.pendingRecovery === true || isObject(task.pendingRecovery) || recoverySource.active === true;
      return {
        handle: text(task.handle),
        title: boundedText(task.title, 120) || "Untitled task",
        project: boundedText(task.project, 120) || "Unknown project",
        selected: task.selected === true,
        enrolled: task.enrolled === true,
        action: ["Promote", "Rollover", "Pending"].includes(text(task.action)) ? text(task.action) : "Promote",
        pendingRecovery,
        recovery: {
          phase: boundedText(recoverySource.phase, 80),
          blocker: boundedText(recoverySource.blocker, 160),
          action: boundedText(recoverySource.action, 120) || (pendingRecovery ? "Await native Continuity supervisor" : ""),
        },
        current: {
          generation: Math.max(1, Math.trunc(finiteNumber(task.current?.generation, generations.length || 1))),
          status: boundedText(task.current?.status, 40) || "unknown",
          goalStatus: boundedText(task.current?.goalStatus, 40) || "none",
        },
        generations,
      };
    }).filter(Boolean) : [];
    return {
      enabled: true,
      controlEnabled: raw.controlEnabled === true,
      provider: boundedText(raw.provider, 40) || "unknown",
      evidence: boundedText(raw.evidence, 80) || "unknown",
      note: boundedText(raw.note, 240),
      capabilities: {
        rename: raw.capabilities?.rename === true,
        rollover: raw.capabilities?.rollover === true,
        nativeChatListGrouping: raw.capabilities?.nativeChatListGrouping === true,
      },
      tasks,
    };
  }

  /** Strictly project the closed public action-item schema and reject private-key contamination. */
  function adaptActionItems(raw) {
    const empty = { schemaVersion: 1, total: 0, global: { count: 0, items: [] }, projects: [] };
    if (!isObject(raw) || raw.schemaVersion !== 1 || containsPrivateActionItemKey(raw)) return empty;
    if (!hasOnlyKeys(raw, ["schemaVersion", "total", "global", "projects"])) return empty;
    const global = isObject(raw.global) && hasOnlyKeys(raw.global, ["count", "items"]) && Array.isArray(raw.global.items)
      ? raw.global.items.slice(0, 100).map((item) => adaptActionItem(item, null, null)).filter(Boolean)
      : [];
    const projects = Array.isArray(raw.projects) ? raw.projects.slice(0, 100).flatMap((project) => {
      if (!isObject(project) || !hasOnlyKeys(project, ["key", "label", "count", "items"]) || !Array.isArray(project.items)) return [];
      const key = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(text(project.key)) ? text(project.key) : "";
      const label = boundedText(project.label, 120);
      if (!key || !label) return [];
      const items = project.items.slice(0, 100).map((item) => adaptActionItem(item, key, label)).filter(Boolean);
      return [{ key, label, count: items.length, items }];
    }) : [];
    const returned = global.length + projects.reduce((sum, project) => sum + project.items.length, 0);
    return {
      schemaVersion: 1,
      total: Math.min(1_000, Math.max(returned, Number.isSafeInteger(raw.total) && raw.total >= 0 ? raw.total : 0)),
      global: { count: global.length, items: global },
      projects,
    };
  }

  function adaptActionItem(raw, projectKey, projectLabel) {
    const allowed = ["handle", "projectKey", "projectLabel", "title", "summary", "status", "revision", "createdAt", "updatedAt", "completedAt"];
    if (!isObject(raw) || !hasOnlyKeys(raw, allowed)) return null;
    const handle = /^act_[0-9a-f]{32}$/.test(text(raw.handle)) ? text(raw.handle) : "";
    const status = ["open", "completed", "stale", "closed"].includes(text(raw.status)) ? text(raw.status) : "";
    const revision = Number.isSafeInteger(raw.revision) && raw.revision > 0 ? raw.revision : 0;
    const title = boundedText(raw.title, 240);
    const summary = raw.summary === null ? null : boundedText(raw.summary, 2_000);
    const createdAt = canonicalActionItemTime(raw.createdAt);
    const updatedAt = canonicalActionItemTime(raw.updatedAt);
    const completedAt = raw.completedAt === null ? null : canonicalActionItemTime(raw.completedAt);
    if (!handle || !status || !revision || !title || summary === "" || !createdAt || !updatedAt || completedAt === "") return null;
    return { handle, projectKey, projectLabel, title, summary, status, revision, createdAt, updatedAt, completedAt };
  }

  function containsPrivateActionItemKey(value) {
    if (Array.isArray(value)) return value.some(containsPrivateActionItemKey);
    if (!isObject(value)) return false;
    const forbidden = /^(?:ownerRef|nativeId|sourceRevision|path|paths|prompt|prompts|note|idempotencyKey|eventId|claimToken|deliveryRef|receiptId)$/i;
    return Object.entries(value).some(([key, child]) => forbidden.test(key) || containsPrivateActionItemKey(child));
  }

  function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
  }

  function canonicalActionItemTime(value) {
    if (typeof value !== "string") return "";
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : "";
  }

  /**
   * @param {unknown} raw
   */
  function adaptUtilization(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => {
      if (!isObject(row)) return null;
      const used = finiteNumber(row.used);
      const limit = finiteNumber(row.limit);
      if (used == null || limit == null || limit < 0) return null;
      return {
        id: text(row.id) || text(row.label) || "provider",
        label: text(row.label) || text(row.id) || "Provider",
        used,
        limit,
        note: text(row.note) || "Canary value, not a service guarantee.",
      };
    }).filter(Boolean);
  }

  /**
   * @param {unknown} raw
   */
  function adaptHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => {
      if (!isObject(row)) return null;
      const route = text(row.route);
      if (!route) return null;
      const parsed = parseRouteId(route);
      return {
        at: text(row.at),
        route,
        accountId: text(row.accountId) || parsed.accountId || "unknown/default",
        mode: text(row.mode).toLowerCase() || parsed.mode,
        event: text(row.event) || "event",
        verified: row.verified === true,
      };
    }).filter(Boolean);
  }

  /**
   * @param {unknown} raw
   */
  function adaptReroute(raw) {
    if (!isObject(raw)) return null;
    const from = text(raw.from);
    const to = text(raw.to);
    if (!from || !to) return null;
    return {
      at: text(raw.at),
      from,
      to,
      actor: text(raw.actor) || "operator",
      reason: text(raw.reason) || "Explicit reroute. Not automatic failover.",
    };
  }

  /**
   * @param {string} message
   */
  function emptyModel(message) {
    return {
      status: "empty",
      message,
      product: productOf(null),
      hud: hudOf(null),
      thread: { id: "", title: "" },
      route: null,
      accounts: { descriptors: [], accounts: [], active: null, combined: emptyTotals() },
      quota: null,
      forecast: null,
      context: null,
      fallbacks: [],
      checkpoint: null,
      continuity: { enabled: false, controlEnabled: false, tasks: [], reason: "disabled" },
      actionItems: { schemaVersion: 1, total: 0, global: { count: 0, items: [] }, projects: [] },
      utilization: [],
      history: [],
      reroute: null,
      filters: { mode: "all", verifiedOnly: false },
      modeNote: "",
      routeMap: { nodes: [], edges: [] },
      pickerRoutes: [],
      compatibility: { status: "disabled", changed: false, products: [], changes: [] },
      maximumUtilization: null,
      automaticTakeover: { phase: "disabled", counts: { targets: 0, monitors: 0, queued: 0, active: 0, unsupported: 0, blocked: 0 }, monitors: [] },
    };
  }

  /**
   * @param {string} message
   */
  function errorModel(message) {
    const model = emptyModel(message);
    model.status = "error";
    return model;
  }

  function adaptRouteMap(raw) {
    if (!isObject(raw)) return { nodes: [], edges: [] };
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((node) => {
      if (!isObject(node) || !text(node.id)) return null;
      return {
        id: text(node.id),
        accountId: text(node.accountId) || "unknown/default",
        label: text(node.label) || text(node.id),
        intelligence: Math.max(1, Math.min(100, finiteNumber(node.intelligence, 50))),
        availability: text(node.availability) || "unknown",
        hidden: node.hidden === true || text(node.visibility).toLowerCase() === "hide",
        unavailabilityReason: boundedText(node.unavailabilityReason ?? node.reason, 240),
        capabilityReason: boundedText(node.capabilityReason, 240),
        setupReason: boundedText(node.setupReason, 240),
        ...normalizeProviderWebMetadata(node),
        modes: Array.isArray(node.modes) ? node.modes.map((mode) => text(mode).toLowerCase()).filter((mode) => MODES.includes(mode)) : [],
        models: adaptPickerModels(node.models),
        specialties: Array.isArray(node.specialties) ? node.specialties.map(text).filter(Boolean).slice(0, 6) : [],
        usage: isObject(node.usage) ? { requests: finiteNumber(node.usage.requests, 0), failures: finiteNumber(node.usage.failures, 0) } : { requests: 0, failures: 0 },
      };
    }).filter(Boolean) : [];
    const edges = Array.isArray(raw.edges) ? raw.edges.map((edge) => {
      if (!isObject(edge) || !text(edge.provider)) return null;
      const mode = text(edge.mode).toLowerCase();
      if (!MODES.includes(mode)) return null;
      const components = isObject(edge.scoreComponents) ? edge.scoreComponents : {};
      return {
        mode,
        provider: text(edge.provider),
        priority: finiteNumber(edge.priority, 0),
        weight: finiteNumber(edge.weight, 0),
        score: finiteNumber(edge.score, finiteNumber(edge.weight, 0)),
        scoreComponents: {
          preference: finiteNumber(components.preference, 0),
          healthPenalty: finiteNumber(components.healthPenalty, 0),
          failurePenalty: finiteNumber(components.failurePenalty, 0),
          balancePenalty: finiteNumber(components.balancePenalty, 0),
          modeBias: finiteNumber(components.modeBias, 0),
        },
        tieBreak: isObject(edge.tieBreak) && edge.tieBreak.field === "provider"
          ? { field: "provider", value: boundedText(edge.tieBreak.value, 120) }
          : null,
      };
    }).filter(Boolean) : [];
    return { nodes, edges };
  }

  function adaptCompatibility(raw) {
    if (!isObject(raw)) return { status: "disabled", changed: false, products: [], changes: [] };
    const changeKinds = new Set(["baseline", "changed", "removed"]);
    return {
      status: text(raw.status) || "unknown",
      changed: raw.changed === true,
      observedAt: text(raw.observedAt),
      products: Array.isArray(raw.products) ? raw.products.map((product) => isObject(product) && text(product.id) ? { id: text(product.id), label: text(product.label) || text(product.id), status: text(product.status) || "unknown", version: text(product.version) } : null).filter(Boolean).slice(0, 12) : [],
      changes: Array.isArray(raw.changes) ? raw.changes.slice(0, 20).flatMap((change) => {
        if (!isObject(change) || !text(change.productId) || !changeKinds.has(text(change.kind))) return [];
        return [{ productId: boundedText(change.productId, 80), kind: text(change.kind) }];
      }) : [],
    };
  }

  function adaptCopyCheck(raw) {
    const policy = isObject(raw) ? raw : {};
    const modes = ["off", "ask-every-time", "allow-manual-or-release"];
    const adapters = isObject(policy.adapters) ? policy.adapters : {};
    return {
      permissionMode: modes.includes(text(policy.permissionMode)) ? text(policy.permissionMode) : "off",
      enabled: policy.enabled === true,
      maxInputChars: nonNegativeNumber(policy.maxInputChars) ?? 12000,
      disclaimer: boundedText(policy.disclaimer, 400),
      partnership: policy.partnership === true,
      partnershipNote: boundedText(policy.partnershipNote, 400),
      lastResults: Array.isArray(policy.lastResults)
        ? policy.lastResults.filter(isObject).slice(0, 8).map((item) => ({
          adapter: boundedText(item.adapter, 32),
          status: boundedText(item.status, 32),
          score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
          checkedAt: timestamp(item.checkedAt),
          displayText: boundedText(item.displayText, 240),
        }))
        : [],
      adapters: Object.fromEntries(["pangram", "sapling", "winston", "gptzero", "copyleaks"].map((id) => {
        const item = isObject(adapters[id]) ? adapters[id] : {};
        return [id, {
          id,
          configured: item.configured === true,
          runnable: item.runnable === true,
          destination: boundedText(item.destination, 200),
          officialUrl: safeProviderUrl(item.officialUrl),
          advertisedAsWorkingFreeApi: item.advertisedAsWorkingFreeApi === true,
        }];
      })),
    };
  }

  function adaptMaximumUtilization(raw) {
    if (!isObject(raw)) return null;
    const phases = ["disabled", "idle", "maximum-utilization", "exhausted"];
    const readiness = ["disabled", "awaiting-native-quota", "native-quota-observed", "direct-exhaustion-observed", "active", "awaiting-exact-native-recovery", "native-recovery-confirmed", "owner-disabled"];
    const quota = isObject(raw.quota) ? raw.quota : {};
    const counts = isObject(raw.counts) ? raw.counts : {};
    const statuses = isObject(raw.statuses) ? raw.statuses : {};
    const automatic = isObject(raw.automatic) ? raw.automatic : {};
    const automaticScope = isObject(automatic.scope) ? automatic.scope : null;
    const manual = isObject(raw.manual) ? raw.manual : {};
    const manualScope = isObject(manual.scope) ? manual.scope : null;
    return {
      phase: phases.includes(text(raw.phase)) ? text(raw.phase) : "idle",
      readiness: readiness.includes(text(raw.readiness)) ? text(raw.readiness) : "awaiting-native-quota",
      epoch: nonNegativeNumber(raw.epoch) ?? 0,
      quota: { usedRatio: finiteRatio(quota.usedRatio), observedAt: timestamp(quota.observedAt), resetAt: timestamp(quota.resetAt) },
      counts: {
        protectedTasks: nonNegativeNumber(counts.protectedTasks) ?? 0,
        notices: nonNegativeNumber(counts.notices) ?? 0,
        inboxPending: nonNegativeNumber(counts.inboxPending) ?? 0,
        suspendedMonitors: nonNegativeNumber(counts.suspendedMonitors) ?? 0,
        overruns: nonNegativeNumber(counts.overruns) ?? 0,
        provisionalOutputs: nonNegativeNumber(counts.provisionalOutputs) ?? 0,
      },
      statuses: {
        pendingActions: nonNegativeNumber(statuses.pendingActions) ?? 0,
        unsupportedActions: nonNegativeNumber(statuses.unsupportedActions) ?? 0,
        executedActions: nonNegativeNumber(statuses.executedActions) ?? 0,
        manifest: statuses.manifest === "requested" ? "requested" : "not-requested",
        fastCanary: statuses.fastCanary === "requested" ? "requested" : "not-requested",
        recovery: statuses.recovery === "confirmed" ? "confirmed" : "unconfirmed",
      },
      automatic: {
        enabled: automatic.enabled === true,
        active: automatic.active === true,
        scope: automaticScope ? {
          provider: boundedText(automaticScope.provider, 80),
          account: boundedText(automaticScope.account, 80),
          bucket: boundedText(automaticScope.bucket, 80),
        } : null,
      },
      manual: {
        active: manual.active === true,
        scope: manualScope && ["provider", "app", "account"].includes(text(manualScope.kind)) && boundedText(manualScope.label, 80)
          ? { kind: text(manualScope.kind), label: boundedText(manualScope.label, 80) }
          : null,
        manifestCount: nonNegativeNumber(manual.manifestCount) ?? 0,
      },
    };
  }

  function adaptAutomaticTakeover(raw) {
    const phases = new Set(["disabled", "idle", "automatic", "blocked", "unsupported"]);
    if (!isObject(raw)) return { phase: "disabled", counts: { targets: 0, monitors: 0, queued: 0, active: 0, unsupported: 0, blocked: 0 }, monitors: [] };
    const counts = isObject(raw.counts) ? raw.counts : {};
    return {
      phase: phases.has(text(raw.phase)) ? text(raw.phase) : "unsupported",
      counts: Object.fromEntries(["targets", "monitors", "queued", "active", "unsupported", "blocked"].map((key) => [key, nonNegativeNumber(counts[key]) ?? 0])),
      monitors: Array.isArray(raw.monitors) ? raw.monitors.slice(0, 64).map((monitor) => isObject(monitor) && /^monitor_[a-f0-9]{24}$/.test(text(monitor.handle)) ? { handle: text(monitor.handle), phase: boundedText(monitor.phase, 48) } : null).filter(Boolean) : [],
    };
  }

  function finiteRatio(value) {
    const number = finiteNumber(value);
    return number != null && number >= 0 && number <= 1 ? number : null;
  }

  function adaptAccounts(raw, route) {
    if (!isObject(raw)) return { descriptors: [], accounts: [], active: null, combined: emptyTotals() };
    const descriptors = Array.isArray(raw.descriptors) ? raw.descriptors.map((item) => {
      if (!isObject(item) || !text(item.authKind)) return null;
      return { authKind: text(item.authKind), label: text(item.label) || text(item.authKind), instructions: text(item.instructions), collectsSecrets: item.collectsSecrets === true };
    }).filter(Boolean) : [];
    const accounts = Array.isArray(raw.accounts) ? raw.accounts.map((item) => {
      if (!isObject(item) || !text(item.id) || !text(item.providerId)) return null;
      return {
        id: text(item.id), providerId: text(item.providerId), label: text(item.label) || "Account",
        authKind: text(item.authKind) || "unknown", authSourceRef: text(item.authSourceRef), profileRef: text(item.profileRef),
        active: item.active === true, isolatedExecution: item.isolatedExecution === true,
        quota: adaptQuota(item.quota),
        forecast: adaptForecast(item.forecast),
        usage: isObject(item.usage) ? { eventCount: finiteNumber(item.usage.eventCount, 0), inputTokens: finiteNumber(item.usage.inputTokens, 0), outputTokens: finiteNumber(item.usage.outputTokens, 0) } : emptyTotals(),
      };
    }).filter(Boolean) : [];
    return { descriptors, accounts, active: accounts.find((item) => item.id === route.accountId) || accounts.find((item) => item.active) || null, combined: isObject(raw.combined) ? { eventCount: finiteNumber(raw.combined.eventCount, 0), inputTokens: finiteNumber(raw.combined.inputTokens, 0), outputTokens: finiteNumber(raw.combined.outputTokens, 0) } : emptyTotals() };
  }

  function emptyTotals() { return { eventCount: 0, inputTokens: 0, outputTokens: 0 }; }

  function adaptPickerModels(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.flatMap((item) => {
      const source = isObject(item) ? item : { id: item };
      const id = boundedText(source.id ?? source.slug, 240);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [{
        id,
        label: boundedText(source.label ?? source.display_name, 120) || id,
        free: source.free === true ? true : source.free === false ? false : null,
        hidden: source.hidden === true || text(source.visibility).toLowerCase() === "hide",
        availability: boundedText(source.availability, 40),
        unavailabilityReason: boundedText(source.unavailabilityReason ?? source.reason, 240),
        capabilityReason: boundedText(source.capabilityReason, 240),
        setupReason: boundedText(source.setupReason, 240),
        contextWindow: positiveSafeInteger(source.contextWindow ?? source.context_window),
        supportedReasoningLevels: adaptReasoningLevels(source.supportedReasoningLevels ?? source.supported_reasoning_levels),
        defaultReasoningLevel: boundedText(source.defaultReasoningLevel ?? source.default_reasoning_level, 40),
        catalogDegraded: source.catalogDegraded === true || source.catalog_degraded === true,
        catalogReason: boundedText(source.catalogReason ?? source.catalog_reason, 240),
        configuredFallback: source.configuredFallback === true || source.configured_fallback === true,
      }];
    });
  }

  function adaptReasoningLevels(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 12).flatMap((level) => {
      if (typeof level === "string") return [{ effort: boundedText(level, 40), description: "" }];
      if (!isObject(level) || !text(level.effort)) return [];
      return [{ effort: boundedText(level.effort, 40), description: boundedText(level.description, 240) }];
    });
  }

  function positiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function routeId(value) {
    const id = text(value);
    if (!id || id.length > 512 || /[\\\s\u0000-\u001f\u007f]/.test(id)) return "";
    const parsed = parseRouteId(id);
    const segments = id.split("/");
    const providerOk = /^[a-z0-9][a-z0-9._-]{0,119}$/i.test(parsed.provider) && ![".", ".."].includes(parsed.provider);
    const accountOk = !parsed.accountId || /^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(parsed.accountId);
    const modelOk = parsed.model && !segments.some((segment) => segment === "." || segment === "..");
    return MODES.includes(parsed.mode) && providerOk && accountOk && modelOk ? id : "";
  }

  function adaptPickerRoute(raw) {
    if (!isObject(raw)) return null;
    const metadata = isObject(raw.metadata) ? raw.metadata : {};
    const id = routeId(raw.id ?? raw.slug);
    if (!id) return null;
    const parsed = parseRouteId(id);
    const mode = parsed.mode;
    const availability = boundedText(raw.availability ?? metadata.availability, 40).toLowerCase() || "unknown";
    const explicitFree = raw.free ?? metadata.free;
    return {
      id,
      mode,
      provider: parsed.provider,
      accountId: parsed.accountId || "unknown/default",
      model: parsed.model,
      label: boundedText(raw.label ?? raw.display_name, 160),
      availability,
      hidden: raw.hidden === true || text(raw.visibility).toLowerCase() === "hide",
      free: explicitFree === true,
      freeKnown: explicitFree === true || explicitFree === false,
      reason: boundedText(raw.reason, 240),
      unavailabilityReason: boundedText(raw.unavailabilityReason, 240),
      capabilityReason: boundedText(raw.capabilityReason, 240),
      setupReason: boundedText(raw.setupReason, 240),
      contextWindow: positiveSafeInteger(raw.contextWindow ?? metadata.context_window),
      supportedReasoningLevels: adaptReasoningLevels(raw.supportedReasoningLevels ?? metadata.supported_reasoning_levels),
      defaultReasoningLevel: boundedText(raw.defaultReasoningLevel ?? metadata.default_reasoning_level, 40),
      catalogDegraded: raw.catalogDegraded === true || metadata.catalog_degraded === true,
      catalogReason: boundedText(raw.catalogReason ?? metadata.catalog_reason, 240),
      configuredFallback: raw.configuredFallback === true || metadata.configured_fallback === true,
      images: raw.images === true || metadata.images === true,
      ...normalizeProviderWebMetadata(raw),
    };
  }

  /** Build the presentation catalog without changing registry order or eligibility. */
  function adaptPickerRoutes(raw, currentRoute = null, fallbacks = [], routeMap = { nodes: [], edges: [] }) {
    const explicit = Array.isArray(raw) ? raw.map(adaptPickerRoute).filter(Boolean) : [];
    const generated = [];
    if (!explicit.length) {
      const nodes = new Map((routeMap.nodes ?? []).map((node) => [node.id, node]));
      const ranked = [...(routeMap.edges ?? [])].sort((left, right) => left.priority - right.priority);
      const pairs = ranked.map((edge) => ({ mode: edge.mode, node: nodes.get(edge.provider) })).filter((item) => item.node);
      for (const node of routeMap.nodes ?? []) {
        for (const mode of node.modes) {
          if (!pairs.some((item) => item.mode === mode && item.node.id === node.id)) pairs.push({ mode, node });
        }
      }
      for (const { mode, node } of pairs) {
        const models = node.models.length ? node.models : [{ id: "auto", label: "auto", free: null }];
        for (const model of models) {
          const account = node.accountId && node.accountId !== "unknown/default" ? `/@${node.accountId}` : "";
          generated.push(adaptPickerRoute({
            id: `${mode}/${node.id}${account}/${model.id}`,
            mode,
            provider: node.id,
            model: model.id,
            label: model.label,
            free: model.free,
            hidden: node.hidden || model.hidden,
            availability: model.availability || node.availability,
            unavailabilityReason: model.unavailabilityReason || node.unavailabilityReason,
            capabilityReason: model.capabilityReason || node.capabilityReason,
            setupReason: model.setupReason || node.setupReason,
            contextWindow: model.contextWindow,
            supportedReasoningLevels: model.supportedReasoningLevels,
            defaultReasoningLevel: model.defaultReasoningLevel,
            catalogDegraded: model.catalogDegraded,
            catalogReason: model.catalogReason,
            configuredFallback: model.configuredFallback,
            providerLinks: node.providerLinks,
            creditState: node.creditState,
            expiryState: node.expiryState,
          }));
        }
      }
    }

    const active = currentRoute ? adaptPickerRoute({
      ...currentRoute,
      availability: currentRoute.verified ? "available" : "unknown",
      reason: currentRoute.verificationSource,
    }) : null;
    const alternatives = Array.isArray(fallbacks) ? fallbacks.map((row) => adaptPickerRoute({
      ...row,
      availability: row.qualified ? "available" : "unavailable",
      unavailabilityReason: row.qualified ? "" : row.reason,
    })).filter(Boolean) : [];
    const ordered = [...explicit, ...generated];
    if (active && !ordered.some((item) => item.id === active.id)) ordered.unshift(active);
    for (const alternative of alternatives) {
      if (!ordered.some((item) => item.id === alternative.id)) ordered.push(alternative);
    }
    const seen = new Set();
    return ordered.filter((item) => item && !seen.has(item.id) && seen.add(item.id));
  }

  function createPickerPreferences() {
    return {
      schemaVersion: PICKER_PREFERENCE_SCHEMA_VERSION,
      selectedRouteId: "",
      favoriteRouteIds: [],
      hiddenRouteIds: [],
      manualOrderRouteIds: [],
      filters: { ...PICKER_DEFAULT_FILTERS },
    };
  }

  function pickerRouteIds(value) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).flatMap((item) => {
      const id = routeId(isObject(item) ? item.id : item);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      return [id];
    });
  }

  function normalizePickerPreferences(value, knownRoutes = []) {
    const defaults = createPickerPreferences();
    if (!isObject(value) || value.schemaVersion !== PICKER_PREFERENCE_SCHEMA_VERSION || !isObject(value.filters)
      || !Array.isArray(value.favoriteRouteIds) || !Array.isArray(value.hiddenRouteIds) || !Array.isArray(value.manualOrderRouteIds)
      || typeof value.selectedRouteId !== "string") return defaults;
    const validReferences = (items) => items.every((item) => typeof item === "string" && routeId(item));
    if (!validReferences(value.favoriteRouteIds) || !validReferences(value.hiddenRouteIds) || !validReferences(value.manualOrderRouteIds)
      || (value.selectedRouteId && !routeId(value.selectedRouteId))) return defaults;
    const filters = value.filters;
    if (typeof filters.query !== "string" || typeof filters.mode !== "string" || typeof filters.provider !== "string"
      || typeof filters.model !== "string" || typeof filters.freeOnly !== "boolean" || typeof filters.favoritesOnly !== "boolean"
      || typeof filters.showHiddenUnavailable !== "boolean" || /[\u0000-\u001f\u007f]/.test(filters.query)) return defaults;
    const known = new Set(pickerRouteIds(knownRoutes));
    const prune = (items) => pickerRouteIds(items).filter((id) => known.has(id));
    const selectedRouteId = routeId(value.selectedRouteId);
    return {
      schemaVersion: PICKER_PREFERENCE_SCHEMA_VERSION,
      selectedRouteId: known.has(selectedRouteId) ? selectedRouteId : "",
      favoriteRouteIds: prune(value.favoriteRouteIds),
      hiddenRouteIds: prune(value.hiddenRouteIds),
      manualOrderRouteIds: prune(value.manualOrderRouteIds),
      filters: {
        query: boundedText(filters.query, 120),
        mode: filters.mode === "all" || MODES.includes(filters.mode) ? filters.mode : "all",
        provider: boundedFilter(filters.provider),
        model: boundedFilter(filters.model, 240),
        freeOnly: filters.freeOnly,
        favoritesOnly: filters.favoritesOnly,
        showHiddenUnavailable: filters.showHiddenUnavailable,
      },
    };
  }

  function boundedFilter(value, maximum = 120) {
    const candidate = boundedText(value, maximum);
    return candidate && !/[\u0000-\u001f\u007f\\]/.test(candidate) ? candidate : "all";
  }

  function parsePickerPreferences(serialized, knownRoutes = []) {
    if (serialized == null || serialized === "") return createPickerPreferences();
    try {
      const value = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
      return normalizePickerPreferences(value, knownRoutes);
    } catch {
      return createPickerPreferences();
    }
  }

  function serializePickerPreferences(value, knownRoutes = []) {
    return JSON.stringify(normalizePickerPreferences(value, knownRoutes));
  }

  function orderRouteIds(allRouteIds, manualOrderRouteIds) {
    const all = pickerRouteIds(allRouteIds);
    const valid = new Set(all);
    const manual = pickerRouteIds(manualOrderRouteIds).filter((id) => valid.has(id));
    return [...manual, ...all.filter((id) => !manual.includes(id))];
  }

  /** Pure preference reducer used by drag, keyboard, mouse, and touch controls. */
  function reducePickerPreferences(state, action, knownRoutes = []) {
    const all = pickerRouteIds(knownRoutes);
    const current = normalizePickerPreferences(state, all);
    if (!isObject(action)) return current;
    const id = routeId(action.routeId);
    const known = new Set(all);
    if (["toggle-favorite", "toggle-hidden", "select-route", "move-route"].includes(action.type) && !known.has(id)) return current;
    if (action.type === "toggle-favorite") {
      const next = new Set(current.favoriteRouteIds);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...current, favoriteRouteIds: all.filter((route) => next.has(route)) };
    }
    if (action.type === "toggle-hidden") {
      const next = new Set(current.hiddenRouteIds);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...current, hiddenRouteIds: all.filter((route) => next.has(route)) };
    }
    if (action.type === "select-route") return { ...current, selectedRouteId: id };
    if (action.type === "move-route") {
      const ordered = orderRouteIds(all, current.manualOrderRouteIds);
      const from = ordered.indexOf(id);
      const requested = Number(action.toIndex);
      if (from < 0 || !Number.isInteger(requested)) return current;
      const to = Math.max(0, Math.min(ordered.length - 1, requested));
      if (from === to) return current;
      ordered.splice(from, 1);
      ordered.splice(to, 0, id);
      return { ...current, manualOrderRouteIds: ordered };
    }
    if (action.type === "reset-order") return current.manualOrderRouteIds.length ? { ...current, manualOrderRouteIds: [] } : current;
    if (action.type === "set-filter" && Object.hasOwn(PICKER_DEFAULT_FILTERS, action.name)) {
      const nextFilters = { ...current.filters };
      if (["freeOnly", "favoritesOnly", "showHiddenUnavailable"].includes(action.name)) nextFilters[action.name] = action.value === true;
      else if (action.name === "mode") nextFilters.mode = action.value === "all" || MODES.includes(action.value) ? action.value : "all";
      else if (action.name === "query") nextFilters.query = boundedText(action.value, 120);
      else nextFilters[action.name] = boundedFilter(action.value, action.name === "model" ? 240 : 120);
      return { ...current, filters: nextFilters };
    }
    return current;
  }

  /** Apply AND filters and local ordering while always retaining the active route. */
  function applyPickerPreferences(routes, preferences, activeRouteId, options = {}) {
    const source = Array.isArray(routes) ? routes.map(adaptPickerRoute).filter(Boolean) : [];
    const ids = source.map((route) => route.id);
    const prefs = normalizePickerPreferences(preferences, ids);
    const favorites = new Set(prefs.favoriteRouteIds);
    const hidden = new Set(prefs.hiddenRouteIds);
    const byId = new Map(source.map((route) => [route.id, route]));
    const ordered = orderRouteIds(ids, prefs.manualOrderRouteIds).map((id) => byId.get(id)).filter(Boolean);
    const query = prefs.filters.query.trim().toLocaleLowerCase();
    const providerFilter = prefs.filters.provider.toLocaleLowerCase();
    const modelFilter = prefs.filters.model.toLocaleLowerCase();
    const active = routeId(activeRouteId);
    const matches = (route) => {
      const hiddenUnavailable = hidden.has(route.id) || route.hidden || route.availability === "unavailable"
        || Boolean(route.setupReason) || Boolean(route.capabilityReason);
      const searchable = [route.id, route.mode, route.provider, route.model, route.label, route.reason,
        route.unavailabilityReason, route.capabilityReason, route.setupReason].join(" ").toLocaleLowerCase();
      return (!query || searchable.includes(query))
        && (prefs.filters.mode === "all" || route.mode === prefs.filters.mode)
        && (providerFilter === "all" || route.provider.toLocaleLowerCase() === providerFilter)
        && (modelFilter === "all" || route.model.toLocaleLowerCase() === modelFilter)
        && (!prefs.filters.freeOnly || route.free === true)
        && (!prefs.filters.favoritesOnly || favorites.has(route.id))
        && (prefs.filters.showHiddenUnavailable || !hiddenUnavailable);
    };
    const projected = ordered.filter((route) => matches(route) || route.id === active).map((route) => ({
      ...route,
      active: route.id === active,
      selected: route.id === prefs.selectedRouteId,
      favorite: favorites.has(route.id),
      hiddenByPreference: hidden.has(route.id),
      forcedVisible: route.id === active && !matches(route),
    }));
    const defaultView = !query && prefs.filters.mode === "all" && prefs.filters.provider === "all" && prefs.filters.model === "all"
      && !prefs.filters.freeOnly && !prefs.filters.favoritesOnly && !prefs.filters.showHiddenUnavailable;
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 6;
    let visible = defaultView && options.showAll !== true ? projected.slice(0, limit) : projected;
    const activeRoute = projected.find((route) => route.active);
    if (activeRoute && !visible.some((route) => route.id === activeRoute.id)) {
      visible = limit === 1 ? [activeRoute] : [...visible.slice(0, Math.max(0, limit - 1)), activeRoute];
    }
    return {
      routes: visible,
      totalMatches: projected.length,
      hiddenByCompactCount: projected.length - visible.length,
      hiddenUnavailableCount: source.filter((route) => hidden.has(route.id) || route.hidden || route.availability === "unavailable"
        || route.setupReason || route.capabilityReason).length,
      preferences: prefs,
    };
  }

  /**
   * Apply drawer filters to history. Qualified fallbacks stay visible unless
   * unverified rows are excluded; the current route is never hidden.
   * @param {ReturnType<typeof adaptThreadspanState>} model
   * @param {{mode?: string, verifiedOnly?: boolean}} [filters]
   */
  function applyFilters(model, filters) {
    const mode = text(filters?.mode).toLowerCase() || model.filters.mode;
    const verifiedOnly = Boolean(filters?.verifiedOnly ?? model.filters.verifiedOnly);
    const modeOk = (value) => mode === "all" || value === mode;
    return {
      ...model,
      filters: { mode: MODES.includes(mode) ? mode : "all", verifiedOnly },
      fallbacks: model.fallbacks.filter((row) => !verifiedOnly || row.qualified),
      history: model.history.filter((row) => modeOk(row.mode) && (!verifiedOnly || row.verified)),
    };
  }

  root.ThreadspanState = {
    MODE_NOTES,
    MODES,
    PICKER_PREFERENCE_SCHEMA_VERSION,
    SYNTHETIC_STATE,
    adaptPickerRoutes,
    adaptContinuity,
    adaptActionItems,
    adaptAutomaticTakeover,
    adaptThreadspanState,
    applyFilters,
    applyPickerPreferences,
    createPickerPreferences,
    normalizeProviderWebMetadata,
    parsePickerPreferences,
    reducePickerPreferences,
    serializePickerPreferences,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
