import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(root, "ui/adapt-state.js"), "utf8");
const sandbox = { globalThis: {}, URL };
sandbox.globalThis = sandbox;
vm.runInNewContext(source, vm.createContext(sandbox));
const api = sandbox.ThreadspanState;

const routes = [
  { id: "delegate/grok/grok-4", mode: "delegate", provider: "grok", model: "grok-4", availability: "available" },
  { id: "consult/cursor/auto", mode: "consult", provider: "cursor", model: "auto", availability: "available" },
  { id: "integrated/nous/deepseek-v4", mode: "integrated", provider: "nous", model: "deepseek-v4", availability: "available" },
  { id: "integrated/openrouter/free/model:free", mode: "integrated", provider: "openrouter", model: "free/model:free", free: true, availability: "available" },
  { id: "integrated/openrouter/named:free", mode: "integrated", provider: "openrouter", model: "named:free", availability: "available" },
  { id: "delegate/claude/sonnet", mode: "delegate", provider: "claude", model: "sonnet", availability: "unavailable", setupReason: "Sign in first." },
  { id: "consult/nous/deepseek-v4", mode: "consult", provider: "nous", model: "deepseek-v4", availability: "available" },
  { id: "consult/openrouter/model-x", mode: "consult", provider: "openrouter", model: "model-x", availability: "available" },
];
const ids = routes.map((route) => route.id);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function dispatch(state, action) {
  return api.reducePickerPreferences(state, action, ids);
}

test("favorites add and remove without changing smart order", () => {
  const initial = api.createPickerPreferences();
  const added = dispatch(initial, { type: "toggle-favorite", routeId: ids[2] });
  assert.deepEqual(plain(added.favoriteRouteIds), [ids[2]]);
  assert.deepEqual(plain(added.manualOrderRouteIds), []);
  const removed = dispatch(added, { type: "toggle-favorite", routeId: ids[2] });
  assert.deepEqual(plain(removed.favoriteRouteIds), []);
  assert.deepEqual(plain(initial.favoriteRouteIds), [], "the reducer does not mutate its input");
});

test("search and mode/provider/model filters are trimmed, case-insensitive, and ANDed", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "set-filter", name: "query", value: "  DEEPSEEK  " });
  preferences = dispatch(preferences, { type: "set-filter", name: "mode", value: "consult" });
  preferences = dispatch(preferences, { type: "set-filter", name: "provider", value: "  NOUS  " });
  preferences = dispatch(preferences, { type: "set-filter", name: "model", value: "DEEPSEEK-V4" });
  const result = api.applyPickerPreferences(routes, preferences, ids[0], { showAll: true });
  assert.deepEqual(plain(result.routes.map((route) => route.id)), [ids[0], ids[6]], "active route is the only filter exemption");
  assert.equal(result.routes.find((route) => route.id === ids[0]).forcedVisible, true);
});

test("free-only uses explicit boolean metadata and never a model-name suffix", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "set-filter", name: "freeOnly", value: true });
  const result = api.applyPickerPreferences(routes, preferences, "", { showAll: true });
  assert.deepEqual(plain(result.routes.map((route) => route.id)), [ids[3]]);
  assert.equal(result.routes.some((route) => route.id === ids[4]), false);
});

test("picker metadata cannot contradict the exact executable route string", () => {
  const [route] = api.adaptPickerRoutes([{
    id: "consult/provider/model/name",
    mode: "delegate",
    provider: "different-provider",
    model: "different-model",
    availability: "available",
  }]);
  assert.equal(route.mode, "consult");
  assert.equal(route.provider, "provider");
  assert.equal(route.model, "model/name");
});

test("reviewed provider web metadata is HTTPS-only, credential-safe, and never inferred", () => {
  const valid = api.normalizeProviderWebMetadata({
    officialUrl: "https://provider.example/docs",
    accountUrl: "https://account.provider.example/",
    usageUrl: "https://provider.example/usage",
    creditState: "low",
    expiryState: "approaching",
  });
  assert.deepEqual(plain(valid), {
    providerLinks: {
      officialUrl: "https://provider.example/docs",
      accountUrl: "https://account.provider.example/",
      usageUrl: "https://provider.example/usage",
    },
    creditState: "low",
    expiryState: "approaching",
  });

  for (const unsafe of [
    "http://provider.example",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "https://user:secret@provider.example/account",
    "https://provider.example/usage?token=secret",
    "https://provider.example/usage#account",
    "/relative/provider",
    "not a url",
  ]) {
    assert.equal(api.normalizeProviderWebMetadata({ officialUrl: unsafe }).providerLinks.officialUrl, "", unsafe);
  }

  assert.deepEqual(plain(api.normalizeProviderWebMetadata({
    remainingCredits: 0,
    expiresAt: "2026-08-19T00:00:00Z",
    creditState: "almost-low",
    expiryState: "soon-ish",
  })), {
    providerLinks: { officialUrl: "", accountUrl: "", usageUrl: "" },
    creditState: "unknown",
    expiryState: "unknown",
  });
});

