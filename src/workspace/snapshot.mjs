import { constants as fsConstants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, opendir, readlink, realpath, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ConfigError, RequestError } from "../core/errors.mjs";

const DEFAULT_EXCLUDES = Object.freeze([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
]);

/**
 * A disposable copy of a workspace used to make Consult side effects harmless to the source tree.
 */
export class WorkspaceSnapshot {
  /**
   * @param {{sourcePath: string, snapshotPath: string, bytesCopied: number, filesCopied: number, skipped: Array<Record<string, any>>}} state Snapshot state.
   */
  constructor(state) {
    this.sourcePath = state.sourcePath;
    this.path = state.snapshotPath;
    this.bytesCopied = state.bytesCopied;
    this.filesCopied = state.filesCopied;
    this.skipped = state.skipped;
    this.disposed = false;
  }

  /** Remove the snapshot recursively. Safe to call more than once. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  /** Support `await using` when the runtime enables explicit resource management. */
  async [Symbol.asyncDispose]() {
    await this.dispose();
  }
}

/**
 * Create an isolated workspace snapshot with byte/file limits and conservative symlink handling.
 *
 * Symlinks are skipped by default. When `copyInternalSymlinks` is true, only links whose resolved
 * targets remain inside the source workspace are recreated. This prevents a repository symlink from
 * pulling arbitrary host files into a supposedly bounded consultation snapshot.
 *
 * @param {string} sourcePath Source workspace path.
 * @param {{
 *   root?: string,
 *   exclude?: string[],
 *   maxBytes?: number,
 *   maxFiles?: number,
 *   copyInternalSymlinks?: boolean,
 *   prefix?: string,
 *   logger?: any,
 * }} [options] Snapshot options.
 * @returns {Promise<WorkspaceSnapshot>}
 */
