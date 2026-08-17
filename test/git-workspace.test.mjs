import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { enforceGitWorkspacePolicy, inspectGitWorkspace } from "../src/workspace/git-workspace.mjs";

const execFileAsync = promisify(execFile);
const gitAvailable = await execFileAsync("git", ["--version"]).then(() => true, () => false);

test("Delegate Git policy distinguishes linked worktrees, canonical branches, and dirty starts", { skip: !gitAvailable }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-git-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worker");
  await execFileAsync("git", ["init", repository]);
  await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: repository });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: repository });
  await writeFile(join(repository, "file.txt"), "base\n", "utf8");
  await execFileAsync("git", ["add", "file.txt"], { cwd: repository });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: repository });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repository });
  await execFileAsync("git", ["worktree", "add", "-b", "worker", worktree], { cwd: repository });

  const state = await inspectGitWorkspace(worktree);
  assert.equal(state.linkedWorktree, true);
  assert.equal(state.clean, true);
  assert.equal((await enforceGitWorkspacePolicy(worktree, {
    requireGit: true,
    requireLinkedWorktree: true,
    requireCleanStart: true,
    denyBranches: ["main", "master", "trunk"],
  })).branch, "worker");

  await assert.rejects(enforceGitWorkspacePolicy(repository, {
    requireLinkedWorktree: true,
    denyBranches: ["main"],
  }), /linked Git worktree|denied/);
  await writeFile(join(worktree, "file.txt"), "dirty\n", "utf8");
  await assert.rejects(enforceGitWorkspacePolicy(worktree, { requireCleanStart: true }), /must be clean/);
});
