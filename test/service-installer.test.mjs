import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  applyDaemonServicePlan,
  applyDaemonServiceUninstallPlan,
  createDaemonServicePlan,
  createDaemonServiceUninstallPlan,
  computeServicePlanDigest,
  previewDaemonServicePlan,
  previewDaemonServiceUninstallPlan,
  readDaemonServiceLifecycleClaim,
  resolveDaemonServiceClaimRoot,
} from "../src/installer/index.mjs";

async function lifecycleFixture(t, platform = "linux", suffix = "") {
  const root = await mkdtemp(join(tmpdir(), `threadspan-service-${platform}-${suffix}`));
  const serviceDirectory = join(root, "service-directory");
  const stateRoot = join(root, "state");
  const cliPath = join(root, `source ${suffix || "current"}`, "cli.mjs");
  await mkdir(serviceDirectory, { recursive: true });
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "export const revision = 'c4f4113';\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = createDaemonServicePlan({
    platform,
    nodePath: process.execPath,
    cliPath,
    configPath: join(root, "config's reviewed.jsonc"),
    sourceRevision: "c4f4113",
    lifecycleOwner: "desktop-main-owner",
    stateRoot,
    serviceDirectory,
    legacyStartupPath: join(root, "legacy-startup", "Threadspan.cmd"),
    home: root,
    providerEnvironmentVariables: ["NOUS_API_KEY"],
    planId: `service-${platform}-${(suffix || "current").replace(/[^A-Za-z0-9._-]/g, "-")}`,
  });
  return { root, serviceDirectory, stateRoot, cliPath, plan };
}

