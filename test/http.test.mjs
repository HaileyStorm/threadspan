import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { ProviderError } from "../src/core/errors.mjs";
import { UsageLedger } from "../src/core/usage-ledger.mjs";
import { ProviderAdapter } from "../src/providers/base.mjs";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import { createTestConfig as createBaseTestConfig, nativePath, silentLogger } from "./helpers.mjs";

let accountStateSequence = 0;
function createTestConfig(override = {}) {
  return createBaseTestConfig({
    ...override,
    accounts: {
      path: join(tmpdir(), `threadspan-http-account-state-${process.pid}-${accountStateSequence++}.json`),
      profileSources: {},
      fallback: { enabled: false, maxCandidates: 1 },
      ...(override.accounts ?? {}),
    },
  });
}

test("HTTP surface serves health, models, buffered Responses, and SSE", async (t) => {
  const config = createTestConfig({ providers: { mock: {
    officialUrl: "https://provider.example",
    accountUrl: "https://provider.example/account",
    usageUrl: "https://provider.example/usage",
  } } });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.branching.synthesisOwner, "caller");
  assert.equal(health.branching.toolPolicy, "decision-useful-only");
  assert.equal(health.connectionRecovery.reroutePolicy, "existing-gates-only");
  assert.equal(health.selfHeal.subsystemOwner, "compatibility-watch");
  assert.deepEqual(health.selfHeal.phases, ["repair", "meta", "meta-meta"]);
  assert.equal(health.selfHeal.maxAnalysisDepth, 2);
  assert.equal(health.selfHeal.contribution.localMonitorReview, "required");
  assert.equal(health.selfHeal.contribution.autoMerge, false);
  const models = await fetch(`${base}/v1/models`).then((response) => response.json());
  assert.ok(models.data.some((model) => model.id === "consult/mock/mock-model"));
  const providers = await fetch(`${base}/v1/bridge/providers`).then((response) => response.json());
  const mockProvider = providers.data.find((item) => item.id === "mock");
  assert.equal(mockProvider.effectiveSettings.owner, "host");
  assert.equal(mockProvider.effectiveSettings.inheritance, "native-host-project");
  assert.deepEqual(mockProvider.effectiveSettings.preserved, ["sandbox", "approval", "tools", "web", "memory", "user", "project"]);
  assert.match(mockProvider.effectiveSettings.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(mockProvider.connectionLifecycle.health, { provider: "available", account: "available", transport: "not-probed" });
  assert.equal(mockProvider.connectionLifecycle.recovery.parentInterruptionHandleAudit, "required");
  assert.equal(mockProvider.officialUrl, "https://provider.example");
  assert.equal(mockProvider.accountUrl, "https://provider.example/account");
  assert.equal(mockProvider.usageUrl, "https://provider.example/usage");
  const sidecar = await fetch(`${base}/threadspan/`);
  assert.equal(sidecar.status, 200);
  assert.match(sidecar.headers.get("content-type"), /text\/html/);
  assert.match(await sidecar.text(), /One task\. Every model\./);
  const sidecarState = await fetch(`${base}/threadspan/state`).then((response) => response.json());
  assert.equal(sidecarState.product.name, "Threadspan");
  assert.ok(sidecarState.routeMap.nodes.some((node) => node.id === "mock"));
  const sidecarProvider = sidecarState.routeMap.nodes.find((node) => node.id === "mock");
  assert.equal(sidecarProvider.officialUrl, "https://provider.example");
  assert.equal(sidecarProvider.accountUrl, "https://provider.example/account");
  assert.equal(sidecarProvider.usageUrl, "https://provider.example/usage");
  assert.equal(sidecarState.route.officialUrl, "https://provider.example");
  assert.equal(sidecarState.route.accountUrl, "https://provider.example/account");
  assert.equal(sidecarState.route.usageUrl, "https://provider.example/usage");
  assert.equal("creditState" in sidecarProvider, false);
  assert.equal("expiryState" in sidecarProvider, false);
  assert.equal(sidecarState.route.effectiveSettings.owner, "host");
  assert.equal(sidecarState.branching.stopOnConvergence, true);
  assert.deepEqual(sidecarState.branching.activationReasons, ["independent-evidence", "divergent-ideation", "disjoint-writes"]);
  assert.equal(sidecarState.connectionRecovery.requireAdapterSpecificRecovery, true);
  assert.equal(sidecarState.selfHeal.subsystemOwner, "compatibility-watch");
  assert.equal(sidecarState.selfHeal.immediateRecoveryFirst, true);
  assert.equal(sidecarState.selfHeal.stopAfterMetaMeta, true);
  assert.equal("thread" in sidecarState, false);

  const bufferedResponse = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "consult/mock/mock-model", input: "buffered" }),
  });
  assert.equal(bufferedResponse.status, 200);
  const buffered = await bufferedResponse.json();
  assert.match(buffered.output_text, /buffered$/);
  assert.equal(buffered.bridge_provider_metadata.effectiveSettings.owner, "host");
  assert.match(buffered.bridge_provider_metadata.effectiveSettings.digest, /^[0-9a-f]{64}$/);

  const streamResponse = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "consult/mock/mock-model", input: "stream", stream: true }),
  });
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: response\.created/);
  assert.match(streamText, /event: response\.completed/);
  assert.match(streamText, /data: \[DONE\]/);
});

