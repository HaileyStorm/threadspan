import { createHash, randomBytes as secureRandomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createExampleConfig } from "../core/config.mjs";
import {
  loadReleasePublicKey,
  inspectReleaseArchive,
  OFFICIAL_REPOSITORY,
  parseChecksumManifest,
  parseSignedReleaseSourceCommit,
  runInstallerCommand,
  verifyChecksumManifestSignature,
} from "./update-check.mjs";
import { computePlanDigest, createInstallerPlan } from "./components.mjs";
import { createDaemonServicePlan, validateDaemonServicePlan } from "./service.mjs";
import { providerIdsForComponents, readProviderActivationSuccessor } from "./provider-activation.mjs";
import {
  applyDaemonServicePlan,
  applyDaemonServiceUninstallPlan,
  applyInstallerPlan,
  applyInstallerUninstallPlan,
  createDaemonServiceUninstallPlan,
  createInstallerUninstallPlan,
  validateDaemonServiceAppliedState,
  validateInstallerAppliedState,
} from "./apply.mjs";

export const FRESH_INSTALL_SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_REASON_CODES = new Set([
  "auth-not-reviewed",
  "configuration-not-activated",
  "descriptor-unavailable",
  "live-check-not-run",
  "runtime-not-verified",
]);
const OFFICIAL_RELEASE_PUBLIC_KEY_SPKI_SHA256 = "e5176bfa37f10258631f092dc25d34547afb4295316fd9f673d6cacc6d41fdf6";

/** Resolve source provenance only from an exact clean official Git checkout or authenticated staged bundle record. */
export async function resolveFreshInstallProvenance(sourceRoot, options = {}) {
  const root = resolveRequiredAbsolute(sourceRoot, "sourceRoot");
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Fresh-install source root must be a regular directory");
  const canonicalRoot = await realpath(root);
  const cliPath = resolve(canonicalRoot, "src", "cli.mjs");
  await assertRegularFile(cliPath, "Fresh-install CLI source");
  const cliSha256 = await sha256File(cliPath);

  const staged = await readAuthenticatedStagedProvenance(canonicalRoot).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (staged) {
    const base = {
      schemaVersion: 1,
      kind: "publisher-signed-release-bundle",
      repository: OFFICIAL_REPOSITORY,
      sourceCommit: staged.sourceCommit,
      sourceRoot: canonicalRoot,
      cliPath,
      cliSha256,
      bundleSha256: staged.bundleSha256,
      signedManifestSha256: staged.signedManifestSha256,
      sourceTreeDigest: staged.sourceTreeDigest,
      publisherAuthenticated: true,
    };
    return deepFreeze({ ...base, digest: digestObject(base) });
  }

  const runGit = options.runGit ?? (async (args) => runInstallerCommand("git", args, {
    cwd: canonicalRoot,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 30_000,
  }));
  const [top, remote, status, commit, sourceTreeDigest, trackingCommit] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"]),
    runGit(["remote", "get-url", "origin"]),
    runGit(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]),
    runGit(["rev-parse", "--verify", "HEAD^{commit}"]),
    runGit(["rev-parse", "--verify", "HEAD^{tree}"]),
    runGit(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]),
  ]).catch(() => { throw new Error("Fresh-install source requires authenticated bundle metadata or one exact clean official Git commit"); });
  if (await realpath(resolve(String(top).trim())) !== canonicalRoot) throw new Error("Fresh-install source must be the Git worktree root");
  if (!isOfficialRemote(String(remote).trim())) throw new Error("Fresh-install Git provenance requires the exact official repository remote");
  if (String(status).length !== 0) throw new Error("Fresh-install Git provenance requires a clean checkout");
  const sourceCommit = String(commit).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(sourceCommit)) throw new Error("Fresh-install Git provenance has no exact commit");
  if (String(trackingCommit).trim().toLowerCase() !== sourceCommit) {
    throw new Error("Fresh-install Git provenance requires HEAD to equal the inspected official origin/main tracking ref");
  }
  const treeDigest = String(sourceTreeDigest).trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(treeDigest)) throw new Error("Fresh-install Git provenance has no exact source tree");
  const base = {
    schemaVersion: 1,
    kind: "clean-official-tracking-ref",
    repository: OFFICIAL_REPOSITORY,
    sourceCommit,
    sourceRoot: canonicalRoot,
    cliPath,
    cliSha256,
    sourceTreeDigest: treeDigest,
    publisherAuthenticated: false,
  };
  return deepFreeze({ ...base, digest: digestObject(base) });
}

/** Create the initial owner-local config. Selected providers remain disabled until every readiness dimension is proven. */
export function createFreshInstallConfig(options) {
  const providerIds = normalizeIds(options?.providerIds ?? [], PROVIDER_ID_PATTERN, "provider");
  const ownerTokenPath = resolveRequiredAbsolute(options?.ownerTokenPath, "ownerTokenPath");
  const connectorTokenPath = resolveRequiredAbsolute(options?.connectorTokenPath, "connectorTokenPath");
  assertDistinctPathStrings(ownerTokenPath, connectorTokenPath, "Owner and connector token paths must be distinct");
  const example = createExampleConfig();
  const providers = {};
  for (const providerId of providerIds) {
    const descriptor = example.providers[providerId];
    if (descriptor) providers[providerId] = { ...structuredClone(descriptor), enabled: false };
  }
  return {
    ...example,
    server: {
      ...example.server,
      authTokenEnv: null,
      authTokenFile: ownerTokenPath,
      connectorTokenEnv: null,
      connectorTokenFile: connectorTokenPath,
    },
    routing: { providerOrder: { consult: [], integrated: [], delegate: [] }, providerProfiles: {} },
    defaults: { provider: "threadspan", mode: "consult", model: "auto" },
    providers,
  };
}

