import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const PROVIDER_ACTIVATION_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MODES = new Set(["consult", "integrated", "delegate"]);
const API_ADAPTERS = new Set(["openai-chat", "openrouter", "deepseek", "nous"]);
const BLOCK_REASONS = new Set(["preview-provider-blocked", "descriptor-unavailable", "mode-unsupported", "auth-not-ready", "runtime-not-ready", "delegate-workspace-required", "one-attempt-not-provable", "not-selected-for-this-transaction", "prerequisites-not-ready", "request-outcome-unknown", "live-request-failed", "rollback-incomplete"]);
const EXECUTION_POLICY = Object.freeze({ attempts: 1, smartRouting: false, accountFallback: false, crossProviderTakeover: false, retry: false, providerAppLifecycle: false });

/** Explicit installer component to runtime-provider mapping. Preview-only candidates stay visible but blocked. */
export const COMPONENT_PROVIDER_ACTIVATION_MAP = Object.freeze({
  "codex-native": Object.freeze([{ providerId: "openai-codex" }]),
  cursor: Object.freeze([{ providerId: "cursor" }, { providerId: "cursor-ultra", whenConfigured: true }]),
  "grok-build": Object.freeze([{ providerId: "grok-build" }]),
  nous: Object.freeze([{ providerId: "nous" }, { providerId: "nous-worker", whenConfigured: true }]),
  openrouter: Object.freeze([{ providerId: "openrouter" }]),
  "claude-code": Object.freeze([{ providerId: "agentrouter-claude", preview: true }]),
  "agentrouter-free": Object.freeze([{ providerId: "agentrouter-claude", preview: true }]),
  "mistral-api-free": Object.freeze([{ providerId: "mistral-api", preview: true }]),
  "groqcloud-free": Object.freeze([{ providerId: "groqcloud", preview: true }]),
  "cloudflare-workers-ai-free": Object.freeze([{ providerId: "cloudflare-workers-ai", preview: true }]),
  "gemini-api-free": Object.freeze([{ providerId: "gemini-api", preview: true }]),
});

/** Resolve the exact provider descriptors a component selection may install. */
export function providerIdsForComponents(componentIds, configuredProviders = undefined) {
  const configured = configuredProviders ? new Set(Object.keys(configuredProviders)) : null;
  return [...new Set((componentIds ?? []).flatMap((componentId) =>
    (COMPONENT_PROVIDER_ACTIVATION_MAP[componentId] ?? []).flatMap((entry) =>
      entry.whenConfigured && configured && !configured.has(entry.providerId) ? [] : [entry.providerId])))]
    .sort();
}

/**
 * Create one separately approved, one-provider activation transaction after a fresh install.
 * Credential values are observed only as booleans and never copied into the plan.
 */
