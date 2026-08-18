import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir, userInfo } from "node:os";
import {
  CODEX_FULL_ACCESS_TRANSFORM_ID,
  decodeCodexConfig,
  resolveCodexUserConfigPath,
  transformCodexFullAccessConfig,
} from "../codex/execution-policy.mjs";
import { computePlanDigest } from "./components.mjs";
import { DAEMON_SERVICE_LIFECYCLE_API_VERSION, validateDaemonLifecycleCommands, validateDaemonServicePlan } from "./service.mjs";

const SERVICE_PENDING_RUNTIME_STATUS = "applied-pending-runtime-ownership";
const LIFECYCLE_COMMAND_TIMEOUT_MS = 20_000;

/** Resolve the production claim namespace from the OS account database, not HOME/USERPROFILE. */
export function resolveDaemonServiceClaimRoot() {
  return resolve(userInfo().homedir, ".threadspan", "state", "service-lifecycle-claims");
}

/**
 * Render the exact write, backup, rollback-manifest, and prerequisite plan.
 * The returned digest is the approval token required by applyInstallerPlan.
 * @param {Record<string, any>} plan Installer plan.
 * @returns {{digest:string, text:string}}
 */
export function previewInstallerPlan(plan) {
  validatePlan(plan);
  const lines = [
    `Threadspan ${plan.kind} plan ${plan.planId}`,
    `Root: ${plan.installRoot}`,
    `Rollback manifest: ${plan.rollbackManifest}`,
    `Backup root: ${plan.backupRoot}`,
    "Prerequisites:",
    ...plan.prerequisites.map((item) => `  [${item.state}] ${item.component}: ${item.message}`),
    "Writes:",
    ...plan.operations.flatMap((operation) => previewOperation(operation)),
    "Unchanged:",
    ...(plan.unchanged ?? []).flatMap((item) => previewUnchanged(item)),
    `Approval digest: ${plan.digest}`,
  ];
  return { digest: plan.digest, text: `${lines.join("\n")}\n` };
}

function previewUnchanged(item) {
  return [
    `  ${item.component}: ${item.targetPath ?? item.relativePath} (${item.reason})`,
    ...(item.conflicts ?? []).map((conflict) => `    Residual conflict: ${conflict.table}.${conflict.setting} (${conflict.kind}) remains unchanged`),
  ];
}

function previewOperation(operation) {
  if (operation.operationKind !== "codex-config-transform") {
    return [`  ${operation.component}: ${operation.relativePath}`];
  }
  return [
    `  ${operation.component}: ${operation.targetPath} (${operation.transformId})`,
    `    Settings: ${operation.preview.settings.join("; ")}`,
    `    Effect: ${operation.preview.effect}`,
    `    Does not: ${operation.preview.exclusions.join("; ")}`,
    ...(operation.conflicts ?? []).map((conflict) => `    Residual conflict: ${conflict.table}.${conflict.setting} (${conflict.kind}) remains unchanged`),
  ];
}

/**
 * Apply an approved installer plan with bounded paths, backups, atomic replacement,
 * a rollback manifest, and automatic restoration on partial failure.
 * @param {Record<string, any>} plan Installer plan returned by createInstallerPlan.
 * @param {{approvedDigest:string, environment?:NodeJS.ProcessEnv}} options Apply approval.
 * @returns {Promise<{planId:string, digest:string, manifestPath:string, backups:string[], written:string[]}>}
 */