function lifecycleRunner(plan, options = {}) {
  let installed = options.installed === true;
  let activationCalls = 0;
  const fragment = `owner-sha256=${plan.ownerFingerprint} revision=${plan.source.revision}`;
  const calls = [];
  const runner = async (_argv, context) => {
    calls.push(context);
    if (context.phase === "inspect") {
      if (!installed) return { exitCode: plan.platform === "win32" ? 3 : 1, stdout: "", stderr: "" };
      const role = context.id.includes("desktop") ? "desktop-host" : "daemon";
      const stdout = plan.platform === "linux" ? plan.files.find((file) => file.role === role).content : fragment;
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (context.phase === "activate" || context.phase === "recover") {
      activationCalls += 1;
      if (options.failActivationAt === activationCalls) return { exitCode: 9, stdout: "", stderr: "private account diagnostic" };
      installed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (["verify", "verify-resumed", "uninstall-rollback-verify"].includes(context.phase)) {
      if (options.failRecovery && context.phase === "uninstall-rollback-verify") return { exitCode: 1, stdout: "", stderr: "" };
      const stdout = context.id === "daemon-health" ? "ok" : context.id.endsWith("enabled") ? "enabled" : plan.platform === "win32" ? (options.windowsReady ? "Ready" : "Running") : "active";
      return { exitCode: 0, stdout, stderr: "" };
    }
    if (context.phase === "deactivate" || context.phase === "rollback") {
      if (options.failRollback && context.phase === "rollback") return { exitCode: 1, stdout: "", stderr: "cleanup failed" };
      if (options.failDeactivate && context.phase === "deactivate") return { exitCode: 1, stdout: "", stderr: "partial cleanup" };
      installed = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (context.phase === "verify-absent" || context.phase === "rollback-verify-absent") {
      return { exitCode: options.linuxAbsentExit4 && plan.platform === "linux" ? 4 : 3, stdout: plan.platform === "linux" ? (options.linuxAbsentExit4 ? "unknown" : "inactive") : "", stderr: "" };
    }
    if (context.phase === "uninstall-rollback") {
      if (options.failRecovery) return { exitCode: 1, stdout: "", stderr: "repair failed" };
      installed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (context.phase === "finalize") return { exitCode: options.failFinalize ? 1 : 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected phase ${context.phase}`);
  };
  runner.skipStableDelay = true;
  runner.testClaimRoot = join(tmpdir(), `threadspan-lifecycle-test-claims-${process.pid}`);
  return { runner, calls, isInstalled: () => installed };
}

test("Linux lifecycle binds daemon and Desktop host to one exact revision without credential values", async (t) => {
  const { plan } = await lifecycleFixture(t, "linux");
  assert.equal(plan.lifecycleKind, "systemd-user");
  assert.deepEqual(plan.workloads.map((item) => item.id), ["daemon", "desktop-host"]);
  assert.equal(plan.workloads.every((item) => item.sourceRevision === "c4f4113" && item.ownerFingerprint === plan.ownerFingerprint), true);
  assert.equal(plan.files.length, 2);
  assert.match(plan.files[0].content, /PassEnvironment=THREADSPAN_TOKEN NOUS_API_KEY/);
  assert.match(plan.files[0].content, /KillMode=control-group\nTimeoutStopSec=10s/);
  assert.match(plan.files[1].content, /desktop attach --config/);
  assert.doesNotMatch(plan.files.map((file) => file.content).join("\n"), /PrivateTmp|secret-value|NOUS_API_KEY=/);
  assert.deepEqual(plan.commands.activate[1].argv, ["systemctl", "--user", "enable", "--now", "threadspan.service", "threadspan-desktop-host.service"]);
  assert.equal(previewDaemonServicePlan(plan).digest, plan.digest);
});

test("service plan imports only selected configured provider environment names", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "selection");
  const plan = createDaemonServicePlan({
    platform: "linux",
    nodePath: process.execPath,
    cliPath: fixture.cliPath,
    configPath: join(fixture.root, "config.jsonc"),
    sourceRevision: "0123456789abcdef",
    lifecycleOwner: "configured-owner",
    stateRoot: fixture.stateRoot,
    serviceDirectory: fixture.serviceDirectory,
    providerIds: ["nous"],
    config: {
      server: { authTokenEnv: "THREADSPAN_OWNER_TOKEN", connectorTokenEnv: "THREADSPAN_CONNECTOR_TOKEN" },
      providers: {
        nous: { adapter: "nous", apiKeyEnv: "NOUS_API_KEY" },
        openrouter: { adapter: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY" },
      },
    },
  });
  assert.deepEqual(plan.environmentVariables, ["THREADSPAN_OWNER_TOKEN", "THREADSPAN_CONNECTOR_TOKEN", "NOUS_API_KEY"]);
  assert.doesNotMatch(JSON.stringify(plan), /OPENROUTER_API_KEY|NOUS_API_KEY=/);
});

test("Linux systemd and Windows PowerShell arguments escape reviewed paths", async (t) => {
  const linux = await lifecycleFixture(t, "linux", "100% $THREADSPAN_TOKEN \"quoted\"");
  assert.match(linux.plan.files[0].content, /100%% \$\$THREADSPAN_TOKEN \\"quoted\\"/);
  assert.doesNotMatch(linux.plan.files[0].content, /source 100%% \$THREADSPAN_TOKEN/);
  const windows = await lifecycleFixture(t, "win32", "owner's path");
  const content = windows.plan.files.map((file) => file.content).join("\n");
  assert.match(content, /config''s reviewed\.jsonc/);
  assert.match(content, /source owner''s path/);
  assert.doesNotMatch(content, /Start Menu|Startup|Threadspan\.cmd/);
});

test("Windows lifecycle uses per-user Task Scheduler for daemon and Desktop host", async (t) => {
  const { plan } = await lifecycleFixture(t, "win32");
  assert.equal(plan.lifecycleKind, "windows-task-scheduler");
  assert.deepEqual(plan.workloads.map((item) => item.taskName), ["Threadspan Daemon", "Threadspan Desktop Host"]);
  assert.equal(plan.files.length, 4);
  const register = plan.files.find((file) => file.role === "task-registration").content;
  assert.match(register, /New-ScheduledTaskPrincipal -UserId \$identity -LogonType Interactive -RunLevel Limited/);
  assert.match(register, /New-ScheduledTaskSettingsSet -Hidden/);
  assert.match(register, /param\(\[switch\]\$Repair\)/);
  assert.match(register, /Register-ScheduledTask/);
  assert.match(register, /Start-ScheduledTask -TaskName 'Threadspan Daemon'/);
  assert.doesNotMatch(plan.files.map((file) => file.path).join("\n"), /Start Menu|Startup|Threadspan\.cmd/);
  assert.equal(plan.legacyStartup.state, "absent");
  assert.doesNotMatch(JSON.stringify(plan), /NOUS_API_KEY=/);
  assert.match(plan.commands.verify[0].argv.at(-1), /attempt -lt 20/);
  assert.match(plan.commands.verify[0].argv.at(-1), /Start-Sleep -Milliseconds 250/);
});

test("service plan requires exact source and opaque owner bindings", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "binding");
  const base = {
    platform: "linux", nodePath: process.execPath, cliPath: fixture.cliPath, configPath: join(fixture.root, "config.jsonc"),
    stateRoot: fixture.stateRoot, serviceDirectory: fixture.serviceDirectory, providerEnvironmentVariables: [],
  };
  assert.throws(() => createDaemonServicePlan({ ...base, lifecycleOwner: "valid-owner", sourceRevision: "HEAD" }), /exact .* revision/);
  assert.throws(() => createDaemonServicePlan({ ...base, lifecycleOwner: "short", sourceRevision: "c4f4113" }), /opaque identifier/);
  assert.throws(() => createDaemonServicePlan({ ...base, lifecycleOwner: "valid-owner", sourceRevision: "c4f4113", cliSha256: "bad" }), /SHA-256/);
});

test("service plan validation rejects skipped stable verification and previews expectations", async (t) => {
  const { plan } = await lifecycleFixture(t, "linux", "stable-validation");
  const malformed = structuredClone(plan);
  malformed.commands.verify[0].expectation.stableSamples = 0;
  malformed.digest = computeServicePlanDigest(malformed);
  assert.throws(() => previewDaemonServicePlan(malformed), /stableSamples/);
  assert.match(previewDaemonServicePlan(plan).text, /stableSamples.*2/);
  const windows = await lifecycleFixture(t, "win32", "ready-semantic-bypass");
  const weakened = structuredClone(windows.plan);
  weakened.commands.verify[0].expectation.stdout = ["Ready"];
  weakened.digest = computeServicePlanDigest(weakened);
  assert.throws(() => previewDaemonServicePlan(weakened), /not canonical/);
  const duplicate = structuredClone(plan);
  duplicate.commands.verify = Array.from({ length: duplicate.commands.verify.length }, () => structuredClone(duplicate.commands.verify[0]));
  duplicate.digest = computeServicePlanDigest(duplicate);
  assert.throws(() => previewDaemonServicePlan(duplicate), /exact canonical set/);
  const constant = structuredClone(plan);
  constant.commands.verify.find((command) => command.id === "daemon-health").argv = [process.execPath, "-e", "process.stdout.write('ok')"];
  constant.digest = computeServicePlanDigest(constant);
  assert.throws(() => previewDaemonServicePlan(constant), /health command is not canonical/);
  const noInspect = structuredClone(plan);
  noInspect.commands.inspect = [];
  noInspect.digest = computeServicePlanDigest(noInspect);
  assert.throws(() => previewDaemonServicePlan(noInspect), /inspect command IDs/);
  const weakAbsent = structuredClone(windows.plan);
  weakAbsent.commands.verifyAbsent[0].expectation = { exitCodes: [0] };
  weakAbsent.digest = computeServicePlanDigest(weakAbsent);
  assert.throws(() => previewDaemonServicePlan(weakAbsent), /expectation is not canonical/);
  const weakFinalize = structuredClone(plan);
  weakFinalize.commands.finalize[0].expectation = { exitCodes: [0, 1] };
  weakFinalize.digest = computeServicePlanDigest(weakFinalize);
  assert.throws(() => previewDaemonServicePlan(weakFinalize), /expectation is not canonical/);
});

test("apply rejects source drift and duplicate lifecycle ownership before mutation", async (t) => {
  const sourceDrift = await lifecycleFixture(t, "linux", "source-drift");
  await writeFile(sourceDrift.cliPath, "changed after preview\n");
  const absent = lifecycleRunner(sourceDrift.plan);
  await assert.rejects(
    applyDaemonServicePlan(sourceDrift.plan, { approvedDigest: sourceDrift.plan.digest, commandRunner: absent.runner }),
    /source changed after preview/,
  );
  assert.equal(absent.calls.length, 0);

  const duplicate = await lifecycleFixture(t, "linux", "duplicate");
  const present = lifecycleRunner(duplicate.plan, { installed: true });
  await assert.rejects(
    applyDaemonServicePlan(duplicate.plan, { approvedDigest: duplicate.plan.digest, commandRunner: present.runner }),
    /duplicate lifecycle ownership/,
  );
  await assert.rejects(readFile(duplicate.plan.files[0].path), /ENOENT/);
});

test("activation failure restores exact file preimages and never returns private diagnostics", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "rollback");
  const fake = lifecycleRunner(plan, { failActivationAt: 2 });
  await assert.rejects(
    applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner }),
    (error) => {
      assert.doesNotMatch(error.message, /private account diagnostic/);
      return /enable-start exited 9/.test(error.message);
    },
  );
  for (const file of plan.files) await assert.rejects(readFile(file.path), /ENOENT/);
  const manifest = JSON.parse(await readFile(join(stateRoot, "manifests", `${plan.planId}.json`), "utf8"));
  assert.equal(manifest.status, "rolled-back-after-error");
  assert.doesNotMatch(JSON.stringify(manifest), /private account diagnostic/);
});

test("failed rollback stays incomplete and retains generated files for manual recovery", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "rollback-incomplete");
  const fake = lifecycleRunner(plan, { failActivationAt: 2, failRollback: true });
  await assert.rejects(
    applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner }),
    /rollback was incomplete/,
  );
  for (const file of plan.files) assert.equal(typeof await readFile(file.path, "utf8"), "string");
  const manifest = JSON.parse(await readFile(join(stateRoot, "manifests", `${plan.planId}.json`), "utf8"));
  assert.equal(manifest.status, "rollback-incomplete");
});

test("Windows apply requires tasks to remain Running after activation", async (t) => {
  const { plan } = await lifecycleFixture(t, "win32", "ready-is-not-running");
  const fake = lifecycleRunner(plan, { windowsReady: true });
  await assert.rejects(
    applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner }),
    /verification failed/,
  );
  for (const file of plan.files) await assert.rejects(readFile(file.path), /ENOENT/);
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} apply and uninstall use the same digest-bound core with sanitized receipts`, async (t) => {
    const { plan, stateRoot } = await lifecycleFixture(t, platform, "round-trip");
    const fake = lifecycleRunner(plan);
    const applied = await applyDaemonServicePlan(plan, { approvedDigest: previewDaemonServicePlan(plan).digest, commandRunner: fake.runner });
    assert.equal(applied.status, "applied-pending-runtime-ownership");
    assert.equal(applied.runtimeOwnershipVerified, false);
    assert.equal(fake.isInstalled(), true);
    assert.deepEqual(applied.files.map((item) => Object.keys(item)), applied.files.map(() => ["role", "installedSha256"]));
    assert.equal(JSON.stringify(applied).includes(stateRoot), false);
    assert.doesNotMatch(JSON.stringify(applied), /NOUS_API_KEY|USERPROFILE|private account|desktop-main-owner/);

    const manifestPath = join(stateRoot, "manifests", `${plan.planId}.json`);
    const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
    await assert.rejects(applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: "0".repeat(64), commandRunner: fake.runner }), /requires the digest/);
    assert.equal(previewDaemonServiceUninstallPlan(uninstall).digest, uninstall.digest);
    const removed = await applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner });
    assert.equal(removed.status, "uninstalled");
    assert.equal(removed.planId, uninstall.planId);
    assert.equal(removed.digest, uninstall.digest);
    assert.equal(removed.installPlanId, plan.planId);
    assert.equal(removed.installPlanDigest, plan.digest);
    assert.deepEqual(removed.commands.deactivate, plan.commands.deactivate.map((command) => command.id));
    assert.deepEqual(removed.commands.verifyAbsent, plan.commands.verifyAbsent.map((command) => command.id));
    assert.deepEqual(removed.commands.finalize, plan.commands.finalize.map((command) => command.id));
    assert.equal(fake.isInstalled(), false);
    for (const file of plan.files) await assert.rejects(readFile(file.path), /ENOENT/);
    assert.doesNotMatch(JSON.stringify(removed), /NOUS_API_KEY|USERPROFILE|desktop-main-owner/);
  });
}

test("uninstall rejects installed-file drift before stopping lifecycle ownership", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "uninstall-drift");
  const fake = lifecycleRunner(plan);
  await applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner });
  const uninstall = await createDaemonServiceUninstallPlan(join(stateRoot, "manifests", `${plan.planId}.json`));
  await writeFile(plan.files[0].path, "owner edit after install\n");
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /installed or restored file drift/,
  );
  assert.equal(fake.isInstalled(), true);
});

