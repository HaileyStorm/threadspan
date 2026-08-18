# Threadspan Desktop HUD and sidecar UI

**Status:** the compact Electron HUD was live-accepted through the earlier attachment transport on installed Linux and Windows builds. The authenticated one-time bootstrap successor is implemented and offline-tested, but exact-build native Linux and Windows acceptance remains open. The larger browser sidecar remains available for detached use.

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

## App attachment

`threadspan desktop launch` is the only canonical path that starts the unchanged Electron app for attachment. It opens a loopback inspector only for bootstrap, requires one exact Node target plus the launched process/source identity, injects a schema-versioned main-process supervisor with a fresh per-generation capability, waits for a source-bound ready acknowledgement, and then closes and independently checks both the inspector discovery endpoint and WebSocket. Any wrong/multiple target, occupied port, identity mismatch, premature close, or later inspector reappearance fails closed.

After cutover, the Desktop host uses only the closed authenticated supervisor protocol. It supports health/identity, sanitized `sync-hud`, bounded `read-action`, and authenticated teardown—never arbitrary evaluation. Exact generation, authenticated session challenge, per-frame HMAC, sequence, and action IDs fence successor-channel spoofing and replay. The capability is private owner state; it never enters argv, environment, successor frames, renderer state, public receipts, or logs. TCP loopback is paired with mandatory token authentication; loopback alone supplies no native ACL proof. Windows native ACL enforcement remains an explicit unverified acceptance gate.

Renderer actions are untrusted and contain no secret. The supervisor accepts only the current generation, a closed `select-route` schema, a route in the last sanitized catalog, and a fresh bounded action ID; malformed, stale, or duplicate actions are rejected. Another script already running in that renderer could still propose a new schema-valid action, so the owner-authenticated daemon route validation remains authoritative.

The supervisor selects the largest visible non-destroyed ChatGPT/Codex window, uses its current `webContents`, inserts an isolated Shadow DOM HUD, and narrowly observes window creation, DOM-ready, navigation/load, renderer loss, and destruction so the last sanitized HUD is reattached idempotently. It removes listeners during authenticated teardown. Provider credentials, account-private data, and daemon bearer tokens are never copied into the renderer.

Bootstrap state is an owner-private exactly-once transaction (`prepared` → `injected` → `acknowledged` → `inspector-closed` → `attached`) with explicit `indeterminate` and `recovery-required` outcomes. It binds the exact original bootstrap port as well as generation, capability digest, endpoint, source, and package evidence. One process-shared Desktop-host claim spans the whole launch/attach session so an installed attach service cannot poison cutover or race renderer actions. Uncertainty is never reinjected or replayed. `desktop attach` reconnects only when the exact private state remains usable; it never launches, restarts, kills, signals, focuses, or navigates Desktop.

After a normal app exit or update, owner-reviewed `threadspan desktop recover` proves the recorded process is absent, the exact stored bootstrap port explicitly refuses connections, and records the current package-digest disposition before retiring the dead generation and private capability. Only then may another explicit `desktop launch` create a generation. Authenticated rollback first journals recovery, removes every tracked renderer HUD/listener, retains a capability-authenticated tombstone for crash-safe retry, verifies packages and the closed inspector, records `rolled-back`, and only then finalizes the tombstone and removes the capability. It never reopens a persistent inspector. An abandoned cooperative host or transaction claim/guard is inspected with `threadspan desktop claim` and may be preserved/released only by passing its exact reviewed digest to `desktop recover --recover-claim-digest`; it is never cleared from PID age. Guard recovery is deliberately stop-the-world: every Desktop host/service must first be stopped and the CLI requires `--confirm-hosts-stopped`, preventing it from being presented as safe concurrent recovery.

Before and after bootstrap or rollback, reviewed executable, `app.asar`, and package metadata paths are bound by exact digest or exact absence. Threadspan does not unpack, patch, replace, rename, delete, or restore Desktop packages.

The dark strip at the top of standalone `ui/index.html` remains an illustrative host placeholder. It is not used by the app-attached HUD in `src/desktop/host.mjs`.

The larger sidecar can still be:

1. **Served by the local daemon** at `/threadspan/` from the static files in `ui/`;
2. **Opened independently** in a desktop browser from `ui/index.html` (file open or any local static server);
3. **Hosted through a supported plugin or MCP UI surface** that can display a local HTML document.

If bootstrap or reattachment is unavailable after an app update/restart, Compatibility Watch keeps the daemon and detachable sidecar usable while the exact new generation is reviewed. No service silently launches or restarts the app.

