import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relative) {
  return readFile(join(root, relative), "utf8");
}

test("Threadspan sidecar assets exist as local static files", async () => {
  const files = [
    "ui/index.html",
    "ui/threadspan.css",
    "ui/threadspan.js",
    "ui/adapt-state.js",
    "ui/mark.svg",
    "docs/UI.md",
  ];
  for (const file of files) {
    const info = await stat(join(root, file));
    assert.ok(info.isFile(), `${file} should exist`);
    assert.ok(info.size > 0, `${file} should be non-empty`);
  }
});

test("sidecar JavaScript is syntactically valid without a browser", () => {
  for (const file of ["ui/adapt-state.js", "ui/threadspan.js"]) {
    const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `${file} failed node --check`);
  }
});

test("HTML carries route-bar semantics, landmarks, and HUD non-injection copy", async () => {
  const html = await read("ui/index.html");
  assert.match(html, /data-threadspan-ui="sidecar"/);
  assert.match(html, /<title>Threadspan — One task\. Every model\.<\/title>/);
  assert.match(html, /Skip to route bar/);
  assert.match(html, /<header id="threadspan-bar"/);
  assert.match(html, /<main id="threadspan-drawer"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="threadspan-drawer"/);
  assert.match(html, /data-hud-injection="not-assumed"/);
  assert.match(html, /documented Desktop HUD injection is not assumed/i);
  assert.match(html, /local daemon/i);
  assert.match(html, /opened independently/i);
  assert.match(html, /plugin or MCP UI surface/i);
  for (const field of [
    "route",
    "mode",
    "availability",
    "quota",
    "context",
    "fallbacks",
    "checkpoint",
    "utilization",
    "history",
    "route-map",
    "route-picker",
    "appearance",
    "compatibility",
    "maximum-utilization",
    "tip",
    "glossary",
    "filters",
    "reroute",
  ]) {
    assert.match(html, new RegExp(`data-field="${field}"`));
  }
  assert.match(html, />Consult</);
  assert.match(html, />Integrated</);
  assert.match(html, />Delegate</);
  assert.match(html, /ckpt_18f2/);
  assert.match(html, /qualified fallbacks/i);
  assert.match(html, /does not apply automatic failover/i);
  assert.match(html, /data-action="dismiss-tip"/);
  assert.match(html, /data-action="disable-tips"/);
  assert.match(html, /data-action="refine-tip"[^>]+hidden/);
  assert.match(html, /data-action="ask-tip"[^>]+hidden/);
  assert.match(html, /data-field="tip-dialog"/);
  assert.match(html, /data-action="escalate-tip"/);
  assert.match(html, /data-field="glossary-search"/);
  const routeToggleStart = html.indexOf('id="route-toggle"');
  const routeToggleEnd = html.indexOf("</button>", routeToggleStart);
  const pickerToggleStart = html.indexOf('id="route-picker-toggle"');
  assert.ok(routeToggleStart >= 0 && routeToggleEnd > routeToggleStart && pickerToggleStart > routeToggleEnd, "picker trigger is a sibling, not an interactive child of the route toggle");
  assert.match(html, /id="route-picker-toggle"[\s\S]*?aria-controls="threadspan-picker"[\s\S]*?aria-haspopup="dialog"/);
  assert.match(html, /id="threadspan-picker"[\s\S]*?role="dialog"[\s\S]*?aria-labelledby="route-picker-heading"/);
  assert.match(html, /type="search"[^>]+name="picker-query"/);
  assert.match(html, /name="picker-mode"/);
  assert.match(html, /name="picker-provider"/);
  assert.match(html, /name="picker-model"/);
  assert.match(html, /name="picker-free-only"/);
  assert.match(html, /name="picker-favorites-only"/);
  assert.match(html, /name="picker-show-hidden"/);
  assert.match(html, /data-action="reset-picker-order"/);
  assert.match(html, /data-action="copy-picker-route"/);
  assert.match(html, /data-field="route-map"[^>]+role="region"/);
  assert.match(html, /data-field="picker-announcement"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(html, /<details[^>]+data-field="picker-advanced-filters"[^>]*\sopen(?:\s|>)/i);
  assert.doesNotMatch(html, /<details[^>]+id="threadspan-glossary"[^>]*\sopen(?:\s|>)/i);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  assert.match(html, /href="\.\/threadspan\.css"/);
  assert.match(html, /src="\.\/mark\.svg"/);
  assert.match(html, /src="\.\/adapt-state\.js"/);
  assert.match(html, /src="\.\/threadspan\.js"/);
});

test("CSS is local, high-contrast, reduced-motion aware, and not glass or purple", async () => {
  const css = await read("ui/threadspan.css");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /Threadspan alone owns this copper\/teal accent pair/);
  assert.match(css, /appearance-disclosure/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /"Segoe UI"/);
  assert.match(css, /Ubuntu/);
  assert.match(css, /min-height:\s*2\.5rem/);
  assert.match(css, /route-picker__toggle/);
  assert.match(css, /route-picker__item/);
  assert.match(css, /provider-context/);
  assert.match(css, /provider-context--attention/);
  assert.match(css, /min-height:\s*2\.75rem/);
  assert.match(css, /route-picker__list[\s\S]*?max-height:/);
  assert.match(css, /@media \(max-width: 40rem\)[\s\S]*?route-picker__filter-grid[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*?route-picker__item/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*?provider-context--attention/);
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /glass/i);
  assert.doesNotMatch(css, /url\(["']?https?:/i);
  assert.doesNotMatch(css, /purple|violet|magenta|indigo|fuchsia/i);
});

test("mark.svg is an editable vector routing gate without raster assets", async () => {
  const svg = await read("ui/mark.svg");
  assert.match(svg, /<svg[\s\S]*viewBox="0 0 32 32"/);
  assert.match(svg, /id="route-input"/);
  assert.match(svg, /id="route-selector"/);
  assert.match(svg, /id="route-primary"/);
  assert.match(svg, /id="route-fallback"/);
  assert.match(svg, /<path /);
  assert.match(svg, /<circle /);
  assert.match(svg, /<title/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<image[\s>]/);
  assert.doesNotMatch(svg, /xlink:href=/);
  assert.doesNotMatch(svg, /href=["']https?:/);
});

test("adapter normalizes synthetic JSON and fails closed on bad state", async () => {
  const source = await read("ui/adapt-state.js");
  const sandbox = { globalThis: {}, URL };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, vm.createContext(sandbox));
  const api = sandbox.ThreadspanState;
  assert.equal(typeof api.adaptThreadspanState, "function");
  assert.equal(api.SYNTHETIC_STATE.hud.assumedInjection, false);

  const ready = api.adaptThreadspanState(api.SYNTHETIC_STATE);
  assert.equal(ready.status, "ready");
  assert.equal(ready.product.tagline, "One task. Every model.");
  assert.equal(ready.route.mode, "delegate");
  assert.equal(ready.route.verified, true);
  assert.equal(ready.fallbacks.length, 2);
  assert.ok(ready.fallbacks.every((row) => row.qualified));
  assert.equal(ready.checkpoint.id, "ckpt_18f2");
  assert.equal(ready.context.percentUsed, 41);
  assert.equal(ready.reroute.actor, "operator");
  assert.match(ready.modeNote, /bounded execution task/i);
  assert.equal(ready.hud.assumedInjection, false);
  assert.equal(ready.forecast.status, "rate-only");
  assert.equal(ready.forecast.limitKnown, false);
  assert.match(ready.forecast.burn.rateLabel, /turns\/hour/);

  const copyCheckReady = api.adaptThreadspanState({
    status: "ready",
    route: { id: "consult/mock/m", mode: "consult", provider: "mock", model: "m" },
    copyCheck: {
      permissionMode: "ask-every-time",
      enabled: true,
      adapters: { pangram: { configured: true, runnable: true, officialUrl: "https://www.pangram.com/" } },
    },
  });
  assert.equal(copyCheckReady.copyCheck.adapters.pangram.officialUrl, "https://www.pangram.com/");
  const unsafePangramUrl = new URL("https://www.pangram.com/");
  unsafePangramUrl.username = "user";
  unsafePangramUrl.password = "secret";
  const unsafeCopyCheck = api.adaptThreadspanState({
    status: "ready",
    route: { id: "consult/mock/m", mode: "consult", provider: "mock", model: "m" },
    copyCheck: { adapters: { pangram: { officialUrl: unsafePangramUrl.href } } },
  });
  assert.equal(unsafeCopyCheck.copyCheck.adapters.pangram.officialUrl, "");

  const sanitized = api.adaptThreadspanState({
    status: "ready",
    route: { id: "consult/mock/m", mode: "consult", provider: "mock", model: "m" },
    quota: { remaining: null, allowance: null, resetAt: null, renewalAt: null, source: "not-observed" },
    forecast: {
      status: "rate-only", source: "sanitized-usage-ledger", evidenceClass: "live-provider", observedAt: "2026-08-17T18:00:00Z",
      compatibilityKey: "private-pool", identity: "private-identity", prompt: "private prompt",
      burn: { unit: "turns", amount: 3, ratePerHour: 1.23456789, rateLabel: "fake precise secret" },
      coverage: { ratio: 0.5, eventCount: 3, scannedEventCount: 3 }, freshness: { status: "fresh", ageMs: 0 },
      confidence: { level: "medium", reason: "partial temporal coverage" }, sampleInterval: {}, limitKnown: false,
      entitlement: { identity: "private-plan", allowance: null, remaining: null, source: "not-observed" },
    },
    maximumUtilization: {
      enabled: true, phase: "maximum-utilization", readiness: "active", epoch: 4,
      bucketId: "private-bucket", accountId: "private-account", receipt: "private-receipt", actions: [{ body: "private-body", path: "/private/path" }],
      quota: { usedRatio: 0.97, observedAt: "2026-08-17T18:00:00Z", resetAt: "2026-08-18T18:00:00Z" },
      counts: { protectedTasks: 2, notices: 2, inboxPending: 1, suspendedMonitors: 1, overruns: 0, provisionalOutputs: 1 },
      statuses: { pendingActions: 3, unsupportedActions: 1, executedActions: 2, manifest: "requested", fastCanary: "not-requested", recovery: "unconfirmed" },
    },
  });
  assert.equal(sanitized.quota, null, "an unknown authoritative quota remains null");
  assert.equal(sanitized.forecast.burn.rateLabel, "1.23 turns/hour");
  assert.doesNotMatch(JSON.stringify(sanitized.forecast), /private|identity|compatibilityKey|fake precise secret/);
  assert.equal(sanitized.maximumUtilization.phase, "maximum-utilization");
  assert.equal(sanitized.maximumUtilization.quota.usedRatio, 0.97);
  assert.doesNotMatch(JSON.stringify(sanitized.maximumUtilization), /private-bucket|private-account|private-receipt|private-body|\/private\/path|bucketId|accountId|receipt/);

  const filtered = api.applyFilters(ready, { mode: "consult", verifiedOnly: true });
  assert.equal(filtered.fallbacks.length, 2);
  assert.equal(filtered.history.length, 1);
  assert.equal(filtered.history[0].event, "consult-complete");

  assert.equal(api.adaptThreadspanState(null).status, "empty");
  assert.equal(api.adaptThreadspanState("nope").status, "error");
  assert.equal(api.adaptThreadspanState({ status: "loading" }).status, "loading");
  assert.equal(api.adaptThreadspanState({ route: { id: "other/x/y", mode: "other" } }).status, "empty");
});

test("docs describe independent hosting and refuse assumed Desktop HUD injection", async () => {
  const docs = await read("docs/UI.md");
  assert.match(docs, /HUD injection is not assumed/i);
  assert.match(docs, /Served by the local daemon/);
  assert.match(docs, /Opened independently/);
  assert.match(docs, /plugin or MCP UI surface/i);
  assert.match(docs, /adaptThreadspanState/);
  assert.match(docs, /snapshot is not a security sandbox/i);
  assert.match(docs, /not automatic failover/i);
  assert.match(docs, /not live-certified/i);
});

test("renderer keeps authoritative quota and local recent-burn projection visibly separate", async () => {
  const source = await read("ui/threadspan.js");
  assert.match(source, /Authoritative quota, allowance, and reset\/renewal are not published/);
  assert.match(source, /Recent burn:/);
  assert.match(source, /forecastEvidence/);
  assert.match(source, /projected exhaustion/);
});

test("HUD state is initialized before the first render can use it", async () => {
  const source = await read("ui/threadspan.js");
  const declaration = source.indexOf('let activeCopyCheckPolicy = { permissionMode: "off"');
  const firstUse = source.indexOf("renderCopyCheckPolicy(next.copyCheck)");
  assert.ok(declaration >= 0);
  assert.ok(firstUse >= 0);
  assert.ok(declaration < firstUse, "copy-check policy must exist before the first synthetic or live render");
});

test("optional HUD tips are heuristic-first, compact, foreground-only, and budget bounded", async () => {
  const source = await read("ui/threadspan.js");
  assert.match(source, /TIP_SESSION_KEY/);
  assert.match(source, /TIP_PREFERENCES_KEY/);
  assert.match(source, /shownThisSession/);
  assert.match(source, /preferences\.disabled/);
  assert.match(source, /tip\.cooldownMs/);
  assert.match(source, /data-action='dismiss-tip'/);
  assert.match(source, /data-action='disable-tips'/);
  assert.match(source, /message\.length <= 180/);
  assert.match(source, /showPublishedTip\(json\?\.hud\?\.tip\)/);
  assert.doesNotMatch(source.slice(source.indexOf("function showPublishedTip"), source.indexOf("function bindTipControls")), /fetch\(|consultTip\(/);
  assert.match(source, /addEventListener\("click", refineTip\)/);
  assert.match(source, /addEventListener\("click", openTipConversation\)/);
  assert.match(source, /form\?\.addEventListener\("submit", askAboutTip\)/);
  assert.match(source, /maxCallsPerSession !== 1/);
  assert.match(source, /askTurns >= tip\.model\.ask\.maxTurnsPerSession/);
  assert.match(source, /maxOutputTokens: tip\.model\.maxOutputTokens/);
  assert.match(source, /AbortController/);
  assert.match(source, /allowWebSearch: false/);
  assert.match(source, /allowSubagents: false/);
  assert.match(source, /threadspan_tip_kind: "refine"/);
  assert.match(source, /threadspan_tip_kind: "ask"/);
  assert.match(source, /threadspan:tip-escalate/);
  assert.match(source, /No mini-conversation transcript is attached/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^\n]*(?:askThreadId|tip-transcript|result\.text)/);
});

test("HUD picker stays local, accessible, reorderable, and separate from native routing", async () => {
  const source = await read("ui/threadspan.js");
  const pickerStart = source.indexOf("function renderPicker");
  const pickerEnd = source.indexOf("function currentFilters", pickerStart);
  const pickerSource = source.slice(pickerStart, pickerEnd);
  assert.match(source, /PICKER_PREFERENCES_KEY = "threadspan-hud-picker-preferences-v1"/);
  assert.match(source, /textContent = "Move up"/);
  assert.match(source, /textContent = "Move down"/);
  assert.match(source, /item\.draggable = supportsDrag/);
  assert.match(source, /dataTransfer\?\.setData\("text\/plain", route\.id\)/);
  assert.match(source, /Smart route order restored\. Favorites and filters were kept/);
  assert.match(source, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(source, /Active route shown despite the current filters/);
  assert.match(source, /function restorePickerFocus/);
  assert.match(source, /dataset\.pickerAction/);
  const hydrateStart = source.indexOf("function hydratePickerPreferences");
  const hydrateEnd = source.indexOf("function dispatchPickerPreference", hydrateStart);
  assert.doesNotMatch(source.slice(hydrateStart, hydrateEnd), /select-route/, "the active route is not persisted as an explicit local selection");
  assert.doesNotMatch(pickerSource, /fetch\(|\/v1\//);
  assert.doesNotMatch(source, /\/v1\/(?:route|routing|models?)\b/);
});

test("contextual provider links are inline, HTTPS-normalized, and safe external anchors", async () => {
  const html = await read("ui/index.html");
  const source = await read("ui/threadspan.js");
  const adapter = await read("ui/adapt-state.js");
  assert.match(adapter, /function normalizeProviderWebMetadata/);
  assert.match(adapter, /url\.protocol !== "https:"/);
  assert.match(adapter, /url\.username \|\| url\.password \|\| url\.search \|\| url\.hash/);
  assert.match(source, /function providerContextEl/);
  assert.match(source, /document\.createElement\("a"\)/);
  assert.match(source, /link\.target = "_blank"/);
  assert.match(source, /link\.rel = "noopener noreferrer external"/);
  assert.match(source, /link\.referrerPolicy = "no-referrer"/);
  assert.match(source, /opens in a new tab/);
  assert.match(source, /creditState === "low"/);
  assert.match(source, /expiryState === "approaching"/);
  assert.doesNotMatch(source, /window\.open\(|alert\(/);
  assert.doesNotMatch(html, /href="https:\/\//i, "no provider URL is hardcoded into the static HUD");
});
