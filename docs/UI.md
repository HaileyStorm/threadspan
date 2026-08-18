# Threadspan sidecar UI

**Status:** implemented as a static, offline-tested source UI. Not live-certified as a ChatGPT/Codex Desktop overlay, plugin host, or MCP UI renderer.

Threadspan is the operator-facing route surface for this bridge: **one task, every model**, without collapsing Consult, Integrated, and Delegate into a single “use another model” switch.

The host HUD is deliberately neutral. Threadspan owns a restrained copper-and-teal routing gate and boundary accent, keeping the sidecar visually related but clearly distinct without competing for attention.

Accent colors can be changed under the collapsed **Appearance** disclosure. The choice is browser-local, never changes the host HUD, and can be reset to the shipped pair.

## What this is

`ui/` is a dependency-free HTML/CSS/JS/SVG sidecar:

- a compact **collapsed route bar** with an in-bar route picker, meant to sit *beneath* a host agent-status HUD;
- an **expanded drawer** for the current route, mode authority, verified availability, quota/context, two qualified fallbacks, checkpoint, provider utilization, history, filters, and a visible reroute event;
- a small editable vector mark (`ui/mark.svg`);
- synthetic demo state plus `adaptThreadspanState()` for a future live JSON payload.

No images, webfonts, CDNs, or JavaScript packages are required.

## Host HUD injection is not assumed

Documented Desktop HUD injection is **not** implemented or assumed.

The dark strip at the top of `ui/index.html` is an illustrative **host-agent placeholder** so the route bar’s intended position is obvious. A current ChatGPT/Codex Desktop build is not required to open this UI, and this package does not inject into Desktop chrome.

This UI can be:

1. **Served by the local daemon** as static files from `ui/` (when that serving path is wired);
2. **Opened independently** in a desktop browser from `ui/index.html` (file open or any local static server);
3. **Hosted through a supported plugin or MCP UI surface** that can display a local HTML document.

Until a host actually provides a HUD, the placeholder remains visible. Do not treat the placeholder as a live agent-status feed.

## Routing-gate layout

The visual system is a live switchyard, not a dashboard:

- one task reaches a visible selector and continues through the primary or fallback route;
- the collapsed bar is a compact route line under the host HUD;
- the expanded drawer continues the switch as a split left spine on wide viewports, then a two-column inspector (route facts | capacity and history);
- on narrow Ubuntu/Windows windows the spine hides and the drawer stacks.

Mode uses **non-color structure** as well as labels: dashed = Consult, dotted = Integrated, solid = Delegate.

## HUD route picker preferences

The **Pick route** control is part of the existing route bar. It is not a second app and does not replace or inject into a native Desktop model picker. Selecting a row updates the browser-local displayed choice and exposes the exact Threadspan route string for copying. It does not call a routing mutation endpoint, change the daemon’s active route, or claim to change native Desktop selection.

The default list is capped to a compact set in the registry’s published smart order. Search and the collapsed-by-default **Advanced filters** combine with AND semantics across mode, provider, model, explicit free metadata, and favorites. A model name ending in `:free` is not enough: **Free only** includes a route only when its metadata explicitly says `free: true`. The daemon’s active route is always included even when search, filters, hidden state, or unavailability would otherwise remove it.

Favorites, hidden state, and manual order are presentation overlays only. Drag-and-drop uses the same pure move operation as the always-visible **Move up** and **Move down** buttons. **Reset smart order** removes only the manual ordering overlay; it keeps favorites, hidden routes, the selected display route, and filters. **Show hidden/unavailable** is the recovery control for locally hidden, catalog-hidden, setup-blocked, and unavailable routes, whose published setup/capability/availability reason remains visible.

Picker preferences use the distinct browser-local key `threadspan-hud-picker-preferences-v1`. The payload is schema-versioned and contains only route IDs, route-ID ordering, the selected route ID, and filter values. Malformed or version-mismatched payloads are rejected, and route-ID fields are pruned against the current catalog. It never stores prompts, separate account identifiers, raw paths, credentials, provider response text, availability snapshots, or registry scores. Browser favorites do not feed Codex catalog `--favorite` values and never mutate `ProviderRegistry` smart ranking or `providerOrder`; existing CLI `--favorite` behavior remains independent and compatible.

Expanded route and provider details may show contextual **Official site**, **Account**, and **Usage** links only when reviewed state metadata supplies `officialUrl`, `accountUrl`, or `usageUrl`. Each value is independently revalidated as a bounded absolute HTTPS URL; URLs with credentials, query strings, fragments, invalid schemes, or parse failures are omitted rather than repaired or guessed. External links open only from an explicit click and use `noopener noreferrer`; the HUD never opens a popup, emits a toast, appends provider/account/route values, or invents a provider URL.

