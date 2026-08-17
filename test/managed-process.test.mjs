import assert from "node:assert/strict";
import test from "node:test";
import { runCapturedProcess } from "../src/core/managed-process.mjs";

test("captured POSIX jobs reap descendants left by an exited group leader", { skip: process.platform === "win32" }, async () => {
  const fixture = new URL("./fixtures/process-tree-leak.mjs", import.meta.url).pathname;
  const result = await runCapturedProcess({ command: process.execPath, args: [fixture], timeoutMs: 5000, killTree: true });
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0));
});
