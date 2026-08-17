import assert from "node:assert/strict";
import test from "node:test";
import { discoverNativeCodexCatalog } from "../src/codex/app-server.mjs";

test("App Server discovery converts the signed-in native model list to a catalog", async () => {
  const fixture = new URL("./fixtures/codex-app-server.mjs", import.meta.url).pathname;
  const catalog = await discoverNativeCodexCatalog({ command: process.execPath, commandArgs: [fixture] });
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.models[0], {
    ...catalog.models[0],
    slug: "gpt-fixture",
    display_name: "GPT Fixture",
    default_reasoning_level: "high",
    visibility: "list",
    priority: 1000,
    input_modalities: ["text", "image"],
  });
  assert.deepEqual(catalog.models[0].supported_reasoning_levels, [{ effort: "high", description: "Deep" }]);
});
