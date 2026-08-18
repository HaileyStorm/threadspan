import assert from "node:assert/strict";
import test from "node:test";
import { buildMergedModelCatalog } from "../src/codex/catalog.mjs";

test("Codex catalog merge preserves native models and keeps explicit routes hidden by default", () => {
  const native = { models: [{ slug: "gpt-native", display_name: "Native" }] };
  const routes = [
    { id: "integrated/threadspan/auto", owned_by: "threadspan", metadata: { bridge_mode: "integrated", provider: "threadspan", upstream_model: "auto", threadspan_smart: true } },
    { id: "integrated/nous/deepseek/deepseek-v4-flash-0731", owned_by: "nous", metadata: { bridge_mode: "integrated", provider: "nous", upstream_model: "deepseek/deepseek-v4-flash-0731", context_window: 128000 } },
    { id: "integrated/openrouter/free/model:free", owned_by: "openrouter", metadata: { bridge_mode: "integrated", provider: "openrouter", upstream_model: "free/model:free", free: true } },
  ];
  const providers = [
    { id: "nous", adapter: "nous", capabilities: {} },
    { id: "openrouter", adapter: "openrouter", capabilities: {} },
  ];
  const catalog = buildMergedModelCatalog(native, routes, providers, { showFree: true });
  assert.equal(catalog.models[0].slug, "gpt-native");
  assert.equal(catalog.models[1].visibility, "list");
  assert.equal(catalog.models[2].visibility, "hide");
  assert.equal(catalog.models[2].default_reasoning_level, "max");
  assert.equal(catalog.models[2].context_window, 128000);
  assert.equal(catalog.models[3].visibility, "list");
  assert.equal(catalog.models[3].display_name.includes("OpenRouter"), true);
});

test("catalog favorites and explicit free metadata remain CLI-compatible visibility overlays", () => {
  const native = { models: [{ slug: "gpt-native", display_name: "Native" }] };
  const routes = [
    { id: "integrated/threadspan/auto", metadata: { bridge_mode: "integrated", provider: "threadspan", upstream_model: "auto", threadspan_smart: true } },
    { id: "consult/provider/favorite", metadata: { bridge_mode: "consult", provider: "provider", upstream_model: "favorite" } },
    { id: "integrated/openrouter/explicit-free", metadata: { bridge_mode: "integrated", provider: "openrouter", upstream_model: "explicit-free", free: true } },
    { id: "integrated/openrouter/name:free", metadata: { bridge_mode: "integrated", provider: "openrouter", upstream_model: "name:free" } },
    { id: "integrated/openrouter/string-free", metadata: { bridge_mode: "integrated", provider: "openrouter", upstream_model: "string-free", free: "true" } },
  ];
  const providers = [{ id: "openrouter", adapter: "openrouter", capabilities: {} }];
  const hiddenFree = buildMergedModelCatalog(native, routes, providers, {
    showFree: false,
    favorites: ["consult/provider/favorite"],
  });
  assert.deepEqual(hiddenFree.models.map((model) => model.visibility), [undefined, "list", "list", "hide", "hide", "hide"]);

  const shownFree = buildMergedModelCatalog(native, routes, providers, {
    showFree: true,
    favorites: ["integrated/openrouter/name"],
  });
  assert.deepEqual(shownFree.models.map((model) => model.visibility), [undefined, "list", "hide", "list", "hide", "hide"]);
  assert.equal(shownFree.models.find((model) => model.slug === "integrated/openrouter/name:free").visibility, "hide", "favorites match the exact --favorite route string");
});

test("catalog merge preserves native order, deduplicates exact slugs, and does not mutate inputs", () => {
  const native = { revision: "native-r1", models: [{ slug: "native-a", nested: { value: 1 } }, { slug: "duplicate", display_name: "Native wins" }] };
  const routes = [
    { id: "duplicate", metadata: { bridge_mode: "consult", provider: "other", upstream_model: "duplicate" } },
    { id: "consult/other/model", metadata: { bridge_mode: "consult", provider: "other", upstream_model: "model", free: false } },
  ];
  const beforeNative = structuredClone(native);
  const beforeRoutes = structuredClone(routes);
  const catalog = buildMergedModelCatalog(native, routes, [], { favorites: ["consult/other/model"] });
  assert.deepEqual(catalog.models.map((model) => model.slug), ["native-a", "duplicate", "consult/other/model"]);
  assert.equal(catalog.models[1].display_name, "Native wins");
  assert.deepEqual(native, beforeNative);
  assert.deepEqual(routes, beforeRoutes);
});