export async function createWorkspaceSnapshot(sourcePath, options = {}) {
  const requestedSource = resolve(sourcePath);
  await assertReadableDirectory(requestedSource);
  const source = await realpath(requestedSource);
  const root = resolve(options.root ?? tmpdir());
  await mkdir(root, { recursive: true });
  const snapshotPath = await mkdtemp(join(root, options.prefix ?? "cursor-bridge-consult-"));
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 100_000;
  const excludes = [...DEFAULT_EXCLUDES, ...(options.exclude ?? [])];
  const skipped = [];
  const state = { bytesCopied: 0, filesCopied: 0 };

  try {
    await copyDirectory(source, snapshotPath, source, {
      excludes,
      maxBytes,
      maxFiles,
      copyInternalSymlinks: options.copyInternalSymlinks === true,
      targetRoot: snapshotPath,
      skipped,
      state,
      logger: options.logger,
    });
    return new WorkspaceSnapshot({
      sourcePath: source,
      snapshotPath,
      bytesCopied: state.bytesCopied,
      filesCopied: state.filesCopied,
      skipped,
    });
  } catch (error) {
    await rm(snapshotPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Assert that a path exists, is a directory, and is readable.
 * @param {string} path Candidate workspace path.
 * @returns {Promise<void>}
 */
async function assertReadableDirectory(path) {
  let metadata;
  try {
    metadata = await stat(path);
    await access(path, fsConstants.R_OK);
  } catch (error) {
    throw new RequestError(`Workspace is not readable: ${path}`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!metadata.isDirectory()) throw new RequestError(`Workspace is not a directory: ${path}`);
}

/**
 * Recursively copy one directory while enforcing snapshot policy.
 * @param {string} currentSource Current source directory.
 * @param {string} currentTarget Current target directory.
 * @param {string} sourceRoot Canonical source root.
 * @param {Record<string, any>} options Internal copy options.
 * @returns {Promise<void>}
 */
async function copyDirectory(currentSource, currentTarget, sourceRoot, options) {
  await mkdir(currentTarget, { recursive: true });
  const directory = await opendir(currentSource);
  for await (const entry of directory) {
    const sourceEntry = join(currentSource, entry.name);
    const relativePath = normalizeRelative(relative(sourceRoot, sourceEntry));
    if (matchesAnyExclude(relativePath, entry.name, options.excludes)) {
      options.skipped.push({ path: relativePath, reason: "excluded" });
      continue;
    }

    const targetEntry = join(currentTarget, entry.name);
    const metadata = await lstat(sourceEntry);
    if (metadata.isSymbolicLink()) {
      await copySymlink(sourceEntry, targetEntry, relativePath, sourceRoot, options);
      continue;
    }
    if (metadata.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry, sourceRoot, options);
      continue;
    }
    if (!metadata.isFile()) {
      options.skipped.push({ path: relativePath, reason: "non-regular-file" });
      continue;
    }

    options.state.filesCopied += 1;
    options.state.bytesCopied += metadata.size;
    if (options.state.filesCopied > options.maxFiles) {
      throw new ConfigError(`Consult snapshot exceeds maxFiles (${options.maxFiles})`, { path: relativePath });
    }
    if (options.state.bytesCopied > options.maxBytes) {
      throw new ConfigError(`Consult snapshot exceeds maxBytes (${options.maxBytes})`, { path: relativePath });
    }
    await mkdir(dirname(targetEntry), { recursive: true });
    await copyFile(sourceEntry, targetEntry);
    await utimes(targetEntry, metadata.atime, metadata.mtime).catch(() => undefined);
  }
}

/**
 * Copy an internal symlink or record why it was skipped.
 * @param {string} sourceEntry Source symlink.
 * @param {string} targetEntry Target symlink.
 * @param {string} relativePath Display path.
 * @param {string} sourceRoot Source workspace root.
 * @param {Record<string, any>} options Internal copy options.
 * @returns {Promise<void>}
 */
async function copySymlink(sourceEntry, targetEntry, relativePath, sourceRoot, options) {
  if (!options.copyInternalSymlinks) {
    options.skipped.push({ path: relativePath, reason: "symlink" });
    return;
  }
  const linkText = await readlink(sourceEntry);
  const resolvedTarget = resolve(dirname(sourceEntry), linkText);
  let canonicalTarget;
  let targetMetadata;
  try {
    canonicalTarget = await realpath(resolvedTarget);
    targetMetadata = await stat(canonicalTarget);
  } catch {
    options.skipped.push({ path: relativePath, reason: "dangling-symlink" });
    return;
  }
  if (!isPathInside(sourceRoot, canonicalTarget)) {
    options.skipped.push({ path: relativePath, reason: "external-symlink" });
    return;
  }

  const snapshotTarget = join(options.targetRoot, relative(sourceRoot, canonicalTarget));
  const snapshotLinkText = relative(dirname(targetEntry), snapshotTarget) || ".";
  await mkdir(dirname(targetEntry), { recursive: true });
  await symlink(snapshotLinkText, targetEntry, targetMetadata.isDirectory() ? "dir" : "file");
}

/**
 * Determine whether a path remains under a root after resolution.
 * @param {string} root Root path.
 * @param {string} candidate Candidate path.
 * @returns {boolean}
 */
export function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Match a relative path against simple exact, directory, `*`, and `**` exclusion patterns.
 * @param {string} relativePath POSIX-normalized relative path.
 * @param {string} baseName Entry basename.
 * @param {string[]} patterns Exclusion patterns.
 * @returns {boolean}
 */
export function matchesAnyExclude(relativePath, baseName, patterns) {
  return patterns.some((rawPattern) => {
    const pattern = normalizeRelative(String(rawPattern).replace(/^\.\//, "").replace(/\/$/, ""));
    if (!pattern) return false;
    if (!pattern.includes("/")) {
      return pattern.includes("*") || pattern.includes("?")
        ? globToRegExp(pattern).test(baseName)
        : baseName === pattern;
    }
    return globToRegExp(pattern).test(relativePath);
  });
}

/**
 * Convert the intentionally small snapshot glob dialect to a regular expression.
 * @param {string} pattern Glob pattern.
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}(?:/.*)?$`);
}

/**
 * Normalize a platform path to a stable slash-separated relative path.
 * @param {string} value Input path.
 * @returns {string}
 */
function normalizeRelative(value) {
  return value.split(sep).join("/");
}
