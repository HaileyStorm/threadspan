import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { callCodexAppServerBatchWithReceipt } from "../codex/app-server.mjs";
import { UNKNOWN_ACCOUNT_ID } from "./account-store.mjs";
import { ConfigError, RequestError } from "./errors.mjs";

export const CODEX_NATIVE_QUOTA_PROVIDER_ID = "openai-codex";
export const CODEX_NATIVE_QUOTA_SOURCE_KIND = "codex-native-quota";

/** Read authenticated Codex quota only through the selected isolated account profile. */
export class CodexNativeQuotaAdapter {
  /**
   * @param {{
   *   accountStore: import("./account-store.mjs").AccountStore,
   *   config: Record<string, any>,
   *   callAppServerBatch?: typeof callCodexAppServerBatchWithReceipt,
   *   now?: () => Date|number|string,
   *   instanceId?: string,
   * }} options
   */
  constructor(options) {
    if (!options?.accountStore) throw new TypeError("Codex native quota requires AccountStore");
    this.accountStore = options.accountStore;
    this.config = options.config ?? {};
    this.callAppServerBatch = options.callAppServerBatch ?? callCodexAppServerBatchWithReceipt;
    this.now = options.now ?? (() => new Date());
    this.instanceId = options.instanceId ?? randomUUID();
    this.generationId = options.generationId ?? randomUUID();
    this.generationStartedAt = new Date(this.now()).toISOString();
    this.batchSequence = 0;
    this.sequence = 0;
    this.inFlight = null;
    this.lastIssuedBatch = null;
  }