test("HTTP Responses defaults Consult and Integrated to no source, preserves explicit workspace aliases, and rejects implicit Delegate cwd", async (t) => {
  const config = createTestConfig();
  const service = new BridgeService(config, { logger: silentLogger() });
  const provider = service.registry.providers.get("mock");
  const providerRun = provider.run.bind(provider);
  const requests = [];
  provider.run = async function* observedRun(request) {
    requests.push({ mode: request.mode, workspace: request.workspace });
    yield* providerRun(request);
  };
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const endpoint = `http://127.0.0.1:${address.port}/v1/responses`;
  const post = (body) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  for (const body of [
    { model: "consult/mock/mock-model", input: "private consult" },
    { model: "integrated/mock/mock-model", input: "private integrated" },
    { model: "consult/mock/mock-model", input: "explicit bridge workspace", metadata: { bridge_workspace: "/explicit/bridge" } },
    { model: "consult/mock/mock-model", input: "explicit cwd", metadata: { cwd: "/explicit/cwd" } },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(requests, [
    { mode: "consult", workspace: undefined },
    { mode: "integrated", workspace: undefined },
    { mode: "consult", workspace: "/explicit/bridge" },
    { mode: "consult", workspace: "/explicit/cwd" },
  ]);
  assert.equal(requests.some((request) => request.workspace === process.cwd()), false);

  const delegate = await post({ model: "delegate/mock/mock-model", input: "must fail without workspace" });
  assert.equal(delegate.status, 400);
  const error = await delegate.json();
  assert.equal(error.error.code, "invalid_request");
  assert.match(error.error.message, /Delegate requires an explicit workspace/);
  assert.equal(requests.length, 4, "HTTP Delegate must fail before provider invocation");
});

test("service keeps pre-output auth, mid-turn provider, and parent interruption recovery distinct", async (t) => {
  const isolatedRaw = new ProviderAdapter("isolated-raw", {
    adapter: "mock",
    capabilities: ["integrated"],
    __threadspanAccount: { id: "acct_raw", authKind: "api-key-env", isolated: true },
  }, { logger: silentLogger() });
  assert.equal(isolatedRaw.effectiveSettings().authentication, "isolated-api-key-environment");

  class LifecycleProvider extends ProviderAdapter {
    capabilities() {
      return { ...super.capabilities(), modes: { consult: { supported: true }, integrated: { supported: false }, delegate: { supported: false } } };
    }
    async *run(request) {
      const scenario = request.metadata.scenario;
      if (scenario === "auth") throw new ProviderError(this.id, "native login required", { status: 401 });
      if (scenario === "exhaust") return;
      if (scenario === "mid") {
        yield { type: "text-delta", delta: "partial" };
        throw new ProviderError(this.id, "provider connection closed", { status: 502 });
      }
      if (request.signal.aborted) throw request.signal.reason;
      await new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
    }
    async auditRecovery() {
      return { adapter: "lifecycle-test", status: "handle-audited", resumable: true, orphaned: false };
    }
  }
  const config = createTestConfig({ providers: { lifecycle: { adapter: "mock", capabilities: ["consult"], model: "model" } }, defaults: { provider: "lifecycle", mode: "consult", model: "model" } });
  const provider = new LifecycleProvider("lifecycle", config.providers.lifecycle, { logger: silentLogger() });
  const registry = {
    providers: new Map([["lifecycle", provider]]),
    resolveRoute: () => ({ providerId: "lifecycle", accountId: "unknown/default", mode: "consult", model: "model", provider }),
    fallbackRoutes: () => [],
    recordFailure: async () => undefined,
    recordSuccess: async () => undefined,
    close: async () => undefined,
  };
  const service = new BridgeService(config, { logger: silentLogger(), registry });
  t.after(() => service.close());
  const invoke = (scenario, options = {}) => service.executeResponse({ model: "consult/lifecycle/model", input: "test", metadata: { scenario } }, options);

  await assert.rejects(invoke("auth"), (error) => {
    assert.equal(error.details.connectionLifecycle.failure.class, "pre-output-auth-failure");
    assert.equal(error.details.connectionLifecycle.failure.safeReroute, "existing-privacy-account-authority-gates-only");
    assert.equal(error.details.connectionLifecycle.health.account, "reauth-required");
    assert.deepEqual(error.details.selfHealPolicy.phases, ["repair", "meta", "meta-meta"]);
    return true;
  });
  await assert.rejects(invoke("mid"), (error) => {
    assert.equal(error.details.connectionLifecycle.failure.class, "mid-turn-provider-failure");
    assert.equal(error.details.connectionLifecycle.failure.safeReroute, false);
    return true;
  });
  await assert.rejects(invoke("exhaust"), (error) => {
    assert.match(error.message, /without a terminal done event/);
    assert.equal(error.details.connectionLifecycle.failure.stage, "pre-output");
    return true;
  });
  const controller = new AbortController();
  const interrupted = invoke("interrupt", { signal: controller.signal });
  controller.abort(new Error("parent stopped"));
  await assert.rejects(interrupted, (error) => {
    assert.equal(error.details.connectionLifecycle.failure.class, "parent-turn-interruption");
    assert.equal(error.details.connectionLifecycle.failure.recoveryAudit.status, "handle-audited");
    assert.equal(error.details.connectionLifecycle.failure.recoveryAudit.orphaned, false);
    return true;
  });
});

test("HTTP surface rejects unapproved browser origins without a valid token", async (t) => {
  const original = process.env.CURSOR_BRIDGE_TEST_TOKEN;
  process.env.CURSOR_BRIDGE_TEST_TOKEN = "token";
  t.after(() => {
    if (original === undefined) delete process.env.CURSOR_BRIDGE_TEST_TOKEN;
    else process.env.CURSOR_BRIDGE_TEST_TOKEN = original;
  });
  const config = createTestConfig({ server: { allowUnauthenticatedLoopback: false } });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const response = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(response.status, 403);
  const authorized = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: { origin: "https://evil.example", authorization: "Bearer token" },
  });
  assert.equal(authorized.status, 200);
  const stateWithoutToken = await fetch(`http://127.0.0.1:${address.port}/threadspan/state`);
  assert.equal(stateWithoutToken.status, 401);
  const stateWithToken = await fetch(`http://127.0.0.1:${address.port}/threadspan/state`, { headers: { authorization: "Bearer token" } });
  assert.equal(stateWithToken.status, 200);
});