test("Windows planning fails closed on the published Startup predecessor without deleting it", async (t) => {
  const fixture = await lifecycleFixture(t, "win32", "legacy-predecessor");
  const legacyPath = fixture.plan.legacyStartup.path;
  await mkdir(dirname(legacyPath), { recursive: true });
  await writeFile(legacyPath, "@echo off\r\nlegacy-owner-sentinel\r\n");
  assert.throws(() => createDaemonServicePlan({
    platform: "win32",
    nodePath: process.execPath,
    cliPath: fixture.cliPath,
    configPath: join(fixture.root, "config.jsonc"),
    sourceRevision: "c4f4113",
    lifecycleOwner: "legacy-test-owner",
    stateRoot: fixture.stateRoot,
    home: fixture.root,
    legacyStartupPath: legacyPath,
    providerEnvironmentVariables: [],
  }), /Published Windows Startup predecessor detected/);
  assert.match(await readFile(legacyPath, "utf8"), /legacy-owner-sentinel/);
});

test("exclusive lifecycle claim makes concurrent apply loser filesystem and command silent", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "concurrent-apply");
  const winner = lifecycleRunner(plan);
  const loser = lifecycleRunner(plan);
  let releaseBarrier;
  let enterBarrier;
  const entered = new Promise((resolveEntered) => { enterBarrier = resolveEntered; });
  const release = new Promise((resolveRelease) => { releaseBarrier = resolveRelease; });
  const first = applyDaemonServicePlan(plan, {
    approvedDigest: plan.digest,
    commandRunner: winner.runner,
    checkpoint: async (name) => { if (name === "activation-ownership-began") { enterBarrier(); await release; } },
  });
  await entered;
  await assert.rejects(
    applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: loser.runner }),
    /exclusive claim/,
  );
  assert.equal(loser.calls.length, 0);
  releaseBarrier();
  assert.equal((await first).status, "applied-pending-runtime-ownership");
  await assert.rejects(readFile(join(winner.runner.testClaimRoot, ".lifecycle.claim.json")), /ENOENT/);
});

