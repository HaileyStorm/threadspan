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
