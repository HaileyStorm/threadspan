import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCursorCliArguments, CursorCliProvider, parseCursorModels } from "../src/providers/cursor-cli.mjs";
import { nativePath, silentLogger } from "./helpers.mjs";

function provider(overrides = {}) {
  return new CursorCliProvider("cursor", {
    adapter: "cursor-cli",
    command: process.execPath,
    commandArgs: [nativePath(new URL("./fixtures/cursor-cli.mjs", import.meta.url))],
    model: "auto",
    capabilities: ["consult", "delegate"],
    sandbox: "disabled",
    ...overrides,
  }, { logger: silentLogger() });
}

test("Cursor CLI adapter discovers signed-in account models", async () => {
  const models = await provider().listModels();
  assert.deepEqual(models, [
    { id: "auto", name: "Auto" },
    { id: "cursor-grok-4.6-high", name: "Cursor Grok 4.6" },
  ]);
  assert.deepEqual(parseCursorModels("noise\na - A\n"), [{ id: "a", name: "A" }]);
});

test("Cursor CLI keeps native profile auth paths but excludes unnamed provider and daemon credentials", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "threadspan-cursor-env-"));
  const script = join(directory, "cursor-env.mjs");
  writeFileSync(script, `process.stdout.write(JSON.stringify({ result: JSON.stringify({
    home: process.env.HOME ?? process.env.USERPROFILE,
    named: process.env.THREADSPAN_CURSOR_NAMED,
    configured: process.env.THREADSPAN_CURSOR_CONFIGURED,
    providerKey: process.env.CURSOR_API_KEY,
    daemonCredential: process.env.THREADSPAN_TOKEN,
    unrelated: process.env.THREADSPAN_CURSOR_PRIVATE,
  }) }));\n`);
  const names = ["HOME", "THREADSPAN_CURSOR_NAMED", "THREADSPAN_CURSOR_PRIVATE", "CURSOR_API_KEY", "THREADSPAN_TOKEN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HOME: "/threadspan-test-home",
    THREADSPAN_CURSOR_NAMED: "named-value",
    THREADSPAN_CURSOR_PRIVATE: "must-not-leak",
    CURSOR_API_KEY: "provider-key-must-not-leak",
    THREADSPAN_TOKEN: "daemon-credential-must-not-leak",
  });
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const events = [];
  for await (const event of provider({
    commandArgs: [script],
    envAllowlist: ["THREADSPAN_CURSOR_NAMED"],
    env: { THREADSPAN_CURSOR_CONFIGURED: "configured-value" },
  }).run({ mode: "consult", model: "auto", messages: [{ role: "user", content: "hello" }] })) events.push(event);

  assert.deepEqual(JSON.parse(events.at(-1).message.content), {
    home: "/threadspan-test-home",
    named: "named-value",
    configured: "configured-value",
  });
});

test("Cursor CLI Consult uses a disposable workspace and normalizes usage", async () => {
  const events = [];
  for await (const event of provider().run({
    mode: "consult",
    model: "cursor-grok-4.6-high",
    messages: [{ role: "user", content: "hello" }],
  })) events.push(event);
  assert.match(events.at(-1).message.content, /cursor:/);
  assert.equal(events.at(-1).usage.totalTokens, 6);
  assert.equal(events.at(-1).usage.cachedInputTokens, 1);
  assert.equal(events.at(-1).providerMetadata.cursorCli.sessionId, "session-test");
  assert.equal(events.at(-1).providerMetadata.cursorCli.nativeSettings.workspaceTrust, false);
  assert.equal(events.at(-1).providerMetadata.cursorCli.effectiveSettings.workspaceTrust, "trusted");
});

test("Cursor CLI Delegate requires an explicit workspace", async () => {
  await assert.rejects(async () => {
    for await (const _event of provider().run({ mode: "delegate", model: "auto", messages: [{ role: "user", content: "work" }] })) {}
  }, /requires a workspace/);
});

test("Cursor CLI leaves trust and sandbox native unless their effective overrides are visible", () => {
  const request = { mode: "delegate", model: "auto" };
  const nativeArgs = buildCursorCliArguments({ consult: { agentMode: "plan" } }, request, "/tmp/workspace", "prompt");
  assert.equal(nativeArgs.includes("--trust"), false);
  assert.equal(nativeArgs.includes("--sandbox"), false);

  const explicitArgs = buildCursorCliArguments({ sandbox: "enabled", trust: true, consult: { agentMode: "plan" } }, request, "/tmp/workspace", "prompt");
  assert.deepEqual(explicitArgs.slice(explicitArgs.indexOf("--sandbox"), explicitArgs.indexOf("--sandbox") + 2), ["--sandbox", "enabled"]);
  assert.ok(explicitArgs.includes("--trust"));

  const settings = provider({ sandbox: undefined, trust: undefined }).capabilities().settings;
  assert.deepEqual(settings.nativeSettings, { sandbox: true, workspaceTrust: true });
  assert.deepEqual(settings.effectiveSettings, { sandbox: "native", workspaceTrust: "native" });
});

test("Cursor CLI Consult trusts its disposable workspace with exact argv and no shell interpolation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threadspan-cursor-trust-"));
  const marker = join(directory, "shell-interpolation-marker");
  const prompt = `literal; touch ${marker}; $(touch ${marker})`;
  const workspace = "/tmp/threadspan disposable workspace";

  assert.deepEqual(
    buildCursorCliArguments({ consult: { agentMode: "plan" } }, { mode: "consult", model: "cursor-grok-4.6-high" }, workspace, prompt),
    [
      "--print",
      "--output-format", "json",
      "--trust",
      "--workspace", workspace,
      "--model", "cursor-grok-4.6-high",
      "--mode", "plan",
      prompt,
    ],
  );

  try {
    for await (const _event of provider().run({
      mode: "consult",
      model: "cursor-grok-4.6-high",
      messages: [{ role: "user", content: prompt }],
    })) {}
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Cursor CLI rejects protected safety and routing flags from commandArgs", () => {
  for (const argument of ["--api-key=secret", "-ehttps://example.invalid", "--continue", "--force", "--sandbox=disabled", "--model", "--max-turns", "--no-memory", "--no-subagents"]) {
    assert.throws(
      () => provider({ commandArgs: [nativePath(new URL("./fixtures/cursor-cli.mjs", import.meta.url)), argument] }),
      /commandArgs contains protected argument/,
    );
  }
});