test("cross-root plans for the same canonical workloads share one runtime claim namespace", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "cross-root-claims");
  const secondPlan = createDaemonServicePlan({
    platform: "linux",
    nodePath: process.execPath,
    cliPath: fixture.cliPath,
    configPath: join(fixture.root, "config's reviewed.jsonc"),
    sourceRevision: "c4f4113",
    lifecycleOwner: "desktop-main-owner",
    stateRoot: join(fixture.root, "alternate-state"),
    serviceDirectory: fixture.serviceDirectory,
    home: fixture.root,
    providerEnvironmentVariables: ["NOUS_API_KEY"],
    planId: "alternate-cross-root",
  });
  const winner = lifecycleRunner(fixture.plan);
  const loser = lifecycleRunner(secondPlan);
  assert.equal(winner.runner.testClaimRoot, loser.runner.testClaimRoot);
  let releaseBarrier;
  let enterBarrier;
  const entered = new Promise((resolveEntered) => { enterBarrier = resolveEntered; });
  const release = new Promise((resolveRelease) => { releaseBarrier = resolveRelease; });
  const first = applyDaemonServicePlan(fixture.plan, {
    approvedDigest: fixture.plan.digest,
    commandRunner: winner.runner,
    checkpoint: async (name) => { if (name === "activation-ownership-began") { enterBarrier(); await release; } },
  });
  await entered;
  await assert.rejects(applyDaemonServicePlan(secondPlan, { approvedDigest: secondPlan.digest, commandRunner: loser.runner }), /exclusive claim/);
  assert.equal(loser.calls.length, 0);
  releaseBarrier();
  await first;
});

