import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { DesktopHost, createDesktopLaunchPlan, sanitizeDesktopHudState } from "../src/desktop/host.mjs";
import { capabilityDigest, createElectronGeneration, createSupervisorCapability, snapshotDesktopPackages } from "../src/desktop/supervisor.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("desktop launch plan uses a loopback-only one-time bootstrap port", () => {
  const plan = createDesktopLaunchPlan({ platform: "win32", executable: "C:/Program Files/OpenAI/ChatGPT.exe", bootstrapPort: 19324 });
  assert.equal(plan.command, "C:/Program Files/OpenAI/ChatGPT.exe");
  assert.deepEqual(plan.args, ["--inspect=127.0.0.1:19324"]);
  assert.equal(plan.options.detached, true);
  assert.equal(plan.options.stdio, "ignore");
  assert.deepEqual(plan.bootstrap, { host: "127.0.0.1", port: 19324, oneTime: true });
  assert.equal(createDesktopLaunchPlan({ executable: "/usr/bin/chatgpt", inspectPort: 19325 }).bootstrap.port, 19325, "compatibility alias remains bounded");
  assert.throws(() => createDesktopLaunchPlan({ executable: "/usr/bin/chatgpt", bootstrapPort: 80 }), /1024 through 65535/);
});

test("desktop HUD projection is bounded and contains no credential material", () => {
  const hud = sanitizeDesktopHudState({
    status: "ready",
    route: { id: "consult/mock/mock-model" },
    routeMap: { nodes: [{ id: "mock" }] },
    pickerRoutes: [{ id: "consult/mock/mock-model", mode: "consult", provider: "mock", model: "mock-model", availability: "available", free: true }],
    authToken: "must-not-project",
  });
  assert.equal(hud.selected, "consult/mock/mock-model");
  assert.equal(hud.routes[0].id, "consult/mock/mock-model");
  assert.doesNotMatch(JSON.stringify(hud), /Bearer|authToken|secret|must-not-project/i);
});

test("attach mode preserves Desktop when no authenticated supervisor exists", async () => {
  const config = createTestConfig();
  let launched = false;
  let probed = false;
  const host = new DesktopHost(config, {
    token: "owner-token",
    store: { read: async () => null },
    launchProcess: () => { launched = true; throw new Error("must not launch"); },
    portProbe: async () => { probed = true; return false; },
  });
  await assert.rejects(host.run({ launch: false }), /preserves the daemon and sidecar without disturbing Desktop/);
  assert.equal(launched, false);
  assert.equal(probed, false);
});

test("attach reconnects and rollback removes only the exact authenticated supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-host-reconnect-"));
  const executable = join(root, "ChatGPT");
  const asar = join(root, "app.asar");
  await writeFile(executable, "desktop executable\n");
  await writeFile(asar, "desktop package\n");
  const packageEvidence = await snapshotDesktopPackages([executable, asar]);
  const source = { processId: 4001, executablePath: executable, executableSha256: "a".repeat(64), startIdentity: "4001:1780000000", electronVersion: "39.1.0" };
  const generation = createElectronGeneration(source);
  const capability = createSupervisorCapability();
  let transaction = {
    schemaVersion: 1,
    revision: 5,
    generation,
    phase: "attached",
    source,
    bootstrap: { host: "127.0.0.1", port: 19324 },
    sourceDigest: "b".repeat(64),
    capabilityDigest: capabilityDigest(capability),
    packageDigest: packageEvidence.digest,
    endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: 40123, aclEvidence: "token-authenticated-loopback-no-native-acl" },
    receiptDigest: "c".repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recovery: null,
  };
  let launched = false;
  const probedPorts = [];
  let removedCapability = false;
  let teardownCalls = 0;
  const client = {
    async open() {},
    async close() {},
    async request(operation) {
      if (operation === "identity") return { generation, processId: source.processId, executablePath: source.executablePath, electronVersion: source.electronVersion, capabilityDigest: capabilityDigest(capability) };
      if (operation === "health") return { ready: true, generation };
      if (operation === "teardown") { teardownCalls += 1; return { removed: true }; }
      if (operation === "finalize-teardown") return { finalized: true };
      throw new Error(`Unexpected ${operation}`);
    },
  };
  const store = {
    async read() { return transaction; },
    async loadCapability() { return capability; },
    async transition(input) { transaction = { ...transaction, revision: transaction.revision + 1, phase: input.phase, recovery: input.recovery ?? null }; return transaction; },
    async removeCapability() { removedCapability = true; },
  };
  const config = createTestConfig();
  const host = new DesktopHost(config, {
    token: "owner-token",
    store,
    packagePaths: [executable, asar],
    clientFactory: () => client,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
    portProbe: async (port) => { probedPorts.push(port); return false; },
    launchProcess: () => { launched = true; throw new Error("must not launch"); },
  });
  const signal = AbortSignal.abort();
  await host.run({ launch: false, signal });
  assert.deepEqual(probedPorts, [19324], "service attach uses the exact persisted custom bootstrap port");
  assert.equal(launched, false);
  const rollback = await host.rollback("reviewed rollback");
  assert.equal(rollback.phase, "rolled-back");
  assert.equal(rollback.inspectorRestored, false);
  assert.equal(teardownCalls, 1);
  assert.equal(removedCapability, true);
  assert.equal(await readFile(asar, "utf8"), "desktop package\n");
});