test("maximum-utilization native refresh and owner controls deny the connector token and arbitrary events", async (t) => {
  const previousMain = process.env.THREADSPAN_MAX_TEST_MAIN;
  const previousConnector = process.env.THREADSPAN_MAX_TEST_CONNECTOR;
  process.env.THREADSPAN_MAX_TEST_MAIN = "owner-main-token";
  process.env.THREADSPAN_MAX_TEST_CONNECTOR = "connector-only-token";
  t.after(() => {
    if (previousMain === undefined) delete process.env.THREADSPAN_MAX_TEST_MAIN;
    else process.env.THREADSPAN_MAX_TEST_MAIN = previousMain;
    if (previousConnector === undefined) delete process.env.THREADSPAN_MAX_TEST_CONNECTOR;
    else process.env.THREADSPAN_MAX_TEST_CONNECTOR = previousConnector;
  });
  const received = [];
  const service = {
    refreshMaximumUtilizationNative: async () => { received.push("refresh"); return { accepted: true, observationCount: 1 }; },
    disableMaximumUtilization: async () => { received.push("disable"); return { accepted: true }; },
    enterManualMaximumUtilization: async (body) => { received.push(body); return { accepted: true }; },
    leaveManualMaximumUtilization: async () => { received.push("leave"); return { accepted: true }; },
    threadspanState: async () => ({ status: "ready", maximumUtilization: { phase: "idle" } }),
  };
  const config = {
    server: {
      host: "127.0.0.1", port: 0, authTokenEnv: "THREADSPAN_MAX_TEST_MAIN",
      connectorTokenEnv: "THREADSPAN_MAX_TEST_CONNECTOR", allowUnauthenticatedLoopback: false,
      connectorTokenFile: "/not/read/by-threadspan-server",
      maxBodyBytes: 1024 * 1024, requestTimeoutMs: 5000, maxConcurrentRequests: 1, allowedOrigins: [],
    },
  };
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(() => closeHttpServer(server));
  const base = `http://127.0.0.1:${address.port}`;
  const connectorHeaders = { authorization: "Bearer connector-only-token", "content-type": "application/json" };
  const deniedEvent = await fetch(`${base}/v1/maximum-utilization/refresh-native`, { method: "POST", headers: connectorHeaders, body: "{}" });
  const deniedRead = await fetch(`${base}/threadspan/state`, { headers: connectorHeaders });
  assert.equal(deniedEvent.status, 401);
  assert.equal(deniedRead.status, 401);
  assert.deepEqual(received, []);

  const removedArbitrary = await fetch(`${base}/v1/maximum-utilization/events`, {
    method: "POST",
    headers: { authorization: "Bearer owner-main-token", "content-type": "application/json" },
    body: JSON.stringify({ type: "native-quota-observed", usedRatio: 1 }),
  });
  assert.equal(removedArbitrary.status, 404);
  const accepted = await fetch(`${base}/v1/maximum-utilization/refresh-native`, {
    method: "POST",
    headers: { authorization: "Bearer owner-main-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(accepted.status, 202);
  assert.equal(received.length, 1);
});

test("Threadspan state propagates a sanitized recent-burn forecast without inventing quota", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-http-forecast-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = "2026-08-17T18:00:00Z";
  const usageLedger = new UsageLedger({ path: join(root, "usage.jsonl"), now: () => now, forecastWindowMs: 6 * 60 * 60 * 1000 });
  for (const timestamp of ["2026-08-17T12:00:00Z", now]) {
    await usageLedger.append({ timestamp, provider: "mock", accountId: "unknown/default", model: "mock-model", mode: "consult", status: "completed", evidenceClass: "live-provider", inputTokens: 120, outputTokens: 30 });
  }
  const config = createTestConfig();
  const service = new BridgeService(config, { logger: silentLogger(), usageLedger });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });
  const state = await fetch(`http://127.0.0.1:${address.port}/threadspan/state`).then((response) => response.json());
  assert.equal(state.quota, null);
  assert.equal(state.forecast.status, "rate-only");
  assert.equal(state.forecast.limitLabel, "limit unknown");
  assert.equal(state.forecast.scope.accountId, "unknown/default");
  assert.equal(state.forecast.source, "sanitized-usage-ledger");
  assert.equal(state.forecast.coverage.eventCount, 2);
  assert.doesNotMatch(JSON.stringify(state.forecast), /prompt|credential|rawToolOutput/i);
});

