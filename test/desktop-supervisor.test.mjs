import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  DesktopBootstrapStore,
  DesktopSupervisorClient,
  assertDesktopPackagesUnchanged,
  capabilityDigest,
  createElectronGeneration,
  createSupervisorBootstrapExpression,
  createSupervisorCapability,
  discoverInspectorTarget,
  proveInspectorClosed,
  snapshotDesktopPackages,
  validateInspectorTargetList,
  validateSupervisorAcknowledgement,
} from "../src/desktop/supervisor.mjs";

function identity(overrides = {}) {
  return {
    processId: 4242,
    executablePath: "/opt/chatgpt/ChatGPT",
    executableSha256: "a".repeat(64),
    startIdentity: "4242:1780000000",
    electronVersion: "39.1.0",
    ...overrides,
  };
}

function target(port, overrides = {}) {
  return {
    id: "node-main-1",
    type: "node",
    title: "ChatGPT",
    url: "file:///opt/chatgpt/resources/app.asar/main.js",
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/node/node-main-1`,
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "threadspan-desktop-supervisor-"));
  const executable = join(root, "ChatGPT");
  const resources = join(root, "resources");
  await mkdir(join(resources, "app"), { recursive: true });
  await writeFile(executable, "synthetic executable\n", { mode: 0o700 });
  await writeFile(join(resources, "app.asar"), "synthetic immutable asar\n");
  await writeFile(join(resources, "app", "package.json"), "{}\n");
  return { root, executable, paths: [executable, join(resources, "app.asar"), join(resources, "app", "package.json")] };
}

test("inspector discovery requires one exact Node target and rejects spoofing", async () => {
  const accepted = validateInspectorTargetList([target(19224)], { port: 19224 });
  assert.equal(accepted.id, "node-main-1");
  assert.match(accepted.discoveryDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => validateInspectorTargetList([], { port: 19224 }), /exactly one/);
  assert.throws(() => validateInspectorTargetList([target(19224), target(19224, { id: "other", webSocketDebuggerUrl: "ws://127.0.0.1:19224/node/other" })], { port: 19224 }), /exactly one/);
  assert.throws(() => validateInspectorTargetList([target(19224, { type: "page" })], { port: 19224 }), /Node main-process/);
  assert.throws(() => validateInspectorTargetList([target(19224, { webSocketDebuggerUrl: "ws://192.0.2.1:19224/node/node-main-1" })], { port: 19224 }), /loopback/);
  assert.throws(() => validateInspectorTargetList([target(19225)], { port: 19224 }), /exact loopback bootstrap port/);
  assert.throws(() => validateInspectorTargetList([target(19224, { webSocketDebuggerUrl: "ws://127.0.0.1:19224/node/wrong" })], { port: 19224 }), /does not match/);
});

test("inspector discovery rejects redirects, wrong content, and wrong target identity", async () => {
  const headers = { get: () => "application/json" };
  const accepted = await discoverInspectorTarget(19224, { fetchImpl: async () => ({ ok: true, status: 200, headers, json: async () => [target(19224)] }) });
  assert.equal(accepted.id, "node-main-1");
  await assert.rejects(discoverInspectorTarget(19224, { expectedTargetId: "different", fetchImpl: async () => ({ ok: true, status: 200, headers, json: async () => [target(19224)] }) }), /identity changed/);
  await assert.rejects(discoverInspectorTarget(19224, { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => [target(19224)] }) }), /content type/);
  await assert.rejects(discoverInspectorTarget(19224, { fetchImpl: async () => ({ ok: false, status: 302, headers, json: async () => [] }) }), /unavailable or unexpected/);
});

test("bootstrap expression installs a closed authenticated supervisor without renderer credentials", () => {
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(identity());
  const expression = createSupervisorBootstrapExpression({ generation, capability, expectedIdentity: identity() });
  assert.match(expression, /timingSafeEqual/);
  assert.match(expression, /tcp-loopback/);
  assert.match(expression, /browser-window-created/);
  assert.match(expression, /dom-ready/);
  assert.match(expression, /did-navigate/);
  assert.match(expression, /render-process-gone/);
  assert.match(expression, /removeListener/);
  assert.match(expression, /sync-hud/);
  assert.match(expression, /read-action/);
  assert.match(expression, /teardown/);
  assert.match(expression, /inspector\.close/);
  assert.doesNotMatch(expression, /authorization.*Bearer/i);
  const rendererSource = expression.slice(expression.indexOf("function mountRendererHud"), expression.indexOf("async function attachHud"));
  assert.doesNotMatch(rendererSource, new RegExp(capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(expression, /token-authenticated-native-acl-unverified/);
});

test("injected fake Electron runtime reattaches on navigation and rejects stale renderer actions", async () => {
  const fixedNow = 1_780_000_000_000;
  const executableBytes = Buffer.from("fake electron executable");
  const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
  const source = identity({ executablePath: "/opt/chatgpt/ChatGPT", executableSha256, startIdentity: "4242:1779999990" });
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(source);
  const runtime = fakeElectronRuntime({ fixedNow, executableBytes, capability, generation });
  const expression = createSupervisorBootstrapExpression({ generation, capability, expectedIdentity: source, closeInspectorDelayMs: 25 });
  const acknowledgement = structuredClone(await vm.runInNewContext(expression, runtime.context));
  assert.equal(validateSupervisorAcknowledgement(acknowledgement, { generation, capability, expectedIdentity: source }).ready, true);
  await flushTasks();
  assert.equal(runtime.inspectorCloseCount(), 1);

  const flood = runtime.connect();
  flood.emit("data", "{}\n".repeat(40));
  await flushTasks();
  assert.equal(flood.destroyed, true, "unauthenticated tiny-frame flood is bounded and disconnected");

  const socket = runtime.connect();
  let response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 1, actionId: `act_${"1".repeat(32)}`, operation: "sync-hud", payload: { hud: { routes: [{ id: "consult/mock/model", mode: "consult", provider: "mock", model: "model", available: true, free: true }], selected: "consult/mock/model", providerCount: 1, status: "ready" } } }));
  assert.equal(response.ok, true, response.error);
  assert.equal(response.result.attached, true);
  const attachedBefore = runtime.webContents.executions.length;
  runtime.webContents.emit("did-navigate");
  await flushTasks();
  assert.ok(runtime.webContents.executions.length > attachedBefore, "navigation reattaches the last sanitized HUD");
  runtime.windows[0].visible = false;
  const replacementWindow = runtime.addWindow({ id: 8, width: 1400, height: 900 });
  runtime.app.emit("browser-window-created", {}, replacementWindow);
  await flushTasks();
  assert.ok(replacementWindow.webContents.executions.some((sourceText) => sourceText.includes("function mountRendererHud")), "replacement largest window receives the HUD");
  assert.ok(runtime.webContents.executions.some((sourceText) => sourceText.includes("threadspanGeneration")), "prior hidden renderer is generation-cleaned");

  runtime.rendererAction = JSON.stringify({ schemaVersion: 1, generation, actionId: "renderer_same-action", type: "select-route", routeId: "consult/mock/model" });
  response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 2, actionId: `act_${"2".repeat(32)}`, operation: "read-action", payload: {} }));
  assert.equal(response.result.action.routeId, "consult/mock/model");
  runtime.rendererAction = JSON.stringify({ schemaVersion: 1, generation, actionId: "renderer_same-action", type: "select-route", routeId: "consult/mock/model" });
  response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 3, actionId: `act_${"3".repeat(32)}`, operation: "read-action", payload: {} }));
  assert.equal(response.ok, false);
  assert.match(response.error, /duplicated or replayed/);

  const intruder = runtime.connect();
  response = await runtime.request(intruder, protocolRequest("x".repeat(43), { schemaVersion: 1, generation, sessionNonce: intruder.sessionNonce, sequence: 1, actionId: `act_${"4".repeat(32)}`, operation: "health", payload: {} }));
  assert.equal(response.ok, false);
  assert.match(response.error, /authentication/);

  replacementWindow.visible = false;
  replacementWindow.webContents.failRemovalOnce = true;
  response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 4, actionId: `act_${"5".repeat(32)}`, operation: "teardown", payload: {} }));
  assert.equal(response.ok, false);
  assert.match(response.error, /could not remove/);
  response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 5, actionId: `act_${"6".repeat(32)}`, operation: "teardown", payload: {} }));
  assert.equal(response.result.removed, true);
  response = await runtime.request(socket, protocolRequest(capability, { schemaVersion: 1, generation, sessionNonce: socket.sessionNonce, sequence: 6, actionId: `act_${"7".repeat(32)}`, operation: "finalize-teardown", payload: {} }));
  assert.equal(response.result.finalized, true);
  assert.equal(runtime.app.listenerCount("browser-window-created"), 0);
  for (const contents of [runtime.webContents, replacementWindow.webContents]) {
    for (const event of ["dom-ready", "did-finish-load", "did-navigate", "render-process-gone", "destroyed"]) assert.equal(contents.listenerCount(event), 0);
  }
});

test("injected bootstrap failure closes the inspector and removes partial initialization", async () => {
  const fixedNow = 1_780_000_000_000;
  const executableBytes = Buffer.from("fake electron executable");
  const source = identity({ executableSha256: createHash("sha256").update(executableBytes).digest("hex"), startIdentity: "4242:1779999990" });
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(source);
  const runtime = fakeElectronRuntime({ fixedNow, executableBytes, failServerBind: true });
  await assert.rejects(vm.runInNewContext(createSupervisorBootstrapExpression({ generation, capability, expectedIdentity: source }), runtime.context), /synthetic bind failure/);
  await flushTasks();
  assert.equal(runtime.inspectorCloseCount(), 1);
  assert.equal(runtime.app.listenerCount("browser-window-created"), 0);
});

test("post-listen supervisor server error is contained without crashing Electron main", async () => {
  const fixedNow = 1_780_000_000_000;
  const executableBytes = Buffer.from("fake electron executable");
  const source = identity({ executableSha256: createHash("sha256").update(executableBytes).digest("hex"), startIdentity: "4242:1779999990" });
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(source);
  const runtime = fakeElectronRuntime({ fixedNow, executableBytes });
  await vm.runInNewContext(createSupervisorBootstrapExpression({ generation, capability, expectedIdentity: source }), runtime.context);
  assert.doesNotThrow(() => runtime.server.emit("error", new Error("synthetic post-listen failure")));
  await flushTasks();
  assert.equal(runtime.app.listenerCount("browser-window-created"), 0);
});

test("source-bound acknowledgement rejects source, capability, and receipt substitution", () => {
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(identity());
  const endpoint = { transport: "tcp-loopback", host: "127.0.0.1", port: 41234, aclEvidence: "token-authenticated-loopback-no-native-acl" };
  const body = {
    schemaVersion: 1,
    generation,
    ready: true,
    source: { processId: 4242, executablePath: "/opt/chatgpt/ChatGPT", executableSha256: "a".repeat(64), startIdentity: "4242:1780000000", electronVersion: "39.1.0" },
    endpoint,
    capabilityDigest: capabilityDigest(capability),
    reused: false,
  };
  const receiptDigest = createHashForTest(body);
  const accepted = validateSupervisorAcknowledgement({ ...body, receiptDigest }, { generation, capability, expectedIdentity: identity() });
  assert.equal(accepted.receiptDigest, receiptDigest);
  assert.doesNotMatch(JSON.stringify(accepted), new RegExp(capability));
  assert.throws(() => validateSupervisorAcknowledgement({ ...body, source: { ...body.source, processId: 7 }, receiptDigest }, { generation, capability, expectedIdentity: identity() }), /source identity mismatch/);
  assert.throws(() => validateSupervisorAcknowledgement({ ...body, capabilityDigest: "b".repeat(64), receiptDigest }, { generation, capability, expectedIdentity: identity() }), /capability mismatch/);
  assert.throws(() => validateSupervisorAcknowledgement({ ...body, receiptDigest: "c".repeat(64) }, { generation, capability, expectedIdentity: identity() }), /not source-bound/);
});

test("durable transaction is revision-bound, exactly phased, and capability-private", async () => {
  const { root, paths } = await fixture();
  const statePath = join(root, "state", "desktop-bootstrap.json");
  const store = new DesktopBootstrapStore({ statePath, owner: "test-owner", platform: "linux" });
  const source = identity({ executablePath: paths[0] });
  const generation = createElectronGeneration(source);
  const capability = createSupervisorCapability();
  const packages = await snapshotDesktopPackages(paths);
  let state = await store.prepare({ generation, source, bootstrap: { host: "127.0.0.1", port: 19224 }, capabilityDigest: capabilityDigest(capability), packageEvidence: packages });
  assert.equal(state.phase, "prepared");
  await store.saveCapability(generation, capability);
  assert.equal(await store.loadCapability(generation), capability);
  assert.equal((await stat(`${statePath}.capability`)).mode & 0o777, 0o600);
  const persisted = await readFile(statePath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(capability));
  assert.match(persisted, new RegExp(capabilityDigest(capability)));
  await assert.rejects(store.transition({ generation, expectedRevision: state.revision, phase: "attached" }), /cannot transition/);
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "injected" });
  await assert.rejects(store.transition({ generation, expectedRevision: state.revision - 1, phase: "acknowledged", endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: 40001, aclEvidence: "token-authenticated-loopback-no-native-acl" }, receiptDigest: "d".repeat(64) }), /revision changed/);
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "acknowledged", endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: 40001, aclEvidence: "token-authenticated-loopback-no-native-acl" }, receiptDigest: "d".repeat(64) });
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "inspector-closed" });
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "attached" });
  assert.equal(state.phase, "attached");
});

test("cooperative claim blocks concurrent writers and never guesses staleness", async () => {
  const { root, paths } = await fixture();
  const statePath = join(root, "desktop-bootstrap.json");
  const claimPath = `${statePath}.claim`;
  await writeFile(claimPath, `${JSON.stringify({ schemaVersion: 1, nonce: "foreign", owner: "other", processId: 999999 })}\n`, { mode: 0o600 });
  const store = new DesktopBootstrapStore({ statePath });
  const source = identity({ executablePath: paths[0] });
  const packages = await snapshotDesktopPackages(paths);
  await assert.rejects(store.prepare({ generation: createElectronGeneration(source), source, bootstrap: { host: "127.0.0.1", port: 19224 }, capabilityDigest: capabilityDigest(createSupervisorCapability()), packageEvidence: packages }), /existing cooperative claim/);
  assert.match(await readFile(claimPath, "utf8"), /foreign/);
});

test("one process-shared Desktop host claim fences service attach from explicit launch", async () => {
  const { root } = await fixture();
  const store = new DesktopBootstrapStore({ statePath: join(root, "bootstrap.json") });
  const releaseLaunch = await store.acquireHostClaim({ mode: "launch" });
  await assert.rejects(store.acquireHostClaim({ mode: "attach" }), /Another Desktop host owns/);
  await releaseLaunch();
  const releaseAttach = await store.acquireHostClaim({ mode: "attach" });
  await releaseAttach();
});

test("abandoned Desktop host claim requires exact reviewed digest and preserves evidence", async () => {
  const { root } = await fixture();
  const store = new DesktopBootstrapStore({ statePath: join(root, "bootstrap.json") });
  await store.acquireHostClaim({ mode: "launch" });
  const claim = await store.inspectHostClaim();
  assert.equal(claim.present, true);
  const digest = claim.blockers.find((item) => item.kind === "host-claim").digest;
  await assert.rejects(store.recoverHostClaim("f".repeat(64)), /digest mismatch/);
  const recovered = await store.recoverHostClaim(digest);
  assert.equal(recovered.recovered, true);
  assert.match(recovered.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await store.inspectHostClaim(), { present: false, blockers: [] });
  const release = await store.acquireHostClaim({ mode: "attach" });
  await release();
});

test("crashed transaction claim is inspectable and exact-digest recoverable", async () => {
  const { root } = await fixture();
  const statePath = join(root, "bootstrap.json");
  const claimPath = `${statePath}.claim`;
  await writeFile(claimPath, `${JSON.stringify({ schemaVersion: 1, nonce: "crashed-transaction", owner: "test", processId: 999999, platform: "linux", createdAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  const store = new DesktopBootstrapStore({ statePath });
  const inspected = await store.inspectHostClaim();
  const blocker = inspected.blockers.find((item) => item.kind === "transaction-claim");
  assert.ok(blocker);
  const recovered = await store.recoverHostClaim(blocker.digest);
  assert.equal(recovered.kind, "transaction-claim");
  assert.deepEqual(await store.inspectHostClaim(), { present: false, blockers: [] });
});

test("uncertain injection is terminal and cannot be blindly replayed", async () => {
  const { root, paths } = await fixture();
  const store = new DesktopBootstrapStore({ statePath: join(root, "bootstrap.json") });
  const source = identity({ executablePath: paths[0] });
  const generation = createElectronGeneration(source);
  const capability = createSupervisorCapability();
  let state = await store.prepare({ generation, source, bootstrap: { host: "127.0.0.1", port: 19224 }, capabilityDigest: capabilityDigest(capability), packageEvidence: await snapshotDesktopPackages(paths) });
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "injected" });
  state = await store.transition({ generation, expectedRevision: state.revision, phase: "indeterminate", recovery: { reason: "WebSocket closed before acknowledgement", ownerAction: "Review exact generation", inspectorRestored: false } });
  assert.equal(state.phase, "indeterminate");
  await assert.rejects(store.prepare({ generation, source, bootstrap: { host: "127.0.0.1", port: 19224 }, capabilityDigest: capabilityDigest(capability), packageEvidence: await snapshotDesktopPackages(paths) }), /reviewed recovery/);
  await assert.rejects(store.transition({ generation, expectedRevision: state.revision, phase: "attached" }), /cannot transition/);
});

test("package evidence binds exact digest and absence without mutating app.asar", async () => {
  const { paths } = await fixture();
  const missing = `${paths[1]}.missing`;
  const before = await snapshotDesktopPackages([...paths, missing]);
  const after = await snapshotDesktopPackages([...paths, missing]);
  assert.deepEqual(assertDesktopPackagesUnchanged(before, after), { unchanged: true, digest: before.digest, paths: 4 });
  const originalAsar = await readFile(paths[1], "utf8");
  assert.equal(originalAsar, "synthetic immutable asar\n");
  await writeFile(paths[2], "{\"changed\":true}\n");
  const changed = await snapshotDesktopPackages([...paths, missing]);
  assert.throws(() => assertDesktopPackagesUnchanged(before, changed), /immutability check failed/);
  assert.equal(await readFile(paths[1], "utf8"), originalAsar);
});

test("successor client authenticates exact generation, sequence, and action IDs with bounded frames", async (t) => {
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(identity());
  const received = [];
  const serverSockets = [];
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
    serverSockets.push(socket);
    const sessionNonce = (connectionCount % 16).toString(16).repeat(32);
    const hello = { schemaVersion: 1, generation, kind: "hello", sessionNonce };
    socket.write(`${JSON.stringify({ ...hello, auth: protocolAuthentication(capability, hello) })}\n`);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(raw);
      received.push(request);
      const body = { schemaVersion: 1, generation, sessionNonce, sequence: request.sequence, actionId: request.actionId, ok: true, result: { ready: true } };
      socket.write(`${JSON.stringify({ ...body, auth: protocolAuthentication(capability, body) })}\n`);
    });
  });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  t.after(() => server.close());
  const address = server.address();
  const client = new DesktopSupervisorClient({ generation, capability, endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: address.port, aclEvidence: "token-authenticated-loopback-no-native-acl" } });
  t.after(() => client.close());
  assert.deepEqual(await client.request("health", {}), { ready: true });
  assert.equal(received[0].generation, generation);
  assert.equal("capability" in received[0], false);
  assert.equal(received[0].auth, protocolAuthentication(capability, { schemaVersion: 1, generation, sessionNonce: "1".repeat(32), sequence: 1, actionId: received[0].actionId, operation: "health", payload: {} }));
  assert.equal(received[0].sequence, 1);
  assert.match(received[0].actionId, /^act_[a-f0-9]{32}$/);
  serverSockets[0].destroy();
  await flushTasks();
  assert.deepEqual(await client.request("health", {}), { ready: true });
  assert.equal(received[1].sequence, 1, "fresh authenticated session resets the per-connection sequence");
  assert.equal(received[1].sessionNonce, "2".repeat(32));

  const concurrent = new DesktopSupervisorClient({ generation, capability, endpoint: { transport: "tcp-loopback", host: "127.0.0.1", port: address.port, aclEvidence: "token-authenticated-loopback-no-native-acl" } });
  t.after(() => concurrent.close());
  const beforeConcurrent = connectionCount;
  await Promise.all([concurrent.open(), concurrent.open(), concurrent.open()]);
  assert.equal(connectionCount, beforeConcurrent + 1, "concurrent opens share one authenticated handshake");
  await assert.rejects(client.request("eval", {}), /Unsupported/);
  await assert.rejects(client.request("sync-hud", { hud: { routes: [{ id: "x", padding: "z".repeat(70_000) }] } }), /frame is too large/);
});