test("dead-generation recovery and rolled-back state permit a later explicit launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-host-recovery-"));
  const executable = join(root, "ChatGPT");
  const asar = join(root, "app.asar");
  await writeFile(executable, "desktop executable\n");
  await writeFile(asar, "desktop package\n");
  const packages = await snapshotDesktopPackages([executable, asar]);
  const source = { processId: 987654, executablePath: executable, executableSha256: "a".repeat(64), startIdentity: "987654:1780000000", electronVersion: "39.1.0" };
  const generation = createElectronGeneration(source);
  let transaction = { revision: 8, generation, phase: "recovery-required", source, bootstrap: { host: "127.0.0.1", port: 19324 }, capabilityDigest: capabilityDigest(createSupervisorCapability()), packageDigest: packages.digest };
  let removed = false;
  const store = {
    async read() { return transaction; },
    async loadCapability() { return null; },
    async transition(input) { transaction = { ...transaction, revision: transaction.revision + 1, phase: input.phase, recovery: input.recovery }; return transaction; },
    async removeCapability() { removed = true; },
  };
  const host = new DesktopHost(createTestConfig(), {
    token: "owner-token",
    store,
    packagePaths: [executable, asar],
    processPresenceProbe: async () => false,
    portProbe: async () => false,
    fetchImpl: async () => { const error = new Error("connect ECONNREFUSED"); error.code = "ECONNREFUSED"; throw error; },
  });
  const recovered = await host.recoverDeadGeneration("reviewed dead generation");
  assert.equal(recovered.phase, "rolled-back");
  assert.equal(removed, true);
  let launchCalls = 0;
  const relaunch = new DesktopHost(createTestConfig(), {
    token: "owner-token",
    store,
    portProbe: async () => true,
    launchProcess: () => { launchCalls += 1; throw new Error("must not reach spawn while occupied"); },
  });
  await assert.rejects(relaunch.run({ launch: true }), /port is already occupied/);
  assert.equal(launchCalls, 0);
});

