import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyProviderActivationPlan,
  createProviderActivationPlan,
  previewProviderActivationPlan,
  providerIdsForComponents,
  readProviderActivationSuccessor,
} from "../src/installer/provider-activation.mjs";

const execFileAsync = promisify(execFile);

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function fixture(t, components = ["cursor"]) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-provider-activation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  const config = {
    server: { authTokenFile: join(root, "owner.token"), connectorTokenFile: join(root, "connector.token") },
    accounts: { path: join(root, "accounts.json"), profileSources: {}, fallback: { enabled: false, maxCandidates: 1 } },
    routing: { providerOrder: {} },
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    providers: {
      cursor: { enabled: false, adapter: "mock", model: "cursor-model", models: ["cursor-model"], capabilities: ["consult"] },
      "cursor-ultra": { enabled: false, adapter: "cursor-sdk", apiKeyEnv: "ACTIVATION_CURSOR_KEY", model: "cursor-ultra-model", capabilities: ["consult", "delegate"] },
      "openai-codex": { enabled: false, adapter: "codex-native-worker", command: "codex", model: "gpt-test", models: ["gpt-test"], capabilities: ["delegate"] },
      "agentrouter-claude": { enabled: false, adapter: "claude-code", command: "claude", model: "preview-model", capabilities: ["consult"] },
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  await writeFile(configPath, bytes, { mode: 0o600 });
  const freshPlan = {
    kind: "threadspan-fresh-install",
    planId: "fresh-test",
    digest: "a".repeat(64),
    stateRoot: join(root, "fresh-state"),
    config: { path: configPath, sha256: sha256(bytes) },
    selectedComponentIds: components,
  };
  const freshInstallReceipt = {
    schemaVersion: 1,
    kind: "threadspan-fresh-install-receipt",
    planId: freshPlan.planId,
    digest: freshPlan.digest,
    status: "applied-pending-provider-and-host-activation",
  };
  await mkdir(freshPlan.stateRoot, { recursive: true });
  await writeFile(join(freshPlan.stateRoot, "fresh-install-journal.json"), `${JSON.stringify({ status: "applied", terminalReceipt: freshInstallReceipt })}\n`, { mode: 0o600 });
  return { root, configPath, config, bytes, freshPlan, freshInstallPlan: freshPlan, freshInstallReceipt };
}

test("component mapping is explicit and expands Codex and configured Cursor variants", () => {
  assert.deepEqual(providerIdsForComponents(["codex-native", "cursor", "nous"], { cursor: {}, "cursor-ultra": {}, "openai-codex": {}, nous: {}, "nous-worker": {} }), ["cursor", "cursor-ultra", "nous", "nous-worker", "openai-codex"]);
  assert.deepEqual(providerIdsForComponents(["cursor"], { cursor: {} }), ["cursor"]);
});

test("CLI and API serialize the same exact activation plan", async (t) => {
  const fx = await fixture(t);
  const freshPlanPath = join(fx.root, "fresh-plan.json");
  const freshReceiptPath = join(fx.root, "fresh-receipt.json");
  const outputPath = join(fx.root, "activation-plan.json");
  await Promise.all([
    writeFile(freshPlanPath, `${JSON.stringify(fx.freshPlan)}\n`),
    writeFile(freshReceiptPath, `${JSON.stringify(fx.freshInstallReceipt)}\n`),
  ]);
  await execFileAsync(process.execPath, ["src/cli.mjs", "install", "provider-activation-plan", "--fresh-plan", freshPlanPath, "--fresh-receipt", freshReceiptPath, "--output", outputPath, "--provider", "cursor", "--mode", "consult", "--model", "cursor-model", "--auth-ref", "profile:primary", "--auth-ready", "--runtime-ready"], { cwd: new URL("..", import.meta.url).pathname });
  const cliPlan = JSON.parse(await readFile(outputPath, "utf8"));
  const apiPlan = await createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true, authRef: "profile:primary" } } });
  assert.deepEqual(cliPlan, apiPlan);
});

test("plan binds one exact route and retains blocked selected providers without credential values", async (t) => {
  const fx = await fixture(t);
  const secret = "do-not-persist-this-key";
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true, authRef: "profile:primary" } },
    environment: { ACTIVATION_CURSOR_KEY: secret },
  });
  assert.equal(plan.request.routeId, "consult/cursor/cursor-model");
  assert.equal(plan.providerEvidence.find((entry) => entry.providerId === "cursor").executable, true);
  assert.deepEqual(plan.providerEvidence.find((entry) => entry.providerId === "cursor-ultra").reasonCodes, ["not-selected-for-this-transaction"]);
  assert.deepEqual(plan.executionPolicy, { attempts: 1, smartRouting: false, accountFallback: false, crossProviderTakeover: false, retry: false, providerAppLifecycle: false });
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));
  assert.match(previewProviderActivationPlan(plan).text, /Exact request: consult\/cursor\/cursor-model/);
});

