/**
 * Threadspan sidecar state adapter.
 *
 * The static UI ships synthetic data. Live JSON from the local daemon can be
 * passed through `adaptThreadspanState` without changing render code.
 * Missing fields fail closed to explicit empty or error states.
 */
(function bindThreadspanState(root) {
  const MODES = ["consult", "integrated", "delegate"];

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
    route: {
      id: "delegate/grok-build/grok-4.6",
      mode: "delegate",
      provider: "grok-build",
      model: "grok-4.6",
      verified: true,
      verifiedAt: "2026-08-17T20:00:00Z",
      verificationSource: "offline capability matrix, not live entitlement",
    },
    quota: {
      label: "Consumer week remaining",
      percentRemaining: 62,
      note: "Manual meter. Local token telemetry cannot reconstruct provider weekly usage.",
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
   * @returns {{mode: string, provider: string, model: string}}
   */
  function parseRouteId(routeId) {
    const parts = routeId.split("/");
    return {
      mode: text(parts[0]).toLowerCase(),
      provider: text(parts[1]),
      model: parts.slice(2).join("/") || "",
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

    return {
      status: "ready",
      message: "",
      product: productOf(raw),
      hud: hudOf(raw),
      thread: threadOf(raw),
      route,
      quota: adaptQuota(raw.quota),
      context: adaptContext(raw.context),
      fallbacks,
      checkpoint: adaptCheckpoint(raw.checkpoint),
      utilization: adaptUtilization(raw.utilization),
      history: adaptHistory(raw.history),
      reroute: adaptReroute(raw.reroute),
      filters: {
        mode: MODES.includes(filterMode) ? filterMode : "all",
        verifiedOnly: filters.verifiedOnly === true,
      },
      modeNote: MODE_NOTES[route.mode] || "Mode authority is unspecified.",
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
      model: text(raw.model) || parsed.model || "unspecified",
      verified: raw.verified === true,
      verifiedAt: text(raw.verifiedAt),
      verificationSource: text(raw.verificationSource) || "Unspecified source.",
    };
  }

  /**
   * @param {unknown} raw
   */
  function adaptQuota(raw) {
    if (!isObject(raw)) return null;
    const percentRemaining = finiteNumber(raw.percentRemaining);
    if (percentRemaining == null) return null;
    return {
      label: text(raw.label) || "Quota remaining",
      percentRemaining: Math.max(0, Math.min(100, percentRemaining)),
      note: text(raw.note) || "Quota source is unspecified.",
    };
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
      quota: null,
      context: null,
      fallbacks: [],
      checkpoint: null,
      utilization: [],
      history: [],
      reroute: null,
      filters: { mode: "all", verifiedOnly: false },
      modeNote: "",
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
    SYNTHETIC_STATE,
    adaptThreadspanState,
    applyFilters,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