The collapsed **Compatibility** disclosure shows current products plus two compact transition queues: **Needs review** for failed, interrupted, claimed/recovery-required, or rollback-incomplete exact transitions, and **Diagnostics** for pending or accepted evidence. Rows show only product, platform, N→N+1 versions, bounded status, and evidence scope. Claim IDs, artifact and path hashes, raw probe details, authentication, account state, and target contents remain server-side. A synthetic pass is visibly labeled “synthetic only” and is not native host acceptance.

## Routing-gate layout

The visual system is a live switchyard, not a dashboard:

- one task reaches a visible selector and continues through the primary or fallback route;
- the collapsed bar is a compact route line under the host HUD;
- the expanded drawer continues the switch as a split left spine on wide viewports, then a two-column inspector (route facts | capacity and history);
- on narrow Ubuntu/Windows windows the spine hides and the drawer stacks.

Mode uses **non-color structure** as well as labels: dashed = Consult, dotted = Integrated, solid = Delegate.

## HUD route picker preferences

The app-attached picker is a real Threadspan routing control. Selecting a row immediately updates the HUD, calls the owner-authenticated `/v1/desktop/route` endpoint, persists the choice locally, and applies it to Threadspan `auto` requests and matching Consult/Delegate defaults. Explicit request mode/provider/account authority still wins. The host's native OpenAI picker remains independent and available. The detachable browser picker keeps browser-local presentation preferences and does not mutate native Desktop selection.

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

The collapsed **Copy review** panel stays local. The separate **External copy check** panel is owner-token POST only, off by default, and starts Pangram, Sapling, or Winston only from an explicit button. Pangram copies selected text and opens `https://www.pangram.com/`; it never submits or scrapes the page. Results are advisory and cannot prove authorship.

## Needs you

The expanded drawer includes a compact sticky **Needs you** rail on wide viewports and places it immediately below Continuity on narrow viewports. Open items are actionable owner work; completed, stale, and closed entries are available only through explicit filters and are labeled as history rather than diagnostics or a ready queue.

Items live in a separate owner-private durable store. The public model contains only opaque action handles, bounded titles/summaries, sanitized project keys/labels, status, revision, and canonical timestamps. Native task IDs, owner references, paths, prompts, receipts, credentials, and delivery details remain server-side. `GET /v1/action-items` and `POST /v1/action-items/:handle/complete` require the main owner token on loopback; the connector token cannot call either route. Completion is revision-bound and durably enqueues one exact-owner delivery. There is no scheduled wake, polling, or acknowledgement loop.

The store's delivered records intentionally retain bounded audit capacity. Capacity exhaustion and abandoned locks fail closed as typed operator-visible errors; retention and lock recovery require a separately reviewed owner procedure.

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

The tracked screenshots and GIF under `docs/media/` are captured only from `SYNTHETIC_STATE`. `docs/media/MANIFEST.json` binds each asset to its dimensions, viewport, SHA-256, tool versions, and privacy review. Browser acceptance remains separate from static Node tests; it covers desktop and narrow layouts, picker/drawer disclosures, Escape behavior, console errors, and visible sensitive-data review without invoking providers.

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
## Continuity task tree

The companion HUD keeps Continuity collapsed by default. Expanding it shows one logical task with its origin, current generation, prior generations, and any prepared successor. Only the selected task opens automatically. Native thread IDs, Goal IDs, account IDs, receipts, paths, stable operation IDs, and recovery keys stay server-side. Only short-lived opaque task and operation handles cross the public boundary.

Rename uses the native host naming API. Promote/Rollover first shows a receipt-bound preview, then journals and posts one fixed control request to the exact task. The certified Continuity supervisor owns predecessor stop, capsule acceptance, native Goal lifecycle, rollback, and archival. Threadspan independently requires one exact worker/rw successor, predecessor inactive-plus-archive read-back, and Goal-free or objective/status/accounting parity before selecting a new generation. A post-journal timeout or malformed receipt becomes actionable `dispatch-indeterminate` state and is never replayed automatically.

The compact `aria-live` status reports the recovery phase, blocker, requested action, and bounded authority states. Rename and Promote/Rollover remain disabled while recovery is pending or native Goal evidence is unsupported/ambiguous. Static/VM interaction fixtures cover click, fetch, sanitization, and gating behavior. A Linux local true-browser smoke additionally exercised Rename, confirmed Promote, pending recovery, disabled controls, identifier-free DOM output, console cleanliness, and a 390px no-overflow layout against a synthetic API; it is not exact native App Server acceptance or Windows browser parity.
