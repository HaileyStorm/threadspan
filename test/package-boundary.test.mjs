import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readNpmPacklist } from "../scripts/release-bundle.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("npm pack manifest excludes every .working sentinel pattern", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "threadspan-pack-boundary-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(fixture, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(join(fixture, "src"), { recursive: true });
  await mkdir(join(fixture, "integrations"), { recursive: true });
  await writeFile(join(fixture, "src", "index.mjs"), "export {};\n");
  await writeFile(join(fixture, "src", ".working"), "must-not-pack\n");
  await writeFile(join(fixture, "src", ".working.agent"), "must-not-pack\n");
  await writeFile(join(fixture, "integrations", ".working-foreign"), "must-not-pack\n");
  const files = await readNpmPacklist(fixture);
  assert.ok(files.includes("src/index.mjs"));
  assert.equal(files.some((path) => path.split("/").some((part) => part.startsWith(".working"))), false);
});
