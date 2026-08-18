import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  applyFreshInstallPlan,
  applyFreshInstallUninstallPlan,
  applyDaemonServicePlan,
  createFreshInstallPlan,
  createFreshInstallConfig,
  createFreshInstallUninstallPlan,
  previewFreshInstallPlan,
  resolveFreshInstallProvenance,
} from "../src/installer/index.mjs";
import { parseSignedReleaseSourceCommit } from "../src/installer/update-check.mjs";
import { InstallerGuiController } from "../src/installer/gui-controller.mjs";
import { InstallerRecoveryStore } from "../src/installer/recovery-store.mjs";

const execFileAsync = promisify(execFile);

async function fixture(t, suffix = "base") {
  const root = await mkdtemp(join(tmpdir(), `threadspan-fresh-${suffix}-`));
  const sourceRoot = join(root, "source");
  const installRoot = join(root, "install");
  const serviceDirectory = join(root, "services");
  await Promise.all([
    mkdir(join(sourceRoot, "src"), { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(serviceDirectory, { recursive: true }),
  ]);
  await writeFile(join(sourceRoot, "src", "cli.mjs"), "export const freshFixture = true;\n");
  await writeFile(join(sourceRoot, "src", "module.mjs"), "export const imported = true;\n");
  await execFileAsync("git", ["init", "-q"], { cwd: sourceRoot });
  await execFileAsync("git", ["config", "user.name", "Threadspan Test"], { cwd: sourceRoot });
  await execFileAsync("git", ["config", "user.email", "threadspan@example.invalid"], { cwd: sourceRoot });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/HaileyStorm/threadspan.git"], { cwd: sourceRoot });
  await execFileAsync("git", ["add", "src"], { cwd: sourceRoot });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: sourceRoot });
  await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: sourceRoot });
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = await createFreshInstallPlan({
    planId: `fresh-${suffix}`,
    platform: process.platform,
    installRoot,
    configPath: join(installRoot, "config.jsonc"),
    ownerTokenPath: join(installRoot, "secrets", "owner.token"),
    connectorTokenPath: join(installRoot, "secrets", "connector.token"),
    sourceRoot,
    stateRoot: join(root, "state"),
    serviceDirectory,
    legacyStartupPath: join(root, "legacy", "Threadspan.cmd"),
    home: root,
    componentIds: ["daemon"],
    providerIds: ["nous"],
    taskProtection: { disposition: "manual-confirmed", trusted: false, taskIds: ["private-task-id"] },
  });
  return { root, sourceRoot, installRoot, serviceDirectory, plan };
}