test("successor connection refusal is caught without an unhandled hello rejection", async () => {
  const capability = createSupervisorCapability();
  const generation = createElectronGeneration(identity());
  const endpoint = { transport: "tcp-loopback", host: "127.0.0.1", port: 40123, aclEvidence: "token-authenticated-loopback-no-native-acl" };
  const client = new DesktopSupervisorClient({
    generation, capability, endpoint, timeoutMs: 100,
    connect: () => {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.setNoDelay = () => {};
      socket.setEncoding = () => {};
      socket.destroy = () => { socket.destroyed = true; };
      queueMicrotask(() => socket.emit("error", new Error("synthetic refusal")));
      return socket;
    },
  });
  let unhandled = null;
  const onUnhandled = (error) => { unhandled = error; };
  process.once("unhandledRejection", onUnhandled);
  await assert.rejects(client.open(), /synthetic refusal/);
  await flushTasks();
  process.removeListener("unhandledRejection", onUnhandled);
  assert.equal(unhandled, null);
});

test("inspector closure proof rejects premature close and later reappearance", async () => {
  let calls = 0;
  const closed = await proveInspectorClosed({
    port: 19224,
    socketClosed: Promise.resolve(true),
    attempts: 4,
    intervalMs: 1,
    wait: async () => {},
    portProbe: async () => false,
    fetchImpl: async () => { calls += 1; throw new Error("ECONNREFUSED"); },
  });
  assert.equal(closed.closed, true);
  await assert.rejects(proveInspectorClosed({ port: 19224, socketClosed: Promise.resolve(false), socketCloseTimeoutMs: 1, attempts: 1, intervalMs: 1, wait: async () => {}, portProbe: async () => false, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), /WebSocket did not close/);
  await assert.rejects(proveInspectorClosed({ port: 19224, socketClosed: Promise.resolve(true), attempts: 2, intervalMs: 1, wait: async () => {}, portProbe: async () => true, fetchImpl: async () => { throw new Error("timeout"); } }), /remained, reappeared, or its port was reoccupied/);
  await assert.rejects(proveInspectorClosed({ port: 19224, socketClosed: Promise.resolve(true), attempts: 2, intervalMs: 1, wait: async () => {}, portProbe: async () => false, fetchImpl: async () => { throw new Error("ETIMEDOUT"); } }), /closure was ambiguous/);
});

function createHashForTest(value) {
  const stable = (item) => Array.isArray(item) ? `[${item.map(stable).join(",")}]`
    : item && typeof item === "object" ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`
      : JSON.stringify(item);
  return createHash("sha256").update(stable(value)).digest("hex");
}

function protocolRequest(capability, body) { return { ...body, auth: protocolAuthentication(capability, body) }; }

function protocolAuthentication(capability, value) {
  const stable = (item) => Array.isArray(item) ? `[${item.map(stable).join(",")}]`
    : item && typeof item === "object" ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}`
      : JSON.stringify(item);
  return createHmac("sha256", capability).update(stable(value)).digest("hex");
}

function fakeElectronRuntime({ fixedNow, executableBytes, failServerBind = false }) {
  const app = new EventEmitter();
  const runtime = { rendererAction: null, windows: [] };
  runtime.addWindow = ({ id, width, height, visible = true }) => {
    const contents = new EventEmitter();
    contents.id = id + 5;
    contents.executions = [];
    contents.destroyed = false;
    contents.failRemovalOnce = false;
    contents.isDestroyed = () => contents.destroyed;
    contents.executeJavaScript = async (source) => {
      contents.executions.push(source);
      if (source.includes("function mountRendererHud")) return { mounted: true };
      if (source.includes("threadspanAction")) {
        const action = runtime.rendererAction;
        runtime.rendererAction = null;
        return action;
      }
      if (source.includes("threadspanGeneration")) {
        if (contents.failRemovalOnce) { contents.failRemovalOnce = false; throw new Error("renderer navigated during removal"); }
        return true;
      }
      return { mounted: true };
    };
    const window = { id, visible, isDestroyed: () => false, isVisible: () => window.visible, getBounds: () => ({ width, height }), webContents: contents };
    runtime.windows.push(window);
    return window;
  };
  const primaryWindow = runtime.addWindow({ id: 7, width: 1200, height: 800 });
  const webContents = primaryWindow.webContents;
  const electron = { app, BrowserWindow: { getAllWindows: () => runtime.windows } };
  let connectionHandler;
  let inspectorCloses = 0;
  const server = new EventEmitter();
  server.listen = (_options, callback) => { if (failServerBind) queueMicrotask(() => server.emit("error", new Error("synthetic bind failure"))); else callback(); return server; };
  server.address = () => ({ address: "127.0.0.1", port: 42123 });
  server.close = () => {};
  const net = { createServer(handler) { connectionHandler = handler; return server; } };
  const fakeProcess = {
    pid: 4242,
    execPath: "/opt/chatgpt/ChatGPT",
    platform: "linux",
    versions: { electron: "39.1.0" },
    uptime: () => 10,
    getBuiltinModule(name) {
      if (name === "crypto") return process.getBuiltinModule("crypto");
      if (name === "fs") return { readFileSync: () => executableBytes };
      if (name === "net") return net;
      if (name === "inspector") return { close: () => { inspectorCloses += 1; } };
      if (name === "module") return { createRequire: () => () => electron };
      throw new Error(`Unexpected builtin ${name}`);
    },
  };
  class FixedDate extends Date { static now() { return fixedNow; } }
  const timer = (callback, delay = 0) => { if (delay < 5_000) queueMicrotask(callback); return { unref() {} }; };
  runtime.context = { process: fakeProcess, Buffer, Date: FixedDate, setTimeout: timer, clearTimeout };
  runtime.app = app;
  runtime.server = server;
  runtime.webContents = webContents;
  runtime.inspectorCloseCount = () => inspectorCloses;
  runtime.connect = () => {
    const socket = new EventEmitter();
    socket.responses = [];
    socket.destroyed = false;
    socket.setEncoding = () => {};
    socket.setNoDelay = () => {};
    socket.pause = () => {};
    socket.resume = () => {};
    socket.write = (data) => { socket.responses.push(JSON.parse(String(data).trim())); return true; };
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; socket.emit("close"); } };
    connectionHandler(socket);
    const hello = socket.responses.shift();
    socket.sessionNonce = hello.sessionNonce;
    return socket;
  };
  runtime.request = async (socket, request) => {
    socket.emit("data", `${JSON.stringify(request)}\n`);
    await flushTasks();
    return socket.responses.shift();
  };
  return runtime;
}

async function flushTasks() {
  await new Promise((accept) => setImmediate(accept));
  await new Promise((accept) => setImmediate(accept));
}
