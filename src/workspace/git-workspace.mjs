import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { RequestError } from "../core/errors.mjs";

const execFileAsync = promisify(execFile);

/**
 * Inspect Git identity and cleanliness for a candidate delegated workspace.
 * @param {string} workspace Candidate repository/worktree path.
 * @returns {Promise<{
 *   workspace: string,
 *   topLevel: string,
 *   gitDir: string,
 *   commonDir: string,
 *   linkedWorktree: boolean,
 *   branch: string,
 *   commit: string,
 *   clean: boolean,
 *   status: string[],
 * }>}
 */
export async function inspectGitWorkspace(workspace) {
  const cwd = resolve(workspace);
  const [topLevelText, gitDirText, commonDirText, branchText, commitText, statusText] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--git-dir"]),
    git(cwd, ["rev-parse", "--git-common-dir"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const topLevel = resolve(cwd, topLevelText);
  const gitDir = resolveGitPath(cwd, gitDirText);
  const commonDir = resolveGitPath(cwd, commonDirText);
  const status = statusText ? statusText.split(/\r?\n/).filter(Boolean) : [];
  return {
    workspace: cwd,
    topLevel,
    gitDir,
    commonDir,
    linkedWorktree: gitDir !== commonDir,
    branch: branchText,
    commit: commitText,
    clean: status.length === 0,
    status,
  };
}

/**
 * Enforce optional Git/worktree policy before a provider-owned Delegate run.
 * @param {string} workspace Candidate workspace.
 * @param {{
 *   requireGit?: boolean,
 *   requireLinkedWorktree?: boolean,
 *   requireCleanStart?: boolean,
 *   denyBranches?: string[],
 * }} [policy] Workspace policy.
 * @returns {Promise<ReturnType<typeof inspectGitWorkspace> extends Promise<infer T> ? T|undefined : never>}
 */
export async function enforceGitWorkspacePolicy(workspace, policy = {}) {
  const needsInspection = policy.requireGit === true
    || policy.requireLinkedWorktree === true
    || policy.requireCleanStart === true
    || (Array.isArray(policy.denyBranches) && policy.denyBranches.length > 0);
  if (!needsInspection) return undefined;

  let state;
  try {
    state = await inspectGitWorkspace(workspace);
  } catch (error) {
    throw new RequestError(`Delegate workspace is not an inspectable Git worktree: ${resolve(workspace)}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (policy.requireLinkedWorktree === true && !state.linkedWorktree) {
    throw new RequestError(`Delegate workspace must be a linked Git worktree, not the primary checkout: ${state.topLevel}`);
  }
  if (policy.requireCleanStart === true && !state.clean) {
    throw new RequestError(`Delegate workspace must be clean before launch; found ${state.status.length} changed path(s)`);
  }
  if ((policy.denyBranches ?? []).includes(state.branch)) {
    throw new RequestError(`Delegate workspace branch '${state.branch}' is denied by provider policy`);
  }
  return state;
}

/** Execute one bounded Git query and return trimmed stdout. */
async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout.trim();
}

/** Resolve a Git path that may be absolute or relative to the worktree. */
function resolveGitPath(cwd, value) {
  return resolve(isAbsolute(value) ? value : resolve(cwd, value));
}