function lifecycleRunner(plan, events = []) {
  let installed = false;
  const fragment = `owner-sha256=${plan.serviceChild.plan.ownerFingerprint} revision=${plan.provenance.sourceCommit}`;
  const runner = async (_argv, context) => {
    events.push(context.phase);
    if (context.phase === "inspect") {
      if (!installed) return { exitCode: plan.platform === "win32" ? 3 : 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: plan.platform === "win32" ? fragment : plan.serviceChild.plan.files[context.id.includes("desktop") ? 1 : 0].content, stderr: "" };
    }
    if (["activate", "recover", "uninstall-rollback"].includes(context.phase)) {
      installed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (["deactivate", "rollback"].includes(context.phase)) {
      installed = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (["verify-absent", "rollback-verify-absent"].includes(context.phase)) {
      return { exitCode: plan.platform === "win32" ? 3 : 3, stdout: plan.platform === "linux" ? "inactive" : "", stderr: "" };
    }
    if (["verify", "verify-resumed", "uninstall-rollback-verify"].includes(context.phase)) {
      const stdout = context.id === "daemon-health" ? "ok"
        : context.id.endsWith("enabled") ? "enabled"
          : plan.platform === "win32" ? "Running" : "active";
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (context.phase === "finalize") return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected lifecycle phase ${context.phase}`);
  };
  runner.skipStableDelay = true;
  runner.testClaimRoot = join(tmpdir(), `threadspan-lifecycle-test-claims-${process.pid}`);
  return runner;
}

test("fresh parent derives provenance, binds both children, and rejects caller revisions", async (t) => {
  const { plan, sourceRoot } = await fixture(t, "provenance");
  const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
  assert.equal(plan.provenance.sourceCommit, commit);
  assert.equal(plan.serviceChild.plan.source.revision, commit);
  assert.equal(plan.componentChild.digest, plan.componentChild.plan.digest);
  assert.equal(plan.serviceChild.digest, plan.serviceChild.plan.digest);
  assert.match(plan.taskProtection.digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(plan), /private-task-id/);
  assert.throws(() => previewFreshInstallPlan({ ...plan, componentChild: { ...plan.componentChild, digest: "0".repeat(64) } }), /integrity|bound|invalid/i);
  await assert.rejects(createFreshInstallPlan({ sourceRoot, sourceRevision: commit }), /cannot be supplied/);
});

test("CLI and GUI hooks serialize the exact canonical coordinator plan", async (t) => {
  const base = await fixture(t, "parity-base");
  const cliRoot = join(base.root, "cli-install");
  const cliState = join(base.root, "cli-state");
  const cliServices = join(base.root, "cli-services");
  const cliPlanPath = join(base.root, "cli-plan.json");
  await Promise.all([mkdir(cliRoot), mkdir(cliServices)]);
  await execFileAsync(process.execPath, [
    "src/cli.mjs", "install", "fresh-plan",
    "--root", cliRoot,
    "--config", join(cliRoot, "config.jsonc"),
    "--owner-token-file", join(cliRoot, "secrets", "owner.token"),
    "--connector-token-file", join(cliRoot, "secrets", "connector.token"),
    "--output", cliPlanPath,
    "--source-root", base.sourceRoot,
    "--state-root", cliState,
    "--service-directory", cliServices,
    "--plan-id", "fresh-cli-parity",
  ], { cwd: join(dirname(new URL(import.meta.url).pathname), "..") });
  const cliPlan = JSON.parse(await readFile(cliPlanPath, "utf8"));
  const direct = await createFreshInstallPlan({
    planId: "fresh-cli-parity",
    platform: process.platform,
    installRoot: cliRoot,
    configPath: join(cliRoot, "config.jsonc"),
    ownerTokenPath: join(cliRoot, "secrets", "owner.token"),
    connectorTokenPath: join(cliRoot, "secrets", "connector.token"),
    sourceRoot: base.sourceRoot,
    stateRoot: cliState,
    serviceDirectory: cliServices,
    componentIds: ["daemon"],
    providerIds: [],
    taskProtection: { disposition: "manual-confirmed", trusted: false, taskIds: [] },
  });
  assert.deepEqual(cliPlan, direct);

  const guiRoot = join(base.root, "gui-install");
  const guiState = join(base.root, "gui-state");
  const guiServices = join(base.root, "gui-services");
  await Promise.all([mkdir(guiRoot), mkdir(guiServices)]);
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 }, codex: {} }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(base.root, "gui-recovery") }),
    listTasks: async () => ({ groups: [], evidence: { trusted: true, total: 0, active: 0, notLoaded: 0 } }),
    freshInstallOptions: {
      sourceRoot: base.sourceRoot,
      configPath: join(guiRoot, "config.jsonc"),
      ownerTokenPath: join(guiRoot, "secrets", "owner.token"),
      connectorTokenPath: join(guiRoot, "secrets", "connector.token"),
      stateRoot: guiState,
      serviceDirectory: guiServices,
    },
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot: guiRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.match(/session=([^&]+)/)[1];
  const gui = await controller.plan(decodeURIComponent(nonce), {
    freshInstall: true,
    components: ["daemon"],
    providers: [],
    taskProtection: { disposition: "manual-confirmed", trusted: false, taskIds: [] },
  });
  const directGui = await createFreshInstallPlan({
    planId: created.sessionId,
    platform: process.platform,
    installRoot: guiRoot,
    configPath: join(guiRoot, "config.jsonc"),
    ownerTokenPath: join(guiRoot, "secrets", "owner.token"),
    connectorTokenPath: join(guiRoot, "secrets", "connector.token"),
    sourceRoot: base.sourceRoot,
    stateRoot: guiState,
    serviceDirectory: guiServices,
    componentIds: ["daemon"],
    providerIds: [],
    taskProtection: { disposition: "manual-confirmed", trusted: false, taskIds: [] },
  });
  assert.deepEqual(gui.plan, directGui);
});

test("installer GUI CLI rejects non-loopback plaintext before reading a token file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-fresh-gui-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createFreshInstallConfig({
    ownerTokenPath: join(root, "missing-owner.token"),
    connectorTokenPath: join(root, "missing-connector.token"),
    providerIds: [],
  });
  config.server.host = "192.0.2.10";
  const configPath = join(root, "config.json");
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  await assert.rejects(execFileAsync(process.execPath, ["src/cli.mjs", "install", "gui", "--config", configPath], {
    cwd: join(dirname(new URL(import.meta.url).pathname), ".."),
  }), (error) => /refuses plaintext authentication to a non-loopback/.test(error.stderr));
});

test("fresh GUI wait protection may converge active tasks to zero without Desktop closure approval", async (t) => {
  const base = await fixture(t, "gui-wait");
  const guiRoot = join(base.root, "gui-wait-install");
  const serviceDirectory = join(base.root, "gui-wait-services");
  await Promise.all([mkdir(guiRoot), mkdir(serviceDirectory)]);
  let inventoryReads = 0;
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 }, codex: {} }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(base.root, "gui-wait-recovery") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.5.0", latestVersion: "0.5.0", canContinueCurrent: true, retryable: true }) },
    listTasks: async () => {
      inventoryReads += 1;
      return inventoryReads === 1
        ? { groups: [{ project: "fixture", tasks: [{ id: "task-1", name: "Task", activeFlags: [], status: "running" }] }], evidence: { trusted: true, total: 1, active: 1, notLoaded: 0 } }
        : { groups: [], evidence: { trusted: true, total: 0, active: 0, notLoaded: 0 } };
    },
    freshInstallOptions: (session) => ({
      sourceRoot: base.sourceRoot,
      configPath: join(guiRoot, "config.jsonc"),
      ownerTokenPath: join(guiRoot, "secrets", "owner.token"),
      connectorTokenPath: join(guiRoot, "secrets", "connector.token"),
      stateRoot: join(base.root, "gui-wait-state"),
      serviceDirectory,
      ...(session.plan ? { commandRunner: lifecycleRunner(session.plan) } : {}),
    }),
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot: guiRoot, origin: { kind: "direct" } });
  const nonce = decodeURIComponent(new URL(created.url).hash.match(/session=([^&]+)/)[1]);
  await controller.bootstrap(nonce);
  const planned = await controller.plan(nonce, {
    freshInstall: true,
    components: ["daemon", "nous"],
    taskProtection: { taskIds: ["task-1"], disposition: "wait" },
  });
  assert.deepEqual(planned.plan.selectedProviderIds, ["nous"]);
  assert.equal(planned.plan.providerEvidence[0].status, "pending");
  await controller.protect(nonce, { taskIds: ["task-1"], disposition: "wait" });
  const receipt = await controller.apply(nonce, { approvedDigest: planned.plan.digest });
  assert.equal(receipt.status, "applied-pending-provider-and-host-activation");
  assert.equal("desktopClosureApproved" in receipt, false);
  const durable = await controller.recovery.read(created.sessionId);
  assert.equal(durable.result.digest, receipt.digest);
  assert.equal(durable.result.providerEvidence[0].status, "pending");
  assert.equal(durable.result.hostSurface.status, "pending");
});

test("fresh GUI session URL brackets accepted IPv6 loopback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-fresh-ipv6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new InstallerGuiController({ server: { host: "::1", port: 8743 }, codex: {} }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "recovery") }),
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot: join(root, "install"), origin: { kind: "direct" } });
  assert.match(created.url, /^http:\/\/\[::1\]:8743\//);
  assert.doesNotThrow(() => new URL(created.url));
});

test("fresh GUI cancellation propagates and cannot be overwritten by apply", async (t) => {
  const base = await fixture(t, "gui-cancel");
  const guiRoot = join(base.root, "gui-cancel-install");
  const serviceDirectory = join(base.root, "gui-cancel-services");
  await Promise.all([mkdir(guiRoot), mkdir(serviceDirectory)]);
  let releaseActivation;
  let enteredActivation;
  const entered = new Promise((resolveEntered) => { enteredActivation = resolveEntered; });
  const barrier = new Promise((resolveBarrier) => { releaseActivation = resolveBarrier; });
  let runner;
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 }, codex: {} }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(base.root, "gui-cancel-recovery") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.5.0", latestVersion: "0.5.0", canContinueCurrent: true, retryable: true }) },
    listTasks: async () => ({ groups: [], evidence: { trusted: true, total: 0, active: 0, notLoaded: 0 } }),
    freshInstallOptions: (session) => {
      if (session.plan && !runner) {
        const baseRunner = lifecycleRunner(session.plan);
        let held = false;
        runner = async (argv, context) => {
          if (!held && context.phase === "activate") { held = true; enteredActivation(); await barrier; }
          return baseRunner(argv, context);
        };
        runner.skipStableDelay = true;
        runner.testClaimRoot = baseRunner.testClaimRoot;
      }
      return {
        sourceRoot: base.sourceRoot,
        configPath: join(guiRoot, "config.jsonc"),
        ownerTokenPath: join(guiRoot, "secrets", "owner.token"),
        connectorTokenPath: join(guiRoot, "secrets", "connector.token"),
        stateRoot: join(base.root, "gui-cancel-state"),
        serviceDirectory,
        ...(runner ? { commandRunner: runner } : {}),
      };
    },
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot: guiRoot, origin: { kind: "direct" } });
  const nonce = decodeURIComponent(new URL(created.url).hash.match(/session=([^&]+)/)[1]);
  await controller.bootstrap(nonce);
  const planned = await controller.plan(nonce, { freshInstall: true, components: ["daemon"], taskProtection: { taskIds: [], disposition: "wait" } });
  await controller.protect(nonce, { taskIds: [], disposition: "wait" });
  const applying = controller.apply(nonce, { approvedDigest: planned.plan.digest });
  await entered;
  await controller.close(nonce, "cancel");
  releaseActivation();
  await assert.rejects(applying, /cancel/i);
  assert.equal(controller.authorize(nonce).state, "cancelled");
});

test("fresh GUI cancel remains terminal across blocked planning preflight", async (t) => {
  const base = await fixture(t, "gui-plan-cancel");
  const guiRoot = join(base.root, "gui-plan-cancel-install");
  await mkdir(guiRoot);
  let releaseOptions;
  let enteredOptions;
  const entered = new Promise((resolveEntered) => { enteredOptions = resolveEntered; });
  const barrier = new Promise((resolveBarrier) => { releaseOptions = resolveBarrier; });
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 }, codex: {} }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(base.root, "gui-plan-cancel-recovery") }),
    freshInstallOptions: async () => {
      enteredOptions();
      await barrier;
      return {
        sourceRoot: base.sourceRoot,
        configPath: join(guiRoot, "config.jsonc"),
        ownerTokenPath: join(guiRoot, "owner.token"),
        connectorTokenPath: join(guiRoot, "connector.token"),
        stateRoot: join(base.root, "gui-plan-cancel-state"),
        serviceDirectory: join(base.root, "gui-plan-cancel-services"),
      };
    },
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot: guiRoot, origin: { kind: "direct" } });
  const nonce = decodeURIComponent(new URL(created.url).hash.match(/session=([^&]+)/)[1]);
  const planning = controller.plan(nonce, { freshInstall: true, components: ["daemon"], taskProtection: { taskIds: [], disposition: "wait" } });
  await entered;
  await controller.close(nonce, "cancel");
  releaseOptions();
  await assert.rejects(planning, /cancel/i);
  assert.equal(controller.authorize(nonce).state, "cancelled");
  assert.equal((await controller.recovery.read(created.sessionId)).state, "cancelled");
});

test("staged provenance rejects a self-signed source-commit record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-fresh-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "cli.mjs"), "export const staged = true;\n");
  const sourceCommit = "a".repeat(40);
  const signedManifest = `${"b".repeat(64)}  threadspan-1.0.0.tar.gz\n# threadspan-source-commit ${sourceCommit}\n`;
  const signer = generateKeyPairSync("ed25519");
  assert.equal(parseSignedReleaseSourceCommit(signedManifest), sourceCommit);
  await mkdir(join(root, "src", "installer"), { recursive: true });
  await writeFile(join(root, "src", "installer", "release-signing-public-key.pem"), signer.publicKey.export({ type: "spki", format: "pem" }));
  await writeFile(join(root, ".threadspan-release.SHA256SUMS"), signedManifest, { mode: 0o600 });
  await writeFile(join(root, ".threadspan-release.SHA256SUMS.sig"), sign(null, Buffer.from(signedManifest), signer.privateKey), { mode: 0o600 });
  await writeFile(join(root, ".threadspan-release.tar.gz"), "not an official release archive", { mode: 0o600 });
  await writeFile(join(root, ".threadspan-release.json"), `${JSON.stringify({
    schemaVersion: 2,
    repository: "HaileyStorm/threadspan",
    version: "1.0.0",
    tag: "v1.0.0",
    bundleSha256: "b".repeat(64),
    provenanceKind: "publisher-signed-release-manifest",
    sourceCommit,
    signedManifestSha256: createHash("sha256").update(signedManifest).digest("hex"),
  })}\n`, { mode: 0o600 });
  await assert.rejects(resolveFreshInstallProvenance(root), /pinned official publisher key/);
  assert.throws(() => parseSignedReleaseSourceCommit(`${signedManifest}# threadspan-source-commit ${sourceCommit}\n`), /repeats/);
});

test("fresh apply creates separate owner-only credentials, sanitized pending evidence, replay, and exact uninstall", async (t) => {
  const { plan } = await fixture(t, "apply");
  const events = [];
  const runner = lifecycleRunner(plan, events);
  const preview = previewFreshInstallPlan(plan);
  assert.doesNotMatch(preview.text, /Bearer|tokenValue|authorization/i);
  const receipt = await applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
  });
  const [owner, connector, config] = await Promise.all([
    readFile(plan.tokens.owner.path, "utf8"),
    readFile(plan.tokens.connector.path, "utf8"),
    readFile(plan.config.path, "utf8"),
  ]);
  assert.notEqual(owner, connector);
  if (process.platform !== "win32") {
    assert.equal((await lstat(plan.tokens.owner.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(plan.tokens.connector.path)).mode & 0o777, 0o600);
    assert.equal((await lstat(plan.config.path)).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(owner.trim()));
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(owner.trim()));
  assert.doesNotMatch(await readFile(join(plan.stateRoot, "fresh-install-journal.json"), "utf8"), new RegExp(owner.trim()));
  const parsed = JSON.parse(config);
  assert.equal(parsed.server.authTokenFile, plan.tokens.owner.path);
  assert.equal(parsed.server.connectorTokenFile, plan.tokens.connector.path);
  assert.equal(parsed.server.authTokenEnv, null);
  assert.equal(parsed.server.connectorTokenEnv, null);
  assert.equal(parsed.providers.nous.enabled, false);
  assert.equal(receipt.providerEvidence[0].status, "pending");
  assert.equal(receipt.providerEvidence[0].live, false);
  assert.equal(receipt.status, "applied-pending-provider-and-host-activation");

  const beforeReplay = events.length;
  assert.deepEqual(await applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
  }), receipt);
  assert.equal(events.length, beforeReplay, "terminal replay must not execute lifecycle commands");

  const uninstall = await createFreshInstallUninstallPlan(plan);
  const uninstallReceipt = await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(uninstallReceipt.status, "uninstalled");
  for (const path of [plan.config.path, plan.tokens.owner.path, plan.tokens.connector.path, ...plan.componentChild.plan.operations.map((item) => join(plan.installRoot, item.relativePath))]) {
    await assert.rejects(readFile(path), /ENOENT/);
  }
  assert.deepEqual(await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner }), uninstallReceipt);
});