/** Create one canonical parent plan consumed unchanged by CLI and GUI. */
export async function createFreshInstallPlan(options) {
  if (!options || typeof options !== "object") throw new TypeError("Fresh-install options are required");
  if (Object.hasOwn(options, "sourceRevision") || Object.hasOwn(options, "sourceCommit")) {
    throw new Error("Fresh-install source revision is derived from verified provenance and cannot be supplied by the caller");
  }
  const planId = normalizeId(options.planId ?? `fresh-${Date.now()}`, "planId");
  const platform = options.platform ?? process.platform;
  if (!["linux", "win32"].includes(platform)) throw new Error(`Fresh install is unsupported on ${platform}`);
  const installRoot = resolveRequiredAbsolute(options.installRoot, "installRoot");
  const configPath = resolveRequiredAbsolute(options.configPath ?? resolve(installRoot, "config.jsonc"), "configPath");
  const ownerTokenPath = resolveRequiredAbsolute(options.ownerTokenPath ?? resolve(installRoot, "secrets", "owner.token"), "ownerTokenPath");
  const connectorTokenPath = resolveRequiredAbsolute(options.connectorTokenPath ?? resolve(installRoot, "secrets", "connector.token"), "connectorTokenPath");
  assertDistinctPathStrings(ownerTokenPath, connectorTokenPath, "Owner and connector token paths must be distinct");
  if ([ownerTokenPath, connectorTokenPath].some((path) => pathKey(path) === pathKey(configPath))) {
    throw new Error("Fresh-install config and token targets must be distinct");
  }
  await assertFreshTargetsAbsent([configPath, ownerTokenPath, connectorTokenPath]);
  const provenance = await resolveFreshInstallProvenance(options.sourceRoot, { runGit: options.runGit });
  const componentIds = normalizeIds(options.componentIds ?? ["daemon"], PROVIDER_ID_PATTERN, "component");
  const providerCatalog = createExampleConfig().providers;
  const providerIds = normalizeIds(options.providerIds ?? providerIdsForComponents(componentIds, providerCatalog), PROVIDER_ID_PATTERN, "provider");
  const componentPlan = createInstallerPlan({
    installRoot,
    selection: componentIds,
    longContextProfiles: options.longContextProfiles ?? [],
    planId: `${planId}-components`,
    environment: options.environment ?? process.env,
  });
  const config = createFreshInstallConfig({ ownerTokenPath, connectorTokenPath, providerIds });
  const configContent = `${JSON.stringify(config, null, 2)}\n`;
  const taskProtection = createFreshTaskProtectionBinding(options.taskProtection);
  const providerEvidence = providerIds.map((providerId) => providerReadiness(providerId, config.providers[providerId]));
  const home = resolve(options.home ?? homedir());
  const stateRoot = resolve(options.stateRoot ?? resolve(installRoot, ".threadspan-installer", "fresh-state"));
  const serviceStateRoot = resolve(stateRoot, "service");
  const lifecycleOwner = `fresh-owner:${planId}:${provenance.sourceCommit}`;
  const servicePlan = createDaemonServicePlan({
    platform,
    nodePath: resolve(options.nodePath ?? process.execPath),
    cliPath: provenance.cliPath,
    cliSha256: provenance.cliSha256,
    configPath,
    config,
    sourceRevision: provenance.sourceCommit,
    lifecycleOwner,
    providerIds: Object.keys(config.providers),
    home,
    stateRoot: serviceStateRoot,
    planId: `${planId}-service`,
    ...(options.serviceDirectory ? { serviceDirectory: resolve(options.serviceDirectory) } : {}),
    ...(options.legacyStartupPath ? { legacyStartupPath: resolve(options.legacyStartupPath) } : {}),
    environment: options.environment ?? process.env,
  });
  const base = {
    schemaVersion: FRESH_INSTALL_SCHEMA_VERSION,
    kind: "threadspan-fresh-install",
    planId,
    platform,
    installRoot,
    stateRoot,
    provenance,
    config: {
      path: configPath,
      content: configContent,
      sha256: sha256Bytes(Buffer.from(configContent)),
      mode: 0o600,
      policy: "fresh-only-no-overwrite-no-migration",
    },
    tokens: {
      owner: { path: ownerTokenPath, scope: "owner-api", mode: 0o600, bytes: 32 },
      connector: { path: connectorTokenPath, scope: "connector-mcp-read-only", mode: 0o600, bytes: 32 },
      policy: "generated-during-apply-only-independent-values",
    },
    selectedComponentIds: componentIds,
    selectedProviderIds: providerIds,
    componentChild: { digest: componentPlan.digest, plan: componentPlan },
    serviceChild: { digest: servicePlan.digest, plan: servicePlan },
    taskProtection,
    providerEvidence,
    hostSurfaceChild: {
      status: "pending",
      reasonCodes: ["exact-rollback-not-composed"],
      mutationPlanned: false,
    },
  };
  return deepFreeze({ ...base, digest: digestObject(base) });
}

/** Render the closed parent and child digests without credential material. */
export function previewFreshInstallPlan(plan) {
  validateFreshInstallPlan(plan);
  const lines = [
    `Threadspan fresh install plan ${plan.planId}`,
    `Platform: ${plan.platform}`,
    `Source commit: ${plan.provenance.sourceCommit}`,
    `Provenance: ${plan.provenance.kind} (${plan.provenance.digest})`,
    `Config: ${plan.config.path} (${plan.config.sha256})`,
    `Owner token file: ${plan.tokens.owner.path} (${plan.tokens.owner.scope}, generated only during apply)`,
    `Connector token file: ${plan.tokens.connector.path} (${plan.tokens.connector.scope}, generated only during apply)`,
    `Components: ${plan.selectedComponentIds.join(", ") || "none"}`,
    `Providers: ${plan.selectedProviderIds.join(", ") || "none"}`,
    `Component child digest: ${plan.componentChild.digest}`,
    `Service child digest: ${plan.serviceChild.digest}`,
    `Task protection digest: ${plan.taskProtection.digest}`,
    ...plan.providerEvidence.map((item) => `Provider ${item.providerId}: ${item.status} (${item.reasonCodes.join(",") || "none"})`),
    `Host surfaces: ${plan.hostSurfaceChild.status} (${plan.hostSurfaceChild.reasonCodes.join(",")})`,
    `Approval digest: ${plan.digest}`,
  ];
  return { digest: plan.digest, text: `${lines.join("\n")}\n` };
}

