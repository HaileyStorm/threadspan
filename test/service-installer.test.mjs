import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonServicePlan } from "../src/installer/service.mjs";

test("Linux service plan is user-scoped and keeps provider keys out of files", () => {
  const plan = createDaemonServicePlan({ platform: "linux", nodePath: "/opt/node/bin/node", cliPath: "/opt/threadspan/src/cli.mjs", configPath: "/home/me/.threadspan/config.jsonc", providerEnvironmentVariables: [] });
  assert.equal(plan.supported, true);
  assert.match(plan.files[0].content, /PassEnvironment=THREADSPAN_TOKEN/);
  assert.doesNotMatch(plan.files[0].content, /NOUS_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY|CURSOR_API_KEY|DEEPSEEK_API_KEY/);
  assert.deepEqual(plan.environmentVariables, ["THREADSPAN_TOKEN"]);
  assert.doesNotMatch(plan.files[0].content, /PrivateTmp/);
  assert.match(plan.files[0].content, /KillMode=control-group\nTimeoutStopSec=10s/);
  assert.doesNotMatch(plan.files[0].content, /sk-|Bearer /);
  assert.deepEqual(plan.activate[1], ["systemctl", "--user", "enable", "--now", "threadspan.service"]);
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
});

test("service plan imports only selected configured provider environment variables", () => {
  const plan = createDaemonServicePlan({
    platform: "linux",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/threadspan/src/cli.mjs",
    configPath: "/home/me/.threadspan/config.jsonc",
    providerIds: ["nous"],
    config: {
      server: { authTokenEnv: "THREADSPAN_OWNER_TOKEN", connectorTokenEnv: "THREADSPAN_CONNECTOR_TOKEN" },
      providers: {
        nous: { adapter: "nous", apiKeyEnv: "NOUS_API_KEY" },
        openrouter: { adapter: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
        grok: { adapter: "grok-build", executableEnv: "GROK_BUILD_PATH", envAllowlist: ["GROK_SESSION"] },
      },
    },
  });
  assert.deepEqual(plan.environmentVariables, ["THREADSPAN_OWNER_TOKEN", "THREADSPAN_CONNECTOR_TOKEN", "NOUS_API_KEY"]);
  assert.match(plan.files[0].content, /PassEnvironment=THREADSPAN_OWNER_TOKEN THREADSPAN_CONNECTOR_TOKEN NOUS_API_KEY/);
  assert.doesNotMatch(plan.files[0].content, /OPENROUTER_API_KEY|GROK_BUILD_PATH|GROK_SESSION/);
});

test("service plan imports an explicit Claude gateway env name without writing its value", () => {
  const plan = createDaemonServicePlan({
    platform: "linux",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/threadspan/src/cli.mjs",
    configPath: "/home/me/.threadspan/config.jsonc",
    providerIds: ["agentrouter-claude"],
    config: {
      providers: {
        "agentrouter-claude": {
          adapter: "claude-code",
          gateway: { baseUrl: "https://agentrouter.org", apiKeyEnv: "AGENTROUTER_API_KEY", model: "claude-opus-4-8", provider: "agentrouter" },
        },
      },
    },
  });
  assert.deepEqual(plan.environmentVariables, ["THREADSPAN_TOKEN", "AGENTROUTER_API_KEY"]);
  assert.match(plan.files[0].content, /PassEnvironment=THREADSPAN_TOKEN AGENTROUTER_API_KEY/);
  assert.doesNotMatch(JSON.stringify(plan), /AGENTROUTER_API_KEY=/);
});

test("Windows service plan uses per-user startup and argument literals", () => {
  const plan = createDaemonServicePlan({ platform: "win32", nodePath: "C:/Program Files/nodejs/node.exe", cliPath: "C:/Users/Me/threadspan/src/cli.mjs", configPath: "C:/Users/Me/.threadspan/config.jsonc", home: "C:/Users/Me", startupDirectory: "C:/Users/Me/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup", providerEnvironmentVariables: ["NOUS_API_KEY"] });
  assert.equal(plan.files.length, 2);
  assert.match(plan.files[0].content, /serve --config/);
  assert.match(plan.files[1].path, /Startup[\\/]Threadspan\.cmd$/);
  assert.match(plan.files[1].content, /WindowStyle Hidden/);
  assert.match(plan.files[0].content, /GetEnvironmentVariables\('Process'\)/);
  assert.match(plan.files[0].content, /NOUS_API_KEY/);
  assert.doesNotMatch(plan.files[0].content, /OPENROUTER_API_KEY/);
  assert.doesNotMatch(JSON.stringify(plan), /NOUS_API_KEY=/);
});

test("service plan requires explicit environment selection when validated config is unavailable", () => {
  assert.throws(() => createDaemonServicePlan({
    platform: "linux",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/threadspan/src/cli.mjs",
    configPath: "/home/me/.threadspan/config.jsonc",
  }), /config or an explicit providerEnvironmentVariables array/);
});