test("fresh plan refuses existing config or token targets and apply rejects cross-platform plans before mutation", async (t) => {
  const { plan, sourceRoot, installRoot, root } = await fixture(t, "refusal");
  const existing = join(installRoot, "already-there.token");
  await writeFile(existing, "owner data\n", { mode: 0o600 });
  await assert.rejects(createFreshInstallPlan({
    planId: "fresh-existing",
    platform: process.platform,
    installRoot,
    configPath: join(installRoot, "new-config.jsonc"),
    ownerTokenPath: existing,
    connectorTokenPath: join(installRoot, "new-connector.token"),
    sourceRoot,
    stateRoot: join(root, "other-state"),
    serviceDirectory: join(root, "other-services"),
    legacyStartupPath: join(root, "legacy", "Threadspan.cmd"),
    componentIds: ["daemon"],
  }), /refuses existing target/);

  const mismatched = structuredClone(plan);
  mismatched.platform = process.platform === "linux" ? "win32" : "linux";
  const stable = (value) => value === null || typeof value !== "object" ? JSON.stringify(value)
    : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  const { digest: _digest, ...payload } = mismatched;
  mismatched.digest = createHash("sha256").update(stable(payload)).digest("hex");
  await assert.rejects(applyFreshInstallPlan(mismatched, {
    approvedDigest: mismatched.digest,
    approvedTaskProtectionDigest: mismatched.taskProtection.digest,
  }), /does not match native platform/);
  await assert.rejects(readFile(plan.config.path), /ENOENT/);

  const standaloneMismatch = structuredClone(plan.serviceChild.plan);
  standaloneMismatch.platform = process.platform === "linux" ? "win32" : "linux";
  await assert.rejects(applyDaemonServicePlan(standaloneMismatch, { approvedDigest: standaloneMismatch.digest }), /does not match native platform/);
});