/** Apply the approved parent transaction and roll completed children back in exact reverse order on failure. */
export async function applyFreshInstallPlan(plan, options = {}) {
  if (plan?.platform !== process.platform) throw new Error(`Fresh-install plan platform ${plan?.platform} does not match native platform ${process.platform}`);
  validateFreshInstallPlan(plan);
  if (options.approvedDigest !== plan.digest) throw new Error("Fresh install requires the digest from previewFreshInstallPlan");
  if (options.approvedTaskProtectionDigest !== plan.taskProtection.digest) {
    throw new Error("Fresh install requires the task-protection digest bound into the approved plan");
  }
  if (process.platform === "win32") {
    throw new Error("Native Windows fresh apply is blocked until owner-only ACLs can be guaranteed atomically at file creation");
  }
  assertFreshTestHooks(options);
  throwIfFreshAborted(options.signal);
  await assertPlanSourceStable(plan);
  await assertSafeAbsolutePath(plan.stateRoot, { directoryTarget: true });
  await mkdir(plan.stateRoot, { recursive: true, mode: 0o700 });
  await assertSafeAbsolutePath(plan.stateRoot, { directoryTarget: true });
  const journalPath = resolve(plan.stateRoot, "fresh-install-journal.json");
  const existingJournal = await readFreshJournal(journalPath);
  if (existingJournal?.status === "applied") return replayFreshInstallReceipt(plan, existingJournal);
  const claim = await acquireFreshClaim(plan, options, "apply");
  try {
    let journal = await readFreshJournal(journalPath);
    if (!journal) {
      await assertFreshTargetsAbsent([plan.config.path, plan.tokens.owner.path, plan.tokens.connector.path]);
      journal = freshJournal(plan);
      await writeJsonExclusive(journalPath, journal, 0o600);
    } else {
      assertJournalMatchesPlan(journal, plan);
      if (journal.status === "applied") return replayFreshInstallReceipt(plan, journal);
      if (!["prepared", "applying", "rollback-incomplete"].includes(journal.status)) {
        throw new Error(`Fresh-install journal cannot resume while ${journal.status}`);
      }
      if (journal.status === "rollback-incomplete") throw new Error("Fresh-install rollback is incomplete and requires reviewed recovery");
    }

    journal.status = "applying";
    await writeJsonAtomic(journalPath, journal, 0o600);
    try {
      if (journal.steps.config !== "applied") {
        throwIfFreshAborted(options.signal);
        if (journal.credentialBindings) {
          const recovered = await reconcileFreshConfigAndTokens(plan, journal.credentialBindings);
          if (!recovered) {
            delete journal.credentialBindings;
            await writeJsonAtomic(journalPath, journal, 0o600);
          }
        }
        if (!journal.credentialBindings) {
          await applyFreshConfigAndTokens(plan, options, async (bindings) => {
            journal.credentialBindings = bindings;
            await writeJsonAtomic(journalPath, journal, 0o600);
          });
        }
        journal.steps.config = "applied";
        await writeJsonAtomic(journalPath, journal, 0o600);
        await freshCheckpoint(options, "config-applied");
      } else {
        await assertFreshConfigAndTokens(plan, journal.credentialBindings);
      }

      if (journal.steps.components !== "applied") {
        throwIfFreshAborted(options.signal);
        journal.componentManifestPath = resolve(plan.installRoot, plan.componentChild.plan.rollbackManifest);
        await writeJsonAtomic(journalPath, journal, 0o600);
        const componentReceipt = await applyInstallerPlan(plan.componentChild.plan, {
          approvedDigest: plan.componentChild.digest,
          environment: options.environment ?? process.env,
          checkpoint: options.componentCheckpoint,
        });
        journal.steps.components = "applied";
        if (resolve(componentReceipt.manifestPath) !== resolve(journal.componentManifestPath)) throw new Error("Component child returned a noncanonical manifest path");
        await writeJsonAtomic(journalPath, journal, 0o600);
        await freshCheckpoint(options, "components-applied");
      } else {
        await applyInstallerPlan(plan.componentChild.plan, {
          approvedDigest: plan.componentChild.digest,
          environment: options.environment ?? process.env,
          checkpoint: options.componentCheckpoint,
        });
      }

      if (journal.steps.service !== "applied") {
        throwIfFreshAborted(options.signal);
        await assertPlanSourceStable(plan);
        journal.serviceManifestPath = resolve(plan.serviceChild.plan.stateRoot, "manifests", `${plan.serviceChild.plan.planId}.json`);
        await writeJsonAtomic(journalPath, journal, 0o600);
        const serviceReceipt = await applyDaemonServicePlan(plan.serviceChild.plan, {
          approvedDigest: plan.serviceChild.digest,
          commandRunner: options.commandRunner,
          signal: options.signal,
          beforeActivation: () => assertPlanSourceStable(plan),
        });
        journal.steps.service = "applied";
        journal.serviceStatus = serviceReceipt.status;
        await writeJsonAtomic(journalPath, journal, 0o600);
        await freshCheckpoint(options, "service-applied");
      }

      const receipt = freshInstallReceipt(plan, journal);
      throwIfFreshAborted(options.signal);
      journal.status = "applied";
      journal.terminalReceipt = receipt;
      await writeJsonAtomic(journalPath, journal, 0o600);
      await freshCheckpoint(options, "terminal-persisted");
      throwIfFreshAborted(options.signal);
      return receipt;
    } catch (error) {
      if (error?.simulatedProcessExit === true) throw error;
      const failures = await rollbackFreshChildren(plan, journal, options);
      delete journal.terminalReceipt;
      journal.status = failures.length === 0 ? "rolled-back-after-error" : "rollback-incomplete";
      journal.errorCode = "fresh-install-child-failed";
      if (failures.length > 0) journal.rollbackFailures = failures;
      await writeJsonAtomic(journalPath, journal, 0o600).catch(() => undefined);
      if (failures.length > 0) throw new AggregateError([error], "Fresh install failed and reverse rollback was incomplete");
      throw error;
    }
  } finally {
    await releaseFreshClaim(claim);
  }
}

/** Create one separately digest-bound composite uninstall plan for a completed fresh install. */
export async function createFreshInstallUninstallPlan(installPlan, options = {}) {
  validateFreshInstallPlan(installPlan);
  const journalPath = resolve(installPlan.stateRoot, "fresh-install-journal.json");
  const journal = await readFreshJournal(journalPath);
  if (!journal || journal.status !== "applied") throw new Error("Fresh install is not in an uninstallable terminal state");
  await replayFreshInstallReceipt(installPlan, journal);
  const componentPlan = await createInstallerUninstallPlan(journal.componentManifestPath, { planId: `${installPlan.planId}-components-uninstall` });
  const serviceManifestPath = resolve(installPlan.serviceChild.plan.stateRoot, "manifests", `${installPlan.serviceChild.plan.planId}.json`);
  const servicePlan = await createDaemonServiceUninstallPlan(serviceManifestPath, { planId: `${installPlan.planId}-service-uninstall` });
  const activationSuccessor = await readProviderActivationSuccessor(installPlan);
  if (activationSuccessor?.status === "blocked" && activationSuccessor.rollbackComplete === false) {
    throw new Error("Fresh uninstall requires reviewed recovery of the incomplete provider-activation rollback");
  }
  const effectiveConfigSha256 = activationSuccessor?.status === "ready" ? activationSuccessor.configSha256 : installPlan.config.sha256;
  const base = {
    schemaVersion: 1,
    kind: "threadspan-fresh-uninstall",
    planId: normalizeId(options.planId ?? `uninstall-${installPlan.planId}`, "uninstall planId"),
    installPlanId: installPlan.planId,
    installPlanDigest: installPlan.digest,
    provenanceDigest: installPlan.provenance.digest,
    taskProtectionDigest: installPlan.taskProtection.digest,
    componentInstallDigest: installPlan.componentChild.digest,
    serviceInstallDigest: installPlan.serviceChild.digest,
    platform: installPlan.platform,
    stateRoot: installPlan.stateRoot,
    journalPath,
    config: { ...installPlan.config, sha256: effectiveConfigSha256 },
    activationSuccessor: activationSuccessor ? {
      kind: activationSuccessor.kind,
      planId: activationSuccessor.planId,
      planDigest: activationSuccessor.planDigest,
      status: activationSuccessor.status,
      configSha256: activationSuccessor.configSha256,
    } : null,
    tokens: installPlan.tokens,
    credentialBindings: journal.credentialBindings,
    componentChild: { digest: componentPlan.digest, plan: componentPlan },
    serviceChild: { digest: servicePlan.digest, plan: servicePlan },
  };
  return deepFreeze({ ...base, digest: digestObject(base) });
}

/** Preview reverse child ordering for the composite uninstall. */
export function previewFreshInstallUninstallPlan(plan) {
  validateFreshUninstallPlan(plan);
  return {
    digest: plan.digest,
    text: `Threadspan fresh uninstall plan ${plan.planId}\nOrder: service, components, config, connector token, owner token\nService child digest: ${plan.serviceChild.digest}\nComponent child digest: ${plan.componentChild.digest}\nApproval digest: ${plan.digest}\n`,
  };
}

