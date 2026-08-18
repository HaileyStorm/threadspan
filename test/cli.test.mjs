import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, writeConvenienceResult } from "../src/cli.mjs";

test("CLI parser handles values, booleans, equals, and repeated options", () => {
  const parsed = parseArguments(["consult", "question", "--provider", "a", "--model=b", "--json", "--tag", "x", "--tag", "y"]);
  assert.deepEqual(parsed.positionals, ["consult", "question"]);
  assert.equal(parsed.options.provider, "a");
  assert.equal(parsed.options.model, "b");
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.options.tag, ["x", "y"]);
});

import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirectCliInvocation, resolveExecutablePath } from "../src/cli.mjs";
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
