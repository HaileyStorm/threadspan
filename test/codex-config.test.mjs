import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { END_MARKER, installCodexConfigBlock, installCodexProfileDocuments, renderCodexConfigBlock, renderCodexProfileDocuments, replaceManagedBlock, START_MARKER, uninstallCodexConfigBlock } from "../src/codex/config.mjs";
import { transformCodexFullAccessConfig } from "../src/codex/execution-policy.mjs";

test("Codex full-access transform preserves unrelated TOML and reports untouched per-tool overrides", () => {
  const source = `# owner comment\r\nmodel = "owner-model"\r\nsecret_header = "do-not-report"\r\napproval_policy = "on-request" # old\r\n\r\n[apps."drive.app"]\r\nenabled = false\r\nopen_world_enabled = false\r\n\r\n[apps."drive.app".tools.write]\r\napproval_mode = "prompt" # owner override\r\n\r\n[mcp_servers.local]\r\ncommand = "local-secret-command"\r\n\r\n[mcp_servers.local.tools.delete]\r\napproval_mode = "prompt"\r\n\r\n[plugins.bundle.mcp_servers.remote]\r\nurl = "https://credential.example.invalid"\r\n\r\n[plugins.bundle.mcp_servers.remote.tools.publish]\r\napproval_mode = "writes"\r\n`;
  const transformed = transformCodexFullAccessConfig(source);

  assert.match(transformed.content, /^# owner comment\r\nmodel = "owner-model"\r\nsecret_header = "do-not-report"/);
  assert.match(transformed.content, /approval_policy = "never" # old/);
  assert.match(transformed.content, /sandbox_mode = "danger-full-access"/);
  assert.match(transformed.content, /approvals_reviewer = "user"/);
  assert.match(transformed.content, /\[apps\."drive\.app"\][\s\S]*enabled = false[\s\S]*open_world_enabled = false[\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(transformed.content, /\[mcp_servers\.local\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(transformed.content, /\[plugins\.bundle\.mcp_servers\.remote\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(transformed.content, /\[apps\."drive\.app"\.tools\.write\]\r\napproval_mode = "prompt" # owner override/);
  assert.equal(transformed.content.includes("destructive_enabled = true"), false);
  assert.deepEqual(transformed.conflicts.map(({ kind, setting }) => ({ kind, setting })), [
    { kind: "app-tool", setting: "approval_mode" },
    { kind: "mcp-tool", setting: "approval_mode" },
    { kind: "plugin-mcp-tool", setting: "approval_mode" },
  ]);
  const metadata = JSON.stringify({ conflicts: transformed.conflicts, effects: transformed.effects });
  assert.doesNotMatch(metadata, /do-not-report|local-secret-command|credential\.example/);
});

test("Codex full-access transform preserves unrelated multiline values", () => {
  const source = `developer_instructions = """\nKeep [apps.fake] text and approval_policy = "prompt" here.\n"""\n\n[apps.real]\nenabled = true\n\n[mcp_servers.local]\nenv.OWNER_SETTING = "keep"\n`;
  const transformed = transformCodexFullAccessConfig(source);
  assert.match(transformed.content, /Keep \[apps\.fake\] text and approval_policy = "prompt" here\./);
  assert.match(transformed.content, /\[apps\.real\][\s\S]*approvals_reviewer = "user"[\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(transformed.content, /env\.OWNER_SETTING = "keep"/);
});

test("Codex full-access transform fails closed on duplicate target tables and keys", () => {
  assert.throws(
    () => transformCodexFullAccessConfig(`[apps.demo]\nenabled = true\n[apps.demo]\nenabled = false\n`),
    /failed closed.*duplicate target table/i,
  );
  assert.throws(
    () => transformCodexFullAccessConfig(`approval_policy = "never"\napproval_policy = "on-request"\n`),
    /failed closed.*duplicate target key/i,
  );
  assert.throws(
    () => transformCodexFullAccessConfig(`apps.demo = { approvals_reviewer = "user" }\n`),
    /failed closed.*ambiguous/i,
  );
  assert.throws(
    () => transformCodexFullAccessConfig(`[apps.demo]\ntools = { write = { approval_mode = "prompt" } }\n`),
    /failed closed.*ambiguous/i,
  );
});

test("Codex block uses Responses wire API and Consult MCP without legacy profiles", () => {
  const block = renderCodexConfigBlock({ cliPath: "/tmp/cli.mjs", bridgeConfigPath: "/tmp/config.jsonc" });
  assert.match(block, /wire_api = "responses"/);
  assert.match(block, /request_max_retries = 0/);
  assert.match(block, /stream_max_retries = 0/);
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
    mcpRemoteUrl: "http://127.0.0.1:8743/mcp",
    connectorTokenFile: "/home/me/.threadspan/connector-token",
  });
  assert.match(block, /"mcp"/);
  assert.match(block, /"--remote", "http:\/\/127\.0\.0\.1:8743\/mcp"/);
  assert.match(block, /provider pools and admission limits are shared/);
});

test("Codex remote MCP requires the connector token file without embedding its value", () => {
  const connectorTokenFile = join(tmpdir(), "threadspan-codex-config", "connector-token");
  const block = renderCodexConfigBlock({
    cliPath: "/tmp/cli.mjs",
    bridgeConfigPath: "/tmp/config.jsonc",
    mcpRemoteUrl: "http://127.0.0.1:8743/mcp",
    connectorTokenFile,
  });
  const args = parseRenderedTomlArgs(block);
  assert.equal(args[args.indexOf("--token-file") + 1], resolve(connectorTokenFile));
  assert.doesNotMatch(block, /auth-token/);
  assert.doesNotMatch(block, /Bearer |token-value/);
});

test("Codex remote MCP fails closed without a connector file and rejects /v1", () => {
  const base = { cliPath: "/tmp/cli.mjs", bridgeConfigPath: "/tmp/config.jsonc" };
  assert.throws(() => renderCodexConfigBlock({ ...base, mcpRemoteUrl: "http://127.0.0.1:8743/mcp" }), /connectorTokenFile/);
  assert.throws(() => renderCodexConfigBlock({ ...base, mcpRemoteUrl: "http://127.0.0.1:8743/v1", connectorTokenFile: "/tmp/connector" }), /scoped \/mcp/);
});

test("static Cursor MCP example uses the scoped endpoint and connector token file", async () => {
  const example = JSON.parse(await readFile(new URL("../examples/cursor/.cursor/mcp.json", import.meta.url), "utf8"));
  const args = example.mcpServers.consult.args;
  assert.equal(args[args.indexOf("--remote") + 1], "http://127.0.0.1:8743/mcp");
  assert.equal(args[args.indexOf("--token-file") + 1], "/absolute/path/to/threadspan-connector-token");
});

function parseRenderedTomlArgs(block) {
  const encoded = block.match(/^args = (\[[^\r\n]+\])$/m)?.[1];
  assert.ok(encoded, "rendered Codex block must contain an args array");
  return JSON.parse(encoded);
}
