import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  COMPONENT_IDS,
  CONTEXT_PROFILES,
  applyInstallerPlan,
  boundedPath,
  createInstallerPlan,
  previewInstallerPlan,
  renderContextProfile,
  validateContextProfile,
} from "../src/installer/index.mjs";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("one-pass planning includes every component and reveals no credential values", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({
    installRoot: root,
    selection: "all",
    environment: { NOUS_API_KEY: "nous-secret-value", OPENROUTER_API_KEY: "router-secret-value" },
    planId: "one-pass",
  });

  assert.deepEqual(plan.selectedComponents, COMPONENT_IDS);
  assert.equal(plan.credentialPolicy, "names-and-prerequisite-state-only");
  assert.equal(plan.prerequisites.find((item) => item.name === "NOUS_API_KEY").state, "available");
  assert.equal(plan.prerequisites.find((item) => item.name === "OPENROUTER_API_KEY").state, "available");
  assert.equal(plan.prerequisites.find((item) => item.name === "THREADSPAN_DAEMON_TOKEN").state, "missing");
  assert.doesNotMatch(JSON.stringify(plan), /nous-secret-value|router-secret-value/);
  const continuity = JSON.parse(plan.operations.find((item) => item.component === "continuity").content);
  assert.deepEqual(continuity.excludes, ["memory", "multi-host-sync", "cross-host-communications"]);
});

test("incremental planning selects only requested components and optional profiles", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({
    installRoot: root,
    selection: ["continuity", "context-profiles"],
    longContextProfiles: "all",
    planId: "incremental",
  });

  assert.deepEqual(plan.selectedComponents, ["context-profiles", "continuity"]);
  assert.deepEqual(
    plan.operations.map((item) => item.relativePath),
    [
      "gpt-5.6-default.config.toml",
      "spark.config.toml",
      "gpt-5.6-600k.config.toml",
      "gpt-5.6-1m.config.toml",
      "threadspan/components/continuity.json",
    ],
  );
});

test("context profiles use exact defaults and enforce the 90 percent ceiling", () => {
  assert.match(renderContextProfile("gpt-5.6-default", CONTEXT_PROFILES["gpt-5.6-default"]), /model_context_window = 271500\nmodel_auto_compact_token_limit = 192000/);
  assert.match(renderContextProfile("spark", CONTEXT_PROFILES.spark), /model_context_window = 128000\nmodel_auto_compact_token_limit = 80000/);
  assert.match(renderContextProfile("gpt-5.6-600k", CONTEXT_PROFILES["gpt-5.6-600k"]), /600000\nmodel_auto_compact_token_limit = 480000/);
  assert.match(renderContextProfile("gpt-5.6-1m", CONTEXT_PROFILES["gpt-5.6-1m"]), /1000000\nmodel_auto_compact_token_limit = 800000/);
  assert.throws(
    () => validateContextProfile("unsafe", { model: "test", contextWindow: 100, autoCompactTokenLimit: 91 }),
    /must not exceed 90%/,
  );
  assert.throws(
    () => validateContextProfile("bad\nname", { model: "test", contextWindow: 100, autoCompactTokenLimit: 90 }),
    /unsupported characters/,
  );
});

test("optional long-context requests require the context profile component", async (t) => {
  const root = await temporaryRoot(t);
  assert.throws(
    () => createInstallerPlan({ installRoot: root, selection: ["daemon"], longContextProfiles: "all" }),
    /require the context-profiles component/,
  );
});

test("documented profile examples exactly match generated profiles", async () => {
  const examples = new URL("../examples/codex/context-profiles/", import.meta.url);
  for (const [name, profile] of Object.entries(CONTEXT_PROFILES)) {
    assert.equal(await readFile(new URL(`${name}.config.toml`, examples), "utf8"), renderContextProfile(name, profile));
  }
});

test("apply requires a preview digest, backs up existing files, and writes a rollback manifest", async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, "threadspan", "components", "daemon.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, "old daemon config\n");
  const plan = createInstallerPlan({ installRoot: root, selection: ["daemon"], planId: "safe-apply" });

  await assert.rejects(applyInstallerPlan(plan, { approvedDigest: "not-previewed" }), /requires the digest/);
  assert.equal(await readFile(target, "utf8"), "old daemon config\n");

  const preview = previewInstallerPlan(plan);
  assert.match(preview.text, /Rollback manifest: \.threadspan-installer\/rollbacks\/safe-apply\.json/);
  assert.match(preview.text, /threadspan\/components\/daemon\.json/);
  const result = await applyInstallerPlan(plan, { approvedDigest: preview.digest });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

  assert.equal(manifest.status, "applied");
  assert.equal(manifest.entries[0].target, "threadspan/components/daemon.json");
  assert.equal(await readFile(join(root, manifest.entries[0].backup), "utf8"), "old daemon config\n");
  assert.match(await readFile(target, "utf8"), /"component": "daemon"/);
  await assert.rejects(applyInstallerPlan(plan, { approvedDigest: preview.digest }), /already has a rollback manifest/);
});

test("path bounds reject absolute and escaping targets", async (t) => {
  const root = await temporaryRoot(t);
  assert.throws(() => boundedPath(root, "../escape"), /escapes root/);
  assert.throws(() => boundedPath(root, join(root, "absolute")), /Unsafe installer path/);
});

test("apply rejects a target routed through a symbolic-link directory", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  await mkdir(join(root, "redirect"));
  await symlink(join(root, "redirect"), join(root, "threadspan"), "dir");
  const plan = createInstallerPlan({ installRoot: root, selection: ["daemon"], planId: "symlink-path" });
  const preview = previewInstallerPlan(plan);
  await assert.rejects(applyInstallerPlan(plan, { approvedDigest: preview.digest }), /symbolic link/);
  await assert.rejects(readFile(join(root, "redirect", "components", "daemon.json")), /ENOENT/);
});
