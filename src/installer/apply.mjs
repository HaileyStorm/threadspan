import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
    ...plan.operations.map((operation) => `  ${operation.component}: ${operation.relativePath}`),
    `Approval digest: ${plan.digest}`,
  ];
  return { digest: plan.digest, text: `${lines.join("\n")}\n` };
}

/**
 * Apply an approved installer plan with bounded paths, backups, atomic replacement,
 * a rollback manifest, and automatic restoration on partial failure.
 * @param {Record<string, any>} plan Installer plan returned by createInstallerPlan.
 * @param {{approvedDigest:string}} options Apply approval.
 * @returns {Promise<{planId:string, digest:string, manifestPath:string, backups:string[], written:string[]}>}
 */
export async function applyInstallerPlan(plan, options) {
  validatePlan(plan);
  if (!options || options.approvedDigest !== plan.digest) throw new Error("Installer apply requires the digest from previewInstallerPlan");

  const root = await canonicalInstallRoot(plan.installRoot);
  const targets = plan.operations.map((operation) => ({ operation, path: boundedPath(root, operation.relativePath) }));
  const manifestPath = boundedPath(root, plan.rollbackManifest);
  const backupRoot = boundedPath(root, plan.backupRoot);
  assertDistinctTargets(targets.map(({ path }) => path));
  await assertSafeTarget(root, manifestPath);
  await assertSafeTarget(root, backupRoot, { directoryTarget: true });
  if (await safeLstat(manifestPath)) throw new Error(`Installer plan id already has a rollback manifest: ${plan.planId}`);
  if (await safeLstat(backupRoot)) throw new Error(`Installer plan id already has a backup directory: ${plan.planId}`);

  const entries = [];
  for (const { operation, path } of targets) {
    const existing = await safeLstat(path);
    if (existing?.isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${operation.relativePath}`);
    if (existing && !existing.isFile()) throw new Error(`Installer target is not a regular file: ${operation.relativePath}`);
    await assertSafeTarget(root, path);
    const backupRelativePath = existing ? `${plan.backupRoot}/${operation.relativePath}` : undefined;
    entries.push({
      component: operation.component,
      target: operation.relativePath,
      existed: Boolean(existing),
      ...(existing ? { originalSha256: await sha256File(path) } : {}),
      ...(backupRelativePath ? { backup: backupRelativePath } : {}),
    });
  }

  const backups = [];
  for (const entry of entries) {
    if (!entry.existed) continue;
    const source = boundedPath(root, entry.target);
    const destination = boundedPath(root, entry.backup);
    await assertSafeTarget(root, destination);
    await atomicCopy(source, destination);
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
      const entry = entries.find((candidate) => candidate.target === operation.relativePath);
      await assertTargetUnchanged(path, entry);
      await atomicWrite(path, operation.content, operation.mode);
      written.push(path);
    }
    manifest.status = "applied";
    await atomicJsonWrite(manifestPath, manifest, 0o600);
  } catch (error) {
    const writtenTargets = new Set(written.map((path) => relative(root, path)));
    const rollbackErrors = await restoreEntries(root, entries.filter((entry) => writtenTargets.has(entry.target)));
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

function validatePlan(plan) {
  if (!plan || plan.kind !== "install" || !Array.isArray(plan.operations) || !Array.isArray(plan.prerequisites)) {
    throw new TypeError("Invalid installer plan");
  }
  if (computePlanDigest(plan) !== plan.digest) throw new Error("Installer plan integrity check failed");
  for (const operation of plan.operations) {
    if (typeof operation.content !== "string" || typeof operation.component !== "string") throw new TypeError("Invalid installer operation");
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

async function atomicWrite(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await chmod(temporary, mode).catch(() => undefined);
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
    const target = boundedPath(root, entry.target);
    try {
      if (entry.existed) {
        const backup = boundedPath(root, entry.backup);
        await atomicCopy(backup, target);
      } else {
        await rm(target, { force: true });
      }
    } catch (error) {
      errors.push({ target: entry.target, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors;
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

function assertDistinctTargets(paths) {
  if (new Set(paths).size !== paths.length) throw new Error("Installer plan contains duplicate targets");
}
