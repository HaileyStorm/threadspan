import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  CODEX_FULL_ACCESS_TRANSFORM_ID,
  decodeCodexConfig,
  resolveCodexUserConfigPath,
  transformCodexFullAccessConfig,
} from "../codex/execution-policy.mjs";
import { computePlanDigest } from "./components.mjs";

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
