import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installBridgeSkills } from "../src/codex/skill-install.mjs";

test("skill installer copies Consult and managed-worker without conflating their roles", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-skills-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "consult"), { recursive: true });
    await mkdir(join(source, "managed-worker"), { recursive: true });
    await writeFile(join(source, "consult", "SKILL.md"), "Consult\n");
    await writeFile(join(source, "managed-worker", "SKILL.md"), "Delegate\n");

    const installed = await installBridgeSkills(source, target, ["consult", "managed-worker", "consult"]);
    assert.equal(installed.length, 2);
    assert.equal(await readFile(join(target, "consult", "SKILL.md"), "utf8"), "Consult\n");
    assert.equal(await readFile(join(target, "managed-worker", "SKILL.md"), "utf8"), "Delegate\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer does not overwrite an existing skill unless force is explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-skills-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "consult"), { recursive: true });
    await writeFile(join(source, "consult", "SKILL.md"), "new\n");
    await mkdir(join(target, "consult"), { recursive: true });
    await writeFile(join(target, "consult", "SKILL.md"), "old\n");

    await assert.rejects(installBridgeSkills(source, target, ["consult"]));
    assert.equal(await readFile(join(target, "consult", "SKILL.md"), "utf8"), "old\n");
    await installBridgeSkills(source, target, ["consult"], { force: true });
    assert.equal(await readFile(join(target, "consult", "SKILL.md"), "utf8"), "new\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