test("fresh apply resumes after durable component checkpoint and rolls back service then components then credentials", async (t) => {
  const resumedFixture = await fixture(t, "resume");
  const resumeEvents = [];
  const runner = lifecycleRunner(resumedFixture.plan, resumeEvents);
  const interrupted = new Error("simulated exit");
  interrupted.simulatedProcessExit = true;
  await assert.rejects(applyFreshInstallPlan(resumedFixture.plan, {
    approvedDigest: resumedFixture.plan.digest,
    approvedTaskProtectionDigest: resumedFixture.plan.taskProtection.digest,
    commandRunner: runner,
    checkpoint: async (stage) => { if (stage === "components-applied") throw interrupted; },
  }), /simulated exit/);
  const receipt = await applyFreshInstallPlan(resumedFixture.plan, {
    approvedDigest: resumedFixture.plan.digest,
    approvedTaskProtectionDigest: resumedFixture.plan.taskProtection.digest,
    commandRunner: runner,
  });
  assert.equal(receipt.status, "applied-pending-provider-and-host-activation");

  const rollbackFixture = await fixture(t, "rollback-order");
  const order = [];
  const rollbackRunner = lifecycleRunner(rollbackFixture.plan, order);
  await assert.rejects(applyFreshInstallPlan(rollbackFixture.plan, {
    approvedDigest: rollbackFixture.plan.digest,
    approvedTaskProtectionDigest: rollbackFixture.plan.taskProtection.digest,
    commandRunner: rollbackRunner,
    checkpoint: async (stage) => { if (stage === "service-applied") throw new Error("later child failed"); },
  }), /later child failed/);
  assert.ok(order.includes("deactivate"), "service must be deactivated first");
  await assert.rejects(readFile(rollbackFixture.plan.config.path), /ENOENT/);
  await assert.rejects(readFile(rollbackFixture.plan.tokens.owner.path), /ENOENT/);
  await assert.rejects(readFile(join(rollbackFixture.plan.installRoot, rollbackFixture.plan.componentChild.plan.operations[0].relativePath)), /ENOENT/);
});