test("rollback resumes an exact live recovery generation and finalizes its tombstone", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-host-rollback-resume-"));
  const executable = join(root, "ChatGPT");
  const asar = join(root, "app.asar");
  await writeFile(executable, "desktop executable\n");
  await writeFile(asar, "desktop package\n");
  const packages = await snapshotDesktopPackages([executable, asar]);
  const source = { processId: 4002, executablePath: executable, executableSha256: "a".repeat(64), startIdentity: "4002:1780000000", electronVersion: "39.1.0" };
  const generation = createElectronGeneration(source);
  const capability = createSupervisorCapability();
  let transaction = {
    revision: 7, generation, phase: "recovery-required", source,
    bootstrap: { host: "127.0.0.1", port: 19324 }, capabilityDigest: capabilityDigest(capability), packageDigest: packages.digest,
    endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: 40124, aclEvidence: "token-authenticated-loopback-no-native-acl" },
    recovery: { reason: "Authenticated supervisor rollback was journaled but is not yet proven complete" },
  };
  const operations = [];
  const client = {
    async open() {}, async close() {},
    async request(operation) {
      operations.push(operation);
      if (operation === "health") return { generation, ready: false };
      if (operation === "teardown") return { removed: true, duplicate: true };
      if (operation === "finalize-teardown") return { finalized: true };
      throw new Error(`Unexpected ${operation}`);
    },
  };
  let removed = false;
  const store = {
    async read() { return transaction; }, async loadCapability() { return capability; },
    async transition(input) { transaction = { ...transaction, revision: transaction.revision + 1, phase: input.phase, recovery: input.recovery }; return transaction; },
    async removeCapability() { removed = true; },
  };
  const host = new DesktopHost(createTestConfig(), {
    token: "owner-token", store, packagePaths: [executable, asar], clientFactory: () => client,
    portProbe: async () => false,
    fetchImpl: async () => { const error = new Error("ECONNREFUSED"); error.code = "ECONNREFUSED"; throw error; },
  });
  const result = await host.rollback("resumed rollback");
  assert.equal(result.phase, "rolled-back");
  assert.deepEqual(operations, ["health", "teardown", "finalize-teardown"]);
  assert.equal(removed, true);
});

test("explicit attach port mismatch is refused without poisoning persisted generation", async () => {
  const transaction = { generation: `electron_${"a".repeat(32)}`, revision: 3, phase: "attached", bootstrap: { host: "127.0.0.1", port: 19324 } };
  let transitions = 0;
  const host = new DesktopHost(createTestConfig(), {
    token: "owner-token",
    bootstrapPort: 19224,
    store: { async read() { return transaction; }, async transition() { transitions += 1; throw new Error("must not mutate"); } },
  });
  await assert.rejects(host.run({ launch: false }), /does not match the exact persisted generation/);
  assert.equal(transitions, 0);
});

test("endpoint-less rolled-back crash residue removes capability before relaunch", async () => {
  const capability = createSupervisorCapability();
  const source = { processId: 999991, executablePath: "/absent/ChatGPT", executableSha256: "a".repeat(64), startIdentity: "999991:1780000000", electronVersion: "39.1.0" };
  const transaction = { generation: createElectronGeneration(source), revision: 9, phase: "rolled-back", source, bootstrap: { host: "127.0.0.1", port: 19324 }, endpoint: null };
  let removed = false;
  const store = { async read() { return transaction; }, async loadCapability() { return capability; }, async removeCapability() { removed = true; } };
  const host = new DesktopHost(createTestConfig(), { token: "owner-token", store, processPresenceProbe: async () => false, portProbe: async () => true });
  await assert.rejects(host.run({ launch: true }), /port is already occupied/);
  assert.equal(removed, true);
});

test("Desktop route selection becomes the live Threadspan auto route", async () => {
  const config = createTestConfig({
    defaults: { provider: "mock", mode: "consult", model: "mock-model" },
    providers: { mock: { models: ["mock-model"] } },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  const selected = service.selectDesktopRoute({ routeId: "consult/mock/mock-model" });
  assert.equal(selected.routeId, "consult/mock/mock-model");
  const quick = service.desktopState();
  assert.ok(quick.pickerRoutes.some((route) => route.id === "consult/mock/mock-model"));
  const state = await service.threadspanState();
  assert.equal(state.desktopRouteSelection.routeId, "consult/mock/mock-model");
  assert.equal(state.route.id, "consult/mock/mock-model");
  service.selectDesktopRoute({ routeId: "delegate/mock/mock-model" });
  const explicitConsult = await service.executeResponse({ model: "consult/threadspan/auto", input: "mode authority" });
  assert.equal(explicitConsult.model, "consult/mock/mock-model");
  assert.match(explicitConsult.output_text, /^mock:consult:/);
  await service.close();
});