test("provider links and explicit account states survive route-map generation only when supplied", () => {
  const ready = api.adaptThreadspanState({
    status: "ready",
    route: { id: "consult/provider/model", mode: "consult", provider: "provider", model: "model" },
    routeMap: {
      nodes: [{
        id: "provider",
        label: "Provider",
        availability: "available",
        modes: ["consult"],
        models: ["model"],
        officialUrl: "https://provider.example/",
        usageUrl: "https://provider.example/usage",
        creditState: "low",
        expiryState: "approaching",
      }],
      edges: [{ mode: "consult", provider: "provider", priority: 1, weight: 0 }],
    },
  });
  assert.equal(ready.pickerRoutes[0].providerLinks.officialUrl, "https://provider.example/");
  assert.equal(ready.pickerRoutes[0].providerLinks.usageUrl, "https://provider.example/usage");
  assert.equal(ready.pickerRoutes[0].creditState, "low");
  assert.equal(ready.pickerRoutes[0].expiryState, "approaching");

  const unchanged = api.adaptPickerRoutes([{ id: "consult/plain/model", availability: "available" }])[0];
  assert.deepEqual(plain(unchanged.providerLinks), { officialUrl: "", accountUrl: "", usageUrl: "" });
  assert.equal(unchanged.creditState, "unknown");
  assert.equal(unchanged.expiryState, "unknown");
});

test("the active route remains visible through hidden, unavailable, and AND filters", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "toggle-hidden", routeId: ids[5] });
  preferences = dispatch(preferences, { type: "set-filter", name: "query", value: "no-match" });
  preferences = dispatch(preferences, { type: "set-filter", name: "mode", value: "consult" });
  preferences = dispatch(preferences, { type: "set-filter", name: "freeOnly", value: true });
  const result = api.applyPickerPreferences(routes, preferences, ids[5], { showAll: true });
  assert.deepEqual(plain(result.routes.map((route) => route.id)), [ids[5]]);
  assert.equal(result.routes[0].active, true);
  assert.equal(result.routes[0].hiddenByPreference, true);
  assert.equal(result.routes[0].forcedVisible, true);
});

test("show hidden/unavailable is a recovery control for hidden and setup-blocked routes", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "toggle-hidden", routeId: ids[1] });
  const hidden = api.applyPickerPreferences(routes, preferences, ids[0], { showAll: true });
  assert.equal(hidden.routes.some((route) => route.id === ids[1]), false);
  assert.equal(hidden.routes.some((route) => route.id === ids[5]), false);
  preferences = dispatch(preferences, { type: "set-filter", name: "showHiddenUnavailable", value: true });
  const recovered = api.applyPickerPreferences(routes, preferences, ids[0], { showAll: true });
  assert.equal(recovered.routes.some((route) => route.id === ids[1] && route.hiddenByPreference), true);
  assert.equal(recovered.routes.some((route) => route.id === ids[5] && route.setupReason), true);

  const setupBlocked = { id: "consult/setup/model", mode: "consult", provider: "setup", model: "model", availability: "available", setupReason: "Complete native sign-in." };
  const setupDefault = api.applyPickerPreferences([routes[0], setupBlocked], api.createPickerPreferences(), routes[0].id, { showAll: true });
  assert.equal(setupDefault.routes.some((route) => route.id === setupBlocked.id), false);
  let setupRecovery = api.createPickerPreferences();
  setupRecovery = api.reducePickerPreferences(setupRecovery, { type: "set-filter", name: "showHiddenUnavailable", value: true }, [routes[0].id, setupBlocked.id]);
  assert.equal(api.applyPickerPreferences([routes[0], setupBlocked], setupRecovery, routes[0].id, { showAll: true }).routes.some((route) => route.id === setupBlocked.id), true);
});

test("smart baseline is stable and the default result stays compact", () => {
  const preferences = api.createPickerPreferences();
  const compact = api.applyPickerPreferences(routes, preferences, ids[0]);
  assert.deepEqual(plain(compact.routes.map((route) => route.id)), [...ids.slice(0, 5), ids[6]], "unavailable routes are not part of the compact default");
  assert.equal(compact.hiddenByCompactCount, 1);
  assert.equal(compact.hiddenUnavailableCount, 1);
  const all = api.applyPickerPreferences(routes, preferences, ids[0], { showAll: true });
  assert.deepEqual(plain(all.routes.map((route) => route.id)), ids.filter((id) => id !== ids[5]));
  assert.deepEqual(plain(preferences.manualOrderRouteIds), []);

  const lateActive = api.applyPickerPreferences(routes, preferences, ids[7]);
  assert.equal(lateActive.routes.length, 6);
  assert.equal(lateActive.routes.some((route) => route.id === ids[7] && route.active), true, "compact slicing retains a late active route");
});