test("fresh parent resumes a component child left prepared after a process exit", async (t) => {
  const { plan } = await fixture(t, "component-prepared-resume");
  const runner = lifecycleRunner(plan);
  const interrupted = new Error("component process exit");
  interrupted.simulatedProcessExit = true;
  await assert.rejects(applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
    componentCheckpoint: async () => { throw interrupted; },
  }), /component process exit/);
  const componentManifestPath = join(plan.installRoot, plan.componentChild.plan.rollbackManifest);
  assert.equal(JSON.parse(await readFile(componentManifestPath, "utf8")).status, "prepared");
  const receipt = await applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
  });
  assert.equal(receipt.status, "applied-pending-provider-and-host-activation");
  assert.equal(JSON.parse(await readFile(componentManifestPath, "utf8")).status, "applied");
});

test("fresh apply rechecks the full source tree immediately before service activation", async (t) => {
  const { plan, sourceRoot } = await fixture(t, "source-recheck");
  const runner = lifecycleRunner(plan);
  await assert.rejects(applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
    checkpoint: async (stage) => {
      if (stage === "components-applied") await writeFile(join(sourceRoot, "src", "module.mjs"), "export const imported = 'tampered';\n");
    },
  }), /source provenance changed|clean checkout|authenticated bundle metadata/);
  await assert.rejects(readFile(plan.config.path), /ENOENT/);
});