/** Apply the approved fresh uninstall; every child has its own exact digest and terminal replay. */
export async function applyFreshInstallUninstallPlan(plan, options = {}) {
  if (plan?.platform !== process.platform) throw new Error(`Fresh-uninstall plan platform ${plan?.platform} does not match native platform ${process.platform}`);
  validateFreshUninstallPlan(plan);
  if (options.approvedDigest !== plan.digest) throw new Error("Fresh uninstall requires the digest from previewFreshInstallUninstallPlan");
  assertFreshTestHooks(options);
  const journal = await readFreshJournal(plan.journalPath);
  if (!journal) throw new Error("Fresh-install journal is unavailable");
  assertJournalMatchesUninstall(journal, plan);
  if (journal.status === "uninstalled") return replayFreshUninstallReceipt(plan, journal, options);
  if (journal.status !== "applied" && journal.status !== "uninstalling" && journal.status !== "uninstall-incomplete") {
    throw new Error(`Fresh install is not uninstallable while ${journal.status}`);
  }
  const claim = await acquireFreshClaim(plan, options, "uninstall");
  try {
    journal.status = "uninstalling";
    await writeJsonAtomic(plan.journalPath, journal, 0o600);
    const failures = [];
    try {
      await applyDaemonServiceUninstallPlan(plan.serviceChild.plan, {
        approvedDigest: plan.serviceChild.digest,
        commandRunner: options.commandRunner,
        signal: options.signal,
        checkpoint: options.serviceCheckpoint,
      });
    } catch (error) {
      if (error?.simulatedProcessExit === true) throw error;
      failures.push(sanitizedFailure("service", error));
    }
    if (failures.length === 0) {
      try { await applyInstallerUninstallPlan(plan.componentChild.plan, { approvedDigest: plan.componentChild.digest, checkpoint: options.componentUninstallCheckpoint }); }
      catch (error) {
        if (error?.simulatedProcessExit === true) throw error;
        failures.push(sanitizedFailure("components", error));
      }
    }
    if (failures.length === 0) {
      try { await removeFreshConfigAndTokens(plan, undefined, options.uninstallCheckpoint); }
      catch (error) {
        if (error?.simulatedProcessExit === true) throw error;
        failures.push(sanitizedFailure("config-tokens", error));
      }
    }
    if (failures.length > 0) {
      journal.status = "uninstall-incomplete";
      journal.uninstallFailures = failures;
      await writeJsonAtomic(plan.journalPath, journal, 0o600);
      throw new AggregateError([], "Fresh uninstall was incomplete");
    }
    const receipt = freshUninstallReceipt(plan);
    journal.status = "uninstalled";
    journal.terminalUninstallReceipt = receipt;
    journal.terminalUninstallPlanDigest = plan.digest;
    await writeJsonAtomic(plan.journalPath, journal, 0o600);
    return receipt;
  } finally {
    await releaseFreshClaim(claim);
  }
}

function validateFreshInstallPlan(plan) {
  if (!plan || plan.schemaVersion !== FRESH_INSTALL_SCHEMA_VERSION || plan.kind !== "threadspan-fresh-install"
    || !ID_PATTERN.test(plan.planId ?? "") || !["linux", "win32"].includes(plan.platform)
    || !isAbsolute(plan.installRoot ?? "") || !isAbsolute(plan.stateRoot ?? "")
    || !plan.provenance || !COMMIT_PATTERN.test(plan.provenance.sourceCommit ?? "") || !SHA256_PATTERN.test(plan.provenance.digest ?? "")
    || !plan.config || !SHA256_PATTERN.test(plan.config.sha256 ?? "") || !isAbsolute(plan.config.path ?? "")
    || !plan.tokens?.owner || !plan.tokens?.connector || !isAbsolute(plan.tokens.owner.path ?? "") || !isAbsolute(plan.tokens.connector.path ?? "")
    || !plan.componentChild?.plan || plan.componentChild.digest !== plan.componentChild.plan.digest
    || !plan.serviceChild?.plan || plan.serviceChild.digest !== plan.serviceChild.plan.digest
    || !SHA256_PATTERN.test(plan.taskProtection?.digest ?? "") || !Array.isArray(plan.providerEvidence)
    || !SHA256_PATTERN.test(plan.digest ?? "")) {
    throw new TypeError("Invalid fresh-install plan");
  }
  assertDistinctPathStrings(plan.tokens.owner.path, plan.tokens.connector.path, "Owner and connector token paths must be distinct");
  if (sha256Bytes(Buffer.from(plan.config.content, "utf8")) !== plan.config.sha256) throw new Error("Fresh-install config content binding is invalid");
  if (computePlanDigest(plan.componentChild.plan) !== plan.componentChild.digest) throw new Error("Fresh-install component child integrity check failed");
  validateDaemonServicePlan(plan.serviceChild.plan);
  if (plan.serviceChild.plan.source.revision !== plan.provenance.sourceCommit
    || plan.serviceChild.plan.source.cliPath !== plan.provenance.cliPath
    || plan.serviceChild.plan.source.cliSha256 !== plan.provenance.cliSha256
    || plan.serviceChild.plan.configPath !== plan.config.path) {
    throw new Error("Fresh-install service child is not bound to parent provenance and config");
  }
  const { digest: _digest, ...payload } = plan;
  if (digestObject(payload) !== plan.digest) throw new Error("Fresh-install parent plan integrity check failed");
  const { digest: _taskDigest, ...taskPayload } = plan.taskProtection;
  if (digestObject(taskPayload) !== plan.taskProtection.digest) throw new Error("Fresh-install task-protection binding is invalid");
  const { digest: _provenanceDigest, ...provenancePayload } = plan.provenance;
  if (digestObject(provenancePayload) !== plan.provenance.digest) throw new Error("Fresh-install provenance binding is invalid");
  validateProviderEvidence(plan.providerEvidence, plan.selectedProviderIds);
}

function validateFreshUninstallPlan(plan) {
  if (!plan || plan.schemaVersion !== 1 || plan.kind !== "threadspan-fresh-uninstall"
    || !ID_PATTERN.test(plan.planId ?? "") || !["linux", "win32"].includes(plan.platform)
    || !SHA256_PATTERN.test(plan.installPlanDigest ?? "") || !SHA256_PATTERN.test(plan.digest ?? "")
    || !SHA256_PATTERN.test(plan.provenanceDigest ?? "") || !SHA256_PATTERN.test(plan.taskProtectionDigest ?? "")
    || !SHA256_PATTERN.test(plan.componentInstallDigest ?? "") || !SHA256_PATTERN.test(plan.serviceInstallDigest ?? "")
    || plan.componentChild?.digest !== plan.componentChild?.plan?.digest
    || plan.serviceChild?.digest !== plan.serviceChild?.plan?.digest) {
    throw new TypeError("Invalid fresh-uninstall plan");
  }
  const { digest: _digest, ...payload } = plan;
  if (digestObject(payload) !== plan.digest) throw new Error("Fresh-uninstall parent plan integrity check failed");
  validateCredentialBindings(plan.credentialBindings);
}

/** Create the immutable, privacy-minimized task-protection projection bound by fresh plans. */
export function createFreshTaskProtectionBinding(value = {}) {
  const disposition = ["wait", "pause", "manual-confirmed", "none"].includes(value.disposition) ? value.disposition : "manual-confirmed";
  const taskIds = Array.isArray(value.taskIds) ? value.taskIds.map(String) : [];
  const inventory = value.inventory && typeof value.inventory === "object" ? {
    trusted: value.inventory.trusted === true,
    completeness: value.inventory.trusted === true && value.inventory.notLoaded === 0 ? "complete" : "incomplete",
  } : { trusted: value.trusted === true, completeness: value.trusted === true ? "complete" : "incomplete" };
  const inventoryDigest = SHA256_PATTERN.test(value.inventoryDigest ?? "")
    ? value.inventoryDigest
    : sha256Bytes(Buffer.from(stableStringify(inventory), "utf8"));
  const base = {
    schemaVersion: 1,
    kind: "threadspan-fresh-task-protection",
    disposition,
    trusted: inventory.trusted,
    inventoryDigest,
    taskIdDigests: taskIds.map((id) => sha256Bytes(Buffer.from(id, "utf8"))).sort(),
  };
  return deepFreeze({ ...base, digest: digestObject(base) });
}

function providerReadiness(providerId, descriptor) {
  const descriptorAvailable = Boolean(descriptor);
  const reasonCodes = descriptorAvailable
    ? ["configuration-not-activated", "auth-not-reviewed", "runtime-not-verified", "live-check-not-run"]
    : ["descriptor-unavailable", "auth-not-reviewed", "runtime-not-verified", "live-check-not-run"];
  return Object.freeze({
    schemaVersion: 1,
    providerId,
    configured: false,
    descriptor: descriptorAvailable,
    auth: false,
    runtime: false,
    live: false,
    status: descriptorAvailable ? "pending" : "blocked",
    reasonCodes,
  });
}