export async function applyInstallerPlan(plan, options) {
  validatePlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Installer apply requires the digest from previewInstallerPlan");

  const root = await canonicalInstallRoot(plan.installRoot);
  const targets = plan.operations.map((operation) => resolveOperationTarget(root, operation, options));
  const manifestPath = boundedPath(root, plan.rollbackManifest);
  const backupRoot = boundedPath(root, plan.backupRoot);
  assertDistinctTargets(targets.map(({ path }) => path));
  await assertSafeTarget(root, manifestPath);
  await assertSafeTarget(root, backupRoot, { directoryTarget: true });
  if (await safeLstat(manifestPath)) throw new Error(`Installer plan id already has a rollback manifest: ${plan.planId}`);
  if (await safeLstat(backupRoot)) throw new Error(`Installer plan id already has a backup directory: ${plan.planId}`);

  const entries = [];
  const preimages = new Map();
  for (const { operation, path } of targets) {
    if (operation.operationKind === "codex-config-transform") await assertSafeCodexTarget(path);
    const existing = await safeLstat(path);
    const displayTarget = operation.targetPath ?? operation.relativePath;
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${displayTarget}`);
    if (existing && !existing.isFile()) throw new Error(`Installer target is not a regular file: ${displayTarget}`);
    if (operation.operationKind !== "codex-config-transform") await assertSafeTarget(root, path);
    const currentBytes = existing ? await readFile(path) : Buffer.alloc(0);
    const originalSha256 = existing ? sha256Bytes(currentBytes) : null;
    const originalMode = existing ? existing.mode & 0o777 : null;
    if (operation.operationKind === "codex-config-transform") {
      assertCodexPreimage(operation, { existing, originalSha256, originalMode });
      const transformed = transformCodexFullAccessConfig(decodeCodexConfig(currentBytes));
      if (transformed.contentSha256 !== operation.expectedNextSha256) {
        throw new Error("Codex user config transform result changed after preview; create and approve a fresh plan");
      }
      preimages.set(displayTarget, currentBytes);
    }
    const backupRelativePath = existing
      ? operation.operationKind === "codex-config-transform"
        ? `${plan.backupRoot}/external/codex-user-config.toml`
        : `${plan.backupRoot}/${operation.relativePath}`
      : undefined;
    entries.push({
      component: operation.component,
      target: displayTarget,
      ...(operation.operationKind === "codex-config-transform" ? {
        targetKind: "codex-user-config",
        transformId: operation.transformId,
        expectedNextSha256: operation.expectedNextSha256,
        originalMode,
        conflicts: operation.conflicts ?? [],
      } : {}),
      existed: Boolean(existing),
      ...(existing ? { originalSha256 } : {}),
      ...(backupRelativePath ? { backup: backupRelativePath } : {}),
    });
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.existed) continue;
    const destination = boundedPath(root, entry.backup);
    await assertSafeTarget(root, destination);
    if (entry.targetKind === "codex-user-config") await atomicWrite(destination, preimages.get(entry.target), 0o600, { strictMode: true });
    else await atomicCopy(boundedPath(root, entry.target), destination);
    backups.push(destination);
  }

  const manifest = {
    schemaVersion: 1,
    planId: plan.planId,
    planDigest: plan.digest,
    installRoot: root,
    status: "prepared",
    entries,
  };
  await atomicJsonWrite(manifestPath, manifest, 0o600);

  const written = [];
  try {
    for (const { operation, path } of targets) {
      const target = operation.targetPath ?? operation.relativePath;
      const entry = entries.find((candidate) => candidate.target === target);
      const content = operation.operationKind === "codex-config-transform"
        ? await materializeCodexTransform(path, operation, entry)
        : operation.content;
      if (operation.operationKind !== "codex-config-transform") await assertTargetUnchanged(path, entry);
      await atomicWrite(path, content, operation.mode, operation.operationKind === "codex-config-transform"
        ? { strictMode: true, beforeRename: async () => { await materializeCodexTransform(path, operation, entry); } }
        : {});
      written.push(path);
    }
    manifest.status = "applied";
    await atomicJsonWrite(manifestPath, manifest, 0o600);
  } catch (error) {
    const writtenTargets = new Set(written);
    const rollbackErrors = await restoreEntries(root, entries.filter((entry) => writtenTargets.has(resolveEntryTarget(root, entry))));
    manifest.status = rollbackErrors.length === 0 ? "rolled-back-after-error" : "rollback-incomplete";
    manifest.error = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) manifest.rollbackErrors = rollbackErrors;
    await atomicJsonWrite(manifestPath, manifest, 0o600).catch(() => undefined);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error], `Installer apply failed and rollback was incomplete for: ${rollbackErrors.map((item) => item.target).join(", ")}`);
    }
    throw error;
  }

  return { planId: plan.planId, digest: plan.digest, manifestPath, backups, written };
}

/** Render the exact service lifecycle files and command phases covered by its approval digest. */
export function previewDaemonServicePlan(plan) {
  validateDaemonServicePlan(plan);
  const lines = [
    `Threadspan service lifecycle plan ${plan.planId}`,
    `Platform: ${plan.platform} (${plan.lifecycleKind})`,
    `Source revision: ${plan.source.revision}`,
    `CLI SHA-256: ${plan.source.cliSha256}`,
    `Owner fingerprint: ${plan.ownerFingerprint}`,
    `Environment names: ${plan.environmentVariables.join(", ") || "none"}`,
    `Prerequisite: ${plan.note}`,
    "Files:",
    ...plan.files.map((file) => `  ${file.role}: ${file.path} (${sha256Bytes(Buffer.from(file.content, "utf8"))})`),
    "Commands:",
    ...["inspect", "activate", "verify", "recover", "deactivate", "verifyAbsent", "finalize"].flatMap((phase) => [
      `  ${phase}:`,
      ...plan.commands[phase].map((command) => `    ${command.id}: ${command.argv.map(renderArgument).join(" ")} expectation=${stableStringify(command.expectation)}`),
    ]),
    `Approval digest: ${plan.digest}`,
  ];
  return { digest: plan.digest, text: `${lines.join("\n")}\n` };
}

/**
 * Apply an approved daemon/Desktop-host lifecycle plan using an injectable shell-free runner.
 * The returned receipt intentionally excludes account identity, command output, environment
 * values, absolute paths, PIDs, ports, and private runtime telemetry.
 */
export async function applyDaemonServicePlan(plan, options) {
  validateDaemonServicePlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Daemon lifecycle apply requires the digest from previewDaemonServicePlan");
  assertLifecycleRunnerPolicy(options);
  const claimRoot = resolveLifecycleClaimRoot(options);
  await assertAbsoluteTargetSafe(claimRoot, { directoryTarget: true });
  await mkdir(claimRoot, { recursive: true, mode: 0o700 });
  const claim = await acquireLifecycleClaim(claimRoot, { operation: "apply", planId: plan.planId, digest: plan.digest, lifecycleDigest: plan.digest }, options.recoverClaimDigest);
  try {
    return await applyDaemonServicePlanClaimed(plan, options);
  } finally {
    await releaseLifecycleClaim(claim);
  }
}

async function applyDaemonServicePlanClaimed(plan, options) {
  validateDaemonServicePlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Daemon lifecycle apply requires the digest from previewDaemonServicePlan");
  if (await sha256File(plan.source.cliPath) !== plan.source.cliSha256) {
    throw new Error("Daemon lifecycle source changed after preview; create and approve a fresh plan");
  }
  const rawCommandRunner = options.commandRunner ?? defaultLifecycleCommandRunner;
  const runCommand = bindLifecycleCommandRunner(rawCommandRunner, options.signal);
  const recoveryCommand = bindLifecycleCommandRunner(rawCommandRunner, undefined);
  await validateLegacyStartupAbsent(plan);
  const stateRoot = resolve(plan.stateRoot);
  await assertAbsoluteTargetSafe(stateRoot, { directoryTarget: true });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const backupRoot = resolve(stateRoot, "backups", plan.planId);
  const manifestPath = resolve(stateRoot, "manifests", `${plan.planId}.json`);
  await assertAbsoluteTargetSafe(backupRoot, { directoryTarget: true });
  await assertAbsoluteTargetSafe(manifestPath);
  const existingManifest = await safeLstat(manifestPath);
  if (existingManifest) {
    if (!existingManifest.isFile() || existingManifest.isSymbolicLink()) throw new Error("Daemon lifecycle manifest is not a regular file");
    const manifest = parseLifecycleManifest(await readFile(manifestPath));
    return resumeDaemonServiceApplication(plan, options, runCommand, recoveryCommand, manifest, manifestPath);
  }
  await validateLifecycleTargets(plan);
  await inspectLifecycleOwnership(plan, runCommand, { expected: "absent" });
  if (await safeLstat(backupRoot)) throw new Error(`Daemon lifecycle plan id already has a backup directory: ${plan.planId}`);

  const entries = [];
  for (const [index, file] of plan.files.entries()) {
    const stats = await safeLstat(file.path);
    const bytes = stats ? await readFile(file.path) : Buffer.alloc(0);
    entries.push({
      role: file.role,
      target: file.path,
      existed: Boolean(stats),
      originalSha256: stats ? sha256Bytes(bytes) : null,
      originalMode: stats ? stats.mode & 0o777 : null,
      backup: stats ? resolve(backupRoot, `${index}.preimage`) : null,
      installedSha256: sha256Bytes(Buffer.from(file.content, "utf8")),
      installedMode: file.mode,
    });
  }
  for (const entry of entries) {
    if (!entry.existed) continue;
    await atomicCopy(entry.target, entry.backup);
  }

  const manifest = {
    apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
    schemaVersion: 1,
    kind: "threadspan-service-lifecycle-manifest",
    planId: plan.planId,
    planDigest: plan.digest,
    platform: plan.platform,
    sourceRevision: plan.source.revision,
    ownerFingerprint: plan.ownerFingerprint,
    evidenceClass: "service-registration-and-loopback-health-only",
    runtimeOwnershipVerified: false,
    stateRoot,
    status: "prepared",
    entries,
    commands: plan.commands,
  };
  await atomicJsonWrite(manifestPath, manifest, 0o600);

  const written = [];
  const commandReceipts = [];
  let activationOwnershipBegan = false;
  try {
    for (const file of plan.files) {
      const entry = entries.find((candidate) => candidate.target === file.path);
      await assertLifecycleTargetUnchanged(file, entry);
      await atomicWrite(file.path, file.content, file.mode, { strictMode: true });
      written.push(file.path);
      await lifecycleCheckpoint(options, `file-written:${file.role}`);
    }
    manifest.status = "activating";
    await atomicJsonWrite(manifestPath, manifest, 0o600);
    await lifecycleCheckpoint(options, "activation-ownership-began");
    activationOwnershipBegan = true;
    commandReceipts.push(...await runLifecyclePhase(plan.commands.activate, runCommand, "activate"));
    await lifecycleCheckpoint(options, "activation-complete");
    commandReceipts.push(...await runLifecyclePhase(plan.commands.verify, runCommand, "verify"));
    await inspectLifecycleOwnershipStable(plan, runCommand);
    manifest.status = SERVICE_PENDING_RUNTIME_STATUS;
    await atomicJsonWrite(manifestPath, manifest, 0o600);
  } catch (error) {
    if (error?.simulatedProcessExit === true) throw error;
    const rollbackCommandErrors = activationOwnershipBegan
      ? await runLifecyclePhase(plan.commands.deactivate, recoveryCommand, "rollback", { bestEffort: true })
      : { receipts: [], failures: [] };
    const rollbackVerificationErrors = activationOwnershipBegan
      ? await runLifecyclePhase(plan.commands.verifyAbsent, recoveryCommand, "rollback-verify-absent", { bestEffort: true })
      : { receipts: [], failures: [] };
    const commandFailures = [...rollbackCommandErrors.failures, ...rollbackVerificationErrors.failures];
    const rollbackErrors = commandFailures.length === 0
      ? await restoreLifecycleEntries(entries.filter((entry) => written.includes(entry.target)))
      : [];
    manifest.status = rollbackErrors.length === 0 && commandFailures.length === 0
      ? "rolled-back-after-error"
      : "rollback-incomplete";
    manifest.error = error instanceof Error ? error.message : String(error);
    if (rollbackErrors.length > 0) manifest.rollbackErrors = rollbackErrors;
    if (commandFailures.length > 0) manifest.rollbackCommandErrors = commandFailures;
    await atomicJsonWrite(manifestPath, manifest, 0o600).catch(() => undefined);
    if (manifest.status === "rollback-incomplete") throw new AggregateError([error], "Daemon lifecycle apply failed and rollback was incomplete");
    throw error;
  }

  return lifecycleReceipt(plan, SERVICE_PENDING_RUNTIME_STATUS, entries, commandReceipts);
}

/** Create a separately digest-bound uninstall plan from a completed local lifecycle manifest. */
export async function createDaemonServiceUninstallPlan(manifestPath, options = {}) {
  const resolvedManifest = resolve(manifestPath);
  const manifestStats = await lstat(resolvedManifest);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) throw new Error("Daemon lifecycle manifest must be a regular canonical file");
  const bytes = await readFile(resolvedManifest);
  const manifest = parseLifecycleManifest(bytes);
  const expectedManifestPath = resolve(manifest.stateRoot, "manifests", `${manifest.planId}.json`);
  if (await realpath(resolvedManifest) !== await realpath(expectedManifestPath)) throw new Error("Daemon lifecycle manifest is outside its canonical state root");
  if (![SERVICE_PENDING_RUNTIME_STATUS, "uninstalling", "uninstall-incomplete"].includes(manifest.status)) {
    throw new Error(`Daemon lifecycle manifest is not uninstallable or resumable while ${manifest.status}`);
  }
  const basePlan = {
    apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
    schemaVersion: 1,
    kind: "threadspan-service-uninstall",
    planId: normalizeUninstallPlanId(options.planId ?? `uninstall-${manifest.planId}`),
    manifestPath: resolvedManifest,
    stateRoot: manifest.stateRoot,
    manifestSha256: sha256Bytes(bytes),
    installPlanId: manifest.planId,
    installPlanDigest: manifest.planDigest,
    platform: manifest.platform,
    sourceRevision: manifest.sourceRevision,
    ownerFingerprint: manifest.ownerFingerprint,
    files: uninstallFilesFromManifest(manifest),
    commands: uninstallCommandsFromManifest(manifest),
  };
  return Object.freeze({ ...basePlan, digest: computeUninstallPlanDigest(basePlan) });
}

/** Render a service uninstall plan without exposing manifest contents or account-local telemetry. */
export function previewDaemonServiceUninstallPlan(plan) {
  validateUninstallPlan(plan);
  const files = plan.files.map((file) => `  ${file.role}: ${file.target} (installed ${file.installedSha256} mode ${file.installedMode.toString(8)}; original ${file.originalSha256 ?? "absent"})`);
  const commands = ["inspect", "deactivate", "verifyAbsent", "recover", "verify", "finalize"].flatMap((phase) => [
    `  ${phase}:`,
    ...plan.commands[phase].map((command) => `    ${command.id}: ${command.argv.map(renderArgument).join(" ")} expectation=${stableStringify(command.expectation)}`),
  ]);
  return {
    digest: plan.digest,
    text: `Threadspan service uninstall plan ${plan.planId}\nInstall plan: ${plan.installPlanId}\nPlatform: ${plan.platform}\nSource revision: ${plan.sourceRevision}\nFiles:\n${files.join("\n")}\nCommands:\n${commands.join("\n")}\nApproval digest: ${plan.digest}\n`,
  };
}

/** Apply a digest-bound service uninstall, restoring every exact preimage recorded at install. */
export async function applyDaemonServiceUninstallPlan(plan, options) {
  validateUninstallPlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Daemon lifecycle uninstall requires the digest from previewDaemonServiceUninstallPlan");
  assertLifecycleRunnerPolicy(options);
  const terminalReceipt = await readTerminalUninstallReceipt(plan);
  if (terminalReceipt) return terminalReceipt;
  const claimRoot = resolveLifecycleClaimRoot(options);
  await assertAbsoluteTargetSafe(claimRoot, { directoryTarget: true });
  await mkdir(claimRoot, { recursive: true, mode: 0o700 });
  const claim = await acquireLifecycleClaim(claimRoot, { operation: "uninstall", planId: plan.installPlanId, digest: plan.digest, lifecycleDigest: plan.installPlanDigest }, options.recoverClaimDigest);
  try {
    return await applyDaemonServiceUninstallPlanClaimed(plan, options);
  } finally {
    await releaseLifecycleClaim(claim);
  }
}

async function applyDaemonServiceUninstallPlanClaimed(plan, options) {
  validateUninstallPlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Daemon lifecycle uninstall requires the digest from previewDaemonServiceUninstallPlan");
  const manifestBytes = await readFile(plan.manifestPath);
  if (sha256Bytes(manifestBytes) !== plan.manifestSha256) throw new Error("Daemon lifecycle manifest changed after uninstall preview");
  const manifest = parseLifecycleManifest(manifestBytes);
  const expectedManifestPath = resolve(manifest.stateRoot, "manifests", `${manifest.planId}.json`);
  if (resolve(plan.manifestPath) !== expectedManifestPath || resolve(plan.stateRoot) !== resolve(manifest.stateRoot)) {
    throw new Error("Daemon lifecycle uninstall manifest path or state root is not canonical");
  }
  if (![SERVICE_PENDING_RUNTIME_STATUS, "uninstalling", "uninstall-incomplete"].includes(manifest.status)
    || manifest.planDigest !== plan.installPlanDigest || manifest.ownerFingerprint !== plan.ownerFingerprint) {
    throw new Error("Daemon lifecycle uninstall manifest does not match the approved plan");
  }
  const expectedProjection = {
    installPlanId: manifest.planId,
    platform: manifest.platform,
    sourceRevision: manifest.sourceRevision,
    ownerFingerprint: manifest.ownerFingerprint,
    stateRoot: manifest.stateRoot,
    files: uninstallFilesFromManifest(manifest),
    commands: uninstallCommandsFromManifest(manifest),
  };
  const observedProjection = {
    installPlanId: plan.installPlanId,
    platform: plan.platform,
    sourceRevision: plan.sourceRevision,
    ownerFingerprint: plan.ownerFingerprint,
    stateRoot: plan.stateRoot,
    files: plan.files,
    commands: plan.commands,
  };
  if (stableStringify(observedProjection) !== stableStringify(expectedProjection)) {
    throw new Error("Daemon lifecycle uninstall operations differ from the approved preview");
  }
  const rawCommandRunner = options.commandRunner ?? defaultLifecycleCommandRunner;
  const runCommand = bindLifecycleCommandRunner(rawCommandRunner, options.signal);
  const recoveryCommand = bindLifecycleCommandRunner(rawCommandRunner, undefined);
  const ownershipPlan = {
    source: { revision: manifest.sourceRevision },
    ownerFingerprint: manifest.ownerFingerprint,
    commands: manifest.commands,
  };
  const ownership = await inspectLifecycleOwnership(ownershipPlan, runCommand, { expected: manifest.status === SERVICE_PENDING_RUNTIME_STATUS ? "present" : "any" });
  await validateLifecycleUninstallEntries(manifest.entries, { allowRestored: manifest.status !== SERVICE_PENDING_RUNTIME_STATUS });
  manifest.status = "uninstalling";
  await atomicJsonWrite(plan.manifestPath, manifest, 0o600);
  await lifecycleCheckpoint(options, "uninstalling-persisted");
  const uninstallCommandReceipts = [];

  try {
    if (ownership.some((item) => item.exists)) uninstallCommandReceipts.push(...await runLifecyclePhase(manifest.commands.deactivate, runCommand, "deactivate"));
    uninstallCommandReceipts.push(...await runLifecyclePhase(manifest.commands.verifyAbsent, runCommand, "verify-absent"));
  } catch (error) {
    const recovery = await runLifecyclePhase(manifest.commands.recover, recoveryCommand, "uninstall-rollback", { bestEffort: true });
    const recoveryVerification = await runLifecyclePhase(manifest.commands.verify, recoveryCommand, "uninstall-rollback-verify", { bestEffort: true });
    const failures = [...recovery.failures, ...recoveryVerification.failures];
    manifest.status = failures.length === 0 ? SERVICE_PENDING_RUNTIME_STATUS : "uninstall-rollback-incomplete";
    manifest.lastUninstallError = error instanceof Error ? error.message : String(error);
    if (failures.length > 0) manifest.uninstallRollbackErrors = failures;
    try {
      await atomicJsonWrite(plan.manifestPath, manifest, 0o600);
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], "Daemon lifecycle uninstall failed and its recovery status could not be persisted");
    }
    if (failures.length > 0) throw new AggregateError([error], "Daemon lifecycle uninstall failed and recovery was incomplete");
    throw error;
  }
  const restoreErrors = await restoreLifecycleEntries(manifest.entries, { verifyInstalled: true, verifyBackup: true, idempotent: true });
  if (restoreErrors.length > 0) {
    manifest.status = "uninstall-incomplete";
    manifest.uninstallErrors = restoreErrors;
    await atomicJsonWrite(plan.manifestPath, manifest, 0o600).catch(() => undefined);
    throw new AggregateError([], `Daemon lifecycle uninstall could not restore: ${restoreErrors.map((item) => item.role).join(", ")}`);
  }
  await lifecycleCheckpoint(options, "uninstall-files-restored");
  try {
    uninstallCommandReceipts.push(...await runLifecyclePhase(manifest.commands.finalize, runCommand, "finalize"));
  } catch (error) {
    manifest.status = "uninstall-incomplete";
    manifest.uninstallErrors = [{ role: "service-manager", message: error instanceof Error ? error.message : String(error) }];
    await atomicJsonWrite(plan.manifestPath, manifest, 0o600);
    throw error;
  }
  const receipt = lifecycleUninstallReceipt(plan, manifest, uninstallCommandReceipts);
  manifest.status = "uninstalled";
  manifest.terminalUninstallReceipt = receipt;
  await atomicJsonWrite(plan.manifestPath, manifest, 0o600);
  await lifecycleCheckpoint(options, "uninstall-terminal-persisted");
  return receipt;
}

/**
 * Resolve a path under root and reject absolute, empty, or escaping relative paths.
 * @param {string} root Canonical root.
 * @param {string} relativePath Product-local relative path.
 * @returns {string}
 */
export function boundedPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error(`Unsafe installer path '${String(relativePath)}'`);
  }
  const target = resolve(root, relativePath);
  const offset = relative(root, target);
  if (!offset || offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error(`Installer path escapes root: ${relativePath}`);
  return target;
}

function resolveOperationTarget(root, operation, options) {
  if (operation.operationKind !== "codex-config-transform") {
    return { operation, path: boundedPath(root, operation.relativePath) };
  }
  const currentPath = resolveCodexUserConfigPath({ environment: options.environment });
  if (currentPath !== operation.targetPath) {
    throw new Error("Selected host Codex user config path changed after preview; create and approve a fresh plan");
  }
  return { operation, path: currentPath };
}

function validatePlan(plan) {
  if (!plan || plan.kind !== "install" || !Array.isArray(plan.operations) || !Array.isArray(plan.prerequisites)) {
    throw new TypeError("Invalid installer plan");
  }
  if (computePlanDigest(plan) !== plan.digest) throw new Error("Installer plan integrity check failed");
  for (const operation of plan.operations) {
    if (typeof operation.component !== "string") throw new TypeError("Invalid installer operation");
    if (operation.operationKind === "codex-config-transform") {
      if (operation.component !== "codex-full-access"
        || operation.transformId !== CODEX_FULL_ACCESS_TRANSFORM_ID
        || typeof operation.targetPath !== "string"
        || !/^[0-9a-f]{64}$/.test(operation.expectedNextSha256)
        || !(operation.expectedPreimageSha256 === null || /^[0-9a-f]{64}$/.test(operation.expectedPreimageSha256))) {
        throw new TypeError("Invalid Codex config transform operation");
      }
    } else if (typeof operation.content !== "string" || typeof operation.relativePath !== "string") {
      throw new TypeError("Invalid installer operation");
    }
  }
}

async function canonicalInstallRoot(root) {
  const path = resolve(root);
  const stats = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`Install root does not exist: ${path}`);
    throw error;
  });
  if (!stats.isDirectory()) throw new Error(`Install root is not a directory: ${path}`);
  return realpath(path);
}

async function assertSafeTarget(root, target, options = {}) {
  const end = options.directoryTarget ? target : dirname(target);
  const offset = relative(root, end);
  const parts = offset ? offset.split(sep) : [];
  let cursor = root;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    const stats = await safeLstat(cursor);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Refusing installer path through symbolic link: ${cursor}`);
    if (!stats.isDirectory()) throw new Error(`Installer parent is not a directory: ${cursor}`);
  }
}