  /** Perform one single-flight account/rateLimits/read against the current openai-codex account. */
  async read() {
    this.inFlight ??= this.#read().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async #read() {
    const account = this.accountStore.resolve(CODEX_NATIVE_QUOTA_PROVIDER_ID);
    if (!account || account.id === UNKNOWN_ACCOUNT_ID) {
      throw new RequestError("OpenAI Codex quota is setup-required: add and select an isolated openai-codex account first");
    }
    if (!account.profileRef || !["native-oauth", "device-login", "cli-login"].includes(account.authKind)) {
      throw new ConfigError(`Account '${account.id}' is not bound to an isolated native Codex profile`);
    }
    const source = this.config.accounts?.profileSources?.[account.profileRef];
    if (!source || source.kind !== "codex-home" || typeof source.root !== "string" || !source.root) {
      throw new ConfigError(`Account '${account.id}' references an unavailable codex-home profile`);
    }
    const codexHome = await realpath(source.root);
    await assertNotDefaultCodexHome(codexHome);
    const environment = isolatedCodexEnvironment(codexHome);
    const provider = this.config.providers?.[CODEX_NATIVE_QUOTA_PROVIDER_ID] ?? {};
    const command = provider.command ?? "codex";
    const commandArgs = ["app-server", "--stdio"];
    const { results, receipt } = await this.callAppServerBatch([
      { method: "account/read", params: { refreshToken: false } },
      { method: "account/rateLimits/read", params: {} },
    ], {
      command,
      commandArgs,
      environment,
    });
    assertNativeProcessReceipt(receipt, { methods: ["account/read", "account/rateLimits/read"], commandArgs, codexHome, results });
    const nativeAccountIdentityDigest = digest(normalizeNativeAccountIdentity(results?.[0]));
    const selectedAfter = this.accountStore.resolve(CODEX_NATIVE_QUOTA_PROVIDER_ID);
    const sourceAfter = this.config.accounts?.profileSources?.[selectedAfter?.profileRef];
    if (selectedAfter?.id !== account.id || selectedAfter.profileRef !== account.profileRef
      || sourceAfter?.kind !== "codex-home" || await realpath(sourceAfter.root) !== codexHome) {
      throw new Error("Selected opaque Codex account profile changed during native quota read");
    }
    const accountSelectionBinding = this.accountStore.createSelectionBinding(CODEX_NATIVE_QUOTA_PROVIDER_ID, account.id);
    const result = results?.[1];
    const profileBindingDigest = digest({
      accountId: account.id,
      profileRef: account.profileRef,
      codexHome,
      nativeAccountIdentityDigest,
      executableSha256: receipt.executable.sha256,
      accountSelectionBindingDigest: accountSelectionBinding.digest,
    });
    const observedAt = new Date(this.now()).toISOString();
    const buckets = normalizeBuckets(result).sort((left, right) => {
      const leftExhausted = left.rateLimitReachedType !== null || left.usedRatio >= 1;
      const rightExhausted = right.rateLimitReachedType !== null || right.usedRatio >= 1;
      if (leftExhausted !== rightExhausted) return leftExhausted ? -1 : 1;
      if (left.usedRatio !== right.usedRatio) return right.usedRatio - left.usedRatio;
      return left.limitId.localeCompare(right.limitId);
    });
    if (buckets.length === 0) throw new Error("Codex App Server account/rateLimits/read returned no rate-limit buckets");
    const resetCreditsAvailable = nonnegativeInteger(result?.rateLimitResetCredits?.availableCount);
    const batchSequence = ++this.batchSequence;
    const resultBindingDigest = digest({
      processResultDigest: receipt.resultDigest,
      nativeAccountIdentityDigest,
      buckets: buckets.map(boundBucketResult).sort((left, right) => left.bucketId.localeCompare(right.bucketId)),
    });
    const batchId = digest({
      processReceiptId: receipt.id,
      profileBindingDigest,
      resultBindingDigest,
      adapterInstanceId: this.instanceId,
      adapterGenerationId: this.generationId,
      batchSequence,
    });
    const observations = buckets.map((bucket) => {
      const monotonicObservation = ++this.sequence;
      const windowIdentity = digest({
        limitId: bucket.limitId,
        primary: windowIdentityFields(bucket.primary),
        secondary: windowIdentityFields(bucket.secondary),
      });
      const nativeReceipt = {
        ...receipt,
        nativeAccountIdentityDigest,
        profileBindingDigest,
        accountSelectionBindingDigest: accountSelectionBinding.digest,
        adapterInstanceId: this.instanceId,
        adapterGenerationId: this.generationId,
        adapterGenerationStartedAt: this.generationStartedAt,
        batchSequence,
        batchId,
        resultBindingDigest,
        bucketBindingDigest: digest({
          resultBindingDigest,
          ...boundBucketResult(bucket),
        }),
        monotonicObservation,
      };
      const observation = {
        sourceKind: CODEX_NATIVE_QUOTA_SOURCE_KIND,
        providerId: CODEX_NATIVE_QUOTA_PROVIDER_ID,
        accountId: account.id,
        controllingAccountId: account.id,
        bucketId: bucket.limitId,
        limitId: bucket.limitId,
        windowId: windowIdentity,
        windowIdentity,
        nativeReceipt,
        adapterInstanceId: this.instanceId,
        monotonicObservation,
        usedRatio: bucket.usedRatio,
        remainingCapacity: Math.max(0, 1 - bucket.usedRatio),
        exhausted: bucket.rateLimitReachedType !== null || bucket.usedRatio >= 1,
        observedAt,
        resetAt: resetAt(bucket.controllingWindow),
        planType: optionalLabel(bucket.planType ?? result?.planType),
        resetCreditsAvailable,
      };
      return { ...observation, sourceDigest: digest(observation) };
    });
    const bindingProof = {
      kind: "codex-native-quota-binding",
      providerId: CODEX_NATIVE_QUOTA_PROVIDER_ID,
      accountId: account.id,
      profileRef: account.profileRef,
      codexHome,
      profileBindingDigest,
      accountSelectionBindingDigest: accountSelectionBinding.digest,
      nativeAccountIdentityDigest,
      executableSha256: receipt.executable.sha256,
      adapterInstanceId: this.instanceId,
      adapterGenerationId: this.generationId,
      adapterGenerationStartedAt: this.generationStartedAt,
      batchSequence,
      batchId,
      processReceiptId: receipt.id,
      resultBindingDigest,
      observationDigests: observations.map((observation) => observation.sourceDigest).sort(),
    };
    const batch = {
      providerId: CODEX_NATIVE_QUOTA_PROVIDER_ID,
      accountId: account.id,
      observations,
      bindingProof,
      bindingProofDigest: digest(bindingProof),
    };
    this.lastIssuedBatch = {
      batchId,
      bindingProofDigest: batch.bindingProofDigest,
      observationDigests: bindingProof.observationDigests,
      accountSelectionBinding,
    };
    return batch;
  }