function validateProviderEvidence(evidence, selectedProviderIds) {
  if (!Array.isArray(selectedProviderIds) || stableStringify(evidence.map((item) => item.providerId)) !== stableStringify(selectedProviderIds)) {
    throw new Error("Fresh-install provider evidence does not match selected providers");
  }
  for (const item of evidence) {
    if (!item || item.schemaVersion !== 1 || !PROVIDER_ID_PATTERN.test(item.providerId ?? "")
      || !["ready", "blocked", "pending", "unknown"].includes(item.status)
      || ["configured", "descriptor", "auth", "runtime", "live"].some((key) => typeof item[key] !== "boolean")
      || !Array.isArray(item.reasonCodes) || item.reasonCodes.some((code) => !PROVIDER_REASON_CODES.has(code))) {
      throw new Error("Invalid fresh-install provider readiness evidence");
    }
    if (item.status === "ready" && !(item.configured && item.descriptor && item.auth && item.runtime && item.live)) {
      throw new Error(`Provider '${item.providerId}' cannot be ready without complete evidence`);
    }
    if (item.status === "ready") throw new Error(`Offline fresh install cannot issue ready evidence for provider '${item.providerId}'`);
  }
}

async function readAuthenticatedStagedProvenance(root) {
  const path = resolve(root, ".threadspan-release.json");
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) throw new Error("Authenticated release provenance record is invalid");
  const record = JSON.parse(await readFile(path, "utf8"));
  const allowed = ["bundleSha256", "provenanceKind", "repository", "schemaVersion", "signedManifestSha256", "sourceCommit", "tag", "version"];
  if (!record || record.schemaVersion !== 2 || record.repository !== OFFICIAL_REPOSITORY
    || record.provenanceKind !== "publisher-signed-release-manifest"
    || Object.keys(record).some((key) => !allowed.includes(key))
    || !COMMIT_PATTERN.test(record.sourceCommit ?? "") || !SHA256_PATTERN.test(record.bundleSha256 ?? "")
    || !SHA256_PATTERN.test(record.signedManifestSha256 ?? "")) {
    throw new Error("Staged release does not carry authenticated sourceCommit metadata");
  }
  const manifestPath = resolve(root, ".threadspan-release.SHA256SUMS");
  const signaturePath = resolve(root, ".threadspan-release.SHA256SUMS.sig");
  const archivePath = resolve(root, ".threadspan-release.tar.gz");
  const [manifestStats, signatureStats, archiveStats] = await Promise.all([lstat(manifestPath), lstat(signaturePath), lstat(archivePath)]);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > 1024 * 1024
    || !signatureStats.isFile() || signatureStats.isSymbolicLink() || signatureStats.size > 4096
    || !archiveStats.isFile() || archiveStats.isSymbolicLink() || archiveStats.size > 512 * 1024 * 1024) {
    throw new Error("Authenticated staged release proof files are invalid");
  }
  const [manifestBytes, signatureBytes, publicKey] = await Promise.all([
    readFile(manifestPath),
    readFile(signaturePath),
    loadReleasePublicKey(root),
  ]);
  const publicKeyFingerprint = sha256Bytes(publicKey.export({ type: "spki", format: "der" }));
  if (publicKeyFingerprint !== OFFICIAL_RELEASE_PUBLIC_KEY_SPKI_SHA256) {
    throw new Error("Staged release proof is not rooted in the pinned official publisher key");
  }
  verifyChecksumManifestSignature(manifestBytes, signatureBytes, publicKey);
  if (sha256Bytes(manifestBytes) !== record.signedManifestSha256
    || parseSignedReleaseSourceCommit(manifestBytes.toString("utf8")) !== record.sourceCommit
    || parseChecksumManifest(manifestBytes.toString("utf8"), `threadspan-${record.version}.tar.gz`) !== record.bundleSha256) {
    throw new Error("Authenticated staged release proof does not match its closed provenance record");
  }
  if (await sha256File(archivePath) !== record.bundleSha256) throw new Error("Authenticated staged release archive evidence changed");
  const sourceTreeDigest = await verifyStagedSourceTree(root, archivePath, record.version);
  return { ...record, sourceTreeDigest };
}

async function verifyStagedSourceTree(root, archivePath, version) {
  const expectedRootName = `threadspan-${version}`;
  await inspectReleaseArchive(archivePath, { expectedRootName });
  const temporary = await mkdtemp(resolve(tmpdir(), "threadspan-fresh-source-proof-"));
  try {
    await runInstallerCommand("tar", ["-xzf", archivePath, "-C", temporary, "--no-same-owner", "--no-same-permissions"], {
      timeoutMs: 2 * 60_000,
    });
    const extractedRoot = resolve(temporary, expectedRootName);
    const [stagedTree, archiveTree] = await Promise.all([
      collectSourceTree(root, new Set([
        ".threadspan-release.json",
        ".threadspan-release.tar.gz",
        ".threadspan-release.SHA256SUMS",
        ".threadspan-release.SHA256SUMS.sig",
      ])),
      collectSourceTree(extractedRoot),
    ]);
    if (stableStringify(stagedTree) !== stableStringify(archiveTree)) {
      throw new Error("Staged release source tree differs from the authenticated archive");
    }
    return digestObject(stagedTree);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function collectSourceTree(root, excludedTopLevel = new Set()) {
  const entries = [];
  let totalBytes = 0;
  async function visit(directory, prefix = "") {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (!prefix && excludedTopLevel.has(item.name)) continue;
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) throw new Error("Staged release source tree contains a non-regular entry");
      if (item.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        await visit(resolve(directory, item.name), relativePath);
        continue;
      }
      const path = resolve(directory, item.name);
      const stats = await lstat(path);
      totalBytes += stats.size;
      if (entries.length >= 30_000 || totalBytes > 128 * 1024 * 1024) throw new Error("Staged release source tree exceeds verification bounds");
      entries.push({ path: relativePath, kind: "file", sha256: await sha256File(path), bytes: stats.size, mode: stats.mode & 0o777 });
    }
  }
  await visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function assertPlanSourceStable(plan) {
  const observed = await resolveFreshInstallProvenance(plan.provenance.sourceRoot);
  if (stableStringify(observed) !== stableStringify(plan.provenance)) throw new Error("Fresh-install source provenance changed after planning");
}

function freshJournal(plan) {
  return {
    schemaVersion: 1,
    kind: "threadspan-fresh-install-journal",
    planId: plan.planId,
    planDigest: plan.digest,
    platform: plan.platform,
    provenanceDigest: plan.provenance.digest,
    componentDigest: plan.componentChild.digest,
    serviceDigest: plan.serviceChild.digest,
    taskProtectionDigest: plan.taskProtection.digest,
    status: "prepared",
    steps: { config: "pending", components: "pending", service: "pending" },
  };
}

async function readFreshJournal(path) {
  const stats = await safeLstat(path);
  if (!stats) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256 * 1024) throw new Error("Fresh-install journal is not a bounded regular file");
  const journal = JSON.parse(await readFile(path, "utf8"));
  if (!journal || journal.schemaVersion !== 1 || journal.kind !== "threadspan-fresh-install-journal"
    || !ID_PATTERN.test(journal.planId ?? "") || !SHA256_PATTERN.test(journal.planDigest ?? "")
    || !["prepared", "applying", "applied", "rolled-back-after-error", "rollback-incomplete", "uninstalling", "uninstall-incomplete", "uninstalled"].includes(journal.status)
    || !journal.steps || ["config", "components", "service"].some((key) => !["pending", "applied", "rolled-back"].includes(journal.steps[key]))) {
    throw new Error("Invalid fresh-install journal");
  }
  assertNoSecretMaterial(journal);
  if (journal.credentialBindings !== undefined) validateCredentialBindings(journal.credentialBindings);
  return journal;
}