async function atomicWrite(path, content, mode = 0o600, options = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    if (options.strictMode) await chmod(temporary, mode);
    else await chmod(temporary, mode).catch(() => undefined);
    await options.beforeRename?.();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicJsonWrite(path, value, mode) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

async function atomicCopy(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreEntries(root, entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    const target = resolveEntryTarget(root, entry);
    try {
      if (entry.targetKind === "codex-user-config") await assertSafeCodexTarget(target);
      if (entry.existed) {
        const backup = boundedPath(root, entry.backup);
        if (entry.targetKind === "codex-user-config") {
          await atomicWrite(target, await readFile(backup), entry.originalMode, { strictMode: true });
        } else {
          await atomicCopy(backup, target);
        }
      } else {
        await rm(target, { force: true });
      }
    } catch (error) {
      errors.push({ target: entry.target, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors;
}

function resolveEntryTarget(root, entry) {
  return entry.targetKind === "codex-user-config" ? entry.target : boundedPath(root, entry.target);
}

async function assertSafeCodexTarget(path) {
  const parent = dirname(path);
  const parentStats = await safeLstat(parent);
  if (parentStats?.isSymbolicLink()) throw new Error(`Refusing Codex user config through symbolic-link parent: ${parent}`);
  if (parentStats && !parentStats.isDirectory()) throw new Error(`Codex user config parent is not a directory: ${parent}`);
  const targetStats = await safeLstat(path);
  if (targetStats?.isSymbolicLink()) throw new Error(`Refusing symbolic-link Codex user config: ${path}`);
  if (targetStats && !targetStats.isFile()) throw new Error(`Codex user config is not a regular file: ${path}`);
}

function assertCodexPreimage(operation, observed) {
  if (operation.expectedPreimageSha256 === null) {
    if (observed.existing) throw new Error("Codex user config appeared after preview; create and approve a fresh plan");
    return;
  }
  if (!observed.existing || observed.originalSha256 !== operation.expectedPreimageSha256) {
    throw new Error("Codex user config content changed after preview; create and approve a fresh plan");
  }
  if (process.platform !== "win32" && observed.originalMode !== operation.expectedMode) {
    throw new Error("Codex user config mode changed after preview; create and approve a fresh plan");
  }
}

async function materializeCodexTransform(path, operation, entry) {
  await assertSafeCodexTarget(path);
  const stats = await safeLstat(path);
  const bytes = stats ? await readFile(path) : Buffer.alloc(0);
  assertCodexPreimage(operation, {
    existing: stats,
    originalSha256: stats ? sha256Bytes(bytes) : null,
    originalMode: stats ? stats.mode & 0o777 : null,
  });
  const transformed = transformCodexFullAccessConfig(decodeCodexConfig(bytes));
  if (transformed.contentSha256 !== operation.expectedNextSha256) {
    throw new Error("Codex user config transform result changed after backup; create and approve a fresh plan");
  }
  if (entry.originalSha256 && sha256Bytes(bytes) !== entry.originalSha256) {
    throw new Error("Codex user config changed after backup; refusing to write");
  }
  return Buffer.from(transformed.content, "utf8");
}

async function safeLstat(path) {
  return lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
}

async function assertTargetUnchanged(path, entry) {
  const current = await safeLstat(path);
  if (!entry.existed) {
    if (current) throw new Error(`Installer target appeared after planning: ${entry.target}`);
    return;
  }
  if (!current?.isFile() || current.isSymbolicLink()) throw new Error(`Installer target changed type after backup: ${entry.target}`);
  if (await sha256File(path) !== entry.originalSha256) throw new Error(`Installer target changed after backup: ${entry.target}`);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDistinctTargets(paths) {
  if (new Set(paths).size !== paths.length) throw new Error("Installer plan contains duplicate targets");
}

async function resumeDaemonServiceApplication(plan, options, runCommand, recoveryCommand, manifest, manifestPath) {
  assertLifecycleManifestMatchesPlan(manifest, plan);
  if (manifest.status === SERVICE_PENDING_RUNTIME_STATUS) {
    await assertEntriesInState(manifest.entries, "installed");
    await inspectLifecycleOwnershipStable(plan, runCommand);
    const receipts = await runLifecyclePhase(plan.commands.verify, runCommand, "verify-resumed");
    return lifecycleReceipt(plan, SERVICE_PENDING_RUNTIME_STATUS, manifest.entries, receipts);
  }
  if (!["prepared", "activating"].includes(manifest.status)) {
    throw new Error(`Daemon lifecycle manifest cannot resume apply while ${manifest.status}`);
  }

  const states = await classifyLifecycleEntries(manifest.entries);
  if (states.some((item) => item.state === "drift")) {
    manifest.status = "rollback-incomplete";
    manifest.error = "Lifecycle target drift blocked prepared-state recovery";
    await atomicJsonWrite(manifestPath, manifest, 0o600);
    throw new Error("Prepared daemon lifecycle recovery found target drift");
  }
  const ownership = await inspectLifecycleOwnership(plan, runCommand, { expected: "any" });
  let activationOwnershipBegan = ownership.some((item) => item.exists);
  const receipts = [];
  try {
    for (const file of plan.files) {
      const entry = manifest.entries.find((candidate) => candidate.target === file.path);
      const state = states.find((candidate) => candidate.entry.target === file.path).state;
      if (state === "installed") continue;
      await atomicWrite(file.path, file.content, file.mode, { strictMode: true });
      await lifecycleCheckpoint(options, `file-written:${file.role}`);
    }
    manifest.status = "activating";
    await atomicJsonWrite(manifestPath, manifest, 0o600);
    await lifecycleCheckpoint(options, "activation-ownership-began");
    if (activationOwnershipBegan) receipts.push(...await runLifecyclePhase(plan.commands.recover, runCommand, "recover"));
    else {
      activationOwnershipBegan = true;
      receipts.push(...await runLifecyclePhase(plan.commands.activate, runCommand, "activate"));
    }
    await lifecycleCheckpoint(options, "activation-complete");
    receipts.push(...await runLifecyclePhase(plan.commands.verify, runCommand, "verify"));
    await inspectLifecycleOwnershipStable(plan, runCommand);
    manifest.status = SERVICE_PENDING_RUNTIME_STATUS;
    delete manifest.error;
    await atomicJsonWrite(manifestPath, manifest, 0o600);
    return lifecycleReceipt(plan, SERVICE_PENDING_RUNTIME_STATUS, manifest.entries, receipts);
  } catch (error) {
    if (error?.simulatedProcessExit === true) throw error;
    const rollback = activationOwnershipBegan
      ? await runLifecyclePhase(plan.commands.deactivate, recoveryCommand, "rollback", { bestEffort: true })
      : { failures: [] };
    const absence = activationOwnershipBegan
      ? await runLifecyclePhase(plan.commands.verifyAbsent, recoveryCommand, "rollback-verify-absent", { bestEffort: true })
      : { failures: [] };
    const failures = [...rollback.failures, ...absence.failures];
    const restoreErrors = failures.length === 0 ? await restoreLifecycleEntries(manifest.entries) : [];
    manifest.status = failures.length === 0 && restoreErrors.length === 0 ? "rolled-back-after-error" : "rollback-incomplete";
    manifest.error = error instanceof Error ? error.message : String(error);
    if (failures.length > 0) manifest.rollbackCommandErrors = failures;
    if (restoreErrors.length > 0) manifest.rollbackErrors = restoreErrors;
    await atomicJsonWrite(manifestPath, manifest, 0o600);
    if (manifest.status === "rollback-incomplete") throw new AggregateError([error], "Daemon lifecycle resume failed and rollback was incomplete");
    throw error;
  }
}

function assertLifecycleManifestMatchesPlan(manifest, plan) {
  const planEntries = plan.files.map((file) => ({ role: file.role, target: file.path, installedSha256: sha256Bytes(Buffer.from(file.content, "utf8")), installedMode: file.mode }));
  const manifestEntries = manifest.entries.map((entry) => ({ role: entry.role, target: entry.target, installedSha256: entry.installedSha256, installedMode: entry.installedMode }));
  if (manifest.planId !== plan.planId || manifest.planDigest !== plan.digest || manifest.platform !== plan.platform
    || manifest.sourceRevision !== plan.source.revision || manifest.ownerFingerprint !== plan.ownerFingerprint
    || stableStringify(manifest.commands) !== stableStringify(plan.commands)
    || stableStringify(manifestEntries) !== stableStringify(planEntries)) {
    throw new Error("Durable daemon lifecycle state does not match the approved plan");
  }
}

async function classifyLifecycleEntries(entries) {
  const results = [];
  for (const entry of entries) {
    await assertAbsoluteTargetSafe(entry.target);
    const stats = await safeLstat(entry.target);
    if (!stats) {
      results.push({ entry, state: entry.existed ? "drift" : "preimage" });
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      results.push({ entry, state: "drift" });
      continue;
    }
    const digest = await sha256File(entry.target);
    const mode = stats.mode & 0o777;
    if (digest === entry.installedSha256 && (process.platform === "win32" || mode === entry.installedMode)) results.push({ entry, state: "installed" });
    else if (entry.existed && digest === entry.originalSha256 && (process.platform === "win32" || mode === entry.originalMode)) results.push({ entry, state: "preimage" });
    else results.push({ entry, state: "drift" });
  }
  return results;
}

async function assertEntriesInState(entries, expected) {
  const states = await classifyLifecycleEntries(entries);
  if (states.some((item) => item.state !== expected)) throw new Error(`Daemon lifecycle files are not durably ${expected}`);
}

async function validateLifecycleTargets(plan) {
  const roots = plan.allowedWriteRoots.map((root) => resolve(root));
  for (const file of plan.files) {
    const target = resolve(file.path);
    if (!roots.some((root) => isPathInside(root, target))) throw new Error(`Lifecycle target is outside approved roots: ${file.role}`);
    await assertAbsoluteTargetSafe(target);
    const stats = await safeLstat(target);
    if (stats?.isSymbolicLink() || (stats && !stats.isFile())) throw new Error(`Lifecycle target is not a regular file: ${file.role}`);
    const observedSha256 = stats ? await sha256File(target) : null;
    const observedMode = stats ? stats.mode & 0o777 : null;
    if (observedSha256 !== file.expectedPreimageSha256 || (process.platform !== "win32" && observedMode !== file.expectedPreimageMode)) {
      throw new Error(`Lifecycle target changed after preview: ${file.role}`);
    }
    if (stats) {
      const content = await readFile(target, "utf8");
      const expectedMarker = lifecycleOwnershipFragment(plan);
      if (!content.includes(expectedMarker)) throw new Error(`Refusing stale or unowned lifecycle target: ${file.role}`);
      throw new Error(`Refusing duplicate lifecycle ownership: ${file.role}`);
    }
  }
}

async function validateLegacyStartupAbsent(plan) {
  if (plan.platform !== "win32") return;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("Native Windows APPDATA is unavailable during legacy Startup recheck");
    const canonical = resolve(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Threadspan.cmd");
    if (resolve(plan.legacyStartup.path).toLowerCase() !== canonical.toLowerCase()) {
      throw new Error("Native Windows legacy Startup binding changed from the current canonical APPDATA path");
    }
  }
  await assertAbsoluteTargetSafe(plan.legacyStartup.path);
  if (await safeLstat(plan.legacyStartup.path)) throw new Error("Published Windows Startup predecessor appeared after preview; refusing Task Scheduler apply");
}

async function assertLifecycleTargetUnchanged(file, entry) {
  const stats = await safeLstat(file.path);
  if (!entry.existed) {
    if (stats) throw new Error(`Lifecycle target appeared after backup: ${file.role}`);
    return;
  }
  if (!stats?.isFile() || stats.isSymbolicLink()) throw new Error(`Lifecycle target changed type after backup: ${file.role}`);
  if (await sha256File(file.path) !== entry.originalSha256) throw new Error(`Lifecycle target changed after backup: ${file.role}`);
}

async function inspectLifecycleOwnership(plan, runCommand, options) {
  const fragment = lifecycleOwnershipFragment(plan);
  const observations = [];
  for (const command of plan.commands.inspect) {
    const result = normalizeCommandResult(await runCommand(command.argv, { id: command.id, phase: "inspect" }));
    const absentExitCodes = command.expectation?.absentExitCodes ?? [];
    if (absentExitCodes.includes(result.exitCode)) {
      observations.push({ id: command.id, exists: false });
      continue;
    }
    if (result.exitCode !== 0) throw commandFailure(command, result, "inspect");
    const matches = countOccurrences(result.stdout, fragment);
    if (matches === 0) throw new Error(`Refusing stale lifecycle ownership reported by ${command.id}`);
    if (matches > 1) throw new Error(`Refusing duplicate lifecycle ownership reported by ${command.id}`);
    observations.push({ id: command.id, exists: true });
  }
  const existing = observations.filter((item) => item.exists);
  if (options.expected === "absent" && existing.length > 0) throw new Error(`Refusing duplicate lifecycle ownership: ${existing.map((item) => item.id).join(", ")}`);
  if (options.expected === "present" && existing.length !== observations.length) throw new Error("Lifecycle ownership is partial or stale; refusing mutation");
  return observations;
}

async function inspectLifecycleOwnershipStable(plan, runCommand) {
  await inspectLifecycleOwnership(plan, runCommand, { expected: "present" });
  if (!runCommand.skipStableDelay) await delay(250, runCommand.signal);
  await inspectLifecycleOwnership(plan, runCommand, { expected: "present" });
}

async function runLifecyclePhase(commands, runCommand, phase, options = {}) {
  const receipts = [];
  const failures = [];
  for (const command of commands) {
    try {
      const samples = command.expectation?.stableSamples ?? 1;
      if (!Number.isInteger(samples) || samples < 1 || samples > 5) throw new Error(`Invalid lifecycle stable sample count for ${command.id}`);
      for (let sample = 0; sample < samples; sample += 1) {
        if (sample > 0 && !runCommand.skipStableDelay) await delay(command.expectation?.stableIntervalMs ?? 250, runCommand.signal);
        const result = normalizeCommandResult(await runCommand(command.argv, { id: command.id, phase, sample: sample + 1, samples }));
        assertCommandExpectation(command, result, phase);
      }
      receipts.push({ id: command.id, phase, status: "verified" });
    } catch (error) {
      if (!options.bestEffort) throw error;
      failures.push({ id: command.id, phase, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (options.bestEffort) return { receipts, failures };
  return receipts;
}

async function acquireLifecycleClaim(stateRoot, identity, recoverClaimDigest) {
  const path = resolve(stateRoot, ".lifecycle.claim.json");
  await assertAbsoluteTargetSafe(path);
  const nonce = createHash("sha256").update(`${process.pid}\0${Date.now()}\0${Math.random()}\0${identity.digest}`).digest("hex");
  const content = `${JSON.stringify({ apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION, schemaVersion: 1, operation: identity.operation, planId: identity.planId, digest: identity.digest, lifecycleDigest: identity.lifecycleDigest, processId: process.pid, nonce })}\n`;
  return withLifecycleClaimGuard(stateRoot, recoverClaimDigest, async () => {
    const existingStats = await safeLstat(path);
    if (existingStats) {
      if (!existingStats.isFile() || existingStats.isSymbolicLink()) throw new Error("Existing daemon lifecycle claim is not a regular file");
      const existingBytes = await readFile(path);
      const existingDigest = sha256Bytes(existingBytes);
      if (recoverClaimDigest !== existingDigest) {
        const conflict = new Error(`Another host-local daemon lifecycle mutation owns the exclusive claim; recovery digest ${existingDigest}`);
        conflict.claimDigest = existingDigest;
        throw conflict;
      }
      const existing = JSON.parse(existingBytes.toString("utf8"));
      if (existing?.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || existing.schemaVersion !== 1
        || existing.operation !== identity.operation || existing.planId !== identity.planId
        || existing.digest !== identity.digest || existing.lifecycleDigest !== identity.lifecycleDigest
        || !Number.isInteger(existing.processId) || existing.processId <= 0
        || typeof existing.nonce !== "string" || !/^[0-9a-f]{64}$/.test(existing.nonce)) {
        throw new Error("Existing daemon lifecycle claim is malformed or belongs to another lifecycle");
      }
      if (isProcessAlive(existing.processId)) throw new Error("Refusing to recover a daemon lifecycle claim owned by a live local process");
      const historyRoot = resolve(stateRoot, "claim-history");
      await assertAbsoluteTargetSafe(historyRoot, { directoryTarget: true });
      await mkdir(historyRoot, { recursive: true, mode: 0o700 });
      const historyPath = resolve(historyRoot, `${existingDigest}.json`);
      await assertAbsoluteTargetSafe(historyPath);
      if (await safeLstat(historyPath)) throw new Error("Daemon lifecycle claim recovery evidence already exists");
      if (sha256Bytes(await readFile(path)) !== existingDigest) throw new Error("Daemon lifecycle claim changed during guarded recovery");
      await rename(path, historyPath);
    }
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(content, "utf8"); } finally { await handle.close(); }
    return { path, content, stateRoot };
  });
}

/** Read the exact sanitized digest needed for an explicit stale-claim recovery decision. */
export async function readDaemonServiceLifecycleClaim(stateRoot) {
  const claimPath = resolve(stateRoot, ".lifecycle.claim.json");
  const guardPath = resolve(stateRoot, ".lifecycle.claim.guard");
  const [claimBytes, guardBytes] = await Promise.all([
    readFile(claimPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error)),
    readFile(guardPath).catch((error) => error?.code === "ENOENT" ? undefined : Promise.reject(error)),
  ]);
  if (claimBytes) {
    const claim = JSON.parse(claimBytes.toString("utf8"));
    if (claim?.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || claim.schemaVersion !== 1 || !["apply", "uninstall"].includes(claim.operation)
      || typeof claim.planId !== "string" || typeof claim.digest !== "string" || typeof claim.lifecycleDigest !== "string" || !Number.isInteger(claim.processId) || claim.processId <= 0
      || typeof claim.nonce !== "string" || !/^[0-9a-f]{64}$/.test(claim.nonce)) throw new Error("Invalid daemon lifecycle claim");
    const guard = guardBytes ? parseLifecycleClaimGuard(guardBytes) : undefined;
    return {
      apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
      schemaVersion: 1,
      kind: guard ? "claim-and-guard" : "claim",
      operation: claim.operation,
      planId: claim.planId,
      planDigest: claim.digest,
      lifecycleDigest: claim.lifecycleDigest,
      claimDigest: sha256Bytes(claimBytes),
      ...(guard ? { guardDigest: sha256Bytes(guardBytes), guardLiveProcess: isProcessAlive(guard.processId) } : {}),
    };
  }
  if (!guardBytes) throw new Error("No daemon lifecycle claim or claim guard exists");
  const guard = parseLifecycleClaimGuard(guardBytes);
  return { apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION, schemaVersion: 1, kind: "guard", guardDigest: sha256Bytes(guardBytes), liveProcess: isProcessAlive(guard.processId) };
}

function resolveLifecycleClaimRoot(options) {
  const injectedRunner = typeof options?.commandRunner === "function";
  const testOverride = options?.testClaimRoot ?? options?.commandRunner?.testClaimRoot;
  if (testOverride !== undefined) {
    if (!injectedRunner) throw new Error("testClaimRoot is test-only and requires an injected commandRunner");
    const expected = resolve(tmpdir(), `threadspan-lifecycle-test-claims-${process.pid}`);
    if (!process.env.NODE_TEST_CONTEXT || resolve(testOverride) !== expected) throw new Error("testClaimRoot is restricted to the fixed Node test harness namespace");
    return expected;
  }
  return resolveDaemonServiceClaimRoot();
}

function assertLifecycleRunnerPolicy(options) {
  if (options?.commandRunner && !process.env.NODE_TEST_CONTEXT) {
    throw new Error("Injected lifecycle commandRunner is restricted to the offline Node test harness");
  }
}

async function releaseLifecycleClaim(claim) {
  await withLifecycleClaimGuard(claim.stateRoot, undefined, async () => {
    const observed = await readFile(claim.path, "utf8").catch((error) => {
      if (error?.code === "ENOENT") throw new Error("Daemon lifecycle claim disappeared before guarded release");
      throw error;
    });
    if (observed !== claim.content) throw new Error("Daemon lifecycle claim identity changed before guarded release");
    await rm(claim.path);
  });
}

async function withLifecycleClaimGuard(stateRoot, recoverClaimDigest, callback, attempt = 0) {
  const guardPath = resolve(stateRoot, ".lifecycle.claim.guard");
  await assertAbsoluteTargetSafe(guardPath);
  let guard;
  const guardNonce = createHash("sha256").update(`${process.pid}\0${Date.now()}\0${Math.random()}`).digest("hex");
  try {
    guard = await open(guardPath, "wx", 0o600);
    await guard.writeFile(`${JSON.stringify({ apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION, schemaVersion: 1, processId: process.pid, nonce: guardNonce })}\n`, "utf8");
  } catch (error) {
    await guard?.close().catch(() => undefined);
    if (error?.code === "EEXIST") {
      if (!recoverClaimDigest) {
        if (attempt < 20) { await delay(5); return withLifecycleClaimGuard(stateRoot, undefined, callback, attempt + 1); }
        throw new Error("Daemon lifecycle claim coordination is busy");
      }
      const guardBytes = await readFile(guardPath);
      const existingGuard = parseLifecycleClaimGuard(guardBytes);
      const guardDigest = sha256Bytes(guardBytes);
      if (guardDigest !== recoverClaimDigest) throw new Error(`Claim guard recovery requires exact guard digest ${guardDigest}`);
      if (isProcessAlive(existingGuard.processId)) throw new Error("Refusing claim recovery while its guard process is live");
      const historyRoot = resolve(stateRoot, "claim-history");
      await assertAbsoluteTargetSafe(historyRoot, { directoryTarget: true });
      await mkdir(historyRoot, { recursive: true, mode: 0o700 });
      const guardHistory = resolve(historyRoot, `guard-${guardDigest}.json`);
      await assertAbsoluteTargetSafe(guardHistory);
      if (await safeLstat(guardHistory)) throw new Error("Claim guard recovery evidence already exists");
      if (sha256Bytes(await readFile(guardPath)) !== guardDigest) throw new Error("Claim guard changed during recovery");
      await rename(guardPath, guardHistory);
      return withLifecycleClaimGuard(stateRoot, recoverClaimDigest, callback);
    }
    throw error;
  }
  await guard.close();
  try { return await callback(); } finally { await rm(guardPath); }
}

function parseLifecycleClaimGuard(bytes) {
  const guard = JSON.parse(bytes.toString("utf8"));
  if (guard?.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || guard.schemaVersion !== 1
    || !Number.isInteger(guard.processId) || guard.processId <= 0 || typeof guard.nonce !== "string" || !/^[0-9a-f]{64}$/.test(guard.nonce)) {
    throw new Error("Invalid daemon lifecycle claim guard");
  }
  return guard;
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try { process.kill(processId, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

async function lifecycleCheckpoint(options, name) {
  if (typeof options?.checkpoint === "function") await options.checkpoint(name);
}

function delay(milliseconds, signal) {
  return new Promise((resolveDelay, rejectDelay) => {
    if (signal?.aborted) { rejectDelay(signal.reason ?? new Error("Daemon lifecycle operation aborted")); return; }
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); rejectDelay(signal.reason ?? new Error("Daemon lifecycle operation aborted")); }, { once: true });
  });
}

function assertCommandExpectation(command, result, phase) {
  const expectation = command.expectation ?? {};
  if (expectation.absent === true) {
    const absentCodes = expectation.absentExitCodes ?? [3];
    if (!absentCodes.includes(result.exitCode)) throw commandFailure(command, result, phase);
    return;
  }
  const accepted = expectation.exitCodes ?? [0];
  if (!accepted.includes(result.exitCode)) throw commandFailure(command, result, phase);
  if (Array.isArray(expectation.stdout) && !expectation.stdout.includes(result.stdout.trim())) {
    throw new Error(`Lifecycle ${phase} verification failed for ${command.id}`);
  }
}

function commandFailure(command, result, phase) {
  return new Error(`Lifecycle ${phase} command ${command.id} exited ${result.exitCode}`);
}

function normalizeCommandResult(value) {
  if (!value || !Number.isInteger(value.exitCode)) throw new TypeError("Lifecycle command runner must return an integer exitCode");
  return { exitCode: value.exitCode, stdout: String(value.stdout ?? ""), stderr: String(value.stderr ?? "") };
}

function defaultLifecycleCommandRunner(argv, context = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(argv[0], argv.slice(1), { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024, timeout: LIFECYCLE_COMMAND_TIMEOUT_MS, killSignal: "SIGTERM", signal: context.signal }, (error, stdout, stderr) => {
      if (error && (error.name === "AbortError" || error.code === "ABORT_ERR" || error.killed === true)) { rejectCommand(error); return; }
      resolveCommand({ exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

function bindLifecycleCommandRunner(runner, signal) {
  const bound = async (argv, context) => {
    const timeoutMs = process.env.NODE_TEST_CONTEXT && Number.isInteger(runner.testTimeoutMs) && runner.testTimeoutMs > 0 && runner.testTimeoutMs <= 1_000
      ? runner.testTimeoutMs
      : LIFECYCLE_COMMAND_TIMEOUT_MS;
    if (signal?.aborted) throw signal.reason ?? new Error("Daemon lifecycle operation aborted");
    if (runner === defaultLifecycleCommandRunner) {
      return runner(argv, { ...context, signal, timeoutMs });
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason ?? new Error("Daemon lifecycle operation aborted"));
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error(`Lifecycle command exceeded ${timeoutMs}ms`)), timeoutMs);
    try {
      return await Promise.race([
        Promise.resolve(runner(argv, { ...context, signal: controller.signal, timeoutMs })),
        new Promise((_, rejectTimeout) => controller.signal.addEventListener("abort", () => rejectTimeout(controller.signal.reason), { once: true })),
      ]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  };
  bound.skipStableDelay = runner.skipStableDelay;
  bound.signal = signal;
  return bound;
}

async function restoreLifecycleEntries(entries, options = {}) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      await assertAbsoluteTargetSafe(entry.target);
      const current = await safeLstat(entry.target);
      if (options.idempotent) {
        if (!entry.existed && !current) continue;
        if (entry.existed && current?.isFile() && !current.isSymbolicLink()
          && await sha256File(entry.target) === entry.originalSha256
          && (process.platform === "win32" || (current.mode & 0o777) === entry.originalMode)) continue;
      }
      if (options.verifyInstalled) {
        if (!current?.isFile() || current.isSymbolicLink() || await sha256File(entry.target) !== entry.installedSha256
          || (process.platform !== "win32" && (current.mode & 0o777) !== entry.installedMode)) {
          throw new Error("installed lifecycle file changed before restore");
        }
      }
      if (entry.existed) {
        const backupBytes = await readFile(entry.backup);
        if (options.verifyBackup && sha256Bytes(backupBytes) !== entry.originalSha256) throw new Error("lifecycle preimage backup changed before restore");
        await atomicWrite(entry.target, backupBytes, entry.originalMode, { strictMode: true });
      } else {
        await rm(entry.target, { force: true });
      }
    } catch (error) {
      errors.push({ role: entry.role, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors;
}

async function validateLifecycleUninstallEntries(entries, options = {}) {
  const errors = [];
  for (const entry of entries) {
    await assertAbsoluteTargetSafe(entry.target);
    const target = await safeLstat(entry.target);
    const installed = target?.isFile() && !target.isSymbolicLink() && await sha256File(entry.target) === entry.installedSha256
      && (process.platform === "win32" || (target.mode & 0o777) === entry.installedMode);
    const restored = !entry.existed
      ? !target
      : target?.isFile() && !target.isSymbolicLink() && await sha256File(entry.target) === entry.originalSha256
        && (process.platform === "win32" || (target.mode & 0o777) === entry.originalMode);
    if (!installed && !(options.allowRestored && restored)) errors.push(`${entry.role}: installed or restored file drift`);
    if (entry.existed) {
      await assertAbsoluteTargetSafe(entry.backup);
      const backup = await safeLstat(entry.backup);
      if (!backup?.isFile() || backup.isSymbolicLink() || await sha256File(entry.backup) !== entry.originalSha256) errors.push(`${entry.role}: backup drift`);
    }
  }
  if (errors.length > 0) throw new Error(`Daemon lifecycle uninstall preimage validation failed: ${errors.join(", ")}`);
}

function lifecycleReceipt(plan, status, entries, commands) {
  return {
    apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
    schemaVersion: 1,
    kind: "threadspan-service-lifecycle-receipt",
    status,
    planId: plan.planId,
    digest: plan.digest,
    platform: plan.platform,
    sourceRevision: plan.source.revision,
    ownerFingerprint: plan.ownerFingerprint,
    evidenceClass: "service-registration-and-loopback-health-only",
    runtimeOwnershipVerified: false,
    files: entries.map((entry) => ({ role: entry.role, installedSha256: entry.installedSha256 })),
    commands,
  };
}

function lifecycleUninstallReceipt(plan, manifest, commands) {
  return {
    apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
    schemaVersion: 1,
    kind: "threadspan-service-uninstall-receipt",
    status: "uninstalled",
    planId: plan.planId,
    digest: plan.digest,
    installPlanId: plan.installPlanId,
    installPlanDigest: plan.installPlanDigest,
    platform: plan.platform,
    sourceRevision: plan.sourceRevision,
    ownerFingerprint: plan.ownerFingerprint,
    evidenceClass: "verified-deactivation-and-file-preimage-restoration",
    runtimeOwnershipVerified: false,
    commands: {
      deactivate: commands.filter((item) => item.phase === "deactivate").map((item) => item.id),
      verifyAbsent: commands.filter((item) => item.phase === "verify-absent").map((item) => item.id),
      finalize: commands.filter((item) => item.phase === "finalize").map((item) => item.id),
    },
    files: manifest.entries.map((entry) => ({ role: entry.role, restoredPreimage: true })),
  };
}

async function readTerminalUninstallReceipt(plan) {
  const stats = await safeLstat(plan.manifestPath);
  if (!stats) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Daemon lifecycle manifest must be a regular canonical file");
  const manifest = parseLifecycleManifest(await readFile(plan.manifestPath));
  if (manifest.status !== "uninstalled") return undefined;
  const expectedPath = resolve(manifest.stateRoot, "manifests", `${manifest.planId}.json`);
  if (resolve(plan.manifestPath) !== expectedPath || resolve(plan.stateRoot) !== resolve(manifest.stateRoot)) {
    throw new Error("Terminal uninstall receipt is outside its canonical state root");
  }
  const receipt = manifest.terminalUninstallReceipt;
  validateTerminalUninstallReceipt(receipt);
  if (stableStringify(uninstallFilesFromManifest(manifest)) !== stableStringify(plan.files)
    || stableStringify(uninstallCommandsFromManifest(manifest)) !== stableStringify(plan.commands)
    || manifest.platform !== plan.platform || manifest.sourceRevision !== plan.sourceRevision
    || manifest.ownerFingerprint !== plan.ownerFingerprint) {
    throw new Error("Terminal uninstall manifest projection does not match the approved plan");
  }
  if (receipt.planId !== plan.planId || receipt.digest !== plan.digest
    || receipt.installPlanId !== plan.installPlanId || receipt.installPlanDigest !== plan.installPlanDigest
    || receipt.ownerFingerprint !== plan.ownerFingerprint || receipt.sourceRevision !== plan.sourceRevision || receipt.platform !== plan.platform
    || receipt.evidenceClass !== "verified-deactivation-and-file-preimage-restoration" || receipt.runtimeOwnershipVerified !== false
    || manifest.planDigest !== plan.installPlanDigest) {
    throw new Error("Terminal uninstall receipt does not match the approved uninstall plan");
  }
  const expectedFiles = manifest.entries.map((entry) => ({ role: entry.role, restoredPreimage: true }));
  if (stableStringify(receipt.files) !== stableStringify(expectedFiles)) throw new Error("Terminal uninstall receipt file projection is invalid");
  for (const [receiptPhase, planPhase] of [["deactivate", "deactivate"], ["verifyAbsent", "verifyAbsent"], ["finalize", "finalize"]]) {
    const expectedIds = plan.commands[planPhase].map((command) => command.id);
    const observedIds = receipt.commands[receiptPhase];
    const exact = stableStringify(observedIds) === stableStringify(expectedIds);
    const allowedEmptyDeactivate = receiptPhase === "deactivate" && observedIds.length === 0;
    if (!exact && !allowedEmptyDeactivate) {
      throw new Error(`Terminal uninstall receipt ${receiptPhase} provenance is invalid`);
    }
  }
  return receipt;
}

function validateTerminalUninstallReceipt(receipt) {
  const allowed = ["apiVersion", "schemaVersion", "kind", "status", "planId", "digest", "installPlanId", "installPlanDigest", "platform", "sourceRevision", "ownerFingerprint", "evidenceClass", "runtimeOwnershipVerified", "commands", "files"];
  const required = [...allowed];
  if (!receipt || Object.keys(receipt).some((key) => !allowed.includes(key)) || required.some((key) => !(key in receipt))
    || receipt.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || receipt.schemaVersion !== 1
    || receipt.kind !== "threadspan-service-uninstall-receipt" || receipt.status !== "uninstalled"
    || receipt.runtimeOwnershipVerified !== false || receipt.evidenceClass !== "verified-deactivation-and-file-preimage-restoration"
    || !["linux", "win32"].includes(receipt.platform) || !/^[0-9a-f]{64}$/.test(receipt.digest ?? "")
    || !/^[0-9a-f]{64}$/.test(receipt.installPlanDigest ?? "") || !/^[0-9a-f]{64}$/.test(receipt.ownerFingerprint ?? "")
    || !receipt.commands || stableStringify(Object.keys(receipt.commands).sort()) !== stableStringify(["deactivate", "finalize", "verifyAbsent"])
    || !["deactivate", "verifyAbsent", "finalize"].every((phase) => Array.isArray(receipt.commands[phase])
      && receipt.commands[phase].every((id) => typeof id === "string"))
    || !Array.isArray(receipt.files) || receipt.files.some((file) => !file || stableStringify(Object.keys(file).sort()) !== stableStringify(["restoredPreimage", "role"])
      || typeof file.role !== "string" || file.restoredPreimage !== true)) {
    throw new Error("Invalid terminal daemon lifecycle uninstall receipt");
  }
}

function lifecycleOwnershipFragment(plan) {
  return `owner-sha256=${plan.ownerFingerprint} revision=${plan.source.revision}`;
}

async function assertAbsoluteTargetSafe(target, options = {}) {
  const resolved = resolve(target);
  const end = options.directoryTarget ? resolved : dirname(resolved);
  const parsedRoot = resolve(resolved, sep);
  const offset = relative(parsedRoot, end);
  let cursor = parsedRoot;
  for (const part of offset.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    const stats = await safeLstat(cursor);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new Error(`Refusing lifecycle path through symbolic link: ${cursor}`);
    if (!stats.isDirectory()) throw new Error(`Lifecycle parent is not a directory: ${cursor}`);
  }
}

function isPathInside(root, target) {
  const offset = relative(root, target);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function parseLifecycleManifest(bytes) {
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!manifest || manifest.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || manifest.schemaVersion !== 1 || manifest.kind !== "threadspan-service-lifecycle-manifest"
    || !Array.isArray(manifest.entries) || !manifest.commands || !/^[0-9a-f]{64}$/.test(manifest.planDigest ?? "")
    || !/^[0-9a-f]{64}$/.test(manifest.ownerFingerprint ?? "")) {
    throw new Error("Invalid daemon lifecycle manifest");
  }
  if (typeof manifest.stateRoot !== "string" || !isAbsolute(manifest.stateRoot)) throw new Error("Invalid daemon lifecycle manifest state root");
  if (!["prepared", "activating", SERVICE_PENDING_RUNTIME_STATUS, "rolled-back-after-error", "rollback-incomplete", "uninstalling", "uninstall-incomplete", "uninstall-rollback-incomplete", "uninstalled"].includes(manifest.status)) {
    throw new Error("Invalid daemon lifecycle manifest status");
  }
  if (manifest.status === SERVICE_PENDING_RUNTIME_STATUS
    && (manifest.runtimeOwnershipVerified !== false || manifest.evidenceClass !== "service-registration-and-loopback-health-only")) {
    throw new Error("Pending runtime-ownership manifest is missing its truthful evidence boundary");
  }
  if (manifest.status === "uninstalled") validateTerminalUninstallReceipt(manifest.terminalUninstallReceipt);
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.role !== "string" || typeof entry.target !== "string" || !isAbsolute(entry.target)
      || typeof entry.existed !== "boolean" || !/^[0-9a-f]{64}$/.test(entry.installedSha256 ?? "")
      || !Number.isInteger(entry.installedMode)
      || !(entry.originalSha256 === null || /^[0-9a-f]{64}$/.test(entry.originalSha256))
      || (entry.existed && (typeof entry.backup !== "string" || !isAbsolute(entry.backup)))) {
      throw new Error("Invalid daemon lifecycle manifest entry");
    }
  }
  for (const phase of ["inspect", "activate", "verify", "recover", "deactivate", "verifyAbsent", "finalize"]) {
    if (!Array.isArray(manifest.commands[phase])) throw new Error(`Invalid daemon lifecycle manifest command phase: ${phase}`);
    for (const command of manifest.commands[phase]) {
      if (!command || typeof command.id !== "string" || !Array.isArray(command.argv) || command.argv.length === 0
        || command.argv.some((value) => typeof value !== "string")) throw new Error("Invalid daemon lifecycle manifest command");
    }
  }
  validateDaemonLifecycleCommands(manifest.platform, manifest.commands, { files: manifest.entries });
  return manifest;
}

function computeUninstallPlanDigest(plan) {
  const { digest: _digest, ...payload } = plan;
  return sha256Bytes(Buffer.from(stableStringify(payload), "utf8"));
}

function validateUninstallPlan(plan) {
  if (!plan || plan.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || plan.schemaVersion !== 1 || plan.kind !== "threadspan-service-uninstall") throw new TypeError("Invalid daemon lifecycle uninstall plan");
  if (!/^[0-9a-f]{64}$/.test(plan.manifestSha256 ?? "") || !/^[0-9a-f]{64}$/.test(plan.ownerFingerprint ?? "")
    || !/^[0-9a-f]{64}$/.test(plan.installPlanDigest ?? "") || !/^[0-9a-f]{64}$/.test(plan.digest ?? "")) {
    throw new TypeError("Invalid daemon lifecycle uninstall binding");
  }
  if (!Array.isArray(plan.files) || !plan.commands
    || ["inspect", "deactivate", "verifyAbsent", "recover", "verify", "finalize"].some((phase) => !Array.isArray(plan.commands[phase]))) {
    throw new TypeError("Invalid daemon lifecycle uninstall operations");
  }
  if (typeof plan.stateRoot !== "string" || !isAbsolute(plan.stateRoot)) throw new TypeError("Invalid daemon lifecycle uninstall state root");
  if (computeUninstallPlanDigest(plan) !== plan.digest) throw new Error("Daemon lifecycle uninstall plan integrity check failed");
}

function normalizeUninstallPlanId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new TypeError("uninstall planId contains unsupported characters");
  return value;
}

function uninstallFilesFromManifest(manifest) {
  return manifest.entries.map((entry) => ({
    role: entry.role,
    target: entry.target,
    installedSha256: entry.installedSha256,
    installedMode: entry.installedMode,
    originalSha256: entry.originalSha256,
  }));
}

function uninstallCommandsFromManifest(manifest) {
  return {
    inspect: manifest.commands.inspect,
    deactivate: manifest.commands.deactivate,
    verifyAbsent: manifest.commands.verifyAbsent,
    recover: manifest.commands.recover,
    verify: manifest.commands.verify,
    finalize: manifest.commands.finalize,
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function renderArgument(value) {
  return /^[A-Za-z0-9_./:\\=-]+$/.test(value) ? value : JSON.stringify(value);
}

function countOccurrences(value, fragment) {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(fragment, cursor)) !== -1) { count += 1; cursor += fragment.length; }
  return count;
}
