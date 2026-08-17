/**
 * Threadspan sidecar renderer. Depends on `adapt-state.js` attaching
 * `globalThis.ThreadspanState`. No network calls are made unless a same-origin
 * relative `?state=` URL is supplied.
 */
(function startThreadspanUi() {
  const api = globalThis.ThreadspanState;
  if (!api) return;

  const root = document.querySelector("[data-threadspan-ui]");
  const toggle = document.getElementById("route-toggle");
  const drawer = document.getElementById("threadspan-drawer");
  const banner = document.getElementById("state-banner");
  if (!root || !toggle || !drawer || !banner) return;

  /** @type {ReturnType<typeof api.adaptThreadspanState>} */
  let sourceModel = api.adaptThreadspanState(api.SYNTHETIC_STATE);
  /** @type {ReturnType<typeof api.adaptThreadspanState>} */
  let model = sourceModel;

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

    const availability = route.verified ? "verified" : "unverified";
    const availBar = root.querySelector("[data-field='availability']");
    availBar.classList.toggle("pill--ok", route.verified);
    availBar.replaceChildren(kicker("Availability"), document.createTextNode(` ${availability}`));
    root.querySelector("[data-field='availability-detail']").textContent =
      `${availability}${route.verifiedAt ? ` · ${formatUtc(route.verifiedAt)}` : ""}`;
    root.querySelector("[data-field='availability-note']").textContent = route.verificationSource;

    const quota = next.quota;
    const quotaBar = root.querySelector("[data-field='quota']");
    quotaBar.replaceChildren(kicker("Quota"), document.createTextNode(quota ? ` ${quota.percentRemaining}% week` : " unavailable"));
    const quotaDetail = root.querySelector("[data-field='quota-detail']");
    if (quota) {
      quotaDetail.replaceChildren(
        document.createTextNode(`${quota.label} · ${quota.percentRemaining}% remaining`),
        meterEl(quota.percentRemaining, 100, "Quota remaining"),
        noteEl(quota.note),
      );
    } else {
      quotaDetail.textContent = "Quota not published.";
    }

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
    syncFilterControls(next.filters);
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
    render(nextSource.status === "ready" ? api.applyFilters(nextSource, nextSource.filters) : nextSource);
  }

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    setExpanded(toggle.getAttribute("aria-expanded") !== "true");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setExpanded(false);
      toggle.focus();
    }
  });

  root.querySelector("[data-field='filters']")?.addEventListener("change", applyCurrentFilters);

  const requested = safeStateUrl(new URLSearchParams(location.search).get("state") || "");
  if (!requested) {
    show(sourceModel);
    return;
  }

  show(api.adaptThreadspanState({ status: "loading" }));
  fetch(requested, { credentials: "same-origin" })
    .then((response) => {
      if (!response.ok) throw new Error("State request failed.");
      return response.json();
    })
    .then((json) => {
      show(api.adaptThreadspanState(json));
    })
    .catch(() => {
      show(api.adaptThreadspanState({
        status: "error",
        message: "Live JSON state could not be read. Synthetic demo was not substituted automatically.",
      }));
    });
})();