Context links stay inline and quiet. They receive subtle emphasis beside only explicit `creditState: "low"` or `expiryState: "approaching"` metadata (and accurately label explicit `exhausted`/`expired` states). Quota numbers, remaining credit, timestamps, provider names, and model names never cause the browser to infer those states. The closed values are `unknown|normal|low|exhausted` for credit and `unknown|current|approaching|expired` for expiry; unknown values collapse to `unknown`. When link/state metadata is absent or rejected, the rendered UI is unchanged.

Provider configuration may optionally define `officialUrl`, `accountUrl`, and `usageUrl`. Startup validation requires strict absolute HTTPS URLs with a hostname and rejects credentials, query strings, fragments, controls, surrounding whitespace, and oversized values. Accepted fields are conditionally published by `describeProviders()`, copied onto Threadspan route-map nodes, and attached to the active route; omitted fields remain structurally absent. This publication path does not create or infer `creditState` or `expiryState`. The example configuration contains reviewed links only for OpenRouter and AgentRouter.

## Modes (do not blur)

| Mode | Authority shown in the drawer |
|---|---|
| **Consult** | Secondary output is advisory. The primary owns judgment and execution. Cursor Consult still uses a disposable snapshot; that snapshot is not a security sandbox. |
| **Integrated** | The calling client owns tools. The secondary is raw inference. Cursor SDK and Grok Build cannot be presented as Integrated. |
| **Delegate** | The secondary provider’s agent owns a bounded execution task. The worker has no integration authority. |

Qualified fallbacks are **capability-checked alternatives**, not automatic failover. The visible reroute event is an explicit operator/policy action.

## Synthetic state and the adapter

`ui/adapt-state.js` exposes:

- `ThreadspanState.SYNTHETIC_STATE` — demo JSON;
- `ThreadspanState.adaptThreadspanState(raw)` — normalizes live or synthetic JSON;
- `ThreadspanState.applyFilters(model, filters)` — history/verified filtering without hiding the current route.
- `ThreadspanState.applyPickerPreferences(routes, preferences, activeRouteId)` — pure search/filter/order projection with an active-route exemption;
- `ThreadspanState.reducePickerPreferences(state, action, routeIds)` — pure favorite, hide, select, filter, move, and smart-order-reset transitions;
- `ThreadspanState.parsePickerPreferences()` / `serializePickerPreferences()` — strict schema validation and stale-route pruning.

Default boot uses synthetic data. To try a same-origin JSON document later:

```text
ui/index.html?state=./route-state.json
```

Only relative same-origin paths are accepted (`./` or `/`). Parent segments (`..`), backslashes, and absolute URLs are rejected. Failed live loads surface an error; the UI does not silently fall back to synthetic data.

Live JSON should use the same shape as `SYNTHETIC_STATE`. Unknown or missing fields fail closed (empty or error), including missing route IDs and non-Consult/Integrated/Delegate modes.

Quota copy in the demo is a **manual consumer-week meter**. Local token counts cannot reconstruct provider weekly usage. Utilization numbers are **canary values**, not Grok or Cursor service guarantees. Retained Cursor agents are daemon-keyed local agents, not an official Cloud Agent pool.

## Keyboard, contrast, motion, Windows/Ubuntu

- Skip link to the route bar; separate route-detail and picker buttons have explicit controlled regions; `Escape` closes the foremost open region and returns focus.
- History uses a native `<details>` disclosure; filters are native radio/checkbox controls with 40px-class targets.
- Picker controls use 44px-class targets; advanced filters start collapsed, move controls remain visible for keyboard/touch use, and reorder changes are announced through an ARIA live region.
- Focus is a 2px copper outline. Text is ink on linen (or Canvas/CanvasText under Windows high contrast).
- `prefers-reduced-motion: reduce` disables animation and chevron motion.
- `prefers-contrast: more` and `forced-colors: active` thicken structure and drop decorative color.
- Fonts are `system-ui, "Segoe UI", Ubuntu, "Noto Sans", sans-serif`. Layout wraps at ~40rem and ~52rem so 125%/150% Windows scaling remains readable.

## Files

| Path | Role |
|---|---|
| `ui/index.html` | Structure and static semantics |
| `ui/threadspan.css` | Layout, contrast, motion, forced colors |
| `ui/adapt-state.js` | Synthetic JSON + adapter |
| `ui/threadspan.js` | Expand/collapse, filters, optional live JSON |
| `ui/mark.svg` | Editable routing-gate mark (`#route-input`, `#route-selector`, `#route-primary`, `#route-fallback`) |

Offline checks live in `test/ui-assets.test.mjs` (file presence, semantics, adapter behavior). They do not launch a browser and are not visual or live-host acceptance.