test("HTTP surface permits bearerless CORS preflight for an explicitly allowed origin", async (t) => {
  const original = process.env.CURSOR_BRIDGE_TEST_TOKEN;
  process.env.CURSOR_BRIDGE_TEST_TOKEN = "token";
  t.after(() => {
    if (original === undefined) delete process.env.CURSOR_BRIDGE_TEST_TOKEN;
    else process.env.CURSOR_BRIDGE_TEST_TOKEN = original;
  });
  const allowedOrigin = "https://client.example";
  const config = createTestConfig({ server: { allowedOrigins: [allowedOrigin] } });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: "OPTIONS",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);

  const actual = await fetch(`http://127.0.0.1:${address.port}/health`, {
    headers: { origin: allowedOrigin, authorization: "Bearer token" },
  });
  assert.equal(actual.status, 200);
  assert.equal(actual.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.match(actual.headers.get("vary"), /Origin/i);
});

test("HTTP convenience routes normalize managed-worker snake_case controls", async (t) => {
  const fixture = nativePath(new URL("./fixtures/fake-grok.mjs", import.meta.url));
  const config = createTestConfig({
    defaults: { provider: "grok", mode: "consult", model: "grok-4.6" },
    providers: {
      grok: {
        adapter: "grok-build",
        capabilities: ["consult", "delegate"],
        command: process.execPath,
        commandArgs: [fixture],
        versionArgs: ["--version"],
        versionPattern: "^grok\\s",
        model: "grok-4.6",
        models: ["grok-4.6"],
        strictModelList: true,
        allowedEfforts: ["low", "medium", "high"],
        maxTurnsCeiling: 24,
        inheritEnv: false,
        envAllowlist: [],
        noAutoUpdate: true,
        allowSubagents: true,
        noMemory: true,
        allowWebSearch: true,
        admission: { maxActive: 1, minStartIntervalMs: 0, maxUnitsPerWindow: 20, windowMs: 1000 },
        ledger: { enabled: false },
        consult: { workspaceStrategy: "none", profile: "diagnose", maxTurns: 8, expectedTurns: 2 },
        delegate: { profile: "balanced", maxTurns: 16, expectedTurns: 4 },
      },
    },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
  t.after(async () => { await closeHttpServer(server); await service.close(); });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/consult`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "Review the bounded worker contract",
      provider: "grok",
      model: "grok-4.6",
      profile: "mechanical",
      reasoning_effort: "high",
      max_turns: 7,
      expected_turns: 5,
      no_plan: true,
      acceptance_commands: ["npm test", "npm run check"],
      allow_subagents: false,
      allow_web_search: false,
      coordinator_id: "cgpt-http",
      worker_group: "http-normalization",
    }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, "worker-ok");
  assert.deepEqual(result.providerMetadata.grokBuild, {
    ...result.providerMetadata.grokBuild,
    profile: "mechanical",
    reasoningEffort: "high",
    maxTurns: 7,
    expectedTurns: 5,
    allowSubagents: false,
    allowWebSearch: false,
    coordinatorId: "cgpt-http",
    workerGroup: "http-normalization",
    acceptanceCommands: ["npm test", "npm run check"],
  });
});