test("production claim root is invariant under HOME and USERPROFILE changes", () => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = "/tmp/caller-controlled-home-a";
    process.env.USERPROFILE = "/tmp/caller-controlled-profile-a";
    const first = resolveDaemonServiceClaimRoot();
    process.env.HOME = "/tmp/caller-controlled-home-b";
    process.env.USERPROFILE = "/tmp/caller-controlled-profile-b";
    assert.equal(resolveDaemonServiceClaimRoot(), first);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
});

test("pre-activation file failure never issues lifecycle deactivation", async (t) => {
  const { plan } = await lifecycleFixture(t, "linux", "no-premature-deactivate");
  const fake = lifecycleRunner(plan);
  await assert.rejects(applyDaemonServicePlan(plan, {
    approvedDigest: plan.digest,
    commandRunner: fake.runner,
    checkpoint: async (name) => { if (name === "file-written:daemon") throw new Error("synthetic file-phase failure"); },
  }), /synthetic file-phase failure/);
  assert.equal(fake.calls.some((call) => ["rollback", "rollback-verify-absent"].includes(call.phase)), false);
});

test("Windows apply rechecks an appearing legacy Startup predecessor before commands", async (t) => {
  const fixture = await lifecycleFixture(t, "win32", "legacy-appeared");
  await mkdir(dirname(fixture.plan.legacyStartup.path), { recursive: true });
  await writeFile(fixture.plan.legacyStartup.path, "legacy appeared after preview\r\n");
  const fake = lifecycleRunner(fixture.plan);
  await assert.rejects(applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner }), /appeared after preview/);
  assert.equal(fake.calls.length, 0);
  assert.match(await readFile(fixture.plan.legacyStartup.path, "utf8"), /legacy appeared/);
});

test("Windows prepared-state resume rechecks the legacy Startup predecessor", async (t) => {
  const fixture = await lifecycleFixture(t, "win32", "legacy-resume");
  const fake = lifecycleRunner(fixture.plan);
  await assert.rejects(applyDaemonServicePlan(fixture.plan, {
    approvedDigest: fixture.plan.digest,
    commandRunner: fake.runner,
    checkpoint: async (name) => {
      if (name === "file-written:daemon") {
        const error = new Error("simulated process exit");
        error.simulatedProcessExit = true;
        throw error;
      }
    },
  }), /simulated process exit/);
  await mkdir(dirname(fixture.plan.legacyStartup.path), { recursive: true });
  await writeFile(fixture.plan.legacyStartup.path, "legacy before resume\r\n");
  const callsBefore = fake.calls.length;
  await assert.rejects(applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner }), /appeared after preview/);
  assert.equal(fake.calls.length, callsBefore);
});

test("exclusive lifecycle claim prevents concurrent uninstall loser from deactivating winner", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "concurrent-uninstall");
  const installed = lifecycleRunner(plan);
  await applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: installed.runner });
  const manifestPath = join(stateRoot, "manifests", `${plan.planId}.json`);
  const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
  let releaseBarrier;
  let enterBarrier;
  const entered = new Promise((resolveEntered) => { enterBarrier = resolveEntered; });
  const release = new Promise((resolveRelease) => { releaseBarrier = resolveRelease; });
  const winnerCalls = [];
  const winnerRunner = async (argv, context) => {
    winnerCalls.push(context);
    if (context.phase === "deactivate") { enterBarrier(); await release; }
    return installed.runner(argv, context);
  };
  winnerRunner.skipStableDelay = true;
  winnerRunner.testClaimRoot = installed.runner.testClaimRoot;
  const loser = lifecycleRunner(plan, { installed: true });
  const first = applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: winnerRunner });
  await entered;
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: loser.runner }),
    /exclusive claim/,
  );
  assert.equal(loser.calls.length, 0);
  releaseBarrier();
  assert.equal((await first).status, "uninstalled");
  assert.equal(winnerCalls.filter((call) => call.phase === "deactivate").length, plan.commands.deactivate.length);
});

