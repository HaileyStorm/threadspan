import assert from "node:assert/strict";
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot, isPathInside, matchesAnyExclude } from "../src/workspace/snapshot.mjs";

test("snapshot copies regular files, excludes heavy directories, and skips symlinks", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "bridge-source-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "a.txt"), "alpha");
  await mkdir(join(source, "node_modules"));
  await writeFile(join(source, "node_modules", "ignored.txt"), "ignored");
  await symlink(join(source, "a.txt"), join(source, "link.txt"));

  const snapshot = await createWorkspaceSnapshot(source, { maxBytes: 1024, maxFiles: 10 });
  t.after(() => snapshot.dispose());
  assert.equal(await readFile(join(snapshot.path, "a.txt"), "utf8"), "alpha");
  await assert.rejects(() => stat(join(snapshot.path, "node_modules")));
  await assert.rejects(() => stat(join(snapshot.path, "link.txt")));
  assert.equal(snapshot.filesCopied, 1);
  assert.ok(snapshot.skipped.some((entry) => entry.reason === "symlink"));
});

test("snapshot enforces byte limit and cleans failed destination", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "bridge-source-limit-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "large.bin"), Buffer.alloc(128));
  await assert.rejects(() => createWorkspaceSnapshot(source, { maxBytes: 64 }), /maxBytes/);
});

test("path and exclusion helpers handle nested patterns", () => {
  assert.equal(isPathInside("/tmp/root", "/tmp/root/a"), true);
  assert.equal(isPathInside("/tmp/root", "/tmp/other"), false);
  assert.equal(matchesAnyExclude("src/generated/a.js", "a.js", ["src/generated/**"]), true);
  assert.equal(matchesAnyExclude("src/a.js", "a.js", ["*.log"]), false);
  assert.equal(matchesAnyExclude("x/debug.log", "debug.log", ["*.log"]), true);
});

test("copied internal symlinks are rewritten to snapshot-local targets", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges and link-type rules vary by runner");
  const source = await mkdtemp(join(tmpdir(), "bridge-source-links-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(source, { recursive: true, force: true });
  });
  await writeFile(join(source, "target.txt"), "source-value");
  await symlink(join(source, "target.txt"), join(source, "absolute-link.txt"));

  const snapshot = await createWorkspaceSnapshot(source, { copyInternalSymlinks: true });
  t.after(() => snapshot.dispose());
  const snapshotLink = join(snapshot.path, "absolute-link.txt");
  assert.equal((await lstat(snapshotLink)).isSymbolicLink(), true);
  assert.equal(await readFile(snapshotLink, "utf8"), "source-value");
  assert.equal(await realpath(snapshotLink), join(snapshot.path, "target.txt"));
  assert.equal((await readlink(snapshotLink)).includes(source), false);

  await writeFile(join(snapshot.path, "target.txt"), "snapshot-value");
  assert.equal(await readFile(snapshotLink, "utf8"), "snapshot-value");
  assert.equal(await readFile(join(source, "target.txt"), "utf8"), "source-value");
});

test("symlink chains that resolve outside the workspace are rejected", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges and link-type rules vary by runner");
  const source = await mkdtemp(join(tmpdir(), "bridge-source-external-links-"));
  const external = await mkdtemp(join(tmpdir(), "bridge-external-links-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(source, { recursive: true, force: true }), rm(external, { recursive: true, force: true })]);
  });
  await writeFile(join(external, "secret.txt"), "secret");
  await symlink(join(external, "secret.txt"), join(source, "hop.txt"));
  await symlink(join(source, "hop.txt"), join(source, "chain.txt"));

  const snapshot = await createWorkspaceSnapshot(source, { copyInternalSymlinks: true });
  t.after(() => snapshot.dispose());
  await assert.rejects(() => lstat(join(snapshot.path, "hop.txt")));
  await assert.rejects(() => lstat(join(snapshot.path, "chain.txt")));
  assert.equal(snapshot.skipped.filter((entry) => entry.reason === "external-symlink").length, 2);
});

