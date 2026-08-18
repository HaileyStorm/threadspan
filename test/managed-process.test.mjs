import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveExecutablePath } from "../src/core/executable.mjs";
import { normalizeManagedCommand, runCapturedProcess } from "../src/core/managed-process.mjs";

test("bare Windows npm resolves through PATHEXT before safe command-shim normalization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-managed-npm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionless = join(root, "npm");
  const command = join(root, "npm.CMD");
  const script = join(root, "npm.ps1");
  await writeFile(extensionless, "#!/bin/sh\nexit 99\n");
  await chmod(extensionless, 0o755);
  await writeFile(command, "@echo off\r\nexit /b 99\r\n");
  await writeFile(script, "Write-Output 'safe'\r\n");
  const environment = { PATH: root, PATHEXT: ".CMD", SystemRoot: "C:\\Windows" };
  const resolved = await resolveExecutablePath("npm", { platform: "win32", environment, cwd: root });
  assert.equal(resolved, command);
  assert.equal(await resolveExecutablePath(extensionless, { platform: "win32", environment, cwd: root }), extensionless);
  assert.equal(await resolveExecutablePath(command, { platform: "win32", environment, cwd: root }), command);
  assert.equal(await resolveExecutablePath("npm", { platform: "linux", environment: { PATH: root }, cwd: root }), extensionless);
  const invocation = normalizeManagedCommand(resolved, ["pack", "--dry-run"], { platform: "win32", environment });
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.executable, script);
  assert.deepEqual(invocation.args.slice(-3), [script, "pack", "--dry-run"]);
  assert.equal(invocation.viaCommandShim, true);
});

test("Windows npm command shims use a verified sibling PowerShell file without command-string parsing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan managed & shim "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok & launcher.cmd");
  const script = join(root, "grok & launcher.ps1");
  await writeFile(command, "@echo off\r\nexit /b 99\r\n");
  await writeFile(script, "Write-Output 'safe'\r\n");
  const hostileArgs = ["--single", "spaces & whoami | calc.exe $(ignored); `ignored`", "C:\\workspace with spaces"];
  const result = normalizeManagedCommand(command, hostileArgs, {
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(result.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(result.executable, script);
  assert.deepEqual(result.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...hostileArgs]);
  assert.equal(result.viaCommandShim, true);
  assert.throws(() => normalizeManagedCommand("unsafe.bat", ["& whoami"], { platform: "win32" }), /not supported/);
  assert.equal(normalizeManagedCommand("codex", [], { platform: "linux" }).viaCommandShim, false);
});

test("Windows command shim resolution uses the actual linked command's sibling", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-managed-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actualRoot = join(root, "actual");
  const actualCommand = join(actualRoot, "grok.cmd");
  const actualScript = join(actualRoot, "grok.ps1");
  await mkdir(actualRoot);
  await writeFile(actualCommand, "not evaluated");
  await writeFile(actualScript, "Write-Output 'actual sibling'");
  const linkedCommand = join(root, "linked.cmd");
  await symlink(actualCommand, linkedCommand);
  assert.equal(normalizeManagedCommand(linkedCommand, [], { platform: "win32" }).executable, actualScript);
});

test("Windows command shim validation rejects a missing PowerShell sibling", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-managed-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.cmd");
  await writeFile(command, "not evaluated");
  assert.throws(() => normalizeManagedCommand(command, [], { platform: "win32" }), /sibling PowerShell shim does not exist/);
});

test("Windows command shim validation rejects a linked PowerShell sibling", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-managed-linked-script-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.cmd");
  const target = join(root, "target.ps1");
  await writeFile(command, "not evaluated");
  await writeFile(target, "Write-Output 'target'");
  await symlink(target, join(root, "grok.ps1"));
  assert.throws(() => normalizeManagedCommand(command, [], { platform: "win32" }), /must not be a symbolic link/);
});

test("Windows command shim launch rejects an artifact swapped after hash preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-managed-swap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "grok.cmd");
  const script = join(root, "grok.ps1");
  await writeFile(command, "not evaluated");
  await writeFile(script, "Write-Output 'reviewed'");
  const expectedExecutableSha256 = createHash("sha256").update("Write-Output 'reviewed'").digest("hex");
  assert.equal(normalizeManagedCommand(command, [], { platform: "win32", expectedExecutableSha256 }).executable, script);

  await writeFile(script, "Write-Output 'swapped'");
  assert.throws(
    () => normalizeManagedCommand(command, [], { platform: "win32", expectedExecutableSha256 }),
    /no longer matches the verified preflight artifact/,
  );
});

test("captured POSIX jobs reap descendants left by an exited group leader", { skip: process.platform === "win32" }, async () => {
  const fixture = new URL("./fixtures/process-tree-leak.mjs", import.meta.url).pathname;
  const result = await runCapturedProcess({ command: process.execPath, args: [fixture], timeoutMs: 5000, killTree: true });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0));
});