test("prepared and activating apply states resume idempotently at deterministic kill points", async (t) => {
  for (const checkpointName of ["file-written:daemon", "activation-complete"]) {
    const fixture = await lifecycleFixture(t, "linux", `resume-${checkpointName.replace(/[^a-z]/g, "-")}`);
    const fake = lifecycleRunner(fixture.plan);
    let interrupted = false;
    await assert.rejects(applyDaemonServicePlan(fixture.plan, {
      approvedDigest: fixture.plan.digest,
      commandRunner: fake.runner,
      checkpoint: async (name) => {
        if (!interrupted && name === checkpointName) {
          interrupted = true;
          const error = new Error("simulated process exit");
          error.simulatedProcessExit = true;
          throw error;
        }
      },
    }), /simulated process exit/);
    const resumed = await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
    assert.equal(resumed.status, "applied-pending-runtime-ownership");
    const manifest = JSON.parse(await readFile(join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`), "utf8"));
    assert.equal(manifest.status, "applied-pending-runtime-ownership");
  }
});

test("uninstalling state resumes after stop and after exact file restoration", async (t) => {
  for (const checkpointName of ["uninstalling-persisted", "uninstall-files-restored"]) {
    const fixture = await lifecycleFixture(t, "linux", `uninstall-resume-${checkpointName}`);
    const fake = lifecycleRunner(fixture.plan);
    await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
    const manifestPath = join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`);
    const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
    await assert.rejects(applyDaemonServiceUninstallPlan(uninstall, {
      approvedDigest: uninstall.digest,
      commandRunner: fake.runner,
      checkpoint: async (name) => {
        if (name === checkpointName) {
          const error = new Error("simulated process exit");
          error.simulatedProcessExit = true;
          throw error;
        }
      },
    }), /simulated process exit/);
    const resumedPlan = await createDaemonServiceUninstallPlan(manifestPath);
    assert.equal((await applyDaemonServiceUninstallPlan(resumedPlan, { approvedDigest: resumedPlan.digest, commandRunner: fake.runner })).status, "uninstalled");
  }
});

test("uninstall-incomplete finalize failure resumes without re-deactivating ownership", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "uninstall-incomplete-resume");
  const controls = { failFinalize: false };
  const fake = lifecycleRunner(fixture.plan, controls);
  await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
  const manifestPath = join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`);
  const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
  controls.failFinalize = true;
  await assert.rejects(applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }), /finalize command/);
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).status, "uninstall-incomplete");
  controls.failFinalize = false;
  const resumedPlan = await createDaemonServiceUninstallPlan(manifestPath);
  assert.equal((await applyDaemonServiceUninstallPlan(resumedPlan, { approvedDigest: resumedPlan.digest, commandRunner: fake.runner })).status, "uninstalled");
});

test("terminal uninstall receipt replays identically after return-path interruption without mutations", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "terminal-receipt-replay");
  const fake = lifecycleRunner(fixture.plan);
  await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
  const manifestPath = join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`);
  const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
  await assert.rejects(applyDaemonServiceUninstallPlan(uninstall, {
    approvedDigest: uninstall.digest,
    commandRunner: fake.runner,
    checkpoint: async (name) => {
      if (name === "uninstall-terminal-persisted") {
        const error = new Error("simulated terminal return interruption");
        error.simulatedProcessExit = true;
        throw error;
      }
    },
  }), /simulated terminal return interruption/);
  const terminalBytes = await readFile(manifestPath);
  const terminalManifest = JSON.parse(terminalBytes.toString("utf8"));
  const expectedReceipt = terminalManifest.terminalUninstallReceipt;
  const commandCount = fake.calls.length;
  const replayed = await applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner });
  assert.deepEqual(replayed, expectedReceipt);
  assert.equal(fake.calls.length, commandCount);
  assert.deepEqual(await readFile(manifestPath), terminalBytes);
  for (const file of fixture.plan.files) await assert.rejects(readFile(file.path), /ENOENT/);
  await assert.rejects(readFile(join(fake.runner.testClaimRoot, ".lifecycle.claim.json")), /ENOENT/);
  const tampered = JSON.parse(terminalBytes.toString("utf8"));
  tampered.terminalUninstallReceipt.files[0].secret = "private-leak";
  tampered.terminalUninstallReceipt.commands.extra = ["unverified-command"];
  await writeFile(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /Invalid terminal daemon lifecycle uninstall receipt/,
  );
  const forgedProjection = JSON.parse(terminalBytes.toString("utf8"));
  forgedProjection.entries[0].role = "forged-role";
  forgedProjection.terminalUninstallReceipt.files[0].role = "forged-role";
  await writeFile(manifestPath, `${JSON.stringify(forgedProjection, null, 2)}\n`);
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /manifest projection does not match/,
  );
  const weakenedProvenance = JSON.parse(terminalBytes.toString("utf8"));
  weakenedProvenance.terminalUninstallReceipt.commands.verifyAbsent.pop();
  await writeFile(manifestPath, `${JSON.stringify(weakenedProvenance, null, 2)}\n`);
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /verifyAbsent provenance is invalid/,
  );
});