export async function createProviderActivationPlan(options) {
  const freshPlan = options?.freshInstallPlan;
  const freshReceipt = options?.freshInstallReceipt;
  assertFreshPredecessor(freshPlan, freshReceipt);
  const configPath = resolve(options.configPath ?? freshPlan.config.path);
  if (configPath !== resolve(freshPlan.config.path)) throw new Error("Provider activation config path must match the fresh-install predecessor");
  await assertSafePath(configPath, { requireFile: true });
  const configBytes = await readFile(configPath);
  const configSha256 = sha256(configBytes);
  if (configSha256 !== freshPlan.config.sha256) throw new Error("Provider activation requires the exact fresh-install config preimage");
  const config = JSON.parse(configBytes.toString("utf8"));
  const selectedComponents = [...new Set(freshPlan.selectedComponentIds.map(String))].sort();
  const mapped = mappedProviders(selectedComponents, config.providers ?? {}, freshPlan.selectedProviderIds ?? []);
  const request = normalizeExactRequest(options.request);
  const target = mapped.find((entry) => entry.providerId === request.providerId);
  if (!target) throw new Error(`Provider '${request.providerId}' is not mapped by the fresh-install component selection`);
  const readiness = normalizeReadiness(options.readiness ?? {});
  const evidence = buildEvidence(mapped, config, request, readiness, options.environment ?? process.env);
  const targetEvidence = evidence.find((entry) => entry.providerId === request.providerId);
  const nextConfig = structuredClone(config);
  if (targetEvidence.executable) {
    nextConfig.providers[request.providerId].enabled = true;
    nextConfig.providers[request.providerId].retryWithoutStreaming = false;
  }
  const nextBytes = Buffer.from(`${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  const stateRoot = resolve(options.stateRoot ?? resolve(freshPlan.stateRoot, "provider-activation"));
  if (stateRoot !== resolve(freshPlan.stateRoot, "provider-activation")) throw new Error("Provider activation state root is fixed by the fresh-install predecessor");
  await assertSafePath(stateRoot, { allowMissingTarget: true });
  const base = {
    schemaVersion: PROVIDER_ACTIVATION_SCHEMA_VERSION,
    kind: "threadspan-provider-activation",
    planId: normalizePlanId(options.planId ?? `${freshPlan.planId}-${request.providerId}-activation`),
    predecessor: {
      kind: freshReceipt.kind,
      planId: freshPlan.planId,
      planDigest: freshPlan.digest,
      receiptStatus: freshReceipt.status,
      receiptDigest: digestObject(freshReceipt),
    },
    stateRoot,
    config: {
      path: configPath,
      preimageSha256: configSha256,
      nextSha256: targetEvidence.executable ? sha256(nextBytes) : configSha256,
      transform: "enable-one-exact-provider-disable-streaming-retry-v1",
      baseline: {
        enabledPresent: Object.hasOwn(config.providers[request.providerId] ?? {}, "enabled"),
        enabled: config.providers[request.providerId]?.enabled === true,
        retryWithoutStreamingPresent: Object.hasOwn(config.providers[request.providerId] ?? {}, "retryWithoutStreaming"),
        retryWithoutStreaming: config.providers[request.providerId]?.retryWithoutStreaming === true,
      },
    },
    selectedComponents,
    request,
    providerEvidence: evidence,
    executionPolicy: EXECUTION_POLICY,
  };
  assertSanitized(base);
  return deepFreeze({ ...base, digest: digestObject(base) });
}

/** Render the exact successor, route, prerequisite state, and approval digest. */
export function previewProviderActivationPlan(plan) {
  validateProviderActivationPlan(plan);
  const lines = [
    `Threadspan provider activation plan ${plan.planId}`,
    `Fresh predecessor: ${plan.predecessor.planId} (${plan.predecessor.planDigest})`,
    `Exact request: ${plan.request.routeId}`,
    `Config preimage: ${plan.config.preimageSha256}`,
    `Config next: ${plan.config.nextSha256}`,
    ...plan.providerEvidence.map((item) => `Provider ${item.providerId}: ${item.status} (${item.reasonCodes.join(",") || "none"})`),
    "Attempts: 1; smart routing, fallback, takeover, retry, and provider-app lifecycle are disabled",
    `Approval digest: ${plan.digest}`,
  ];
  return { digest: plan.digest, text: `${lines.join("\n")}\n` };
}

/**
 * Apply one exact provider activation. The injected executor is called at most once.
 * A crash after dispatch is recovered as outcome-unknown and is never replayed.
 */
export async function applyProviderActivationPlan(plan, options = {}) {
  validateProviderActivationPlan(plan);
  if (options.approvedDigest !== plan.digest) throw new Error("Provider activation requires the digest from previewProviderActivationPlan");
  const journalPath = resolve(plan.stateRoot, `${plan.planId}.json`);
  await assertSafePath(plan.config.path, { requireFile: true });
  await assertSafePath(plan.stateRoot, { allowMissingTarget: true });
  await mkdir(plan.stateRoot, { recursive: true, mode: 0o700 });
  const claim = await acquireClaim(plan, options);
  try {
  await assertSingleSuccessor(plan, journalPath);
  let journal = await readJournal(journalPath);
  if (journal) assertJournalIdentity(journal, plan);
  if (journal?.status === "ready" || journal?.status === "blocked") return replayProviderActivationReceipt(plan, journal);
  if (journal?.status === "executing") {
    await rm(resolve(plan.stateRoot, `${plan.planId}.runtime-config.json`), { force: true }).catch(() => undefined);
    const observedSha256 = sha256(await readFile(plan.config.path));
    const receipt = unknownOutcomeReceipt(plan, observedSha256);
    journal = { ...journal, status: receipt.status, terminalReceipt: receipt };
    await writeJsonAtomic(journalPath, journal);
    return receipt;
  }
  if (!journal) {
    journal = { schemaVersion: 1, kind: "threadspan-provider-activation-journal", planId: plan.planId, planDigest: plan.digest, plan: structuredClone(plan), status: "prepared", attempts: 0 };
    await writeJsonAtomic(journalPath, journal);
  }
  const target = plan.providerEvidence.find((entry) => entry.providerId === plan.request.providerId);
  if (!target?.executable) {
    const receipt = blockedReceipt(plan, target?.reasonCodes?.[0] ?? "prerequisites-not-ready", true);
    journal = { ...journal, status: "blocked", terminalReceipt: receipt };
    await writeJsonAtomic(journalPath, journal);
    return receipt;
  }
  if (typeof options.executor !== "function") throw new Error("Provider activation requires an explicit local executor");
  if (sha256(await readFile(plan.config.path)) !== plan.config.preimageSha256) throw new Error("Provider activation config changed after review");
  journal = { ...journal, status: "executing", attempts: 1 };
  await writeJsonAtomic(journalPath, journal);
  await options.checkpoint?.("attempt-persisted");
  const runtimeConfigPath = resolve(plan.stateRoot, `${plan.planId}.runtime-config.json`);
  try {
    await writeActivatedConfig(plan, runtimeConfigPath);
    const result = await options.executor(structuredClone(plan.request), {
      configPath: runtimeConfigPath,
      signal: options.signal,
      policy: structuredClone(plan.executionPolicy),
    });
    validateExecutorResult(result, plan.request);
    await rm(runtimeConfigPath, { force: true });
    await options.checkpoint?.("request-succeeded");
    await writeActivatedConfig(plan);
    await options.checkpoint?.("config-enabled");
    const receipt = readyReceipt(plan, result);
    journal = { ...journal, status: "ready", terminalReceipt: receipt };
    await writeJsonAtomic(journalPath, journal);
    return receipt;
  } catch (error) {
    await rm(runtimeConfigPath, { force: true }).catch(() => undefined);
    if (error?.simulatedProcessExit === true) throw error;
    const rollback = await restorePreimage(plan).catch(() => false);
    const observedSha256 = sha256(await readFile(plan.config.path));
    const receipt = blockedReceipt(plan, rollback ? "live-request-failed" : "rollback-incomplete", rollback, observedSha256, 1);
    journal = { ...journal, status: "blocked", terminalReceipt: receipt };
    await writeJsonAtomic(journalPath, journal);
    return receipt;
  }
  } finally {
    await releaseClaim(claim);
  }
}

async function assertSingleSuccessor(plan, journalPath) {
  const currentName = journalPath.slice(plan.stateRoot.length + 1);
  const names = await readdir(plan.stateRoot);
  const other = names.filter((name) => name.endsWith(".json") && !name.endsWith(".runtime-config.json") && name !== currentName).sort();
  if (other.length === 0) return;
  if (other.length > 1) throw new Error("Fresh predecessor has multiple provider-activation successors and requires reviewed recovery");
  let existing;
  try { existing = JSON.parse(await readFile(resolve(plan.stateRoot, other[0]), "utf8")); }
  catch { throw new Error("Fresh predecessor has an unreadable provider-activation successor"); }
  if (existing?.kind !== "threadspan-provider-activation-journal" || !existing.plan) throw new Error("Fresh predecessor has an invalid provider-activation successor");
  validateProviderActivationPlan(existing.plan);
  assertJournalIdentity(existing, existing.plan);
  if (existing.plan.predecessor.planDigest !== plan.predecessor.planDigest || existing.plan.config.preimageSha256 !== plan.config.preimageSha256) {
    throw new Error("Provider-activation state root is occupied by another predecessor");
  }
  throw new Error(`Fresh predecessor already has provider-activation successor ${existing.plan.digest}`);
}

/** Read and validate an activation successor for fresh-install replay/uninstall composition. */
export async function readProviderActivationSuccessor(freshPlan) {
  const root = resolve(freshPlan.stateRoot, "provider-activation");
  let names;
  try { names = await readdir(root); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const files = names.filter((name) => name.endsWith(".json") && !name.endsWith(".runtime-config.json")).sort();
  if (files.length === 0) return null;
  if (files.length > 1) throw new Error("Multiple provider-activation successors require explicit chain composition");
  const journal = JSON.parse(await readFile(resolve(root, files[0]), "utf8"));
  if (journal?.kind !== "threadspan-provider-activation-journal" || !journal.plan || !journal.terminalReceipt) throw new Error("Provider-activation successor is incomplete");
  validateProviderActivationPlan(journal.plan);
  assertJournalIdentity(journal, journal.plan);
  if (journal.plan.predecessor.planId !== freshPlan.planId || journal.plan.predecessor.planDigest !== freshPlan.digest
    || journal.plan.predecessor.receiptStatus !== "applied-pending-provider-and-host-activation"
    || journal.plan.config.path !== resolve(freshPlan.config.path) || journal.plan.config.preimageSha256 !== freshPlan.config.sha256
    || journal.plan.stateRoot !== resolve(freshPlan.stateRoot, "provider-activation")
    || stableStringify(journal.plan.selectedComponents) !== stableStringify([...new Set(freshPlan.selectedComponentIds.map(String))].sort())) {
    throw new Error("Provider-activation successor bindings do not reconstruct the fresh predecessor");
  }
  const allowedProviders = mappedProviders(journal.plan.selectedComponents, Object.fromEntries((freshPlan.selectedProviderIds ?? []).map((id) => [id, {}])), freshPlan.selectedProviderIds ?? []).map((entry) => entry.providerId);
  if (!allowedProviders.includes(journal.plan.request.providerId)) throw new Error("Provider-activation successor target is not selected by the fresh predecessor");
  const freshJournal = JSON.parse(await readFile(resolve(freshPlan.stateRoot, "fresh-install-journal.json"), "utf8"));
  if (freshJournal?.status !== "applied" || digestObject(freshJournal.terminalReceipt) !== journal.plan.predecessor.receiptDigest) {
    throw new Error("Provider-activation successor does not bind the terminal fresh receipt");
  }
  const receipt = await replayProviderActivationReceipt(journal.plan, journal);
  if (receipt.predecessorPlanDigest !== freshPlan.digest) throw new Error("Provider-activation successor does not bind the fresh install");
  return receipt;
}

function mappedProviders(componentIds, configuredProviders, selectedProviderIds = []) {
  const output = [];
  for (const componentId of componentIds) {
    for (const entry of COMPONENT_PROVIDER_ACTIVATION_MAP[componentId] ?? []) {
      if (entry.whenConfigured && !Object.hasOwn(configuredProviders, entry.providerId)) continue;
      if (!output.some((item) => item.providerId === entry.providerId)) output.push({ componentId, ...entry });
    }
  }
  for (const providerId of selectedProviderIds) {
    if (!output.some((item) => item.providerId === providerId)) output.push({ componentId: "explicit-provider", providerId });
  }
  return output.sort((left, right) => left.providerId.localeCompare(right.providerId));
}

function buildEvidence(mapped, config, request, readiness, environment) {
  return mapped.map((mapping) => {
    const descriptor = config.providers?.[mapping.providerId];
    const selected = mapping.providerId === request.providerId;
    const reasonCodes = [];
    if (mapping.preview) reasonCodes.push("preview-provider-blocked");
    if (!descriptor) reasonCodes.push("descriptor-unavailable");
    const descriptorReady = Boolean(descriptor && Array.isArray(descriptor.capabilities) && descriptor.capabilities.includes(request.mode));
    if (selected && descriptor && !descriptorReady) reasonCodes.push("mode-unsupported");
    const authRef = request.accountId ? `account:${request.accountId}` : descriptor?.apiKeyEnv ? `env:${descriptor.apiKeyEnv}` : descriptor?.gateway?.apiKeyEnv ? `env:${descriptor.gateway.apiKeyEnv}` : readiness[mapping.providerId]?.authRef ?? null;
    const authReady = descriptor?.apiKeyEnv
      ? Boolean(environment[descriptor.apiKeyEnv])
      : descriptor?.gateway?.apiKeyEnv
        ? Boolean(environment[descriptor.gateway.apiKeyEnv])
        : readiness[mapping.providerId]?.authReady === true;
    const runtimeReady = descriptor && (API_ADAPTERS.has(descriptor.adapter) || readiness[mapping.providerId]?.runtimeReady === true);
    const oneAttemptProvable = descriptor && (API_ADAPTERS.has(descriptor.adapter) || (descriptor.adapter === "mock" && Boolean(process.env.NODE_TEST_CONTEXT)));
    if (selected && descriptorReady && !authReady) reasonCodes.push("auth-not-ready");
    if (selected && descriptorReady && !runtimeReady) reasonCodes.push("runtime-not-ready");
    if (selected && request.mode === "delegate" && !request.workspace) reasonCodes.push("delegate-workspace-required");
    if (selected && (request.mode === "delegate" || !oneAttemptProvable)) reasonCodes.push("one-attempt-not-provable");
    if (!selected && reasonCodes.length === 0) reasonCodes.push("not-selected-for-this-transaction");
    const executable = selected && reasonCodes.length === 0;
    return {
      componentId: mapping.componentId,
      providerId: mapping.providerId,
      status: executable ? "pending-live-request" : "blocked",
      configured: Boolean(descriptor),
      descriptorReady,
      authReady,
      runtimeReady: Boolean(runtimeReady),
      live: false,
      executable,
      authRef,
      reasonCodes,
    };
  });
}

function normalizeReadiness(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Provider activation readiness must be an object");
  return Object.fromEntries(Object.entries(input).map(([providerId, value]) => {
    if (!REF_PATTERN.test(providerId) || !value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Provider activation readiness entry is invalid");
    const authRef = value.authRef === undefined ? undefined : normalizeAuthRef(value.authRef);
    return [providerId, { authReady: value.authReady === true, runtimeReady: value.runtimeReady === true, ...(authRef ? { authRef } : {}) }];
  }));
}

function normalizeAuthRef(value) {
  const text = String(value);
  const match = /^(account|profile):([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/.exec(text);
  if (!match || /(?:bearer|password|secret|token|api[_-]?key)/i.test(match[2]) || /[A-Za-z0-9_-]{40,}/.test(match[2])) {
    throw new TypeError("Provider activation authRef must be an opaque account: or profile: reference, never a credential value");
  }
  return text;
}

function normalizeExactRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Provider activation requires one exact request");
  const providerId = normalizeRef(input.providerId, "providerId");
  const mode = String(input.mode ?? "");
  if (!MODES.has(mode)) throw new TypeError("Provider activation mode must be consult, integrated, or delegate");
  const model = String(input.model ?? "").trim();
  if (!model || model === "auto" || model.includes("\0")) throw new TypeError("Provider activation requires an explicit non-auto model");
  const accountId = input.accountId === undefined ? undefined : normalizeRef(input.accountId, "accountId");
  if (accountId === "unknown/default") throw new TypeError("Provider activation cannot bind the unknown/default account sentinel");
  const workspace = input.workspace === undefined ? undefined : resolve(String(input.workspace));
  const routeId = `${mode}/${providerId}/${accountId ? `@${accountId}/` : ""}${model}`;
  return { providerId, mode, model, ...(accountId ? { accountId } : {}), ...(workspace ? { workspace } : {}), routeId };
}

function validateProviderActivationPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== "threadspan-provider-activation" || !PLAN_ID_PATTERN.test(plan.planId ?? "")
    || !SHA256_PATTERN.test(plan.digest ?? "") || !SHA256_PATTERN.test(plan.predecessor?.planDigest ?? "")
    || !isAbsolute(plan.stateRoot ?? "") || !isAbsolute(plan.config?.path ?? "")
    || !SHA256_PATTERN.test(plan.config?.preimageSha256 ?? "") || !SHA256_PATTERN.test(plan.config?.nextSha256 ?? "")
    || !Array.isArray(plan.providerEvidence) || stableStringify(plan.executionPolicy) !== stableStringify(EXECUTION_POLICY)
    || plan.config.transform !== "enable-one-exact-provider-disable-streaming-retry-v1") throw new TypeError("Invalid provider-activation plan");
  const normalized = normalizeExactRequest(plan.request);
  if (stableStringify(normalized) !== stableStringify(plan.request)) throw new Error("Provider-activation request is not canonical");
  if (!Array.isArray(plan.selectedComponents) || plan.selectedComponents.some((item) => !REF_PATTERN.test(item))) throw new Error("Provider-activation component binding is invalid");
  const ids = new Set();
  for (const entry of plan.providerEvidence) {
    if (!entry || !REF_PATTERN.test(entry.componentId ?? "") || !REF_PATTERN.test(entry.providerId ?? "") || ids.has(entry.providerId)
      || !["pending", "pending-live-request", "blocked"].includes(entry.status) || !Array.isArray(entry.reasonCodes)
      || entry.reasonCodes.some((reason) => !BLOCK_REASONS.has(reason))
      || ["configured", "descriptorReady", "authReady", "runtimeReady", "live", "executable"].some((key) => typeof entry[key] !== "boolean")
      || (entry.authRef !== null && !/^(?:env:[A-Z][A-Z0-9_]{0,127}|account:[A-Za-z0-9][A-Za-z0-9._:-]{0,159}|profile:[A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/.test(entry.authRef))) {
      throw new Error("Provider-activation evidence is invalid");
    }
    ids.add(entry.providerId);
  }
  const target = plan.providerEvidence.find((entry) => entry.providerId === plan.request.providerId);
  if (!target || target.executable !== (target.status === "pending-live-request" && target.reasonCodes.length === 0)) throw new Error("Provider-activation target evidence is invalid");
  const { digest: _digest, ...payload } = plan;
  if (digestObject(payload) !== plan.digest) throw new Error("Provider-activation plan integrity check failed");
  assertSanitized(plan);
}

async function writeActivatedConfig(plan, destination = plan.config.path) {
  const config = JSON.parse(await readFile(plan.config.path, "utf8"));
  if (!config.providers?.[plan.request.providerId]) throw new Error("Provider descriptor disappeared after review");
  config.providers[plan.request.providerId].enabled = true;
  config.providers[plan.request.providerId].retryWithoutStreaming = false;
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (sha256(bytes) !== plan.config.nextSha256) throw new Error("Provider activation transform drifted after review");
  await writeAtomic(destination, bytes);
}

async function restorePreimage(plan) {
  const observed = await readFile(plan.config.path);
  if (sha256(observed) === plan.config.preimageSha256) return true;
  if (sha256(observed) !== plan.config.nextSha256) return false;
  const config = JSON.parse(observed.toString("utf8"));
  const descriptor = config.providers?.[plan.request.providerId];
  if (!descriptor) return false;
  if (plan.config.baseline.enabledPresent) descriptor.enabled = plan.config.baseline.enabled;
  else delete descriptor.enabled;
  if (plan.config.baseline.retryWithoutStreamingPresent) descriptor.retryWithoutStreaming = plan.config.baseline.retryWithoutStreaming;
  else delete descriptor.retryWithoutStreaming;
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8");
  if (sha256(bytes) !== plan.config.preimageSha256) return false;
  await writeAtomic(plan.config.path, bytes);
  return true;
}

function validateExecutorResult(result, request) {
  if (!result || result.success !== true || result.discovered !== true || result.status !== "completed" || result.sentinelVerified !== true) throw new Error("Provider activation executor did not return exact live success");
  for (const key of ["providerId", "mode", "model"]) if (result.route?.[key] !== request[key]) throw new Error("Provider activation executor returned a different route");
  if ((result.route?.accountId ?? null) !== (request.accountId ?? null)) throw new Error("Provider activation executor returned a different account");
}

function readyReceipt(plan, result) {
  return sanitizedReceipt(plan, {
    status: "ready",
    attempts: 1,
    reason: null,
    configSha256: plan.config.nextSha256,
    liveRequest: { status: "completed", discovered: true, sentinelVerified: true, evidenceClass: "live-provider" },
  });
}

function blockedReceipt(plan, reason, rollbackComplete, observedSha256 = undefined, attempts = 0) {
  return sanitizedReceipt(plan, {
    status: "blocked",
    attempts,
    reason,
    configSha256: observedSha256 ?? (rollbackComplete ? plan.config.preimageSha256 : plan.config.nextSha256),
    rollbackComplete,
    ...(rollbackComplete ? {} : { manualRecoveryRequired: true }),
    liveRequest: { status: reason === "request-outcome-unknown" ? "outcome-unknown" : "failed", discovered: false, evidenceClass: "sanitized-provider-activation" },
  });
}

function unknownOutcomeReceipt(plan, observedSha256) {
  const knownConfig = [plan.config.preimageSha256, plan.config.nextSha256].includes(observedSha256);
  return sanitizedReceipt(plan, {
    status: "blocked",
    attempts: 1,
    reason: "request-outcome-unknown",
    configSha256: observedSha256,
    rollbackComplete: false,
    configState: observedSha256 === plan.config.preimageSha256 ? "disabled-preimage" : observedSha256 === plan.config.nextSha256 ? "enabled-uncommitted" : "drifted",
    providerTermination: "unknown",
    manualRecoveryRequired: true,
    liveRequest: { status: "outcome-unknown", discovered: false, sentinelVerified: false, evidenceClass: "sanitized-provider-activation" },
    ...(knownConfig ? {} : { configBindingValid: false }),
  });
}

function sanitizedReceipt(plan, result) {
  const receipt = {
    schemaVersion: 1,
    kind: "threadspan-provider-activation-receipt",
    planId: plan.planId,
    planDigest: plan.digest,
    predecessorPlanDigest: plan.predecessor.planDigest,
    providerId: plan.request.providerId,
    routeId: plan.request.routeId,
    credentialsExposed: false,
    providerAppLifecycle: false,
    ...result,
    providerEvidence: terminalProviderEvidence(plan, result),
  };
  assertSanitized(receipt);
  return receipt;
}

function terminalProviderEvidence(plan, result) {
  return plan.providerEvidence.map((entry) => {
    if (entry.providerId !== plan.request.providerId) return { ...entry };
    if (result.status === "ready") return { ...entry, status: "ready", live: true, executable: true, reasonCodes: [] };
    return { ...entry, status: "blocked", live: false, executable: false, reasonCodes: [result.reason] };
  });
}

async function replayProviderActivationReceipt(plan, journal) {
  const receipt = journal.terminalReceipt;
  validateTerminalReceipt(plan, receipt);
  if (sha256(await readFile(plan.config.path)) !== receipt.configSha256) throw new Error("Provider-activation terminal config changed");
  assertSanitized(receipt);
  return structuredClone(receipt);
}

function assertFreshPredecessor(plan, receipt) {
  if (!plan || plan.kind !== "threadspan-fresh-install" || !SHA256_PATTERN.test(plan.digest ?? "")) throw new TypeError("A valid fresh-install plan is required");
  if (!receipt || receipt.kind !== "threadspan-fresh-install-receipt" || receipt.planId !== plan.planId || receipt.digest !== plan.digest
    || receipt.status !== "applied-pending-provider-and-host-activation") throw new Error("Provider activation requires the matching pending fresh-install receipt");
}

function assertJournalIdentity(journal, plan) {
  if (journal.kind !== "threadspan-provider-activation-journal" || journal.planId !== plan.planId || journal.planDigest !== plan.digest || !Number.isInteger(journal.attempts) || journal.attempts < 0 || journal.attempts > 1
    || !["prepared", "executing", "ready", "blocked"].includes(journal.status) || (["ready", "blocked"].includes(journal.status) && !journal.terminalReceipt)
    || (journal.terminalReceipt && (journal.terminalReceipt.status !== journal.status || journal.terminalReceipt.attempts !== journal.attempts))) {
    throw new Error("Provider-activation journal does not match the approved transaction");
  }
  if (journal.plan) {
    validateProviderActivationPlan(journal.plan);
    if (journal.plan.digest !== plan.digest) throw new Error("Provider-activation journal plan changed");
  }
}

function validateTerminalReceipt(plan, receipt) {
  if (!receipt || receipt.kind !== "threadspan-provider-activation-receipt" || receipt.planId !== plan.planId || receipt.planDigest !== plan.digest
    || receipt.predecessorPlanDigest !== plan.predecessor.planDigest || receipt.providerId !== plan.request.providerId
    || receipt.routeId !== plan.request.routeId || ![0, 1].includes(receipt.attempts) || receipt.credentialsExposed !== false || receipt.providerAppLifecycle !== false
    || !["ready", "blocked"].includes(receipt.status)) throw new Error("Provider-activation terminal receipt is invalid");
  const expectedEvidence = terminalProviderEvidence(plan, receipt);
  if (stableStringify(receipt.providerEvidence) !== stableStringify(expectedEvidence)) throw new Error("Provider-activation terminal evidence is invalid");
  if (receipt.status === "ready") {
    if (receipt.attempts !== 1 || receipt.reason !== null || receipt.configSha256 !== plan.config.nextSha256 || receipt.liveRequest?.status !== "completed"
      || receipt.liveRequest?.discovered !== true || receipt.liveRequest?.sentinelVerified !== true || receipt.liveRequest?.evidenceClass !== "live-provider") throw new Error("Provider-activation ready receipt is invalid");
  } else {
    if (!BLOCK_REASONS.has(receipt.reason) || receipt.liveRequest?.evidenceClass !== "sanitized-provider-activation") throw new Error("Provider-activation blocked receipt is invalid");
    if (receipt.reason === "request-outcome-unknown") {
      if (receipt.attempts !== 1 || receipt.rollbackComplete !== false || receipt.providerTermination !== "unknown" || receipt.manualRecoveryRequired !== true
        || receipt.liveRequest?.status !== "outcome-unknown" || !SHA256_PATTERN.test(receipt.configSha256 ?? "")) throw new Error("Provider-activation unknown-outcome receipt is invalid");
    } else if (receipt.reason === "rollback-incomplete") {
      if (receipt.attempts !== 1 || receipt.rollbackComplete !== false || receipt.manualRecoveryRequired !== true || !SHA256_PATTERN.test(receipt.configSha256 ?? "")) throw new Error("Provider-activation incomplete rollback receipt is invalid");
    } else {
      const expectedAttempts = receipt.reason === "live-request-failed" ? 1 : 0;
      if (receipt.attempts !== expectedAttempts) throw new Error("Provider-activation blocked attempt count is invalid");
      const expectedSha = receipt.rollbackComplete === false ? plan.config.nextSha256 : plan.config.preimageSha256;
      if (receipt.configSha256 !== expectedSha) throw new Error("Provider-activation blocked config binding is invalid");
    }
  }
  assertSanitized(receipt);
}

function assertSanitized(value) {
  const text = JSON.stringify(value);
  if (/"(?:apiKey|token|authorization|credentialValue|prompt|output|stderr|stdout)"\s*:/i.test(text)) throw new Error("Provider-activation state contains prohibited private material");
}

async function readJournal(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function writeJsonAtomic(path, value) {
  assertSanitized(value);
  await writeAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function writeAtomic(path, bytes) {
  await assertSafePath(path, { allowMissingTarget: true });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafePath(dirname(path), { requireDirectory: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertSafePath(path, options = {}) {
  const target = resolve(path);
  const root = parse(target).root;
  let cursor = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    let stats;
    try { stats = await lstat(cursor); } catch (error) {
      if (error?.code === "ENOENT" && options.allowMissingTarget) return;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`Provider activation refuses a symbolic-link path: ${cursor}`);
    const terminal = index === parts.length - 1;
    if (!terminal && !stats.isDirectory()) throw new Error(`Provider activation path ancestor is not a directory: ${cursor}`);
    if (terminal && options.requireFile && !stats.isFile()) throw new Error("Provider activation config must be a regular file");
    if (terminal && options.requireDirectory && !stats.isDirectory()) throw new Error("Provider activation state parent must be a directory");
    if (terminal && options.requireFile && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("Provider activation config must be owner-only");
    }
  }
}

async function acquireClaim(plan, options) {
  const path = resolve(plan.stateRoot, ".provider-activation.claim");
  const value = {
    schemaVersion: 1,
    kind: "threadspan-provider-activation-claim",
    planId: plan.planId,
    planDigest: plan.digest,
    processId: process.pid,
    nonce: randomBytes(24).toString("hex"),
  };
  const content = `${JSON.stringify(value)}\n`;
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    return { path, content };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const observed = await readFile(path);
    const claimDigest = sha256(observed);
    if (options.recoverClaimDigest !== claimDigest) {
      const conflict = new Error(`Another provider-activation mutation owns the claim; recovery digest ${claimDigest}`);
      conflict.claimDigest = claimDigest;
      throw conflict;
    }
    const existing = JSON.parse(observed.toString("utf8"));
    if (existing?.schemaVersion !== 1 || existing.kind !== value.kind || existing.planId !== plan.planId || existing.planDigest !== plan.digest
      || !Number.isInteger(existing.processId) || existing.processId <= 0 || !/^[0-9a-f]{48}$/.test(existing.nonce ?? "")) {
      throw new Error("Existing provider-activation claim is malformed or belongs to another transaction");
    }
    if (isProcessAlive(existing.processId)) throw new Error("Refusing to recover a provider-activation claim owned by a live process");
    const history = resolve(plan.stateRoot, "claim-history");
    await mkdir(history, { recursive: true, mode: 0o700 });
    const destination = resolve(history, `${claimDigest}.json`);
    try { await lstat(destination); throw new Error("Provider-activation claim recovery evidence already exists"); }
    catch (destinationError) { if (destinationError?.code !== "ENOENT") throw destinationError; }
    if (sha256(await readFile(path)) !== claimDigest) throw new Error("Provider-activation claim changed during recovery");
    await rename(path, destination);
    return acquireClaim(plan, { ...options, recoverClaimDigest: undefined });
  }
}

async function releaseClaim(claim) {
  if ((await readFile(claim.path, "utf8")) !== claim.content) throw new Error("Provider-activation claim identity changed before release");
  await rm(claim.path);
}

function isProcessAlive(processId) {
  try { process.kill(processId, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function normalizePlanId(value) {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) throw new TypeError("planId contains unsupported or filesystem-unsafe characters");
  return value;
}

function normalizeRef(value, label) {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) throw new TypeError(`${label} contains unsupported characters`);
  if (label === "accountId" && (/(?:bearer|password|secret|token|api[_-]?key)/i.test(value) || /[A-Za-z0-9_-]{40,}/.test(value))) {
    throw new TypeError("accountId must be an opaque reference, never a credential value");
  }
  return value;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function digestObject(value) { return sha256(Buffer.from(stableStringify(value), "utf8")); }
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
