import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const { renderState } = require("../integrations/cursor-threadspan/core.js");

test("Cursor account pane uses fixed command URIs with scripts disabled and never renders identity secrets", async () => {
  const html = renderState({ route: { id: "consult/api/@acct_x/m", accountId: "acct_x" }, accounts: { accounts: [{ id: "acct_x", providerId: "api", label: "Work", active: true }], combined: { eventCount: 2 } } });
  assert.match(html, /command:threadspan\.account\.add/);
  assert.match(html, /command:threadspan\.account\.select/);
  assert.doesNotMatch(html, /<script|Bearer\s|sk-[A-Za-z0-9]|person@example/i);
  const extension = await readFile(new URL("../integrations/cursor-threadspan/extension.js", import.meta.url), "utf8");
  assert.match(extension, /enableScripts:false/);
  assert.match(extension, /enableCommandUris:\["threadspan\.account\.add","threadspan\.account\.select"\]/);
  assert.doesNotMatch(extension, /auth\.json|document\.cookie|webview\.postMessage/);
});