test("explicit stale-claim recovery preserves claim evidence and resumes the same lifecycle", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "linux", "claim-recovery");
  await mkdir(stateRoot, { recursive: true });
  const claimRoot = lifecycleRunner(plan).runner.testClaimRoot;
  await mkdir(claimRoot, { recursive: true });
  await writeFile(join(claimRoot, ".lifecycle.claim.json"), `${JSON.stringify({ apiVersion: 1, schemaVersion: 1, operation: "apply", planId: plan.planId, digest: plan.digest, lifecycleDigest: plan.digest, processId: 2_147_483_647, nonce: "a".repeat(64) })}\n`);
  const claim = await readDaemonServiceLifecycleClaim(claimRoot);
  const fake = lifecycleRunner(plan);
  const result = await applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner, recoverClaimDigest: claim.claimDigest });
  assert.equal(result.status, "applied-pending-runtime-ownership");
  assert.equal(typeof await readFile(join(claimRoot, "claim-history", `${claim.claimDigest}.json`), "utf8"), "string");
});

test("orphan claim guard is inspectable and recoverable while a live guard is protected", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "guard-recovery");
  const fixtureClaimRoot = lifecycleRunner(fixture.plan).runner.testClaimRoot;
  await mkdir(fixtureClaimRoot, { recursive: true });
  const guardPath = join(fixtureClaimRoot, ".lifecycle.claim.guard");
  await writeFile(guardPath, `${JSON.stringify({ apiVersion: 1, schemaVersion: 1, processId: 2_147_483_647, nonce: "b".repeat(64) })}\n`);
  const orphan = await readDaemonServiceLifecycleClaim(fixtureClaimRoot);
  assert.equal(orphan.kind, "guard");
  const fake = lifecycleRunner(fixture.plan);
  assert.equal((await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner, recoverClaimDigest: orphan.guardDigest })).status, "applied-pending-runtime-ownership");

  const other = await lifecycleFixture(t, "linux", "live-guard-protected");
  const otherClaimRoot = lifecycleRunner(other.plan).runner.testClaimRoot;
  await mkdir(otherClaimRoot, { recursive: true });
  const liveGuardPath = join(otherClaimRoot, ".lifecycle.claim.guard");
  await writeFile(liveGuardPath, `${JSON.stringify({ apiVersion: 1, schemaVersion: 1, processId: process.pid, nonce: "c".repeat(64) })}\n`);
  const live = await readDaemonServiceLifecycleClaim(otherClaimRoot);
  await assert.rejects(
    applyDaemonServicePlan(other.plan, { approvedDigest: other.plan.digest, commandRunner: lifecycleRunner(other.plan).runner, recoverClaimDigest: live.guardDigest }),
    /guard process is live/,
  );
  await rm(liveGuardPath, { force: true });
});

test("copied lifecycle manifest cannot create a second uninstall claim namespace", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "canonical-manifest");
  const fake = lifecycleRunner(fixture.plan);
  await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
  const canonical = join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`);
  const copiedRoot = join(fixture.root, "copied-state", "manifests");
  await mkdir(copiedRoot, { recursive: true });
  const copied = join(copiedRoot, `${fixture.plan.planId}.json`);
  await copyFile(canonical, copied);
  await assert.rejects(createDaemonServiceUninstallPlan(copied), /outside its canonical state root/);
});

test("stable verification samples twice and Linux absence accepts systemctl exit 4", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "stable-samples");
  const fake = lifecycleRunner(fixture.plan, { linuxAbsentExit4: true });
  await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner });
  for (const command of fixture.plan.commands.verify) {
    const samples = fake.calls.filter((call) => call.phase === "verify" && call.id === command.id).map((call) => call.sample);
    assert.deepEqual(samples, [1, 2]);
  }
  assert.equal(fake.calls.every((call) => call.timeoutMs === 20_000 && "signal" in call), true);
  const uninstall = await createDaemonServiceUninstallPlan(join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`));
  assert.equal((await applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner })).status, "uninstalled");
  assert.equal(fixture.plan.commands.verifyAbsent.every((command) => command.expectation.exitCodes.includes(4)), true);
});

test("pre-aborted lifecycle apply propagates cancellation before command execution", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "abort-propagation");
  const fake = lifecycleRunner(fixture.plan);
  const controller = new AbortController();
  controller.abort(new Error("owner cancelled lifecycle"));
  await assert.rejects(
    applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner, signal: controller.signal }),
    /owner cancelled lifecycle/,
  );
  assert.equal(fake.calls.length, 0);
});

test("mid-flight apply cancellation uses an independent rollback signal", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "midflight-abort");
  const fake = lifecycleRunner(fixture.plan);
  const controller = new AbortController();
  await assert.rejects(applyDaemonServicePlan(fixture.plan, {
    approvedDigest: fixture.plan.digest,
    commandRunner: fake.runner,
    signal: controller.signal,
    checkpoint: async (name) => { if (name === "activation-complete") controller.abort(new Error("cancel after activation")); },
  }), /cancel after activation/);
  assert.equal(fake.calls.some((call) => call.phase === "rollback"), true);
  assert.equal(fake.calls.some((call) => call.phase === "rollback-verify-absent"), true);
});