test("fresh parent claim rejects a concurrent apply before duplicate lifecycle commands", async (t) => {
  const { plan } = await fixture(t, "concurrency");
  const events = [];
  const base = lifecycleRunner(plan, events);
  let releaseActivation;
  let enteredActivation;
  const entered = new Promise((resolveEntered) => { enteredActivation = resolveEntered; });
  const barrier = new Promise((resolveBarrier) => { releaseActivation = resolveBarrier; });
  let held = false;
  const runner = async (argv, context) => {
    if (!held && context.phase === "activate") {
      held = true;
      enteredActivation();
      await barrier;
    }
    return base(argv, context);
  };
  runner.skipStableDelay = true;
  runner.testClaimRoot = base.testClaimRoot;
  const first = applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
  });
  await entered;
  const before = events.length;
  await assert.rejects(applyFreshInstallPlan(plan, {
    approvedDigest: plan.digest,
    approvedTaskProtectionDigest: plan.taskProtection.digest,
    commandRunner: runner,
  }), /owns the claim/);
  assert.equal(events.length, before);
  releaseActivation();
  await first;
});

test("terminal fresh replay rejects non-applied child durable state without commands", async (t) => {
  const { plan } = await fixture(t, "terminal-child-state");
  const events = [];
  const runner = lifecycleRunner(plan, events);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const manifestPath = join(plan.serviceChild.plan.stateRoot, "manifests", `${plan.serviceChild.plan.planId}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.status = "rollback-incomplete";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const before = events.length;
  await assert.rejects(applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner }), /durable state is rollback-incomplete/);
  assert.equal(events.length, before);
});

test("component uninstall restores exact existing-file mode", async (t) => {
  const { plan } = await fixture(t, "mode");
  const target = join(plan.installRoot, plan.componentChild.plan.operations[0].relativePath);
  await mkdir(dirname(target), { recursive: true });
  const preimage = `${JSON.stringify({ schemaVersion: 1, component: "daemon", ownerSetting: "preserve" }, null, 2)}\n`;
  await writeFile(target, preimage, { mode: 0o640 });
  await chmod(target, 0o640);
  const replanned = await createFreshInstallPlan({
    planId: "fresh-mode-replanned",
    platform: process.platform,
    installRoot: plan.installRoot,
    configPath: plan.config.path,
    ownerTokenPath: plan.tokens.owner.path,
    connectorTokenPath: plan.tokens.connector.path,
    sourceRoot: plan.provenance.sourceRoot,
    stateRoot: join(plan.stateRoot, "replanned"),
    serviceDirectory: dirname(plan.serviceChild.plan.files[0].path),
    legacyStartupPath: plan.serviceChild.plan.legacyStartup?.path,
    home: dirname(plan.installRoot),
    componentIds: ["daemon"],
  });
  const runner = lifecycleRunner(replanned);
  await applyFreshInstallPlan(replanned, { approvedDigest: replanned.digest, approvedTaskProtectionDigest: replanned.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(replanned);
  await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(await readFile(target, "utf8"), preimage);
  if (process.platform !== "win32") assert.equal((await lstat(target)).mode & 0o777, 0o640);
});

test("fresh uninstall resumes after config removal without deleting drifted credentials", async (t) => {
  const { plan } = await fixture(t, "uninstall-resume");
  const runner = lifecycleRunner(plan);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(plan);
  const interrupted = new Error("uninstall process exit");
  interrupted.simulatedProcessExit = true;
  await assert.rejects(applyFreshInstallUninstallPlan(uninstall, {
    approvedDigest: uninstall.digest,
    commandRunner: runner,
    uninstallCheckpoint: async (stage) => { if (stage === "config-removed") throw interrupted; },
  }), /uninstall process exit/);
  await assert.rejects(readFile(plan.config.path), /ENOENT/);
  assert.equal((await readFile(plan.tokens.owner.path, "utf8")).length > 40, true);
  const receipt = await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(receipt.status, "uninstalled");
});

test("fresh uninstall resumes the same approved service child plan after its uninstalling checkpoint", async (t) => {
  const { plan } = await fixture(t, "service-uninstall-resume");
  const runner = lifecycleRunner(plan);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(plan);
  const interrupted = new Error("service uninstall process exit");
  interrupted.simulatedProcessExit = true;
  await assert.rejects(applyFreshInstallUninstallPlan(uninstall, {
    approvedDigest: uninstall.digest,
    commandRunner: runner,
    serviceCheckpoint: async (stage) => { if (stage === "uninstalling-persisted") throw interrupted; },
  }), /service uninstall process exit/);
  const receipt = await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(receipt.status, "uninstalled");
});

test("fresh uninstall resumes the same approved component child plan after its uninstalling checkpoint", async (t) => {
  const { plan } = await fixture(t, "component-uninstall-resume");
  const runner = lifecycleRunner(plan);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(plan);
  const interrupted = new Error("component uninstall process exit");
  interrupted.simulatedProcessExit = true;
  await assert.rejects(applyFreshInstallUninstallPlan(uninstall, {
    approvedDigest: uninstall.digest,
    commandRunner: runner,
    componentUninstallCheckpoint: async () => { throw interrupted; },
  }), /component uninstall process exit/);
  const receipt = await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(receipt.status, "uninstalled");
});

test("fresh uninstall retries the same service child after failed deactivation recovers installed state", async (t) => {
  const { plan } = await fixture(t, "service-deactivate-retry");
  const baseRunner = lifecycleRunner(plan);
  let failed = false;
  const runner = async (argv, context) => {
    if (!failed && context.phase === "deactivate") { failed = true; return { exitCode: 9, stdout: "", stderr: "private failure" }; }
    return baseRunner(argv, context);
  };
  runner.skipStableDelay = true;
  runner.testClaimRoot = baseRunner.testClaimRoot;
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(plan);
  await assert.rejects(applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner }), /incomplete/);
  const receipt = await applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner });
  assert.equal(receipt.status, "uninstalled");
});

test("component uninstall planning rejects a symlinked manifest ancestor", async (t) => {
  const { plan, root } = await fixture(t, "component-manifest-symlink");
  const runner = lifecycleRunner(plan);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const stateDirectory = join(plan.installRoot, ".threadspan-installer");
  const redirected = join(root, "redirected-component-state");
  await rename(stateDirectory, redirected);
  await symlink(redirected, stateDirectory, "dir");
  await assert.rejects(createFreshInstallUninstallPlan(plan), /symbolic link|symlink/i);
});

test("fresh uninstall rejects a substituted parent journal before child mutation", async (t) => {
  const { plan } = await fixture(t, "uninstall-journal-binding");
  const events = [];
  const runner = lifecycleRunner(plan, events);
  await applyFreshInstallPlan(plan, { approvedDigest: plan.digest, approvedTaskProtectionDigest: plan.taskProtection.digest, commandRunner: runner });
  const uninstall = await createFreshInstallUninstallPlan(plan);
  const journalPath = join(plan.stateRoot, "fresh-install-journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.planDigest = "f".repeat(64);
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const before = events.length;
  await assert.rejects(applyFreshInstallUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: runner }), /does not match the approved uninstall/);
  assert.equal(events.length, before);
});