function assertJournalMatchesPlan(journal, plan) {
  if (journal.planId !== plan.planId || journal.planDigest !== plan.digest || journal.platform !== plan.platform
    || journal.provenanceDigest !== plan.provenance.digest || journal.componentDigest !== plan.componentChild.digest
    || journal.serviceDigest !== plan.serviceChild.digest || journal.taskProtectionDigest !== plan.taskProtection.digest) {
    throw new Error("Fresh-install journal does not match the approved parent plan");
  }
}

function assertJournalMatchesUninstall(journal, plan) {
  if (journal.planId !== plan.installPlanId || journal.planDigest !== plan.installPlanDigest || journal.platform !== plan.platform
    || journal.provenanceDigest !== plan.provenanceDigest || journal.taskProtectionDigest !== plan.taskProtectionDigest
    || journal.componentDigest !== plan.componentInstallDigest || journal.serviceDigest !== plan.serviceInstallDigest) {
    throw new Error("Fresh-install journal does not match the approved uninstall transaction");
  }
}

async function applyFreshConfigAndTokens(plan, options, persistBindings) {
  await assertFreshTargetsAbsent([plan.config.path, plan.tokens.owner.path, plan.tokens.connector.path]);
  const random = options.randomBytes ?? secureRandomBytes;
  let owner = Buffer.from(random(plan.tokens.owner.bytes));
  let connector = Buffer.from(random(plan.tokens.connector.bytes));
  if (owner.length < 32 || connector.length < 32) throw new Error("Fresh-install token generator returned insufficient entropy");
  if (secretBuffersEqual(owner, connector)) connector = Buffer.from(random(plan.tokens.connector.bytes));
  if (secretBuffersEqual(owner, connector)) throw new Error("Fresh-install token generator did not produce independent credentials");
  const ownerText = `${owner.toString("base64url")}\n`;
  const connectorText = `${connector.toString("base64url")}\n`;
  const bindings = {
    schemaVersion: 1,
    ownerSha256: sha256Bytes(Buffer.from(ownerText)),
    connectorSha256: sha256Bytes(Buffer.from(connectorText)),
  };
  owner.fill(0);
  connector.fill(0);
  await persistBindings(bindings);
  try {
    await writeExclusive(plan.tokens.owner.path, ownerText, 0o600);
    await writeExclusive(plan.tokens.connector.path, connectorText, 0o600);
    await writeExclusive(plan.config.path, plan.config.content, 0o600);
    await assertFreshConfigAndTokens(plan, bindings);
  } catch (error) {
    const cleanupErrors = [];
    for (const [path, bytes] of [
      [plan.config.path, Buffer.from(plan.config.content)],
      [plan.tokens.connector.path, Buffer.from(connectorText)],
      [plan.tokens.owner.path, Buffer.from(ownerText)],
    ]) {
      try { await removeFreshCreatedFile(path, bytes); }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Fresh-install config/token creation failed and cleanup was incomplete");
    throw error;
  }
}

async function assertFreshConfigAndTokens(plan, bindings, expectedConfigSha256 = plan.config.sha256) {
  validateCredentialBindings(bindings);
  const configStats = await assertRegularFile(plan.config.path, "Fresh-install config");
  if (process.platform === "win32") await verifyWindowsOwnerOnlyFile(plan.config.path);
  if (await sha256File(plan.config.path) !== expectedConfigSha256 || (process.platform !== "win32" && (configStats.mode & 0o777) !== 0o600)) {
    throw new Error("Fresh-install config changed or has unsafe permissions");
  }
  const ownerStats = await assertRegularFile(plan.tokens.owner.path, "Fresh-install owner token");
  const connectorStats = await assertRegularFile(plan.tokens.connector.path, "Fresh-install connector token");
  if (process.platform === "win32") {
    await verifyWindowsOwnerOnlyFile(plan.tokens.owner.path);
    await verifyWindowsOwnerOnlyFile(plan.tokens.connector.path);
  }
  if (process.platform !== "win32" && ((ownerStats.mode & 0o777) !== 0o600 || (connectorStats.mode & 0o777) !== 0o600)) {
    throw new Error("Fresh-install token files must have exact owner-only permissions");
  }
  const [owner, connector] = await Promise.all([readFile(plan.tokens.owner.path), readFile(plan.tokens.connector.path)]);
  if (sha256Bytes(owner) !== bindings.ownerSha256 || sha256Bytes(connector) !== bindings.connectorSha256
    || owner.length < 43 || connector.length < 43 || secretBuffersEqual(owner, connector)) {
    throw new Error("Fresh-install owner and connector credentials are invalid or not independent");
  }
  const config = JSON.parse(await readFile(plan.config.path, "utf8"));
  if (pathKey(config.server?.authTokenFile) !== pathKey(plan.tokens.owner.path)
    || pathKey(config.server?.connectorTokenFile) !== pathKey(plan.tokens.connector.path)
    || config.server?.authTokenEnv !== null || config.server?.connectorTokenEnv !== null) {
    throw new Error("Fresh-install config does not preserve separate owner and connector scopes");
  }
}

async function reconcileFreshConfigAndTokens(plan, bindings) {
  validateCredentialBindings(bindings);
  const expected = [
    { path: plan.tokens.owner.path, sha256: bindings.ownerSha256 },
    { path: plan.tokens.connector.path, sha256: bindings.connectorSha256 },
    { path: plan.config.path, sha256: plan.config.sha256 },
  ];
  const states = [];
  for (const item of expected) {
    const stats = await safeLstat(item.path);
    if (!stats) { states.push({ ...item, exists: false }); continue; }
    if (!stats.isFile() || stats.isSymbolicLink() || await sha256File(item.path) !== item.sha256
      || (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600)) {
      throw new Error("Fresh-install prepared credential/config recovery found target drift");
    }
    states.push({ ...item, exists: true });
  }
  if (states.every((item) => item.exists)) {
    await assertFreshConfigAndTokens(plan, bindings);
    return true;
  }
  for (const item of [...states].reverse()) if (item.exists) await removeOwnedFreshFile(item.path, { sha256: item.sha256 });
  return false;
}

function validateCredentialBindings(bindings) {
  if (!bindings || bindings.schemaVersion !== 1 || !SHA256_PATTERN.test(bindings.ownerSha256 ?? "")
    || !SHA256_PATTERN.test(bindings.connectorSha256 ?? "") || bindings.ownerSha256 === bindings.connectorSha256) {
    throw new Error("Fresh-install credential ownership bindings are invalid");
  }
}

async function rollbackFreshChildren(plan, journal, options) {
  const failures = [];
  if (journal.serviceManifestPath && await safeLstat(journal.serviceManifestPath)) {
    try {
      const serviceManifest = JSON.parse(await readFile(journal.serviceManifestPath, "utf8"));
      if (serviceManifest.status !== "rolled-back-after-error" && serviceManifest.status !== "uninstalled") {
        const uninstall = await createDaemonServiceUninstallPlan(journal.serviceManifestPath, { planId: `${plan.planId}-service-rollback` });
        await applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: options.commandRunner });
      }
      journal.steps.service = "rolled-back";
    } catch (error) { failures.push(sanitizedFailure("service", error)); }
  }
  if (failures.length === 0 && journal.componentManifestPath && await safeLstat(journal.componentManifestPath)) {
    try {
      const componentManifest = JSON.parse(await readFile(journal.componentManifestPath, "utf8"));
      if (componentManifest.status !== "rolled-back-after-error" && componentManifest.status !== "uninstalled") {
        const uninstall = await createInstallerUninstallPlan(journal.componentManifestPath, { planId: `${plan.planId}-components-rollback` });
        await applyInstallerUninstallPlan(uninstall, { approvedDigest: uninstall.digest });
      }
      journal.steps.components = "rolled-back";
    } catch (error) { failures.push(sanitizedFailure("components", error)); }
  }
  if (failures.length === 0 && (journal.steps.config === "applied" || journal.credentialBindings)) {
    try {
      if (journal.steps.config === "applied") await removeFreshConfigAndTokens(plan, journal.credentialBindings);
      else {
        const complete = await reconcileFreshConfigAndTokens(plan, journal.credentialBindings);
        if (complete) await removeFreshConfigAndTokens(plan, journal.credentialBindings);
      }
      journal.steps.config = "rolled-back";
    } catch (error) { failures.push(sanitizedFailure("config-tokens", error)); }
  }
  return failures;
}