test("resumed apply cancellation uses the independent rollback signal", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "resumed-midflight-abort");
  const fake = lifecycleRunner(fixture.plan);
  await assert.rejects(applyDaemonServicePlan(fixture.plan, {
    approvedDigest: fixture.plan.digest,
    commandRunner: fake.runner,
    checkpoint: async (name) => {
      if (name === "activation-complete") {
        const error = new Error("simulated process exit");
        error.simulatedProcessExit = true;
        throw error;
      }
    },
  }), /simulated process exit/);
  const controller = new AbortController();
  await assert.rejects(applyDaemonServicePlan(fixture.plan, {
    approvedDigest: fixture.plan.digest,
    commandRunner: fake.runner,
    signal: controller.signal,
    checkpoint: async (name) => { if (name === "activation-complete") controller.abort(new Error("cancel resumed activation")); },
  }), /cancel resumed activation/);
  assert.equal(fake.calls.some((call) => call.phase === "rollback"), true);
  assert.equal(fake.isInstalled(), false);
  const manifest = JSON.parse(await readFile(join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`), "utf8"));
  assert.equal(manifest.status, "rolled-back-after-error");
});

test("mid-flight uninstall cancellation uses an independent recovery signal", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "midflight-uninstall-abort");
  const base = lifecycleRunner(fixture.plan);
  await applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: base.runner });
  const uninstall = await createDaemonServiceUninstallPlan(join(fixture.stateRoot, "manifests", `${fixture.plan.planId}.json`));
  const controller = new AbortController();
  const calls = [];
  const abortingRunner = async (argv, context) => {
    calls.push(context);
    const result = await base.runner(argv, context);
    if (context.phase === "deactivate") controller.abort(new Error("cancel during uninstall"));
    return result;
  };
  abortingRunner.testClaimRoot = base.runner.testClaimRoot;
  abortingRunner.skipStableDelay = true;
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: abortingRunner, signal: controller.signal }),
    /cancel during uninstall/,
  );
  assert.equal(calls.some((call) => call.phase === "uninstall-rollback"), true);
  assert.equal(calls.some((call) => call.phase === "uninstall-rollback-verify"), true);
});

test("injected runner deadline is enforced outside a non-cooperative runner", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "runner-timeout");
  const never = () => new Promise(() => {});
  never.testClaimRoot = join(tmpdir(), `threadspan-lifecycle-test-claims-${process.pid}`);
  never.testTimeoutMs = 20;
  never.skipStableDelay = true;
  await assert.rejects(
    applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: never }),
    /exceeded 20ms/,
  );
});

test("injected command runners are rejected outside the offline Node test harness", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "runner-production-gate");
  const fake = lifecycleRunner(fixture.plan);
  const previous = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      applyDaemonServicePlan(fixture.plan, { approvedDigest: fixture.plan.digest, commandRunner: fake.runner }),
      /restricted to the offline Node test harness/,
    );
  } finally {
    if (previous !== undefined) process.env.NODE_TEST_CONTEXT = previous;
  }
});

test("partial uninstall deactivation is repaired and durably recorded before retry", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "win32", "uninstall-recovery");
  const controls = { failDeactivate: false };
  const fake = lifecycleRunner(plan, controls);
  await applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner });
  const manifestPath = join(stateRoot, "manifests", `${plan.planId}.json`);
  const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
  controls.failDeactivate = true;
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /deactivate command stop-remove-tasks exited 1/,
  );
  assert.equal(fake.isInstalled(), true);
  const recoveredManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(recoveredManifest.status, "applied-pending-runtime-ownership");
  assert.match(recoveredManifest.lastUninstallError, /stop-remove-tasks exited 1/);
  for (const file of plan.files) assert.equal(typeof await readFile(file.path, "utf8"), "string");
});

test("failed uninstall recovery leaves a durable non-applied manifest", async (t) => {
  const { plan, stateRoot } = await lifecycleFixture(t, "win32", "uninstall-recovery-failed");
  const controls = { failDeactivate: false, failRecovery: false };
  const fake = lifecycleRunner(plan, controls);
  await applyDaemonServicePlan(plan, { approvedDigest: plan.digest, commandRunner: fake.runner });
  const manifestPath = join(stateRoot, "manifests", `${plan.planId}.json`);
  const uninstall = await createDaemonServiceUninstallPlan(manifestPath);
  controls.failDeactivate = true;
  controls.failRecovery = true;
  await assert.rejects(
    applyDaemonServiceUninstallPlan(uninstall, { approvedDigest: uninstall.digest, commandRunner: fake.runner }),
    /recovery was incomplete/,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.status, "uninstall-rollback-incomplete");
});

test("service plan requires explicit environment selection when validated config is unavailable", async (t) => {
  const fixture = await lifecycleFixture(t, "linux", "environment");
  assert.throws(() => createDaemonServicePlan({
    platform: "linux",
    nodePath: process.execPath,
    cliPath: fixture.cliPath,
    configPath: join(fixture.root, "config.jsonc"),
    sourceRevision: "c4f4113",
    lifecycleOwner: "environment-owner",
    stateRoot: fixture.stateRoot,
    serviceDirectory: fixture.serviceDirectory,
  }), /config or an explicit providerEnvironmentVariables array/);
});