  /** Hold the selected-account generation through native identity recheck and controller commit. */
  async withRevalidatedBinding(batch, operation) {
    if (typeof operation !== "function") throw new TypeError("Native quota binding commit operation is required");
    const proof = batch?.bindingProof;
    const proofDigest = digest(proof);
    const observationDigests = Array.isArray(batch?.observations)
      ? batch.observations.map((observation) => observation?.sourceDigest).sort()
      : [];
    if (!proof || proof.kind !== "codex-native-quota-binding"
      || batch?.bindingProofDigest !== proofDigest
      || proof.batchId !== this.lastIssuedBatch?.batchId
      || proofDigest !== this.lastIssuedBatch?.bindingProofDigest
      || proof.accountSelectionBindingDigest !== this.lastIssuedBatch?.accountSelectionBinding?.digest
      || stableStringify(observationDigests) !== stableStringify(this.lastIssuedBatch?.observationDigests)) {
      throw new Error("Native Codex quota binding proof is not the adapter's current issued batch");
    }
    return this.accountStore.withSelectionBinding(this.lastIssuedBatch.accountSelectionBinding, async () => {
      const account = this.accountStore.resolve(CODEX_NATIVE_QUOTA_PROVIDER_ID);
      const source = this.config.accounts?.profileSources?.[account?.profileRef];
      if (!account || account.id !== proof.accountId || account.profileRef !== proof.profileRef
        || source?.kind !== "codex-home" || await realpath(source.root) !== proof.codexHome) {
        throw new Error("Selected opaque Codex account profile changed before native quota commit");
      }
      const command = this.config.providers?.[CODEX_NATIVE_QUOTA_PROVIDER_ID]?.command ?? "codex";
      const commandArgs = ["app-server", "--stdio"];
      const { results, receipt } = await this.callAppServerBatch([
        { method: "account/read", params: { refreshToken: false } },
      ], {
        command,
        commandArgs,
        environment: isolatedCodexEnvironment(proof.codexHome),
      });
      assertNativeProcessReceipt(receipt, { methods: ["account/read"], commandArgs, codexHome: proof.codexHome, results });
      if (digest(normalizeNativeAccountIdentity(results?.[0])) !== proof.nativeAccountIdentityDigest
        || receipt.executable.sha256 !== proof.executableSha256) {
        throw new Error("Native Codex account identity changed before quota commit");
      }
      return operation({
        valid: true,
        batchId: proof.batchId,
        bindingProofDigest: proofDigest,
        accountSelectionBindingDigest: proof.accountSelectionBindingDigest,
        adapterInstanceId: this.instanceId,
        adapterGenerationId: this.generationId,
        batchSequence: proof.batchSequence,
        nativeIdentityRecheckReceiptId: receipt.id,
      });
    });
  }

  /** Recheck without a commit callback for diagnostics and focused tests. */
  async revalidateBinding(batch) {
    return this.withRevalidatedBinding(batch, async (proof) => proof);
  }
}

function normalizeNativeAccountIdentity(result) {
  const account = result?.account;
  const email = typeof account?.email === "string" ? account.email.trim().toLowerCase() : "";
  const planType = optionalLabel(account?.planType);
  if (result?.requiresOpenaiAuth !== true || account?.type !== "chatgpt" || !email || !email.includes("@") || !planType) {
    throw new Error("Codex App Server account/read did not return a bindable native ChatGPT account identity");
  }
  return { type: "chatgpt", email, planType };
}