async function removeFreshConfigAndTokens(plan, bindings = plan.credentialBindings, checkpoint) {
  validateCredentialBindings(bindings);
  const configStats = await safeLstat(plan.config.path);
  const connectorStats = await safeLstat(plan.tokens.connector.path);
  const ownerStats = await safeLstat(plan.tokens.owner.path);
  if (configStats) await assertOwnedFreshFile(plan.config.path, plan.config.sha256, "Fresh-install config");
  if (connectorStats) await assertOwnedFreshFile(plan.tokens.connector.path, bindings.connectorSha256, "Fresh-install connector token", { token: true });
  if (ownerStats) await assertOwnedFreshFile(plan.tokens.owner.path, bindings.ownerSha256, "Fresh-install owner token", { token: true });
  if (configStats) { await rm(plan.config.path); await checkpoint?.("config-removed"); }
  if (connectorStats) { await rm(plan.tokens.connector.path); await checkpoint?.("connector-token-removed"); }
  if (ownerStats) { await rm(plan.tokens.owner.path); await checkpoint?.("owner-token-removed"); }
}

async function assertOwnedFreshFile(path, expectedSha256, label, options = {}) {
  const stats = await assertRegularFile(path, label);
  if (process.platform === "win32") await verifyWindowsOwnerOnlyFile(path);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) throw new Error(`${label} mode changed before removal`);
  const bytes = await readFile(path);
  if (sha256Bytes(bytes) !== expectedSha256 || (options.token && (bytes.length < 43 || bytes.length > 256))) {
    throw new Error(`${label} changed before removal`);
  }
}

async function removeOwnedFreshFile(path, options) {
  await assertOwnedFreshFile(path, options.sha256, "Fresh-install owned file");
  await rm(path);
}

async function removeFreshCreatedFile(path, expectedBytes) {
  const stats = await safeLstat(path);
  if (!stats) return;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Fresh-install created target changed type during cleanup");
  const observed = await readFile(path);
  if (!secretBuffersEqual(observed, expectedBytes)) throw new Error("Fresh-install created target changed during cleanup");
  await rm(path);
}

async function removeOwnedTokenFile(path, expectedSha256) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) throw new Error("Fresh-install token ownership binding is invalid");
  const stats = await assertRegularFile(path, "Fresh-install token file");
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) throw new Error("Fresh-install token mode changed before removal");
  const bytes = await readFile(path);
  if (sha256Bytes(bytes) !== expectedSha256 || bytes.length < 43 || bytes.length > 256) throw new Error("Fresh-install token file changed before removal");
  await rm(path);
}

function freshInstallReceipt(plan, journal) {
  return {
    schemaVersion: 1,
    kind: "threadspan-fresh-install-receipt",
    status: "applied-pending-provider-and-host-activation",
    planId: plan.planId,
    digest: plan.digest,
    platform: plan.platform,
    sourceCommit: plan.provenance.sourceCommit,
    componentDigest: plan.componentChild.digest,
    serviceDigest: plan.serviceChild.digest,
    taskProtectionDigest: plan.taskProtection.digest,
    serviceStatus: journal.serviceStatus,
    providerEvidence: plan.providerEvidence,
    hostSurface: plan.hostSurfaceChild,
    credentialEvidence: {
      owner: { scope: plan.tokens.owner.scope, fileCreated: true, mode: "0600" },
      connector: { scope: plan.tokens.connector.scope, fileCreated: true, mode: "0600" },
      valuesExposed: false,
    },
  };
}

async function replayFreshInstallReceipt(plan, journal) {
  assertJournalMatchesPlan(journal, plan);
  const expected = freshInstallReceipt(plan, journal);
  if (stableStringify(journal.terminalReceipt) !== stableStringify(expected)) throw new Error("Terminal fresh-install receipt is invalid");
  const activationSuccessor = await readProviderActivationSuccessor(plan);
  if (activationSuccessor?.status === "blocked" && activationSuccessor.rollbackComplete === false) {
    throw new Error("Fresh-install replay found an incomplete provider-activation rollback");
  }
  const effectiveConfigSha256 = activationSuccessor?.status === "ready" ? activationSuccessor.configSha256 : plan.config.sha256;
  await assertFreshConfigAndTokens(plan, journal.credentialBindings, effectiveConfigSha256);
  await validateInstallerAppliedState(plan.componentChild.plan);
  await validateDaemonServiceAppliedState(plan.serviceChild.plan);
  return journal.terminalReceipt;
}

function freshUninstallReceipt(plan) {
  return {
    schemaVersion: 1,
    kind: "threadspan-fresh-uninstall-receipt",
    status: "uninstalled",
    planId: plan.planId,
    digest: plan.digest,
    installPlanId: plan.installPlanId,
    installPlanDigest: plan.installPlanDigest,
    children: ["service", "components", "config", "connector-token", "owner-token"],
    credentialsExposed: false,
  };
}

async function replayFreshUninstallReceipt(plan, journal, options) {
  const expected = freshUninstallReceipt(plan);
  if (journal.terminalUninstallPlanDigest !== plan.digest
    || stableStringify(journal.terminalUninstallReceipt) !== stableStringify(expected)) {
    throw new Error("Terminal fresh-uninstall receipt is invalid");
  }
  await applyDaemonServiceUninstallPlan(plan.serviceChild.plan, {
    approvedDigest: plan.serviceChild.digest,
    commandRunner: options.commandRunner,
  });
  await applyInstallerUninstallPlan(plan.componentChild.plan, { approvedDigest: plan.componentChild.digest });
  for (const path of [plan.config.path, plan.tokens.owner.path, plan.tokens.connector.path]) {
    if (await safeLstat(path)) throw new Error("Terminal fresh-uninstall target was recreated");
  }
  return journal.terminalUninstallReceipt;
}

