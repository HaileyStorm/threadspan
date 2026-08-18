/**
 * Threadspan sidecar renderer. Depends on `adapt-state.js` attaching
 * `globalThis.ThreadspanState`. Loading performs only the configured same-origin
 * state read; optional tip-model calls occur only from explicit click/submit handlers.
 */
(function startThreadspanUi() {
  const api = globalThis.ThreadspanState;
  if (!api) return;

  const root = document.querySelector("[data-threadspan-ui]");
  const toggle = document.getElementById("route-toggle");
  const drawer = document.getElementById("threadspan-drawer");
  const banner = document.getElementById("state-banner");
  const pickerToggle = document.getElementById("route-picker-toggle");
  const pickerPanel = document.getElementById("threadspan-picker");
  if (!root || !toggle || !drawer || !banner) return;

  /** @type {ReturnType<typeof api.adaptThreadspanState>} */
  let sourceModel = api.adaptThreadspanState(api.SYNTHETIC_STATE);
  /** @type {ReturnType<typeof api.adaptThreadspanState>} */
  let model = sourceModel;
  let localToken = "";
  const PICKER_PREFERENCES_KEY = "threadspan-hud-picker-preferences-v1";
  const TIP_PREFERENCES_KEY = "threadspan-tip-preferences-v1";
  const TIP_SESSION_KEY = "threadspan-tip-shown-v1";
  let activeTip = null;
  let refinementCalls = 0;
  let askTurns = 0;
  let askThreadId = null;
  let pickerPreferences = api.createPickerPreferences();
  let pickerPreferencesLoaded = false;
  let showAllPickerRoutes = false;
  let draggedPickerRouteId = "";
  let activeCopyCheckPolicy = { permissionMode: "off", maxInputChars: 12000 };

  function readTipPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(TIP_PREFERENCES_KEY) || "{}");
      return {
        disabled: value?.disabled === true,
        lastShownAt: Number.isFinite(value?.lastShownAt) ? value.lastShownAt : 0,
        lastRefinedAt: Number.isFinite(value?.lastRefinedAt) ? value.lastRefinedAt : 0,
      };
    } catch {
      return { disabled: false, lastShownAt: 0, lastRefinedAt: 0 };
    }
  }

  function writeTipPreferences(value) {
    try { localStorage.setItem(TIP_PREFERENCES_KEY, JSON.stringify(value)); } catch {}
  }

  function hideTip() {
    activeTip = null;
    const container = root.querySelector("[data-field='tip']");
    if (!container) return;
    container.hidden = true;
    container.querySelector("[data-field='tip-text']")?.replaceChildren();
    container.querySelector("[data-field='tip-status']")?.replaceChildren();
    for (const action of ["refine-tip", "ask-tip"]) {
      const button = container.querySelector(`[data-action='${action}']`);
      if (button) button.hidden = true;
    }
  }

  function readTipModel(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const provider = typeof value.provider === "string" && /^[a-z0-9._-]{1,80}$/i.test(value.provider) ? value.provider : "";
    const model = typeof value.model === "string" && /^[a-z0-9._:/-]{1,160}$/i.test(value.model) ? value.model : "";
    const settings = value.settings;
    if (!provider || !model || !settings || settings.privacy !== "sanitized-tip-context-only"
      || settings.accountRouting !== "inherit-selected-provider-account" || settings.providerAndHostSettings !== "inherit"
      || settings.mode !== "consult" || settings.web !== false || settings.subagents !== false) return null;
    if (value.maxCallsPerSession !== 1 || !Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 32 || value.maxOutputTokens > 128
      || !Number.isInteger(value.maxLatencyMs) || value.maxLatencyMs < 1_000 || value.maxLatencyMs > 10_000
      || !Number.isInteger(value.cooldownMs) || value.cooldownMs < 60_000 || value.cooldownMs > 2_592_000_000) return null;
    const ask = value.ask && Number.isInteger(value.ask.maxTurnsPerSession) && value.ask.maxTurnsPerSession >= 1 && value.ask.maxTurnsPerSession <= 4
      && Number.isInteger(value.ask.maxOutputTokens) && value.ask.maxOutputTokens >= 32 && value.ask.maxOutputTokens <= 256
      && Number.isInteger(value.ask.maxLatencyMs) && value.ask.maxLatencyMs >= 1_000 && value.ask.maxLatencyMs <= 15_000
      ? { ...value.ask }
      : null;
    return { provider, model, maxCallsPerSession: 1, maxOutputTokens: value.maxOutputTokens, maxLatencyMs: value.maxLatencyMs, cooldownMs: value.cooldownMs, ask };
  }

  function readPublishedTip(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = typeof value.id === "string" && /^[a-z0-9-]{1,64}$/.test(value.id) ? value.id : "";
    const message = typeof value.text === "string" ? value.text.trim() : "";
    const glossaryHref = typeof value.glossaryHref === "string" && /^#glossary-[a-z0-9-]{1,64}$/.test(value.glossaryHref)
      ? value.glossaryHref
      : "";
    const cooldownMs = Number.isInteger(value.cooldownMs) && value.cooldownMs >= 60_000 && value.cooldownMs <= 2_592_000_000
      ? value.cooldownMs
      : 86_400_000;
    return id && message && message.length <= 180 && glossaryHref
      ? { id, message, glossaryHref, cooldownMs, model: readTipModel(value.model) }
      : null;
  }

  function showPublishedTip(value) {
    hideTip();
    const tip = readPublishedTip(value);
    const container = root.querySelector("[data-field='tip']");
    if (!tip || !container) return;
    const preferences = readTipPreferences();
    let shownThisSession = false;
    try { shownThisSession = sessionStorage.getItem(TIP_SESSION_KEY) === "1"; } catch {}
    if (preferences.disabled || shownThisSession || Date.now() - preferences.lastShownAt < tip.cooldownMs) return;

    activeTip = tip;
    container.querySelector("[data-field='tip-text']")?.replaceChildren(tip.message);
    const link = container.querySelector("[data-field='tip-link']");
    if (link) link.setAttribute("href", tip.glossaryHref);
    const refine = container.querySelector("[data-action='refine-tip']");
    const ask = container.querySelector("[data-action='ask-tip']");
    if (refine) refine.hidden = !tip.model;
    if (ask) ask.hidden = !tip.model?.ask;
    container.hidden = false;
    writeTipPreferences({ ...preferences, lastShownAt: Date.now() });
    try { sessionStorage.setItem(TIP_SESSION_KEY, "1"); } catch {}
  }

  function bindTipControls() {
    root.querySelector("[data-action='dismiss-tip']")?.addEventListener("click", hideTip);
    root.querySelector("[data-action='disable-tips']")?.addEventListener("click", () => {
      writeTipPreferences({ ...readTipPreferences(), disabled: true });
      hideTip();
    });
    root.querySelector("[data-field='tip-link']")?.addEventListener("click", (event) => {
      const target = document.querySelector(event.currentTarget.getAttribute("href"));
      const disclosure = target?.closest("details");
      if (disclosure) disclosure.open = true;
    });
    root.querySelector("[data-action='refine-tip']")?.addEventListener("click", refineTip);
    root.querySelector("[data-action='ask-tip']")?.addEventListener("click", openTipConversation);
    const dialog = document.querySelector("[data-field='tip-dialog']");
    const form = document.querySelector("[data-field='tip-form']");
    root.querySelector("[data-action='close-tip-dialog']")?.addEventListener("click", () => dialog?.close());
    root.querySelector("[data-action='escalate-tip']")?.addEventListener("click", escalateTipConversation);
    form?.addEventListener("submit", askAboutTip);
  }

  async function consultTip(body, maxLatencyMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), maxLatencyMs);
    try {
      const response = await fetch("/v1/consult", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Tip model request failed");
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refineTip() {
    const tip = activeTip;
    if (!tip?.model) return;
    const status = root.querySelector("[data-field='tip-status']");
    const preferences = readTipPreferences();
    if (refinementCalls >= tip.model.maxCallsPerSession || Date.now() - preferences.lastRefinedAt < tip.model.cooldownMs) {
      if (status) status.textContent = "Refinement budget or cooldown is active.";
      return;
    }
    refinementCalls += 1;
    writeTipPreferences({ ...preferences, lastRefinedAt: Date.now() });
    if (status) status.textContent = "Refining…";
    try {
      const result = await consultTip({
        system: "Refine one Threadspan product tip. Return one plain sentence under 180 characters. Do not add facts, links, identifiers, or calls to action.",
        question: `Tip key: ${tip.id}\nCurrent copy: ${tip.message}`,
        provider: tip.model.provider,
        model: tip.model.model,
        maxOutputTokens: tip.model.maxOutputTokens,
        timeoutMs: tip.model.maxLatencyMs,
        allowWebSearch: false,
        allowSubagents: false,
        metadata: { threadspan_tip_kind: "refine", threadspan_tip_id: tip.id },
      }, tip.model.maxLatencyMs);
      const refined = typeof result.text === "string" ? result.text.replace(/\s+/g, " ").trim() : "";
      if (!refined || refined.length > 180) throw new Error("Tip model response was not compact");
      activeTip.message = refined;
      root.querySelector("[data-field='tip-text']")?.replaceChildren(refined);
      if (status) status.textContent = "Refined for this session.";
    } catch {
      if (status) status.textContent = "Refinement unavailable; the local heuristic tip is unchanged.";
    }
  }

  function openTipConversation() {
    if (!activeTip?.model?.ask) return;
    document.querySelector("[data-field='tip-dialog']")?.showModal();
  }

  async function askAboutTip(event) {
    event.preventDefault();
    const tip = activeTip;
    const form = event.currentTarget;
    const input = form.elements.question;
    const question = input.value.trim();
    const status = form.querySelector("[data-field='tip-dialog-status']");
    if (!tip?.model?.ask || !question || askTurns >= tip.model.ask.maxTurnsPerSession) {
      if (status) status.textContent = "The session question budget is exhausted or the question is empty.";
      return;
    }
    askTurns += 1;
    input.value = "";
    appendTipTranscript("You", question);
    if (status) status.textContent = "Thinking…";
    try {
      const result = await consultTip({
        ...(!askThreadId ? { system: `Explain only this Threadspan product tip and its documented boundary: ${tip.message}. Do not infer or request the host prompt, identifiers, credentials, memory, files, or account details.` } : {}),
        question,
        provider: tip.model.provider,
        model: tip.model.model,
        ...(askThreadId ? { threadId: askThreadId } : {}),
        maxOutputTokens: tip.model.ask.maxOutputTokens,
        timeoutMs: tip.model.ask.maxLatencyMs,
        allowWebSearch: false,
        allowSubagents: false,
        metadata: { threadspan_tip_kind: "ask", threadspan_tip_id: tip.id },
      }, tip.model.ask.maxLatencyMs);
      askThreadId = typeof result.threadId === "string" ? result.threadId : askThreadId;
      const answer = typeof result.text === "string" ? result.text.replace(/\s+/g, " ").trim().slice(0, 1_200) : "";
      appendTipTranscript("Tip assistant", answer || "No compact answer was returned.");
      if (status) status.textContent = `${askTurns} of ${tip.model.ask.maxTurnsPerSession} session turns used.`;
    } catch {
      appendTipTranscript("Tip assistant", "The bounded tip conversation is unavailable.");
      if (status) status.textContent = `${askTurns} of ${tip.model.ask.maxTurnsPerSession} session turns used.`;
    }
  }

  function appendTipTranscript(label, textValue) {
    const transcript = document.querySelector("[data-field='tip-transcript']");
    if (!transcript) return;
    const row = document.createElement("p");
    row.replaceChildren(`${label}: ${textValue}`);
    transcript.appendChild(row);
  }

  function escalateTipConversation() {
    if (!activeTip) return;
    const instruction = `Continue in the main assistant by explaining the Threadspan ${activeTip.id} topic. No mini-conversation transcript is attached.`;
    document.dispatchEvent(new CustomEvent("threadspan:tip-escalate", { detail: { topic: activeTip.id, instruction } }));
    navigator.clipboard?.writeText(instruction).catch(() => undefined);
    const status = document.querySelector("[data-field='tip-dialog-status']");
    if (status) status.textContent = "Explicit escalation requested; a safe handoff was emitted and copied when permitted.";
  }

  function bindGlossarySearch() {
    const input = root.querySelector("[data-field='glossary-search']");
    if (!input) return;
    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      for (const entry of root.querySelectorAll("[data-glossary-entry]")) {
        entry.hidden = Boolean(query) && !entry.dataset.search.includes(query);
      }
    });
  }

  /**
   * Allow only relative same-origin JSON paths. Reject protocols and parent hops.
   * @param {string} value
   * @returns {string | null}
   */
  function safeStateUrl(value) {
    if (!value || /^\s*$/.test(value)) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
    if (value.includes("\\") || value.includes("..")) return null;
    if (!value.startsWith("./") && !value.startsWith("/")) return null;
    return value;
  }

  function safeExternalHttpsUrl(value) {
    if (typeof value !== "string" || !value) return null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      return parsed.href;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} iso
   * @returns {string}
   */
  function formatUtc(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
  }

  /**
   * @param {string} mode
   */
  function titleMode(mode) {
    if (mode === "consult") return "Consult";
    if (mode === "integrated") return "Integrated";
    if (mode === "delegate") return "Delegate";
    return mode || "Unknown";
  }

  /**
   * @param {HTMLElement} meter
   * @param {number} now
   * @param {number} max
   * @param {string} label
   */
  function setMeter(meter, now, max, label) {
    const percent = max > 0 ? Math.max(0, Math.min(100, Math.round((now / max) * 100))) : 0;
    meter.setAttribute("role", "meter");
    meter.setAttribute("aria-valuemin", "0");
    meter.setAttribute("aria-valuemax", String(max));
    meter.setAttribute("aria-valuenow", String(now));
    meter.setAttribute("aria-label", label);
    const fill = meter.querySelector("span") || meter.appendChild(document.createElement("span"));
    fill.style.width = `${percent}%`;
  }

  /**
   * @param {boolean} expanded
   */
  function setExpanded(expanded) {
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    drawer.hidden = !expanded;
    toggle.querySelector(".route-bar__chevron")?.replaceChildren(expanded ? "▴" : "▾");
  }

  function pickerRouteIds() {
    return sourceModel.pickerRoutes?.map((route) => route.id) ?? [];
  }

  function persistPickerPreferences() {
    try {
      localStorage.setItem(PICKER_PREFERENCES_KEY, api.serializePickerPreferences(pickerPreferences, pickerRouteIds()));
    } catch {}
  }

  function hydratePickerPreferences() {
    const ids = pickerRouteIds();
    if (!pickerPreferencesLoaded) {
      let serialized = "";
      try { serialized = localStorage.getItem(PICKER_PREFERENCES_KEY) || ""; } catch {}
      pickerPreferences = api.parsePickerPreferences(serialized, ids);
      pickerPreferencesLoaded = true;
    } else {
      pickerPreferences = api.parsePickerPreferences(api.serializePickerPreferences(pickerPreferences, ids), ids);
    }
    persistPickerPreferences();
  }

  function dispatchPickerPreference(action, announcement = "", focusTarget = null) {
    pickerPreferences = api.reducePickerPreferences(pickerPreferences, action, pickerRouteIds());
    if (action.type === "set-filter") showAllPickerRoutes = false;
    persistPickerPreferences();
    renderPicker();
    if (focusTarget) restorePickerFocus(focusTarget);
    if (announcement) announcePicker(announcement);
  }

  function setPickerExpanded(expanded) {
    if (!pickerToggle || !pickerPanel) return;
    pickerToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    pickerPanel.hidden = !expanded;
    if (expanded) root.querySelector("input[name='picker-query']")?.focus();
  }

  function announcePicker(message) {
    const live = root.querySelector("[data-field='picker-announcement']");
    if (live) live.textContent = message;
  }

  function restorePickerFocus(target) {
    if (target.control === "selection") {
      root.querySelector("[data-field='picker-selected-route']")?.focus();
      return;
    }
    const item = [...root.querySelectorAll("[data-field='picker-routes'] > [data-route-id]")]
      .find((candidate) => candidate.dataset.routeId === target.routeId);
    const button = [...(item?.querySelectorAll("button") ?? [])]
      .find((candidate) => candidate.dataset.pickerAction === target.control && !candidate.disabled);
    const fallback = [...(item?.querySelectorAll("button") ?? [])].find((candidate) => !candidate.disabled);
    if (button || fallback) (button || fallback).focus();
    else root.querySelector("input[name='picker-show-hidden']")?.focus();
  }

  function orderedPickerIds() {
    const all = pickerRouteIds();
    const manual = pickerPreferences.manualOrderRouteIds.filter((id) => all.includes(id));
    return [...manual, ...all.filter((id) => !manual.includes(id))];
  }

  function routePickerReason(route) {
    if (route.setupReason) return `Setup required: ${route.setupReason}`;
    if (route.capabilityReason) return `Capability: ${route.capabilityReason}`;
    if (route.availability === "unavailable") return `Unavailable: ${route.unavailabilityReason || route.reason || "No reason was published."}`;
    if (route.hiddenByPreference) return route.active
      ? "Hidden preference overridden because this is the active route."
      : "Hidden locally. Use Show hidden/unavailable to restore it.";
    if (route.forcedVisible) return "Active route shown despite the current filters.";
    return route.reason || `${titleMode(route.mode)} via ${route.provider}; live availability remains authoritative.`;
  }

  function optionList(select, values, allLabel, selected) {
    if (!select) return;
    const unique = [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
    const options = [new Option(allLabel, "all"), ...unique.map((value) => new Option(value, value))];
    if (selected !== "all" && !unique.includes(selected)) options.push(new Option(`Saved: ${selected}`, selected));
    select.replaceChildren(...options);
    select.value = selected;
  }

  function syncPickerControls() {
    const filters = pickerPreferences.filters;
    const query = root.querySelector("input[name='picker-query']");
    if (query && query.value !== filters.query) query.value = filters.query;
    const mode = root.querySelector("select[name='picker-mode']");
    if (mode) mode.value = filters.mode;
    optionList(root.querySelector("select[name='picker-provider']"), sourceModel.pickerRoutes.map((route) => route.provider), "All providers", filters.provider);
    optionList(root.querySelector("select[name='picker-model']"), sourceModel.pickerRoutes.map((route) => route.model), "All models", filters.model);
    const free = root.querySelector("input[name='picker-free-only']");
    const favorites = root.querySelector("input[name='picker-favorites-only']");
    const recovery = root.querySelector("input[name='picker-show-hidden']");
    if (free) free.checked = filters.freeOnly;
    if (favorites) favorites.checked = filters.favoritesOnly;
    if (recovery) recovery.checked = filters.showHiddenUnavailable;
  }

  function renderPicker() {
    if (!pickerToggle || !pickerPanel) return;
    const ready = sourceModel.status === "ready" && sourceModel.route && sourceModel.pickerRoutes.length > 0;
    pickerToggle.disabled = !ready;
    if (!ready) {
      setPickerExpanded(false);
      return;
    }
    syncPickerControls();
    const projection = api.applyPickerPreferences(sourceModel.pickerRoutes, pickerPreferences, sourceModel.route.id, {
      limit: 6,
      showAll: showAllPickerRoutes,
    });
    pickerPreferences = projection.preferences;
    const selectedId = pickerPreferences.selectedRouteId || sourceModel.route.id;
    const selected = sourceModel.pickerRoutes.find((route) => route.id === selectedId) || sourceModel.route;
    const selectedField = root.querySelector("[data-field='picker-selected-route']");
    if (selectedField) selectedField.value = selected.id;
    pickerToggle.textContent = selected.id === sourceModel.route.id ? "Pick route" : `Route: ${selected.provider} / ${selected.model}`;

    const list = root.querySelector("[data-field='picker-routes']");
    const empty = root.querySelector("[data-field='picker-empty']");
    const showAll = root.querySelector("[data-action='show-all-picker-routes']");
    if (!list || !empty || !showAll) return;
    list.replaceChildren();
    empty.hidden = projection.routes.length > 0;
    showAll.hidden = projection.hiddenByCompactCount === 0;
    if (!showAll.hidden) showAll.textContent = `Show ${projection.hiddenByCompactCount} more matching route${projection.hiddenByCompactCount === 1 ? "" : "s"}`;
    const fullOrder = orderedPickerIds();
    const supportsDrag = "draggable" in document.createElement("div");

    for (const route of projection.routes) {
      const item = document.createElement("li");
      item.className = "route-picker__item";
      item.dataset.routeId = route.id;
      item.dataset.active = String(route.active);
      item.dataset.selected = String(route.selected || route.id === selected.id);
      item.draggable = supportsDrag;

      const info = document.createElement("div");
      const head = document.createElement("div");
      head.className = "route-picker__route-head";
      const title = document.createElement("strong");
      title.textContent = route.label || route.model;
      const id = document.createElement("span");
      id.className = "mono note";
      id.textContent = route.id;
      const badges = document.createElement("span");
      badges.className = "route-picker__badges";
      for (const label of [route.active && "Active", route.id === selected.id && "Selected", route.favorite && "Favorite", route.free && "Free", route.availability]) {
        if (!label) continue;
        const badge = document.createElement("span");
        badge.className = "route-picker__badge";
        badge.textContent = label;
        badges.appendChild(badge);
      }
      head.append(title, badges);
      const reason = document.createElement("p");
      reason.className = "route-picker__reason note";
      reason.textContent = routePickerReason(route);
      info.append(head, id, reason);
      const providerContext = providerContextEl(route, route.provider);
      if (providerContext) info.appendChild(providerContext);

      const actions = document.createElement("div");
      actions.className = "route-picker__actions";
      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.dataset.pickerAction = "favorite";
      favorite.setAttribute("aria-pressed", route.favorite ? "true" : "false");
      favorite.textContent = route.favorite ? "Unfavorite" : "Favorite";
      favorite.addEventListener("click", () => dispatchPickerPreference(
        { type: "toggle-favorite", routeId: route.id }, "", { routeId: route.id, control: "favorite" },
      ));
      const select = document.createElement("button");
      select.type = "button";
      select.dataset.pickerAction = "select";
      select.disabled = route.id === selected.id;
      select.textContent = route.id === selected.id ? "Selected" : "Select";
      select.addEventListener("click", () => dispatchPickerPreference(
        { type: "select-route", routeId: route.id }, `Selected local route ${route.id}.`, { control: "selection" },
      ));
      const position = fullOrder.indexOf(route.id);
      const up = document.createElement("button");
      up.type = "button";
      up.dataset.pickerAction = "move-up";
      up.textContent = "Move up";
      up.disabled = position <= 0;
      up.setAttribute("aria-label", `Move ${route.id} up`);
      up.addEventListener("click", () => movePickerRoute(route.id, position - 1, "move-up"));
      const down = document.createElement("button");
      down.type = "button";
      down.dataset.pickerAction = "move-down";
      down.textContent = "Move down";
      down.disabled = position < 0 || position >= fullOrder.length - 1;
      down.setAttribute("aria-label", `Move ${route.id} down`);
      down.addEventListener("click", () => movePickerRoute(route.id, position + 1, "move-down"));
      const hide = document.createElement("button");
      hide.type = "button";
      hide.dataset.pickerAction = "hide";
      hide.textContent = route.hiddenByPreference ? "Restore" : "Hide";
      hide.addEventListener("click", () => dispatchPickerPreference(
        { type: "toggle-hidden", routeId: route.id }, "", { routeId: route.id, control: "hide" },
      ));
      actions.append(favorite, select, up, down, hide);
      item.append(info, actions);

      item.addEventListener("dragstart", (event) => {
        draggedPickerRouteId = route.id;
        item.dataset.dragging = "true";
        event.dataTransfer?.setData("text/plain", route.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      item.addEventListener("dragend", () => {
        draggedPickerRouteId = "";
        delete item.dataset.dragging;
      });
      item.addEventListener("dragover", (event) => event.preventDefault());
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const dragged = draggedPickerRouteId || event.dataTransfer?.getData("text/plain");
        const target = orderedPickerIds().indexOf(route.id);
        if (dragged && target >= 0) movePickerRoute(dragged, target);
      });
      list.appendChild(item);
    }
  }

  function movePickerRoute(routeId, toIndex, focusControl = "") {
    dispatchPickerPreference(
      { type: "move-route", routeId, toIndex }, "", focusControl ? { routeId, control: focusControl } : null,
    );
    const position = orderedPickerIds().indexOf(routeId) + 1;
    announcePicker(`${routeId} moved to position ${position}.`);
  }

  function bindPickerControls() {
    if (!pickerToggle || !pickerPanel) return;
    pickerToggle.addEventListener("click", () => {
      const expanded = pickerToggle.getAttribute("aria-expanded") !== "true";
      if (expanded) setExpanded(false);
      setPickerExpanded(expanded);
    });
    const bindings = [
      ["input[name='picker-query']", "input", "query", (input) => input.value],
      ["select[name='picker-mode']", "change", "mode", (input) => input.value],
      ["select[name='picker-provider']", "change", "provider", (input) => input.value],
      ["select[name='picker-model']", "change", "model", (input) => input.value],
      ["input[name='picker-free-only']", "change", "freeOnly", (input) => input.checked],
      ["input[name='picker-favorites-only']", "change", "favoritesOnly", (input) => input.checked],
      ["input[name='picker-show-hidden']", "change", "showHiddenUnavailable", (input) => input.checked],
    ];
    for (const [selector, eventName, name, read] of bindings) {
      root.querySelector(selector)?.addEventListener(eventName, (event) => {
        dispatchPickerPreference({ type: "set-filter", name, value: read(event.currentTarget) });
      });
    }
    root.querySelector("[data-action='reset-picker-order']")?.addEventListener("click", () => {
      dispatchPickerPreference({ type: "reset-order" }, "Smart route order restored. Favorites and filters were kept.");
    });
    root.querySelector("[data-action='show-all-picker-routes']")?.addEventListener("click", () => {
      showAllPickerRoutes = true;
      renderPicker();
    });
    root.querySelector("[data-action='copy-picker-route']")?.addEventListener("click", () => { void copyPickerRoute(); });
  }

  async function copyPickerRoute() {
    const field = root.querySelector("[data-field='picker-selected-route']");
    const value = field?.value || "";
    if (!value) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(value);
      copied = true;
    } catch {
      field?.focus();
      field?.select();
      try { copied = document.execCommand("copy"); } catch {}
    }
    announcePicker(copied ? `Copied ${value}.` : "Copy unavailable. The exact route string is selected for manual copy.");
  }

  function currentFilters() {
    const mode = root.querySelector("input[name='mode-filter']:checked")?.value || model.filters.mode;
    const verifiedOnly = Boolean(root.querySelector("input[name='verified-only']")?.checked);
    return { mode, verifiedOnly };
  }

  /**
   * @param {ReturnType<typeof api.adaptThreadspanState>} next
   */
  function render(next) {
    model = next;
    root.dataset.state = next.status;
    document.title = `${next.product.name} — ${next.product.tagline}`;

    const hud = root.querySelector("[data-field='hud']");
    if (hud) hud.textContent = next.hud.placeholder;

    const wordmark = root.querySelector(".route-bar__wordmark");
    const tagline = root.querySelector(".route-bar__tagline");
    if (wordmark) wordmark.textContent = next.product.name;
    if (tagline) tagline.textContent = next.product.tagline;

    const ready = next.status === "ready" && next.route;
    toggle.disabled = !ready;

    if (!ready) {
      setExpanded(false);
      banner.hidden = false;
      banner.dataset.kind = next.status;
      banner.textContent = next.message;
      root.querySelector("[data-field='route']").textContent = next.status === "loading" ? "Loading route…" : "No current route";
      renderPicker();
      return;
    }

    banner.hidden = true;
    banner.textContent = "";

    const route = next.route;
    root.querySelector("[data-field='route']").textContent = `${route.mode} / ${route.provider} / ${route.model}`;
    root.querySelector("[data-field='route-detail']").textContent = route.id;

    const modeBar = root.querySelector("[data-field='mode']");
    const modeDetail = root.querySelector("[data-field='mode-detail']");
    modeBar.dataset.mode = route.mode;
    modeDetail.dataset.mode = route.mode;
    modeBar.replaceChildren(kicker("Mode"), document.createTextNode(` ${titleMode(route.mode)}`));
    modeDetail.textContent = titleMode(route.mode);
    root.querySelector("[data-field='mode-note']").textContent = next.modeNote;
    renderCopyCheckPolicy(next.copyCheck);

    const availability = route.verified ? "verified" : "unverified";
    const availBar = root.querySelector("[data-field='availability']");
    availBar.classList.toggle("pill--ok", route.verified);
    availBar.replaceChildren(kicker("Availability"), document.createTextNode(` ${availability}`));
    root.querySelector("[data-field='availability-detail']").textContent =
      `${availability}${route.verifiedAt ? ` · ${formatUtc(route.verifiedAt)}` : ""}`;
    const availabilityNote = root.querySelector("[data-field='availability-note']");
    availabilityNote.textContent = route.verificationSource;
    availabilityNote.parentElement?.querySelector(".provider-context--active")?.remove();
    const activeProviderContext = providerContextEl(route, route.provider);
    if (activeProviderContext) {
      activeProviderContext.classList.add("provider-context--active");
      availabilityNote.parentElement?.appendChild(activeProviderContext);
    }

    const quota = next.quota;
    const forecast = next.forecast;
    const quotaBar = root.querySelector("[data-field='quota']");
    const quotaHeadline = quota
      ? quota.percentRemaining != null ? `${quota.percentRemaining}% remaining` : quota.remaining != null ? `${quota.remaining} ${quota.unit} remaining` : "boundary published"
      : forecast ? `${forecast.burn.rateLabel} · ${forecast.exhaustion?.label ?? forecast.limitLabel}` : "unavailable";
    quotaBar.replaceChildren(kicker(quota ? "Quota" : forecast ? "Forecast" : "Quota"), document.createTextNode(` ${quotaHeadline}`));
    quotaBar.title = forecast ? forecastEvidence(forecast) : quota ? `Authoritative source: ${quota.source}.` : "Quota and recent-burn forecast unavailable.";
    const quotaDetail = root.querySelector("[data-field='quota-detail']");
    quotaDetail.replaceChildren();
    if (quota) {
      const value = quota.percentRemaining != null
        ? `${quota.label} · ${quota.percentRemaining}% remaining`
        : `${quota.label} · ${quota.remaining ?? "unknown"} ${quota.unit} remaining`;
      quotaDetail.append(document.createTextNode(value));
      if (quota.percentRemaining != null) quotaDetail.append(meterEl(quota.percentRemaining, 100, "Quota remaining"));
      const boundary = quota.resetAt ? `Reset ${formatUtc(quota.resetAt)}` : quota.renewalAt ? `Renewal ${formatUtc(quota.renewalAt)}` : "Reset/renewal unknown";
      quotaDetail.append(noteEl(`${boundary} · authoritative source ${quota.source}${quota.observedAt ? ` · observed ${formatUtc(quota.observedAt)}` : ""}.`));
    } else {
      quotaDetail.append(noteEl("Authoritative quota, allowance, and reset/renewal are not published."));
    }
    if (forecast) quotaDetail.append(noteEl(`Recent burn: ${forecastSummary(forecast)}.`), noteEl(forecastEvidence(forecast)));

    const context = next.context;
    const contextBar = root.querySelector("[data-field='context']");
    contextBar.replaceChildren(kicker("Context"), document.createTextNode(context ? ` ${context.percentUsed}%` : " unavailable"));
    const contextDetail = root.querySelector("[data-field='context-detail']");
    if (context) {
      contextDetail.replaceChildren(
        document.createTextNode(`${context.usedTokens} / ${context.windowTokens} · ${context.percentUsed}% used`),
        meterEl(context.percentUsed, 100, "Context used"),
      );
    } else {
      contextDetail.textContent = "Context window not published.";
    }

    renderFallbacks(next.fallbacks);
    renderCheckpoint(next.checkpoint);
    renderUtilization(next.utilization);
    renderReroute(next.reroute);
    renderHistory(next.history);
    renderRouteMap(next.routeMap);
    renderAccounts(next.accounts);
    renderContinuity(next.continuity);
    renderMaximumUtilization(next.maximumUtilization);
    renderAutomaticTakeover(next.automaticTakeover);
    renderCompatibility(next.compatibility);
    syncFilterControls(next.filters);
    renderPicker();
  }

  function renderContinuity(continuity) {
    const tree = root.querySelector("[data-field='continuity-tree']");
    const summary = root.querySelector("[data-field='continuity-summary']");
    const count = root.querySelector("[data-field='continuity-count']");
    const note = root.querySelector("[data-field='continuity-note']");
    const status = root.querySelector("[data-field='continuity-status']");
    if (!tree || !summary || !count || !note || !status) return;
    tree.replaceChildren();
    status.textContent = "";
    const tasks = continuity?.tasks ?? [];
    count.textContent = String(tasks.length);
    if (!continuity?.enabled) {
      summary.textContent = "Not connected";
      note.textContent = continuity?.reason || "Native Continuity state is unavailable.";
      return;
    }
    const selected = tasks.find((task) => task.selected) ?? tasks[0];
    summary.textContent = selected ? `${selected.title} · generation ${selected.current.generation}` : "No logical tasks found";
    note.textContent = continuity.note || "Origin and prior generations stay nested under the selected current task.";
    for (const task of tasks) {
      const item = document.createElement("details");
      item.className = "continuity-task";
      item.open = task.selected;
      const head = document.createElement("summary");
      const title = document.createElement("strong");
      title.textContent = task.title;
      const meta = document.createElement("span");
      meta.className = "note";
      meta.textContent = `${task.project} · ${task.current.status} · Goal ${task.current.goalStatus}`;
      head.append(title, meta);
      const generations = document.createElement("ol");
      generations.className = "continuity-generations";
      for (const generation of task.generations) {
        const row = document.createElement("li");
        row.dataset.role = generation.role;
        const label = document.createElement("span");
        label.textContent = generation.label;
        const badge = document.createElement("small");
        badge.textContent = `${generation.role} · ${generation.status}`;
        row.append(label, badge);
        generations.appendChild(row);
      }
      const actions = document.createElement("div");
      actions.className = "continuity-actions";
      if (continuity.capabilities?.rename) {
        const rename = document.createElement("button");
        rename.type = "button";
        rename.textContent = "Rename";
        rename.addEventListener("click", async () => {
          const name = prompt("Task name", task.title);
          if (name == null || !name.trim() || name.trim() === task.title) return;
          await continuityAction("/v1/continuity/rename", { handle: task.handle, name: name.trim() }, status);
        });
        actions.appendChild(rename);
      }
      if (continuity.capabilities?.rollover) {
        const action = document.createElement("button");
        action.type = "button";
        action.disabled = task.action === "Pending";
        action.textContent = task.action;
        action.addEventListener("click", async () => {
          try {
            const preview = await continuityRequest("/v1/continuity/rollover/preview", { handle: task.handle });
            const effects = Array.isArray(preview.effects) ? preview.effects.join("\n• ") : "Use the native Continuity supervisor.";
            if (!confirm(`${task.action} “${task.title}”?\n\n• ${effects}`)) return;
            const result = await continuityRequest("/v1/continuity/rollover", { handle: task.handle, digest: preview.digest });
            status.textContent = `${task.action} requested. The native supervisor owns the handoff.`;
            action.disabled = true;
            action.textContent = "Pending";
            document.dispatchEvent(new CustomEvent("threadspan:continuity-requested", { detail: { operationId: result.operationId } }));
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : String(error);
          }
        });
        actions.appendChild(action);
      }
      item.append(head, generations, actions);
      tree.appendChild(item);
    }
  }

  async function continuityAction(path, body, status) {
    try {
      const result = await continuityRequest(path, body);
      status.textContent = result.title ? `Renamed to ${result.title}.` : "Continuity action accepted.";
      setTimeout(() => location.reload(), 350);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function continuityRequest(path, body) {
    if (!localToken) throw new Error("Owner token is required for Continuity controls.");
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value?.error?.message || `Continuity request failed (${response.status}).`);
    return value;
  }

  /**
   * @param {string} label
   */
  function kicker(label) {
    const span = document.createElement("span");
    span.className = "kicker";
    span.textContent = label;
    return span;
  }

  /**
   * @param {string} text
   */
  function noteEl(text) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    return p;
  }

  function providerContextEl(value, providerLabel) {
    const links = value?.providerLinks ?? {};
    const linkEntries = [
      ["Official site", links.officialUrl],
      ["Account", links.accountUrl],
      ["Usage", links.usageUrl],
    ].filter(([, url]) => Boolean(url));
    const states = [];
    if (value?.creditState === "low") states.push("Low credit");
    if (value?.creditState === "exhausted") states.push("Credits exhausted");
    if (value?.expiryState === "approaching") states.push("Access expires soon");
    if (value?.expiryState === "expired") states.push("Access expired");
    if (!linkEntries.length && !states.length) return null;

    const context = document.createElement("p");
    context.className = "provider-context note";
    if (states.length) {
      context.classList.add("provider-context--attention");
      const state = document.createElement("span");
      state.className = "provider-context__state";
      state.textContent = states.join(" · ");
      context.appendChild(state);
    }
    for (const [label, url] of linkEntries) {
      if (context.childNodes.length) context.append(document.createTextNode(" · "));
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer external";
      link.referrerPolicy = "no-referrer";
      link.textContent = label;
      link.setAttribute("aria-label", `${label} for ${providerLabel} (opens in a new tab)`);
      context.appendChild(link);
    }
    return context;
  }

  /**
   * @param {number} now
   * @param {number} max
   * @param {string} label
   */
  function meterEl(now, max, label) {
    const meter = document.createElement("span");
    meter.className = "meter";
    meter.appendChild(document.createElement("span"));
    setMeter(meter, now, max, label);
    return meter;
  }

  /**
   * @param {object[]} fallbacks
   */
  function renderFallbacks(fallbacks) {
    const list = root.querySelector("[data-field='fallbacks']");
    list.replaceChildren();
    if (!fallbacks.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No qualified fallbacks match the current filters.";
      list.appendChild(empty);
      return;
    }
    for (const row of fallbacks) {
      const li = document.createElement("li");
      li.className = "fallback";
      if (!row.qualified) li.setAttribute("aria-disabled", "true");
      const head = document.createElement("div");
      head.className = "fallback__head";
      const id = document.createElement("span");
      id.className = "mono";
      id.textContent = row.id;
      const mode = document.createElement("span");
      mode.className = "mode";
      mode.dataset.mode = row.mode;
      mode.textContent = titleMode(row.mode);
      head.append(id, mode);
      li.append(head, noteEl(row.reason));
      list.appendChild(li);
    }
  }

  /**
   * @param {object | null} checkpoint
   */
  function renderCheckpoint(checkpoint) {
    const el = root.querySelector("[data-field='checkpoint']");
    const note = root.querySelector("[data-field='checkpoint-note']");
    if (!checkpoint) {
      el.textContent = "No checkpoint.";
      note.textContent = "";
      return;
    }
    el.textContent = `${checkpoint.id}${checkpoint.at ? ` · ${formatUtc(checkpoint.at)}` : ""}`;
    note.textContent = checkpoint.summary;
  }

  /**
   * @param {object[]} rows
   */
  function renderUtilization(rows) {
    const list = root.querySelector("[data-field='utilization']");
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No provider utilization published.";
      list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      li.className = "util";
      const head = document.createElement("div");
      head.className = "util__head";
      const label = document.createElement("span");
      label.textContent = row.label;
      const count = document.createElement("span");
      count.className = "mono";
      count.textContent = `${row.used} / ${row.limit}`;
      head.append(label, count);
      li.append(head, meterEl(row.used, row.limit, row.label), noteEl(row.note));
      list.appendChild(li);
    }
  }

  /**
   * @param {object | null} reroute
   */
  function renderReroute(reroute) {
    const el = root.querySelector("[data-field='reroute']");
    el.replaceChildren();
    const kickerEl = kicker("Reroute event");
    if (!reroute) {
      el.append(kickerEl, noteEl("No reroute event on this thread."));
      return;
    }
    const line = document.createElement("p");
    line.className = "mono";
    line.textContent = `${reroute.at ? `${formatUtc(reroute.at)} · ` : ""}${reroute.actor} · ${reroute.from} → ${reroute.to}`;
    el.append(kickerEl, line, noteEl(reroute.reason));
  }

  /**
   * @param {object[]} rows
   */
  function renderHistory(rows) {
    const details = root.querySelector("[data-field='history']");
    let list = details.querySelector(".history-list");
    if (!list) {
      list = document.createElement("ul");
      list.className = "history-list";
      details.appendChild(list);
    }
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "No matching history.";
      list.appendChild(empty);
      return;
    }
    for (const row of rows) {
      const li = document.createElement("li");
      const when = document.createElement("span");
      when.className = "mono";
      when.textContent = row.at ? formatUtc(row.at) : "time unknown";
      li.append(when, document.createTextNode(` · ${row.event} · ${row.route}`));
      list.appendChild(li);
    }
  }

  function renderRouteMap(routeMap) {
    const el = root.querySelector("[data-field='route-map']");
    if (!el) return;
    el.replaceChildren();
    if (!routeMap?.nodes?.length) {
      el.append(noteEl("No provider hierarchy is published."));
      return;
    }
    const byProvider = new Map(routeMap.edges.map((edge) => [`${edge.mode}:${edge.provider}`, edge]));
    for (const node of routeMap.nodes) {
      const card = document.createElement("article");
      card.className = "route-node";
      card.dataset.availability = node.availability;
      const head = document.createElement("div");
      head.className = "route-node__head";
      const name = document.createElement("strong");
      name.textContent = node.label;
      const score = document.createElement("span");
      score.className = "mono";
      score.textContent = `I${node.intelligence}`;
      head.append(name, score);
      const modes = document.createElement("p");
      modes.className = "route-node__modes";
      modes.textContent = node.modes.map((mode) => {
        const edge = byProvider.get(`${mode}:${node.id}`);
        return edge ? `${titleMode(mode)} #${edge.priority}` : titleMode(mode);
      }).join(" · ");
      card.append(head, modes, noteEl(`${node.availability} · ${node.specialties.join(", ") || "general"} · ${node.usage.requests} uses / ${node.usage.failures} failures`));
      const providerContext = providerContextEl(node, node.label);
      if (providerContext) card.appendChild(providerContext);
      el.appendChild(card);
    }
  }

  function renderCompatibility(compatibility) {
    const summary = root.querySelector("[data-field='compatibility-summary']");
    const list = root.querySelector("[data-field='compatibility-products']");
    if (!summary || !list) return;
    summary.textContent = compatibility.status === "disabled"
      ? "Watch disabled. Run compatibility doctor after an app update."
      : `${compatibility.status}${compatibility.changed ? " · changes need review" : " · no reported drift"}${compatibility.observedAt ? ` · ${formatUtc(compatibility.observedAt)}` : ""}`;
    list.replaceChildren();
    for (const product of compatibility.products) {
      const item = document.createElement("li");
      item.textContent = `${product.label} · ${product.status}${product.version ? ` · ${product.version}` : ""}`;
      list.appendChild(item);
    }
  }

  function renderAccounts(accounts) {
    const active = root.querySelector("[data-field='active-account']");
    const telemetry = root.querySelector("[data-field='account-telemetry']");
    const list = root.querySelector("[data-field='account-list']");
    if (!active || !telemetry || !list) return;
    active.textContent = accounts.active ? `${accounts.active.label} · ${accounts.active.providerId} · ${accounts.active.authKind}` : "Default / unknown account";
    telemetry.textContent = `${accounts.combined.eventCount} combined attempts · ${accounts.combined.inputTokens} input / ${accounts.combined.outputTokens} output tokens. ${accounts.active?.forecast ? `Active recent burn: ${forecastSummary(accounts.active.forecast)}. ` : ""}Quota, reset, renewal, and charge remain unknown unless authoritatively observed.`;
    list.replaceChildren();
    for (const account of accounts.accounts) {
      const item = document.createElement("li");
      item.className = "util";
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = account.active;
      button.textContent = account.active ? "Active" : "Use";
      button.addEventListener("click", () => { void mutateAccount("PUT", "/v1/accounts/active", { accountId: account.id }).catch(() => undefined); });
      const line = document.createElement("span");
      line.textContent = `${account.label} · ${account.providerId} · ${account.isolatedExecution ? "isolated" : "shared/default only"} · ${account.usage.eventCount} attempts`;
      item.append(line, button);
      list.appendChild(item);
    }
  }

  function renderMaximumUtilization(maximum) {
    const phase = root.querySelector("[data-field='maximum-utilization-phase']");
    const detail = root.querySelector("[data-field='maximum-utilization-detail']");
    if (!phase || !detail) return;
    if (!maximum) {
      phase.textContent = "Not configured";
      detail.textContent = "Optional controller state is not published.";
      return;
    }
    const ratio = maximum.quota.usedRatio == null ? "native ratio unknown" : `${Math.round(maximum.quota.usedRatio * 100)}% native usage`;
    const manual = maximum.manual.active && maximum.manual.scope ? `manual full-push active · ${maximum.manual.scope.kind}: ${maximum.manual.scope.label} · ${maximum.manual.manifestCount} frozen entries` : "manual full-push inactive";
    const automaticScope = maximum.automatic.scope ? `${maximum.automatic.scope.provider} / ${maximum.automatic.scope.account} / ${maximum.automatic.scope.bucket}` : "no active scope";
    phase.textContent = `${maximum.phase} · ${maximum.readiness} · epoch ${maximum.epoch} · ${manual}`;
    detail.textContent = `Automatic polling ${maximum.automatic.enabled ? "enabled" : "disabled"}; ${maximum.automatic.active ? "active" : "inactive"}; ${automaticScope}. ${ratio}${maximum.quota.observedAt ? ` · observed ${formatUtc(maximum.quota.observedAt)}` : ""}${maximum.quota.resetAt ? ` · reset ${formatUtc(maximum.quota.resetAt)}` : ""}. ${maximum.counts.protectedTasks} protected, ${maximum.counts.notices} notices, ${maximum.counts.inboxPending} inbox pending, ${maximum.counts.suspendedMonitors} monitors suspended, ${maximum.counts.overruns} overruns, ${maximum.counts.provisionalOutputs} provisional outputs. Actions: ${maximum.statuses.executedActions} executed, ${maximum.statuses.pendingActions} pending, ${maximum.statuses.unsupportedActions} unsupported; manifest ${maximum.statuses.manifest}, Fast ${maximum.statuses.fastCanary}, recovery ${maximum.statuses.recovery}.`;
    const leave = root.querySelector("[data-action='leave-manual-full-push']");
    if (leave) leave.hidden = maximum.manual.active !== true;
  }

  function renderAutomaticTakeover(takeover) {
    const detail = root.querySelector("[data-field='automatic-takeover-detail']");
    const stop = root.querySelector("[data-action='disable-automatic-takeover']");
    if (!detail) return;
    const counts = takeover?.counts ?? {};
    detail.textContent = `Takeover ${takeover?.phase ?? "disabled"} · ${counts.active ?? 0} active · ${counts.queued ?? 0} queued · ${counts.blocked ?? 0} blocked · ${counts.unsupported ?? 0} unsupported.`;
    if (stop) stop.hidden = !["automatic", "blocked", "unsupported"].includes(takeover?.phase) && (counts.active ?? 0) === 0 && (counts.queued ?? 0) === 0;
  }

  function forecastSummary(forecast) {
    if (forecast.status === "zero-burn") return `${forecast.burn.rateLabel}; no exhaustion at observed burn`;
    if (forecast.exhaustion) return `${forecast.burn.rateLabel}; projected exhaustion ${forecast.exhaustion.label} (${forecast.exhaustion.relation.replaceAll("-", " ")})`;
    return `${forecast.burn.rateLabel}; ${forecast.limitLabel}`;
  }

  function forecastEvidence(forecast) {
    const interval = forecast.sampleInterval.start && forecast.sampleInterval.end
      ? `${formatUtc(forecast.sampleInterval.start)} to ${formatUtc(forecast.sampleInterval.end)}`
      : "sample interval unknown";
    const coverage = forecast.coverage.ratio == null ? "coverage unknown" : `${Math.round(forecast.coverage.ratio * 100)}% temporal coverage`;
    return `${forecast.source}; ${forecast.evidenceClass ?? "evidence class unknown"}; newest ${forecast.observedAt ? formatUtc(forecast.observedAt) : "unknown"}; ${interval}; ${forecast.coverage.eventCount ?? 0} usable samples; ${coverage}; ${forecast.freshness.status}; ${forecast.confidence.level} confidence — ${forecast.confidence.reason}`;
  }

  /**
   * @param {{mode: string, verifiedOnly: boolean}} filters
   */
  function syncFilterControls(filters) {
    const selected = filters.mode || "all";
    for (const input of root.querySelectorAll("input[name='mode-filter']")) {
      input.checked = input.value === selected;
    }
    const verified = root.querySelector("input[name='verified-only']");
    if (verified) verified.checked = filters.verifiedOnly;
  }

  function applyCurrentFilters() {
    if (sourceModel.status !== "ready") return;
    render(api.applyFilters(sourceModel, currentFilters()));
  }

  /**
   * @param {ReturnType<typeof api.adaptThreadspanState>} nextSource
   */
  function show(nextSource) {
    sourceModel = nextSource;
    if (nextSource.status === "ready" && nextSource.route && nextSource.pickerRoutes.length) hydratePickerPreferences();
    render(nextSource.status === "ready" ? api.applyFilters(nextSource, nextSource.filters) : nextSource);
  }

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    const expanded = toggle.getAttribute("aria-expanded") !== "true";
    if (expanded) setPickerExpanded(false);
    setExpanded(expanded);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pickerToggle?.getAttribute("aria-expanded") === "true") {
      event.preventDefault();
      setPickerExpanded(false);
      pickerToggle.focus();
    } else if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setExpanded(false);
      toggle.focus();
    }
  });

  root.querySelector("[data-field='filters']")?.addEventListener("change", applyCurrentFilters);
  bindPickerControls();
  bindAppearance();
  bindAccountControls();
  bindMaximumUtilizationControls();
  bindCopyReviewControls();
  bindCopyCheckControls();
  bindTipControls();
  bindGlossarySearch();

  const explicitState = new URLSearchParams(location.search).get("state") || "";
  const requested = safeStateUrl(explicitState || (location.pathname.startsWith("/threadspan/") ? "./state" : ""));
  if (!requested) {
    show(sourceModel);
    return;
  }

  show(api.adaptThreadspanState({ status: "loading" }));
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (fragment.get("token")) {
    try { sessionStorage.setItem("threadspan-token", fragment.get("token")); } catch {}
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  try { localToken = sessionStorage.getItem("threadspan-token") || ""; } catch {}
  fetch(requested, { credentials: "same-origin", headers: localToken ? { authorization: `Bearer ${localToken}` } : {} })
    .then((response) => {
      if (!response.ok) throw new Error("State request failed.");
      return response.json();
    })
    .then((json) => {
      showPublishedTip(json?.hud?.tip);
      show(api.adaptThreadspanState(json));
    })
    .catch(() => {
      hideTip();
      show(api.adaptThreadspanState({
        status: "error",
        message: "Live JSON state could not be read. Synthetic demo was not substituted automatically.",
      }));
    });

  function bindAccountControls() {
    const dialog = document.querySelector("[data-field='account-dialog']");
    const form = document.querySelector("[data-field='account-form']");
    const add = root.querySelector("[data-action='add-account']");
    if (!dialog || !form || !add) return;
    const auth = form.elements.authKind;
    const provider = form.elements.providerId;
    const instructions = form.querySelector("[data-field='account-instructions']");
    const refreshInstructions = () => {
      const descriptor = sourceModel.accounts.descriptors.find((item) => item.authKind === auth.value);
      instructions.textContent = descriptor?.instructions || "Use the provider's native authentication flow. Threadspan never collects credential values.";
    };
    add.addEventListener("click", () => {
      provider.replaceChildren(...sourceModel.routeMap.nodes.map((node) => new Option(node.label, node.id)));
      auth.replaceChildren(...sourceModel.accounts.descriptors.map((item) => new Option(item.label, item.authKind)));
      refreshInstructions();
      dialog.showModal();
    });
    auth.addEventListener("change", refreshInstructions);
    form.querySelector("[data-action='cancel-account']")?.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      void mutateAccount("POST", "/v1/accounts", {
        label: data.get("label"), providerId: data.get("providerId"), authKind: data.get("authKind"),
        authSourceRef: data.get("authSourceRef"), profileRef: data.get("profileRef"),
      }).then(() => { form.reset(); dialog.close(); }).catch(() => undefined);
    });
  }

  async function mutateAccount(method, path, body) {
    const error = document.querySelector("[data-field='account-error']");
    if (!localToken) { if (error) error.textContent = "Account changes require the owner-private daemon token."; throw new Error("Missing owner token"); }
    const response = await fetch(path, { method, credentials: "same-origin", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) { const message = json.error?.message || `Account request failed (${response.status}).`; if (error) error.textContent = message; throw new Error(message); }
    if (error) error.textContent = "";
    if (requested) {
      const state = await fetch(requested, { credentials: "same-origin", headers: { authorization: `Bearer ${localToken}` } });
      if (state.ok) show(api.adaptThreadspanState(await state.json()));
    }
    return json;
  }

  function bindMaximumUtilizationControls() {
    root.querySelector("[data-action='refresh-native-quota']")?.addEventListener("click", () => { void mutateMaximumUtilization("/v1/maximum-utilization/refresh-native"); });
    root.querySelector("[data-action='disable-maximum-utilization']")?.addEventListener("click", () => { void mutateMaximumUtilization("/v1/maximum-utilization/disable"); });
    root.querySelector("[data-action='disable-automatic-takeover']")?.addEventListener("click", () => { void mutateMaximumUtilization("/v1/automatic-takeover/disable"); });
    root.querySelector("[data-action='leave-manual-full-push']")?.addEventListener("click", () => { void mutateMaximumUtilization("/v1/maximum-utilization/manual/leave"); });
    root.querySelector("[data-action='enter-manual-full-push']")?.addEventListener("click", () => {
      const kind = root.querySelector("[name='manual-scope-kind']")?.value;
      const label = root.querySelector("[name='manual-scope-label']")?.value?.trim();
      void mutateMaximumUtilization("/v1/maximum-utilization/manual/enter", { scope: { kind, label }, manifest: [] });
    });
  }

  async function mutateMaximumUtilization(path, body = {}) {
    const error = root.querySelector("[data-field='maximum-utilization-error']");
    if (!localToken) { if (error) error.textContent = "Maximum-utilization controls require the owner-private daemon token."; return; }
    const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) { if (error) error.textContent = json.error?.message || `Control request failed (${response.status}).`; return; }
    if (error) error.textContent = "";
    if (requested) {
      const state = await fetch(requested, { credentials: "same-origin", headers: { authorization: `Bearer ${localToken}` } });
      if (state.ok) show(api.adaptThreadspanState(await state.json()));
    }
  }

  function renderCopyCheckPolicy(policy) {
    const note = root.querySelector("[data-field='copy-check-policy']");
    if (!note) return;
    const mode = policy?.permissionMode || "off";
    const maxInputChars = policy?.maxInputChars || 12000;
    const pangramUrl = safeExternalHttpsUrl(policy?.adapters?.pangram?.officialUrl);
    activeCopyCheckPolicy = { permissionMode: mode, maxInputChars, pangramUrl };
    const text = root.querySelector("[data-field='copy-check-form'] textarea[name='text']");
    const pangramLink = root.querySelector("[data-action='pangram-open']");
    if (text) text.maxLength = maxInputChars;
    if (pangramLink) {
      if (pangramUrl) pangramLink.setAttribute("href", pangramUrl);
      else pangramLink.removeAttribute("href");
      pangramLink.hidden = true;
    }
    note.textContent = `Permission mode: ${mode}. Credentials existing do not enable checks. Payload cap ${maxInputChars} characters. ${policy?.partnershipNote || "Threadspan has no partnership with these vendors."} ${policy?.disclaimer || "External detector results are advisory and cannot prove authorship."}`;
  }

  function bindCopyCheckControls() {
    const form = root.querySelector("[data-field='copy-check-form']");
    if (!form) return;
    const status = root.querySelector("[data-field='copy-check-status']");
    const results = root.querySelector("[data-field='copy-check-results']");
    const pangramLink = root.querySelector("[data-action='pangram-open']");
    const selectedAdapters = () => [...form.querySelectorAll("input[name='adapter']:checked")].map((input) => input.value);
    const showResults = (payload) => {
      if (results) results.replaceChildren();
      for (const item of payload?.results ?? payload?.external?.results ?? []) {
        const row = document.createElement("li");
        row.textContent = `${item.adapter ?? "adapter"} · ${item.status ?? "unknown"} · ${item.score ?? "no score"} · ${item.checkedAt ?? ""} · ${item.displayText ?? ""}`;
        results?.appendChild(row);
      }
      if (status) status.textContent = payload?.releaseFailed === false
        ? "Release review finished. External failure cannot fail a release."
        : `${payload?.results?.length ?? 0} advisory result(s). Never averaged, never proof of authorship.`;
    };
    const postCopyCheck = async (path, body) => {
      if (!localToken) { if (status) status.textContent = "External copy check requires the owner-private daemon token."; return; }
      if (status) status.textContent = "Checking…";
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value?.error?.message || `Copy check failed (${response.status}).`);
      showResults(value);
      return value;
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const data = new FormData(form);
        await postCopyCheck("/v1/copy/check", {
          trigger: "manual",
          action: "check",
          text: data.get("text"),
          adapters: selectedAdapters(),
          acknowledgeRetention: data.get("acknowledgeRetention") === "on",
          confirmed: data.get("confirmed") === "on",
        });
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    root.querySelector("[data-action='pangram-handoff']")?.addEventListener("click", async (event) => {
      event.preventDefault();
      const text = form.elements.text?.value ?? "";
      const confirmed = form.elements.confirmed?.checked === true;
      if (activeCopyCheckPolicy.permissionMode === "off") {
        if (status) status.textContent = "External copy check is off.";
        return;
      }
      if (activeCopyCheckPolicy.permissionMode === "ask-every-time" && !confirmed) {
        if (status) status.textContent = "Confirm this check first.";
        return;
      }
      if (!activeCopyCheckPolicy.pangramUrl) {
        if (status) status.textContent = "Pangram's reviewed HTTPS link is unavailable.";
        return;
      }
      if (pangramLink) pangramLink.hidden = true;
      try {
        const payload = await postCopyCheck("/v1/copy/check", { trigger: "manual", action: "pangram-handoff", text, confirmed });
        const handoff = payload?.results?.find((item) => item.adapter === "pangram" && item.status === "handoff");
        if (!handoff) return;
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        if (pangramLink) {
          pangramLink.hidden = false;
          pangramLink.focus();
        }
        if (status) status.textContent = "Text copied. Open Pangram, paste it there, then paste the result back here.";
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
    root.querySelector("[data-action='pangram-record']")?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await postCopyCheck("/v1/copy/check", {
          trigger: "manual",
          action: "pangram-record",
          pangramResult: form.elements.pangramResult?.value ?? "",
          confirmed: form.elements.confirmed?.checked === true,
        });
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }

  function bindCopyReviewControls() {
    const form = root.querySelector("[data-field='copy-review-form']");
    if (!form) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const status = root.querySelector("[data-field='copy-review-status']");
      const suggestion = root.querySelector("[data-field='copy-review-suggestion']");
      const findings = root.querySelector("[data-field='copy-review-findings']");
      if (!localToken) { if (status) status.textContent = "Copy review requires the owner-private daemon token."; return; }
      if (status) status.textContent = "Reviewing…";
      if (findings) findings.replaceChildren();
      try {
        const data = new FormData(form);
        const response = await fetch("/v1/copy/review", {
          method: "POST",
          credentials: "same-origin",
          headers: { authorization: `Bearer ${localToken}`, "content-type": "application/json" },
          body: JSON.stringify({ text: data.get("text"), profile: data.get("profile") }),
        });
        const value = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(value?.error?.message || `Copy review failed (${response.status}).`);
        if (suggestion) suggestion.value = value.suggestion ?? value.original ?? "";
        for (const finding of value.findings ?? []) {
          const item = document.createElement("li");
          item.textContent = finding.message ?? finding.code ?? "Review finding";
          findings?.appendChild(item);
        }
        if (status) status.textContent = value.reviewRequired ? "Protected text changed; suggestion rejected for review." : `${value.status ?? "Reviewed"} · ${value.stopReason ?? "complete"}`;
      } catch (error) {
        if (status) status.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }

  function bindAppearance() {
    const defaults = { copper: "#8a3f24", teal: "#165e66" };
    const copper = root.querySelector("input[name='accent-copper']");
    const teal = root.querySelector("input[name='accent-teal']");
    const reset = root.querySelector("[data-action='reset-accents']");
    if (!copper || !teal || !reset) return;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem("threadspan-accents") || "{}"); } catch { saved = {}; }
    const valid = (value, fallback) => /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
    const apply = (next) => {
      const colors = { copper: valid(next.copper, defaults.copper), teal: valid(next.teal, defaults.teal) };
      document.documentElement.style.setProperty("--copper", colors.copper);
      document.documentElement.style.setProperty("--teal", colors.teal);
      copper.value = colors.copper;
      teal.value = colors.teal;
      try { localStorage.setItem("threadspan-accents", JSON.stringify(colors)); } catch {}
    };
    apply(saved);
    copper.addEventListener("input", () => apply({ copper: copper.value, teal: teal.value }));
    teal.addEventListener("input", () => apply({ copper: copper.value, teal: teal.value }));
    reset.addEventListener("click", () => apply(defaults));
  }
})();