function assertNativeProcessReceipt(receipt, expected) {
  const executable = receipt?.executable;
  const expectedArgv = [executable?.path, ...expected.commandArgs];
  const startedAt = timestamp(receipt?.startedAt);
  const completedAt = timestamp(receipt?.completedAt);
  const receiptWithoutId = receipt && typeof receipt === "object" ? { ...receipt } : null;
  if (receiptWithoutId) delete receiptWithoutId.id;
  if (receipt?.kind !== "codex-app-server-process"
    || !Array.isArray(receipt.methods)
    || stableStringify(receipt.methods) !== stableStringify(expected.methods)
    || receipt.codexHome !== expected.codexHome
    || receipt.executableVerifiedAfterRead !== true
    || !executable || !isAbsolute(executable.path)
    || !/^[a-f0-9]{64}$/.test(executable.sha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(executable.metadataDigest ?? "")
    || typeof executable.version !== "string" || !executable.version.trim()
    || stableStringify(receipt.argv) !== stableStringify(expectedArgv)
    || !Array.isArray(receipt.spawnArgv) || receipt.spawnArgv.length === 0 || receipt.spawnArgv.some((part) => typeof part !== "string" || !part)
    || !Number.isSafeInteger(receipt.processId) || receipt.processId <= 0
    || !startedAt || !completedAt || Date.parse(completedAt) < Date.parse(startedAt)
    || receipt.resultDigest !== digest(expected.results)
    || receipt.id !== digest(receiptWithoutId)) {
    throw new Error("Codex App Server native quota receipt is not source-bound");
  }
}

function boundBucketResult(bucket) {
  return {
    bucketId: bucket.limitId,
    windowId: digest({
      limitId: bucket.limitId,
      primary: windowIdentityFields(bucket.primary),
      secondary: windowIdentityFields(bucket.secondary),
    }),
    usedRatio: bucket.usedRatio,
    remainingCapacity: Math.max(0, 1 - bucket.usedRatio),
    exhausted: bucket.rateLimitReachedType !== null || bucket.usedRatio >= 1,
    resetAt: resetAt(bucket.controllingWindow),
  };
}

function normalizeBuckets(result) {
  const multiple = result?.rateLimitsByLimitId;
  const entries = multiple && typeof multiple === "object" && !Array.isArray(multiple)
    ? Object.entries(multiple)
    : result?.rateLimits && typeof result.rateLimits === "object"
      ? [[result.rateLimits.limitId ?? "codex", result.rateLimits]]
      : [];
  return entries.flatMap(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const limitId = optionalLabel(value.limitId ?? key);
    if (!limitId) return [];
    const primary = normalizeWindow(value.primary);
    const secondary = normalizeWindow(value.secondary);
    const used = [primary?.usedPercent, secondary?.usedPercent].filter(Number.isFinite);
    if (used.length === 0) return [];
    const controllingWindow = !secondary || (primary && primary.usedPercent >= secondary.usedPercent) ? primary : secondary;
    return [{
      limitId,
      primary,
      secondary,
      controllingWindow,
      usedRatio: Math.max(...used) / 100,
      rateLimitReachedType: optionalLabel(value.rateLimitReachedType),
      planType: optionalLabel(value.planType),
    }];
  });
}

function normalizeWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usedPercent = Number(value.usedPercent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return null;
  return {
    usedPercent,
    windowDurationMins: positiveNumberOrNull(value.windowDurationMins),
    resetsAt: epochSecondsOrNull(value.resetsAt),
  };
}

function windowIdentityFields(window) {
  return window ? { windowDurationMins: window.windowDurationMins, resetsAt: window.resetsAt } : null;
}

function resetAt(window) {
  return Number.isFinite(window?.resetsAt) ? new Date(window.resetsAt * 1000).toISOString() : null;
}

function isolatedCodexEnvironment(codexHome) {
  const environment = { ...process.env, CODEX_HOME: resolve(codexHome) };
  for (const key of ["OPENAI_BASE_URL", "CHATGPT_BASE_URL", "CODEX_BASE_URL", "CODEX_API_BASE_URL"]) delete environment[key];
  return environment;
}

async function assertNotDefaultCodexHome(root) {
  const candidate = profileComparisonKey(await canonicalKnownPath(root));
  const defaults = new Set(await Promise.all([
    resolve(homedir(), ".codex"),
    resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex")),
  ].map(async (path) => profileComparisonKey(await canonicalKnownPath(path)))));
  if (defaults.has(candidate)) throw new ConfigError("Codex native quota refuses the current/default CODEX_HOME");
}

async function canonicalKnownPath(path) {
  try { return await realpath(path); } catch { return resolve(path); }
}

function profileComparisonKey(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function digest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function optionalLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function epochSecondsOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
