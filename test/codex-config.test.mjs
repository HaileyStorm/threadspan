import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { END_MARKER, installCodexConfigBlock, installCodexProfileDocuments, renderCodexConfigBlock, renderCodexProfileDocuments, replaceManagedBlock, START_MARKER, uninstallCodexConfigBlock } from "../src/codex/config.mjs";

test("Codex block uses Responses wire API and Consult MCP without legacy profiles", () => {
  const block = renderCodexConfigBlock({ cliPath: "/tmp/cli.mjs", bridgeConfigPath: "/tmp/config.jsonc" });
  assert.match(block, /wire_api = "responses"/);
  assert.doesNotMatch(block, /\[profiles\./);
  assert.match(block, /\[mcp_servers\.consult\]/);
  assert.doesNotMatch(block, /model_catalog_json/);
});

test("Codex profiles are standalone v2 documents installed beside config.toml", async (t) => {
  const documents = renderCodexProfileDocuments();
  assert.match(documents["threadspan_integrated.config.toml"], /model = "integrated\/nous\/deepseek\/deepseek-v4-flash-0731"/);
  assert.doesNotMatch(JSON.stringify(documents), /\[profiles\./);
  const root = await mkdtemp(join(tmpdir(), "codex-profile-test-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const installed = await installCodexProfileDocuments(join(root, "config.toml"), documents);
  assert.equal(installed.length, 3);
  assert.match(await readFile(join(root, "threadspan_consult.config.toml"), "utf8"), /model_provider = "threadspan_bridge"/);
});

test("managed Codex block replacement preserves unrelated TOML", () => {
  const old = `model = "native"\n\n${START_MARKER}\nold\n${END_MARKER}\n\n[other]\nx = 1\n`;
  const next = replaceManagedBlock(old, `${START_MARKER}\nnew\n${END_MARKER}`);
  assert.equal(next.replaced, true);
  assert.match(next.text, /model = "native"/);
  assert.match(next.text, /new/);
  assert.doesNotMatch(next.text, /\nold\n/);
  assert.match(next.text, /\[other\]/);
});

test("install and uninstall Codex block use a backup and preserve user config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "codex-config-test-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "config.toml");
  await writeFile(path, "model = \"native\"\n");
  const block = `${START_MARKER}\nmanaged\n${END_MARKER}`;
  const installed = await installCodexConfigBlock(path, block);
  assert.ok(installed.backupPath);
  assert.match(await readFile(path, "utf8"), /managed/);
  const removed = await uninstallCodexConfigBlock(path);
  assert.equal(removed.removed, true);
  assert.match(await readFile(path, "utf8"), /model = "native"/);
  assert.doesNotMatch(await readFile(path, "utf8"), /managed/);
});


test("Codex block can proxy MCP tools into the same persistent bridge daemon", () => {
  const block = renderCodexConfigBlock({
    cliPath: "/tmp/cli.mjs",
    bridgeConfigPath: "/tmp/config.jsonc",
    bridgeUrl: "http://127.0.0.1:8743/v1",
    mcpRemoteUrl: "http://127.0.0.1:8743/v1",
  });
  assert.match(block, /"mcp"/);
  assert.match(block, /"--remote", "http:\/\/127\.0\.0\.1:8743\/v1"/);
  assert.match(block, /provider pools and admission limits are shared/);
});