test("successful activation enables only the approved provider and terminal replay calls no executor", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true, authRef: "profile:primary" } },
  });
  let calls = 0;
  const executor = async (request, context) => {
    calls += 1;
    assert.deepEqual(request, plan.request);
    assert.equal(context.policy.retry, false);
    assert.notEqual(context.configPath, fx.configPath, "live proof uses a private activation config before committing the canonical file");
    assert.equal(JSON.parse(await readFile(context.configPath, "utf8")).providers.cursor.enabled, true);
    assert.equal(JSON.parse(await readFile(fx.configPath, "utf8")).providers.cursor.enabled, false);
    return { success: true, discovered: true, sentinelVerified: true, status: "completed", responseId: "response-safe", route: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: null } };
  };
  const receipt = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor });
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.attempts, 1);
  assert.equal(receipt.credentialsExposed, false);
  assert.equal(receipt.providerEvidence.find((entry) => entry.providerId === "cursor").status, "ready");
  assert.equal(receipt.providerEvidence.find((entry) => entry.providerId === "cursor-ultra").status, "blocked");
  const installed = JSON.parse(await readFile(fx.configPath, "utf8"));
  assert.equal(installed.providers.cursor.enabled, true);
  assert.equal(installed.providers.cursor.retryWithoutStreaming, false);
  assert.equal(installed.providers["cursor-ultra"].enabled, false);
  const replay = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor: async () => { throw new Error("must not replay"); } });
  assert.deepEqual(replay, receipt);
  assert.equal(calls, 1);
});

test("provider failure is sanitized, stable, and restores the exact config preimage", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true } },
  });
  const receipt = await applyProviderActivationPlan(plan, {
    approvedDigest: plan.digest,
    executor: async () => { throw new Error("Bearer private-secret /home/private diagnostics"); },
  });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.reason, "live-request-failed");
  assert.equal(receipt.rollbackComplete, true);
  assert.equal((await readFile(fx.configPath)).equals(fx.bytes), true);
  assert.doesNotMatch(JSON.stringify(receipt), /private-secret|\/home\/private|Bearer/);
});

test("resume after dispatch uncertainty leaves observed config unchanged and never issues a second request", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true } },
  });
  let calls = 0;
  await assert.rejects(applyProviderActivationPlan(plan, {
    approvedDigest: plan.digest,
    executor: async () => { calls += 1; return { success: true, discovered: true, sentinelVerified: true, status: "completed", responseId: "ambiguous", route: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: null } }; },
    checkpoint: async (stage) => {
      if (stage === "request-succeeded") {
        const error = new Error("simulated exit");
        error.simulatedProcessExit = true;
        throw error;
      }
    },
  }), /simulated exit/);
  const receipt = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor: async () => { calls += 1; throw new Error("must not retry"); } });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.reason, "request-outcome-unknown");
  assert.equal(receipt.rollbackComplete, false);
  assert.equal(receipt.providerTermination, "unknown");
  assert.equal(receipt.manualRecoveryRequired, true);
  assert.equal(calls, 1);
  assert.equal((await readFile(fx.configPath)).equals(fx.bytes), true);
});

test("cross-call claim prevents concurrent duplicate provider requests", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({
    ...fx,
    planId: "activation-a",
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true } },
  });
  const competingPlan = await createProviderActivationPlan({
    ...fx,
    planId: "activation-b",
    request: { providerId: "cursor", mode: "consult", model: "cursor-model" },
    readiness: { cursor: { authReady: true, runtimeReady: true } },
  });
  let release;
  const barrier = new Promise((resolvePromise) => { release = resolvePromise; });
  let started;
  const entered = new Promise((resolvePromise) => { started = resolvePromise; });
  let calls = 0;
  const first = applyProviderActivationPlan(plan, {
    approvedDigest: plan.digest,
    executor: async () => {
      calls += 1;
      started();
      await barrier;
      return { success: true, discovered: true, sentinelVerified: true, status: "completed", responseId: "only", route: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: null } };
    },
  });
  await entered;
  await assert.rejects(applyProviderActivationPlan(competingPlan, { approvedDigest: competingPlan.digest, executor: async () => { calls += 1; } }), /owns the claim/);
  release();
  assert.equal((await first).status, "ready");
  assert.equal(calls, 1);
});

test("stale canonical claim recovery requires the exact reviewed digest", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true } } });
  await mkdir(plan.stateRoot, { recursive: true });
  const claimPath = join(plan.stateRoot, ".provider-activation.claim");
  const claim = `${JSON.stringify({ schemaVersion: 1, kind: "threadspan-provider-activation-claim", planId: plan.planId, planDigest: plan.digest, processId: 2_147_483_647, nonce: "a".repeat(48) })}\n`;
  await writeFile(claimPath, claim, { mode: 0o600 });
  const claimDigest = sha256(Buffer.from(claim));
  const executor = async () => ({ success: true, discovered: true, sentinelVerified: true, status: "completed", route: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: null } });
  await assert.rejects(applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor }), new RegExp(claimDigest));
  const receipt = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, recoverClaimDigest: claimDigest, executor });
  assert.equal(receipt.status, "ready");
  assert.equal(await readFile(join(plan.stateRoot, "claim-history", `${claimDigest}.json`), "utf8"), claim);
});

