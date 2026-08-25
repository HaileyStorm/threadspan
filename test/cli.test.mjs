import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, writeConvenienceResult } from "../src/cli.mjs";

test("CLI parser handles values, booleans, equals, repeated options, and saved-session disclosure", () => {
  const parsed = parseArguments(["consult", "question", "--provider", "a", "--model=b", "--payload-classification", "public_repo", "--disclosed", "--json", "--tag", "x", "--tag", "y"]);
  assert.deepEqual(parsed.positionals, ["consult", "question"]);
  assert.equal(parsed.options.provider, "a");
  assert.equal(parsed.options.model, "b");
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.payloadClassification, "public_repo");
  assert.equal(parsed.options.disclosed, true);
  assert.deepEqual(parsed.options.tag, ["x", "y"]);
});

import { chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBridgeAuthTokenFile, isDirectCliInvocation, resolveExecutablePath, runDoctor } from "../src/cli.mjs";
import { createWindowsNpmBinShim } from "./helpers.mjs";

test("resolveExecutablePath searches PATH and rejects nonexistent commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-bridge-cli-"));
  const executable = join(directory, "bridge-test-command");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);

  assert.equal(
    await resolveExecutablePath("bridge-test-command", { platform: "linux", environment: { PATH: directory } }),
    executable,
  );
  assert.equal(
    await resolveExecutablePath("missing-bridge-command", { platform: "linux", environment: { PATH: directory } }),
    undefined,
  );
});

test("resolveExecutablePath applies Windows PATHEXT semantics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-bridge-cli-win-"));
  const executable = join(directory, "bridge-win-command.CMD");
  await writeFile(executable, "@exit /b 0\r\n", "utf8");

  assert.equal(
    await resolveExecutablePath("bridge-win-command", {
      platform: "win32",
      environment: { PATH: directory, PATHEXT: ".EXE;.CMD" },
    }),
    executable,
  );
});

test("doctor accepts a metadata-safe owner auth-token file and rejects unsafe file identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-doctor-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = join(root, "owner.token");
  await writeFile(token, "must-never-appear-in-doctor\n", { mode: 0o600 });
  await chmod(token, 0o600);
  assert.deepEqual(inspectBridgeAuthTokenFile(token), { ok: true });
  const report = await runDoctor({
    configPath: join(root, "config.json"),
    server: { authTokenFile: token, allowUnauthenticatedLoopback: false },
    providers: {},
  });
  const check = report.checks.find((entry) => entry.name === "bridge-auth-token");
  assert.equal(check.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /must-never-appear-in-doctor/u);

  await chmod(token, 0o640);
  assert.match(inspectBridgeAuthTokenFile(token).detail, /exact mode 0600/u);
  await chmod(token, 0o600);
  const hardlink = join(root, "owner-hardlink.token");
  await link(token, hardlink);
  assert.match(inspectBridgeAuthTokenFile(token).detail, /exactly one filesystem link/u);
  await rm(hardlink);
  const symbolic = join(root, "owner-symbolic.token");
  await symlink(token, symbolic);
  assert.match(inspectBridgeAuthTokenFile(symbolic).detail, /must not be a symbolic link/u);

  const realDirectory = join(root, "real-token-directory");
  await mkdir(realDirectory);
  const ancestorToken = join(realDirectory, "owner.token");
  await writeFile(ancestorToken, "ancestor-secret\n", { mode: 0o600 });
  const symbolicDirectory = join(root, "symbolic-token-directory");
  await symlink(realDirectory, symbolicDirectory, "dir");
  assert.match(inspectBridgeAuthTokenFile(join(symbolicDirectory, "owner.token")).detail, /symbolic-link ancestors/u);

  const lateDirectory = join(root, "late-token-directory");
  const movedDirectory = join(root, "moved-token-directory");
  await mkdir(lateDirectory);
  const lateToken = join(lateDirectory, "owner.token");
  await writeFile(lateToken, "late-secret\n", { mode: 0o600 });
  assert.deepEqual(inspectBridgeAuthTokenFile(lateToken), { ok: true });
  await rename(lateDirectory, movedDirectory);
  await symlink(movedDirectory, lateDirectory, "dir");
  assert.match(inspectBridgeAuthTokenFile(lateToken).detail, /symbolic-link ancestors/u);
});


test("installed npm bin launchers are recognized as direct CLI invocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-bridge-cli-link-"));
  const modulePath = join(directory, "cli.mjs");
  const invocationPath = join(directory, "cursor-bridge");
  await writeFile(modulePath, "export {};\n", "utf8");
  const commandShim = await createWindowsNpmBinShim(t, modulePath, "cursor-bridge", { platform: "win32" });
  assert.match(commandShim, /cursor-bridge\.cmd$/i);
  assert.match(await readFile(commandShim.replace(/\.cmd$/i, ".ps1"), "utf8"), /\$input \| & .*\$args/);

  if (process.platform === "win32") {
    assert.equal(isDirectCliInvocation(modulePath, modulePath), true);
  } else {
    await symlink(modulePath, invocationPath);
    assert.equal(isDirectCliInvocation(invocationPath, modulePath), true);
  }
  assert.equal(isDirectCliInvocation(undefined, modulePath), false);
});

test("human CLI results keep text on stdout and expose thread continuity on stderr", () => {
  let stdout = "";
  let stderr = "";
  const sinkOut = { write(value) { stdout += String(value); return true; } };
  const sinkErr = { write(value) { stderr += String(value); return true; } };
  writeConvenienceResult({ text: "answer", threadId: "thread_1", responseId: "resp_1" }, {
    stdout: sinkOut,
    stderr: sinkErr,
  });
  assert.equal(stdout, "answer\n");
  assert.match(stderr, /threadId=thread_1/);
  assert.match(stderr, /responseId=resp_1/);
});

test("JSON CLI results include continuity ids without stderr output", () => {
  let stdout = "";
  let stderr = "";
  writeConvenienceResult({ text: "answer", threadId: "thread_2", responseId: "resp_2" }, {
    json: true,
    stdout: { write(value) { stdout += String(value); return true; } },
    stderr: { write(value) { stderr += String(value); return true; } },
  });
  assert.equal(JSON.parse(stdout).threadId, "thread_2");
  assert.equal(stderr, "");
});

test("Desktop CLI documents one-time bootstrap semantics and the legacy alias", async () => {
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /desktop launch .*--bootstrap-port N/);
  assert.match(source, /desktop attach .*--bootstrap-port N/);
  assert.match(source, /desktop rollback .*--bootstrap-port N/);
  assert.match(source, /desktop recover .*--reason TEXT/);
  assert.match(source, /--confirm-hosts-stopped/);
  assert.match(source, /desktop claim \[--config PATH\]/);
  assert.match(source, /--inspect-port N is retained as an alias for --bootstrap-port N/);
  assert.doesNotMatch(source, /desktop attach \[--config PATH\] \[--inspect-port N\]/);
});