async function acquireFreshClaim(plan, options, operation) {
  const root = resolveFreshClaimRoot(options);
  await assertSafeAbsolutePath(root, { directoryTarget: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertSafeAbsolutePath(root, { directoryTarget: true });
  const path = resolve(root, ".fresh-install.claim.json");
  const content = `${JSON.stringify({
    schemaVersion: 1,
    kind: "threadspan-fresh-install-claim",
    operation,
    planId: plan.planId,
    planDigest: plan.digest,
    processId: process.pid,
    nonce: secureRandomBytes(32).toString("hex"),
  })}\n`;
  try {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    return { path, content };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const bytes = await readFile(path);
    const claimDigest = sha256Bytes(bytes);
    if (options.recoverClaimDigest !== claimDigest) {
      const conflict = new Error(`Another fresh-install mutation owns the claim; recovery digest ${claimDigest}`);
      conflict.claimDigest = claimDigest;
      throw conflict;
    }
    const existing = JSON.parse(bytes.toString("utf8"));
    if (!existing || existing.schemaVersion !== 1 || existing.kind !== "threadspan-fresh-install-claim"
      || existing.operation !== operation || existing.planId !== plan.planId || existing.planDigest !== plan.digest
      || !Number.isInteger(existing.processId) || existing.processId <= 0 || !/^[0-9a-f]{64}$/.test(existing.nonce ?? "")) {
      throw new Error("Existing fresh-install claim is malformed or belongs to another transaction");
    }
    if (isProcessAlive(existing.processId)) throw new Error("Refusing to recover a fresh-install claim owned by a live process");
    const history = resolve(root, "claim-history");
    await mkdir(history, { recursive: true, mode: 0o700 });
    const destination = resolve(history, `${claimDigest}.json`);
    if (await safeLstat(destination)) throw new Error("Fresh-install claim recovery evidence already exists");
    if (sha256Bytes(await readFile(path)) !== claimDigest) throw new Error("Fresh-install claim changed during recovery");
    await rename(path, destination);
    return acquireFreshClaim(plan, { ...options, recoverClaimDigest: undefined }, operation);
  }
}

/** Resolve the canonical current-user fresh-install claim namespace. */
export function resolveFreshInstallClaimRoot() {
  return resolve(userInfo().homedir, ".threadspan", "state", "fresh-install-claims");
}

function resolveFreshClaimRoot(options) {
  if (options.commandRunner || options.randomBytes || options.checkpoint || options.componentCheckpoint || options.uninstallCheckpoint || options.serviceCheckpoint || options.componentUninstallCheckpoint) {
    if (!process.env.NODE_TEST_CONTEXT) throw new Error("Fresh-install test claim root is unavailable outside the Node test harness");
    return resolve(tmpdir(), `threadspan-fresh-test-claims-${process.pid}`);
  }
  return resolveFreshInstallClaimRoot();
}

async function releaseFreshClaim(claim) {
  const observed = await readFile(claim.path, "utf8");
  if (observed !== claim.content) throw new Error("Fresh-install claim identity changed before release");
  await rm(claim.path);
}

async function freshCheckpoint(options, stage) {
  if (typeof options.checkpoint !== "function") return;
  await options.checkpoint(stage);
}

function assertFreshTestHooks(options) {
  if ((options.commandRunner || options.randomBytes || options.checkpoint || options.componentCheckpoint || options.uninstallCheckpoint || options.serviceCheckpoint || options.componentUninstallCheckpoint) && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("Fresh-install injected runners and hooks are restricted to the offline Node test harness");
  }
}

async function assertFreshTargetsAbsent(paths) {
  for (const path of paths) {
    await assertSafeAbsolutePath(path);
    if (await safeLstat(path)) throw new Error(`Fresh install refuses existing target: ${path}`);
  }
}

async function assertSafeAbsolutePath(path, options = {}) {
  const target = resolve(path);
  const end = options.directoryTarget ? target : dirname(target);
  const root = resolve(target, sep);
  const offset = relative(root, end);
  let cursor = root;
  for (const part of offset.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const stats = await safeLstat(cursor);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Refusing fresh-install path through symbolic link: ${cursor}`);
    if (!stats.isDirectory()) throw new Error(`Fresh-install parent is not a directory: ${cursor}`);
  }
}

async function writeExclusive(path, content, mode) {
  await assertSafeAbsolutePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeAbsolutePath(path);
  const handle = await open(path, "wx", mode);
  try { await handle.writeFile(content); } finally { await handle.close(); }
  if (process.platform === "win32") await hardenWindowsOwnerOnlyFile(path);
  else await chmod(path, mode);
  const stats = await assertRegularFile(path, "Fresh-install output");
  if (process.platform !== "win32" && (stats.mode & 0o777) !== mode) throw new Error("Fresh-install output permissions are not exact");
}

async function writeJsonExclusive(path, value, mode) {
  assertNoSecretMaterial(value);
  await writeExclusive(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function writeJsonAtomic(path, value, mode) {
  assertNoSecretMaterial(value);
  await assertSafeAbsolutePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${secureRandomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode });
    if (process.platform === "win32") await hardenWindowsOwnerOnlyFile(temporary);
    else await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function hardenWindowsOwnerOnlyFile(path) {
  const script = String.raw`param([string]$Path)
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Path -AclObject $acl
$verified = Get-Acl -LiteralPath $Path
$rules = @($verified.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
if ($verified.Owner -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { exit 23 }`;
  try {
    await runInstallerCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path], {
      timeoutMs: 30_000,
      maxBuffer: 4096,
      maxStderrBytes: 4096,
    });
  } catch {
    throw new Error("Windows owner-only ACL hardening failed");
  }
}

async function verifyWindowsOwnerOnlyFile(path) {
  const script = String.raw`param([string]$Path)
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $Path
$rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
if ($acl.Owner -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { exit 23 }`;
  try {
    await runInstallerCommand("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path], {
      timeoutMs: 30_000,
      maxBuffer: 4096,
      maxStderrBytes: 4096,
    });
  } catch {
    throw new Error("Windows owner-only ACL verification failed");
  }
}

function assertNoSecretMaterial(value) {
  const text = JSON.stringify(value);
  if (/\b(?:ownerToken|connectorToken|tokenValue|credentialValue|authorization)\b/i.test(text)) {
    throw new Error("Fresh-install durable state contains a prohibited credential field");
  }
}

async function assertRegularFile(path, label) {
  await assertSafeAbsolutePath(path);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  return stats;
}

async function safeLstat(path) {
  return lstat(path).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error));
}

async function sha256File(path) { return sha256Bytes(await readFile(path)); }
function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function digestObject(value) { return sha256Bytes(Buffer.from(stableStringify(value), "utf8")); }

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

function normalizeIds(values, pattern, label) {
  if (!Array.isArray(values)) throw new TypeError(`${label}Ids must be an array`);
  const ids = [...new Set(values.map(String))];
  const invalid = ids.find((id) => !pattern.test(id));
  if (invalid) throw new TypeError(`Invalid ${label} id '${invalid}'`);
  return ids;
}

function normalizeId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`${label} contains unsupported characters`);
  return value;
}

function resolveRequiredAbsolute(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError(`${label} is required`);
  return resolve(value);
}

function assertDistinctPathStrings(left, right, message) {
  if (pathKey(left) === pathKey(right)) throw new Error(message);
}

function pathKey(path) {
  const normalized = resolve(String(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isOfficialRemote(value) {
  return new Set([
    "https://github.com/HaileyStorm/threadspan.git",
    "https://github.com/HaileyStorm/threadspan",
    "git@github.com:HaileyStorm/threadspan.git",
    "ssh://git@github.com/HaileyStorm/threadspan.git",
  ]).has(value);
}

function secretBuffersEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function sanitizedFailure(child, error) {
  return { child, code: error instanceof AggregateError ? "rollback-incomplete" : "operation-failed" };
}

function isProcessAlive(processId) {
  try { process.kill(processId, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function throwIfFreshAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Fresh-install operation aborted");
}