test("drag and always-visible move buttons reduce to the same manual order", () => {
  const initial = api.createPickerPreferences();
  const drag = dispatch(initial, { type: "move-route", routeId: ids[2], toIndex: 1 });
  const currentIndex = ids.indexOf(ids[2]);
  const moveUp = dispatch(initial, { type: "move-route", routeId: ids[2], toIndex: currentIndex - 1 });
  assert.deepEqual(plain(drag.manualOrderRouteIds), plain(moveUp.manualOrderRouteIds));
  assert.deepEqual(plain(drag.manualOrderRouteIds.slice(0, 4)), [ids[0], ids[2], ids[1], ids[3]]);
  assert.deepEqual(plain(dispatch(initial, { type: "move-route", routeId: ids[2], toIndex: currentIndex })), plain(initial), "a self-drop does not freeze smart order");
});

test("reset smart order is idempotent and preserves favorites, selection, hidden routes, and filters", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "toggle-favorite", routeId: ids[3] });
  preferences = dispatch(preferences, { type: "toggle-hidden", routeId: ids[1] });
  preferences = dispatch(preferences, { type: "select-route", routeId: ids[2] });
  preferences = dispatch(preferences, { type: "set-filter", name: "provider", value: "nous" });
  preferences = dispatch(preferences, { type: "move-route", routeId: ids[2], toIndex: 0 });
  const reset = dispatch(preferences, { type: "reset-order" });
  const twice = dispatch(reset, { type: "reset-order" });
  assert.deepEqual(plain(reset.manualOrderRouteIds), []);
  assert.deepEqual(plain(reset.favoriteRouteIds), [ids[3]]);
  assert.deepEqual(plain(reset.hiddenRouteIds), [ids[1]]);
  assert.equal(reset.selectedRouteId, ids[2]);
  assert.equal(reset.filters.provider, "nous");
  assert.deepEqual(plain(twice), plain(reset));
});

test("schema-versioned persistence roundtrips and rejects malformed or mismatched data", () => {
  let preferences = api.createPickerPreferences();
  preferences = dispatch(preferences, { type: "toggle-favorite", routeId: ids[3] });
  preferences = dispatch(preferences, { type: "select-route", routeId: ids[2] });
  preferences = dispatch(preferences, { type: "move-route", routeId: ids[2], toIndex: 0 });
  const serialized = api.serializePickerPreferences(preferences, ids);
  assert.deepEqual(plain(api.parsePickerPreferences(serialized, ids)), plain(preferences));
  const payload = JSON.parse(serialized);
  assert.deepEqual(Object.keys(payload).sort(), ["favoriteRouteIds", "filters", "hiddenRouteIds", "manualOrderRouteIds", "schemaVersion", "selectedRouteId"]);
  assert.doesNotMatch(serialized, /prompt|credential|response|providerOrder|accountId|rawPath/i);

  const defaults = plain(api.createPickerPreferences());
  assert.deepEqual(plain(api.parsePickerPreferences("{bad", ids)), defaults);
  assert.deepEqual(plain(api.parsePickerPreferences(JSON.stringify({ ...preferences, schemaVersion: 2 }), ids)), defaults);
  assert.deepEqual(plain(api.parsePickerPreferences(JSON.stringify({ ...preferences, favoriteRouteIds: [42] }), ids)), defaults);
  assert.deepEqual(plain(api.parsePickerPreferences(JSON.stringify({ ...preferences, favoriteRouteIds: ["consult/../../secret"] }), ids)), defaults);
});

test("persistence prunes stale route IDs from every route-reference field", () => {
  const stale = "consult/removed/old";
  const value = {
    ...plain(api.createPickerPreferences()),
    selectedRouteId: stale,
    favoriteRouteIds: [ids[0], stale],
    hiddenRouteIds: [stale, ids[1]],
    manualOrderRouteIds: [stale, ids[2]],
  };
  const parsed = api.parsePickerPreferences(JSON.stringify(value), ids);
  assert.equal(parsed.selectedRouteId, "");
  assert.deepEqual(plain(parsed.favoriteRouteIds), [ids[0]]);
  assert.deepEqual(plain(parsed.hiddenRouteIds), [ids[1]]);
  assert.deepEqual(plain(parsed.manualOrderRouteIds), [ids[2]]);
});