test("one fresh predecessor cannot acquire a second sequential successor", async (t) => {
  const fx = await fixture(t, ["claude-code", "cursor"]);
  const blocked = await createProviderActivationPlan({ ...fx, planId: "blocked-first", request: { providerId: "agentrouter-claude", mode: "consult", model: "preview-model" }, readiness: { "agentrouter-claude": { authReady: true, runtimeReady: true, authRef: "profile:preview" } } });
  const readyCandidate = await createProviderActivationPlan({ ...fx, planId: "ready-second", request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true, authRef: "profile:primary" } } });
  assert.equal((await applyProviderActivationPlan(blocked, { approvedDigest: blocked.digest, executor: async () => { throw new Error("must not run"); } })).status, "blocked");
  let calls = 0;
  await assert.rejects(applyProviderActivationPlan(readyCandidate, { approvedDigest: readyCandidate.digest, executor: async () => { calls += 1; } }), /already has provider-activation successor/);
  assert.equal(calls, 0);
  assert.equal((await readProviderActivationSuccessor(fx.freshPlan)).planDigest, blocked.digest);
});

test("preview providers and unmet prerequisites remain visible but never executable", async (t) => {
  const fx = await fixture(t, ["claude-code"]);
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "agentrouter-claude", mode: "consult", model: "preview-model" },
    readiness: { "agentrouter-claude": { authReady: true, runtimeReady: true } },
  });
  assert.equal(plan.providerEvidence[0].status, "blocked");
  assert.ok(plan.providerEvidence[0].reasonCodes.includes("preview-provider-blocked"));
  let calls = 0;
  const receipt = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor: async () => { calls += 1; } });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.attempts, 0);
  assert.equal(calls, 0);
});

test("Delegate and provider-owned agent adapters remain visibly blocked when one request cannot be proved", async (t) => {
  const fx = await fixture(t, ["codex-native"]);
  const plan = await createProviderActivationPlan({
    ...fx,
    request: { providerId: "openai-codex", mode: "delegate", model: "gpt-test", accountId: "codex-primary", workspace: fx.root },
    readiness: { "openai-codex": { authReady: true, runtimeReady: true, authRef: "account:codex-primary" } },
  });
  const evidence = plan.providerEvidence.find((entry) => entry.providerId === "openai-codex");
  assert.equal(evidence.executable, false);
  assert.ok(evidence.reasonCodes.includes("one-attempt-not-provable"));
  let calls = 0;
  const receipt = await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor: async () => { calls += 1; } });
  assert.equal(receipt.status, "blocked");
  assert.equal(calls, 0);
});

test("approval, plan integrity, and explicit model gates fail before execution", async (t) => {
  const fx = await fixture(t);
  await assert.rejects(createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "auto" } }), /explicit non-auto model/);
  await assert.rejects(createProviderActivationPlan({ ...fx, planId: "unsafe:plan", request: { providerId: "cursor", mode: "consult", model: "cursor-model" } }), /filesystem-unsafe/);
  await assert.rejects(createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true, authRef: "profile:BearerSecretTokenValue123456789012345678901234567890" } } }), /never a credential value/);
  await assert.rejects(createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: "sk_secretCredentialValue123456789012345678901234567890" } }), /never a credential value/);
  const plan = await createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true } } });
  await assert.rejects(applyProviderActivationPlan(plan, { approvedDigest: "b".repeat(64), executor: async () => {} }), /requires the digest/);
  const tampered = structuredClone(plan);
  tampered.request.model = "other";
  await assert.rejects(applyProviderActivationPlan(tampered, { approvedDigest: plan.digest, executor: async () => {} }), /canonical|integrity/);
});

test("fresh successor read-back rejects a forged terminal receipt", async (t) => {
  const fx = await fixture(t);
  const plan = await createProviderActivationPlan({ ...fx, request: { providerId: "cursor", mode: "consult", model: "cursor-model" }, readiness: { cursor: { authReady: true, runtimeReady: true } } });
  await applyProviderActivationPlan(plan, { approvedDigest: plan.digest, executor: async () => ({ success: true, discovered: true, sentinelVerified: true, status: "completed", responseId: "safe", route: { providerId: "cursor", mode: "consult", model: "cursor-model", accountId: null } }) });
  const journalPath = join(plan.stateRoot, `${plan.planId}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.terminalReceipt.configSha256 = "f".repeat(64);
  await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
  await assert.rejects(readProviderActivationSuccessor(fx.freshPlan), /ready receipt is invalid/);
});
