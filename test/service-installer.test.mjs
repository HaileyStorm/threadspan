import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonServicePlan } from "../src/installer/service.mjs";

test("Linux service plan is user-scoped and keeps provider keys out of files", () => {
  const plan = createDaemonServicePlan({ platform: "linux", nodePath: "/opt/node/bin/node", cliPath: "/opt/threadspan/src/cli.mjs", configPath: "/home/me/.threadspan/config.jsonc" });
  assert.equal(plan.supported, true);
  assert.match(plan.files[0].content, /PassEnvironment=THREADSPAN_TOKEN NOUS_API_KEY/);
  assert.doesNotMatch(plan.files[0].content, /PrivateTmp/);
  assert.doesNotMatch(plan.files[0].content, /sk-|Bearer /);
  assert.deepEqual(plan.activate[1], ["systemctl", "--user", "enable", "--now", "threadspan.service"]);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});

test("Windows service plan uses per-user startup and argument literals", () => {
  const plan = createDaemonServicePlan({ platform: "win32", nodePath: "C:/Program Files/nodejs/node.exe", cliPath: "C:/Users/Me/threadspan/src/cli.mjs", configPath: "C:/Users/Me/.threadspan/config.jsonc", home: "C:/Users/Me", startupDirectory: "C:/Users/Me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup" });
  assert.equal(plan.files.length, 2);
  assert.match(plan.files[0].content, /serve --config/);
  assert.match(plan.files[1].path, /Startup[\\/]Threadspan\.cmd$/);
  assert.match(plan.files[1].content, /WindowStyle Hidden/);
  assert.doesNotMatch(JSON.stringify(plan), /NOUS_API_KEY=/);
});
