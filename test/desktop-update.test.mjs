import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DesktopCompatibilityWatch,
  assessNativeDesktopMigration,
  createDefaultDesktopProducts,
} from "../src/maintenance/desktop-update.mjs";

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-desktop-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

function fakeResult(stdout) {
  return { stdout, stderr: "", exitCode: 0, exitSignal: null, startedAt: 0, durationMs: 1 };
}

function probeOutcomes(status = "pass", evidenceClass = "synthetic") {
  return Object.fromEntries(["attach", "protocol", "routing", "provider", "settings"]
    .map((name) => [name, { status, evidenceClass }]));
}

test("watch is disabled and performs no IO by default", async (t) => {
  const root = await temporaryRoot(t);
  const stateRoot = join(root, "state");
  const watch = new DesktopCompatibilityWatch({
    stateRoot,
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"] }],
    resolveExecutable: async () => { throw new Error("must not resolve"); },
    runProcess: async () => { throw new Error("must not run"); },
  });

  const report = await watch.doctor();
  assert.equal(report.status, "disabled");
  assert.equal(report.mode, "read-only");
  assert.equal(report.mutation, "none");
  assert.equal(report.networkAccess, false);
  await assert.rejects(lstat(stateRoot), /ENOENT/);
  assert.throws(() => watch.startPolling(), /disabled/);
});

test("transition core has no updater, Desktop host, provider, auth, settings, or task mutation dependency", async () => {
  const source = await readFile(new URL("../src/maintenance/desktop-update.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\.\/(?:desktop|installer|providers)\//);
  assert.doesNotMatch(source, /\b(?:checkAndUpdate|relaunch|executeResponse|selectDesktopRoute|accountStore|taskStore)\b/);
});

test("Linux and Windows probes record bounded version and artifact changes", async (t) => {
  const root = await temporaryRoot(t);
  for (const platform of ["linux", "win32"]) {
    const platformRoot = join(root, platform);
    const stateRoot = join(platformRoot, "state");
    const cli = await createFile(join(platformRoot, "bin", platform === "win32" ? "codex.EXE" : "codex"), "launcher\n");
    const codexDesktop = await createFile(join(platformRoot, "Codex", "Codex.exe"), "codex-desktop-v1\n");
    const codexVersion = await createFile(join(platformRoot, "Codex", "package.json"), JSON.stringify({ version: "2.3.4" }));
    const chatgptDesktop = await createFile(join(platformRoot, "ChatGPT", "ChatGPT.exe"), "chatgpt-desktop-v1\n");
    const calls = [];
    const environment = {
      PATH: dirname(cli),
      PATHEXT: ".EXE;.CMD",
      HOME: platformRoot,
      USERPROFILE: platformRoot,
      SHOULD_NOT_LEAK: "credential-like-value",
    };
    const watch = new DesktopCompatibilityWatch({
      enabled: true,
      platform,
      environment,
      stateRoot,
      now: () => Date.parse("2026-08-17T12:00:00Z"),
      products: [
        { id: "codex-cli", label: "Codex CLI", kind: "command", commands: ["codex"], versionArgs: ["--version"] },
        { id: "codex-desktop", label: "Codex Desktop", kind: "artifact", candidates: [codexDesktop], versionFiles: [codexVersion] },
        { id: "chatgpt-desktop", label: "ChatGPT Desktop", kind: "artifact", candidates: [chatgptDesktop] },
      ],
      resolveExecutable: async (command, options) => {
        assert.equal(command, "codex");
        assert.equal(options.platform, platform);
        return cli;
      },
      runProcess: async (options) => {
        calls.push(options);
        assert.equal(options.command, cli);
        assert.deepEqual(options.args, ["--version"]);
        assert.equal(options.shell, false);
        assert.equal(options.timeoutMs, 5_000);
        assert.equal(options.maxStdoutBytes, 64 * 1024);
        assert.equal(options.maxStderrBytes, 64 * 1024);
        assert.equal(options.env.SHOULD_NOT_LEAK, undefined);
        return fakeResult("codex-cli 0.147.0\nraw-extra-output");
      },
    });

    const baseline = await watch.doctorAfterUpdate();
    assert.equal(baseline.reason, "after-update");
    assert.equal(baseline.products.every((item) => item.status === "detected"), true);
    assert.equal(baseline.products.find((item) => item.id === "codex-cli").version, "codex-cli 0.147.0");
    assert.equal(baseline.products.find((item) => item.id === "codex-desktop").version, "2.3.4");
    assert.equal(baseline.changes.every((item) => item.kind === "baseline"), true);
    assert.equal(calls.length, 1);

    const state = await readFile(join(stateRoot, "observations.json"), "utf8");
    assert.doesNotMatch(state, /credential-like-value|raw-extra-output/);
    assert.doesNotMatch(state, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await writeFile(chatgptDesktop, "chatgpt-desktop-v2\n");
    const changed = await watch.doctorAfterUpdate();
    assert.deepEqual(changed.changes.map((item) => item.productId), ["chatgpt-desktop"]);
    assert.equal(changed.changes[0].kind, "changed");
  }
});

test("default product definitions cover the required products on Linux and Windows", () => {
  for (const platform of ["linux", "win32"]) {
    const products = createDefaultDesktopProducts({
      platform,
      environment: {
        HOME: "/home/tester",
        USERPROFILE: "C:\\Users\\tester",
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
      },
    });
    assert.deepEqual(products.map((item) => item.id), ["codex-cli", "codex-desktop", "chatgpt-desktop"]);
    assert.equal(products[0].kind, "command");
    assert.equal(products.slice(1).every((item) => item.kind === "artifact" && item.candidates.length > 0), true);
  }
  assert.throws(() => new DesktopCompatibilityWatch({
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"], versionArgs: ["self-update"] }],
  }), /must not request update/);
});

test("exact N to N+1 transitions preserve N until every separate probe passes", async (t) => {
  const root = await temporaryRoot(t);
  for (const platform of ["linux", "win32"]) {
    const platformRoot = join(root, platform);
    const artifact = await createFile(join(platformRoot, "Desktop.bin"), "artifact-N\n");
    const metadata = await createFile(join(platformRoot, "package.json"), JSON.stringify({ version: "N" }));
    const stateRoot = join(platformRoot, "state");
    const watch = new DesktopCompatibilityWatch({
      enabled: true,
      platform,
      stateRoot,
      products: [{ id: "codex-desktop", label: "Codex Desktop", kind: "artifact", candidates: [artifact], versionFiles: [metadata] }],
    });

    await watch.doctorAfterUpdate();
    await writeFile(artifact, "artifact-N+1\n");
    await writeFile(metadata, JSON.stringify({ version: "N+1" }));
    const changed = await watch.doctorAfterUpdate();
    assert.equal(changed.transitions.length, 1);
    const transition = changed.transitions[0];
    assert.equal(transition.platform, platform);
    assert.equal(transition.executionPlatform, process.platform);
    assert.equal(transition.N, "N");
    assert.equal(transition["N+1"], "N+1");
    assert.equal(transition.status, "probes-pending");
    assert.equal(transition.oldWorkingSurface, true);
    assert.equal(transition.sidecarRetained, true);
    const acceptedBefore = JSON.parse(await readFile(join(stateRoot, "accepted-observations.json"), "utf8"));
    assert.equal(acceptedBefore.products[0].version, "N");

    const acceptanceOutcomes = probeOutcomes("pass", platform === process.platform ? "synthetic" : "native-manual");
    const accepted = await watch.recordTransitionProbe({
      transitionId: transition.transitionId,
      claimId: `synthetic-${platform}`,
      source: "manual",
      outcomes: acceptanceOutcomes,
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.acceptanceScope, "synthetic");
    assert.deepEqual(Object.keys(accepted.probe.outcomes), ["attach", "protocol", "routing", "provider", "settings"]);
    const acceptedAfter = JSON.parse(await readFile(join(stateRoot, "accepted-observations.json"), "utf8"));
    assert.equal(acceptedAfter.products[0].version, "N+1");
    await writeFile(join(stateRoot, "accepted-observations.json"), `${JSON.stringify(acceptedBefore)}\n`);
    await watch.recordTransitionProbe({
      transitionId: transition.transitionId,
      claimId: `synthetic-${platform}`,
      source: "manual",
      outcomes: acceptanceOutcomes,
    });
    assert.equal(JSON.parse(await readFile(join(stateRoot, "accepted-observations.json"), "utf8")).products[0].version, "N+1");
    const mismatchedWatch = new DesktopCompatibilityWatch({
      enabled: true,
      platform: platform === "linux" ? "win32" : "linux",
      stateRoot,
      products: [{ id: "codex-desktop", label: "Codex Desktop", kind: "artifact", candidates: [artifact], versionFiles: [metadata] }],
    });
    await assert.rejects(mismatchedWatch.recordTransitionProbe({
      transitionId: transition.transitionId,
      claimId: `wrong-platform-${platform}`,
      source: "manual",
      outcomes: probeOutcomes("pass", "native-manual"),
    }), /platform does not match/);
    await assert.rejects(mismatchedWatch.doctor(), /state does not match this watcher platform/);
    assert.match(await readFile(join(stateRoot, "transitions", transition.transitionId, "transition.json"), "utf8"), /"last-known-working"/);
  }
});

test("simultaneous acceptance of different products preserves both generations and index entries", async (t) => {
  const root = await temporaryRoot(t);
  const products = [];
  for (const id of ["codex-desktop", "chatgpt-desktop"]) {
    const artifact = await createFile(join(root, id, "Desktop.bin"), `${id}-N\n`);
    const metadata = await createFile(join(root, id, "package.json"), JSON.stringify({ version: "N" }));
    products.push({ id, label: id, kind: "artifact", candidates: [artifact], versionFiles: [metadata], artifact, metadata });
  }
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "state"),
    products: products.map(({ artifact, metadata, ...product }) => ({ ...product, candidates: [artifact], versionFiles: [metadata] })),
  });
  await watch.doctor();
  for (const product of products) {
    await writeFile(product.artifact, `${product.id}-N+1\n`);
    await writeFile(product.metadata, JSON.stringify({ version: "N+1" }));
  }
  const transitions = (await watch.doctor()).transitions;
  assert.equal(transitions.length, 2);
  const results = await Promise.all(transitions.map((transition) => watch.recordTransitionProbe({
    transitionId: transition.transitionId,
    claimId: `accept-${transition.product}`,
    source: "manual",
    outcomes: probeOutcomes(),
  })));
  assert.equal(results.every((result) => result.status === "accepted"), true);
  const accepted = JSON.parse(await readFile(join(root, "state", "accepted-observations.json"), "utf8"));
  assert.deepEqual(accepted.products.map((product) => [product.id, product.version]).sort(), [["chatgpt-desktop", "N+1"], ["codex-desktop", "N+1"]]);
  const index = JSON.parse(await readFile(join(root, "state", "transition-index.json"), "utf8"));
  assert.equal(index.transitions.filter((transition) => transition.status === "accepted").length, 2);
});

test("concurrent first-run doctors cannot replace N with N+1 as a second baseline", async (t) => {
  const root = await temporaryRoot(t);
  const executable = await createFile(join(root, "codex"), "N\n");
  const stateRoot = join(root, "state");
  let releaseSlow;
  let slowEntered;
  const entered = new Promise((resolve) => { slowEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseSlow = resolve; });
  const common = {
    enabled: true,
    stateRoot,
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"] }],
    runProcess: async ({ command }) => fakeResult((await readFile(command, "utf8")).trim()),
  };
  const slow = new DesktopCompatibilityWatch({
    ...common,
    resolveExecutable: async () => { slowEntered(); await blocked; return executable; },
  });
  const fast = new DesktopCompatibilityWatch({ ...common, resolveExecutable: async () => executable });
  const slowDoctor = slow.doctor();
  await entered;
  await fast.doctor();
  await writeFile(executable, "N+1\n");
  releaseSlow();
  const slowReport = await slowDoctor;
  assert.equal(slowReport.transitions.length, 1);
  assert.equal(slowReport.transitions[0].N, "N");
  assert.equal(slowReport.transitions[0]["N+1"], "N+1");
  const accepted = JSON.parse(await readFile(join(stateRoot, "accepted-observations.json"), "utf8"));
  assert.equal(accepted.products[0].version, "N");
});

test("transition probes serialize across watch processes and never infer manual from passive evidence", async (t) => {
  const root = await temporaryRoot(t);
  const artifact = await createFile(join(root, "Desktop.bin"), "N\n");
  const metadata = await createFile(join(root, "package.json"), JSON.stringify({ version: "N" }));
  const options = {
    enabled: true,
    stateRoot: join(root, "state"),
    products: [{ id: "codex-desktop", kind: "artifact", candidates: [artifact], versionFiles: [metadata] }],
  };
  const first = new DesktopCompatibilityWatch(options);
  const second = new DesktopCompatibilityWatch(options);
  await first.doctor();
  await writeFile(artifact, "N+1\n");
  await writeFile(metadata, JSON.stringify({ version: "N+1" }));
  const transitionId = (await first.doctor()).transitions[0].transitionId;

  await assert.rejects(first.recordTransitionProbe({
    transitionId,
    claimId: "wrong-evidence-class",
    source: "passive",
    outcomes: probeOutcomes("pass", "native-manual"),
  }), /cannot claim native-manual/);

  const outcomes = await Promise.allSettled([
    first.recordTransitionProbe({ transitionId, claimId: "process-one", source: "passive", outcomes: probeOutcomes() }),
    second.recordTransitionProbe({ transitionId, claimId: "process-one", source: "passive", outcomes: probeOutcomes() }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /already claimed/);
});

test("transition repair binds the exact failed probe and leaves acceptance pending after apply", async (t) => {
  const root = await temporaryRoot(t);
  const artifact = await createFile(join(root, "Desktop.bin"), "N\n");
  const metadata = await createFile(join(root, "package.json"), JSON.stringify({ version: "N" }));
  const repairRoot = join(root, "sidecar");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "attach-profile.txt"), "old\n");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    readOnly: false,
    applyEnabled: true,
    stateRoot: join(root, "state"),
    products: [{ id: "codex-desktop", kind: "artifact", candidates: [artifact], versionFiles: [metadata] }],
  });
  await watch.doctor();
  await writeFile(artifact, "N+1\n");
  await writeFile(metadata, JSON.stringify({ version: "N+1" }));
  const transitionId = (await watch.doctor()).transitions[0].transitionId;
  const failingOutcomes = probeOutcomes();
  failingOutcomes.attach = { status: "fail", evidenceClass: "synthetic" };
  const failed = await watch.recordTransitionProbe({ transitionId, claimId: "failed-probe", source: "manual", outcomes: failingOutcomes });
  assert.equal(failed.status, "repair-needed");
  assert.deepEqual(failed.actionable, ["attach"]);

  await assert.rejects(watch.prepareTransitionRepairPlan({
    transitionId,
    failedProbeDigest: "0".repeat(64),
    planId: "wrong-probe",
    repairRoot,
    operations: [{ relativePath: "attach-profile.txt", content: "new\n" }],
  }), /exact failed probe digest/);
  const plan = await watch.prepareTransitionRepairPlan({
    transitionId,
    failedProbeDigest: failed.probe.digest,
    planId: "exact-transition-repair",
    repairRoot,
    operations: [{ relativePath: "attach-profile.txt", content: "new\n" }],
  });
  const otherTarget = await createFile(join(repairRoot, "protocol-profile.txt"), "old-protocol\n");
  const competingPlan = await watch.prepareTransitionRepairPlan({
    transitionId,
    failedProbeDigest: failed.probe.digest,
    planId: "competing-transition-repair",
    repairRoot,
    operations: [{ relativePath: "protocol-profile.txt", content: "new-protocol\n" }],
  });
  assert.equal(plan.transition.transitionId, transitionId);
  assert.equal(plan.transition.failedProbeDigest, failed.probe.digest);
  const repairOutcomes = await Promise.allSettled([plan, competingPlan].map((candidate) => watch.applyRepairPlan(candidate, {
    applyEnabled: true,
    approvedPlanId: candidate.planId,
    approvedDigest: candidate.digest,
  })));
  assert.equal(repairOutcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(repairOutcomes.filter((item) => item.status === "rejected").length, 1);
  assert.match(repairOutcomes.find((item) => item.status === "rejected").reason.message, /transition target is already claimed|status 'repair-applying'|status 'repair-applied-awaiting-probes'/);
  const result = repairOutcomes.find((item) => item.status === "fulfilled").value;
  assert.equal(result.transitionStatus, "repair-applied-awaiting-probes");
  assert.equal([await readFile(target, "utf8"), await readFile(otherTarget, "utf8")].filter((value) => value.startsWith("new")).length, 1);
  assert.equal((await watch.transitionState(transitionId)).status, "repair-applied-awaiting-probes");
});

test("different plans cannot concurrently claim the same repair target", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "managed.txt"), "before\n");
  const watch = new DesktopCompatibilityWatch({ enabled: true, readOnly: false, applyEnabled: true, stateRoot: join(root, "state"), products: [] });
  const plans = await Promise.all(["plan-a", "plan-b"].map((planId) => watch.prepareRepairPlan({
    planId,
    repairRoot,
    operations: [{ relativePath: "managed.txt", content: `${planId}\n` }],
  })));
  const outcomes = await Promise.allSettled(plans.map((plan) => watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: plan.digest,
  })));
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /already claimed|changed after planning/);
  assert.match(await readFile(target, "utf8"), /^plan-[ab]\n$/);
});

test("Windows command wrappers are fingerprinted without shell execution", async (t) => {
  const root = await temporaryRoot(t);
  const wrapper = await createFile(join(root, "codex.CMD"), "@echo off\r\n");
  const alias = process.platform === "win32" ? wrapper : join(root, "codex.EXE");
  if (process.platform !== "win32") await symlink(wrapper, alias, "file");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    platform: "win32",
    stateRoot: join(root, "state"),
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"] }],
    resolveExecutable: async () => alias,
    runProcess: async () => { throw new Error("Windows command wrapper must not be launched through a shell"); },
  });
  const report = await watch.doctor();
  assert.equal(report.products[0].status, "detected");
  assert.equal(report.products[0].version, undefined);
  assert.equal(report.products[0].evidence, "command-wrapper-artifact");
});

test("command evidence fails closed when the executable changes during its version probe", async (t) => {
  const root = await temporaryRoot(t);
  const executable = await createFile(join(root, "codex"), "before\n");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "state"),
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"] }],
    resolveExecutable: async () => executable,
    runProcess: async () => {
      await writeFile(executable, "after\n");
      return fakeResult("codex 1.0.0");
    },
  });
  const report = await watch.doctor();
  assert.equal(report.products[0].status, "error");
  assert.equal(report.products[0].error, "Product inspection failed");
});

test("native Settings and Usage remain migration candidates behind parity and rollback gates", () => {
  const unknown = assessNativeDesktopMigration();
  assert.equal(unknown.status, "retain-threadspan-hud");
  assert.equal(unknown.threadspanHudPolicy, "retain-indefinitely");
  assert.deepEqual(unknown.migrationCandidates, ["settings", "usage"]);
  assert.equal(unknown.undocumentedInternalsAllowed, false);
  assert.equal(unknown.automaticSunset, false);

  const weaker = assessNativeDesktopMigration({
    settings: "stable",
    usage: "weaker",
    linuxParity: true,
    windowsParity: true,
    rollbackVerified: true,
  });
  assert.equal(weaker.status, "retain-threadspan-hud");
  assert.deepEqual(weaker.blockers, ["stable-native-usage"]);

  const parity = assessNativeDesktopMigration({
    settings: "stable",
    usage: "stable",
    linuxParity: true,
    windowsParity: true,
    rollbackVerified: true,
  });
  assert.equal(parity.status, "eligible-for-measured-sunset-review");
  assert.equal(parity.threadspanHudPolicy, "retain-during-measured-coexistence");
  assert.equal(parity.automaticSunset, false);
});

test("probe output, time, artifact, and diagnostic data are bounded", async (t) => {
  const root = await temporaryRoot(t);
  const cli = await createFile(join(root, "codex"), "small\n");
  const oversized = await createFile(join(root, "desktop.bin"), Buffer.alloc(65));
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "state"),
    products: [
      { id: "codex-cli", kind: "command", commands: ["codex"] },
      { id: "chatgpt-desktop", kind: "artifact", candidates: [oversized] },
    ],
    limits: { maxArtifactBytes: 64, processTimeoutMs: 25, maxProcessOutputBytes: 32 },
    resolveExecutable: async () => cli,
    runProcess: async (options) => {
      assert.equal(options.timeoutMs, 25);
      assert.equal(options.maxStdoutBytes, 32);
      assert.equal(options.maxStderrBytes, 32);
      throw new Error(`probe timeout ${"x".repeat(1_000)}`);
    },
  });

  const report = await watch.doctor();
  assert.equal(report.status, "attention");
  assert.equal(report.products.every((item) => item.status === "error"), true);
  assert.ok(report.products.every((item) => item.error.length <= 501));
  assert.match(report.products.find((item) => item.id === "chatgpt-desktop").error, /byte limit/);
  const state = await readFile(join(root, "state", "observations.json"), "utf8");
  assert.doesNotMatch(state, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("apply verifies rollback backups before the first target write", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "managed.txt"), "before\n");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    readOnly: false,
    applyEnabled: true,
    stateRoot: join(root, "state"),
    products: [],
  });
  const plan = await watch.prepareRepairPlan({
    planId: "corrupt-backup",
    repairRoot,
    operations: [{ relativePath: "managed.txt", content: "after\n" }],
  });
  const preview = watch.previewRepairPlan(plan);
  await writeFile(join(root, "state", plan.rollbackSnapshot, plan.operations[0].backup), "corrupt\n");
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
  }), /Rollback backup/);
  assert.equal(await readFile(target, "utf8"), "before\n");
});

test("repair apply requires every gate, preserves rollback, and only reports app prompts", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  const stateRoot = join(root, "state");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "profiles", "desktop.toml"), "old = true\n");
  let processCalls = 0;
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    readOnly: false,
    applyEnabled: true,
    stateRoot,
    products: [],
    runProcess: async () => { processCalls += 1; throw new Error("must not run"); },
    now: () => Date.parse("2026-08-17T13:00:00Z"),
  });
  const plan = await watch.prepareRepairPlan({
    planId: "desktop-profile-repair",
    repairRoot,
    operations: [{ relativePath: "profiles/desktop.toml", content: "old = false\n", mode: 0o600 }],
    shutdownProducts: ["codex-desktop"],
    restartProducts: ["codex-desktop", "chatgpt-desktop"],
  });
  const preview = watch.previewRepairPlan(plan);
  assert.equal(preview.planId, plan.planId);
  assert.equal(preview.digest, plan.digest);
  assert.match(preview.text, /Close codex-desktop manually/);
  assert.match(preview.text, /Approval digest: [0-9a-f]{64}/);
  assert.equal(await readFile(join(stateRoot, plan.rollbackSnapshot, plan.operations[0].backup), "utf8"), "old = true\n");

  await assert.rejects(watch.applyRepairPlan(plan, {}), /applyEnabled/);
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: "wrong-plan",
    approvedDigest: preview.digest,
  }), /exact preview plan ID/);
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: "0".repeat(64),
  }), /exact preview digest/);
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
  }), /manual shutdown confirmation/);
  assert.equal(await readFile(target, "utf8"), "old = true\n");

  const result = await watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
    confirmedStoppedProducts: ["codex-desktop"],
  });
  assert.equal(await readFile(target, "utf8"), "old = false\n");
  assert.equal(result.appLifecycleActionsPerformed, false);
  assert.match(result.prompts.afterApply.join("\n"), /Restart codex-desktop manually/);
  assert.match(result.nextAction, /doctorAfterUpdate/);
  assert.equal(processCalls, 0);
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
    confirmedStoppedProducts: ["codex-desktop"],
  }), /already claimed|cannot apply from rollback status/);
});

test("an apply plan is claimed atomically across concurrent callers", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "managed.txt"), "before\n");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    readOnly: false,
    applyEnabled: true,
    stateRoot: join(root, "state"),
    products: [],
  });
  const plan = await watch.prepareRepairPlan({
    planId: "concurrent-claim",
    repairRoot,
    operations: [{ relativePath: "managed.txt", content: "after\n" }],
  });
  const approval = {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: watch.previewRepairPlan(plan).digest,
  };
  const outcomes = await Promise.allSettled([
    watch.applyRepairPlan(plan, approval),
    watch.applyRepairPlan(plan, approval),
  ]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.match(outcomes.find((item) => item.status === "rejected").reason.message, /already claimed/);
  assert.equal(await readFile(target, "utf8"), "after\n");
});

test("read-only mode and changed preimages fail before mutation", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  await mkdir(repairRoot);
  const target = await createFile(join(repairRoot, "managed.txt"), "before\n");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    applyEnabled: true,
    stateRoot: join(root, "state"),
    products: [],
  });
  const plan = await watch.prepareRepairPlan({
    planId: "read-only-plan",
    repairRoot,
    operations: [{ relativePath: "managed.txt", content: "after\n" }],
  });
  const preview = watch.previewRepairPlan(plan);
  await assert.rejects(watch.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
  }), /read-only/);

  const writable = new DesktopCompatibilityWatch({
    enabled: true,
    readOnly: false,
    applyEnabled: true,
    stateRoot: join(root, "state"),
    products: [],
  });
  await writeFile(target, "changed-after-preview\n");
  await assert.rejects(writable.applyRepairPlan(plan, {
    applyEnabled: true,
    approvedPlanId: plan.planId,
    approvedDigest: preview.digest,
  }), /changed after planning/);
  assert.equal(await readFile(target, "utf8"), "changed-after-preview\n");

  const modeTarget = await createFile(join(repairRoot, "mode.txt"), "same-content\n");
  await chmod(modeTarget, 0o600);
  const modePlan = await writable.prepareRepairPlan({
    planId: "mode-preimage",
    repairRoot,
    operations: [{ relativePath: "mode.txt", content: "replacement\n" }],
  });
  await chmod(modeTarget, 0o644);
  await assert.rejects(writable.applyRepairPlan(modePlan, {
    applyEnabled: true,
    approvedPlanId: modePlan.planId,
    approvedDigest: writable.previewRepairPlan(modePlan).digest,
  }), /mode changed after planning/);
  assert.equal(await readFile(modeTarget, "utf8"), "same-content\n");
});

test("repair planning enforces rollback bounds and secret-free text", async (t) => {
  const root = await temporaryRoot(t);
  const repairRoot = join(root, "repair");
  await mkdir(repairRoot);
  await createFile(join(repairRoot, "large.txt"), "12345");
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "state"),
    products: [],
    limits: { maxRollbackBytes: 4 },
  });
  await assert.rejects(watch.prepareRepairPlan({
    planId: "too-large",
    repairRoot,
    operations: [{ relativePath: "large.txt", content: "ok\n" }],
  }), /byte limit|maxRollbackBytes/);
  await assert.rejects(lstat(join(root, "state", "rollbacks", "too-large")), /ENOENT/);
  await assert.rejects(watch.prepareRepairPlan({
    planId: "secret-content",
    repairRoot,
    operations: [{ relativePath: "new.txt", content: "api_key = dangerous-value\n" }],
  }), /credentials or authentication material/);
  const secretAssignments = [
    ["environment", "OPENAI_API_KEY = dangerous-value\n"],
    ["client", "client_secret: dangerous-value\n"],
    ["github", "GITHUB_TOKEN=dangerous-value\n"],
    ["aws", "AWS_SECRET_ACCESS_KEY=dangerous-value\n"],
    ["npm", "_authToken=dangerous-value\n"],
  ];
  for (const [name, content] of secretAssignments) {
    await assert.rejects(watch.prepareRepairPlan({
      planId: `secret-${name}`,
      repairRoot,
      operations: [{ relativePath: "new.txt", content }],
    }), /credentials or authentication material/);
  }
});

test("state, artifact, and repair paths fail closed on symlinks and traversal", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const realState = join(root, "real-state");
  await mkdir(realState);
  const linkedState = join(root, "linked-state");
  await symlink(realState, linkedState, "dir");
  const stateWatch = new DesktopCompatibilityWatch({ enabled: true, stateRoot: linkedState, products: [] });
  await assert.rejects(stateWatch.doctor(), /symbolic link or junction/);

  const realArtifact = await createFile(join(root, "artifact.bin"), "artifact\n");
  const linkedArtifact = join(root, "artifact-link.bin");
  await symlink(realArtifact, linkedArtifact, "file");
  const artifactWatch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "artifact-state"),
    products: [{ id: "codex-desktop", kind: "artifact", candidates: [linkedArtifact] }],
  });
  const artifactReport = await artifactWatch.doctor();
  assert.equal(artifactReport.products[0].status, "error");
  assert.match(artifactReport.products[0].error, /symbolic link or junction/);

  const repairRoot = join(root, "repair");
  const outside = join(root, "outside");
  await mkdir(repairRoot);
  await mkdir(outside);
  await symlink(outside, join(repairRoot, "redirect"), "dir");
  const repairWatch = new DesktopCompatibilityWatch({
    enabled: true,
    stateRoot: join(root, "repair-state"),
    products: [],
  });
  await assert.rejects(repairWatch.prepareRepairPlan({
    planId: "traversal",
    repairRoot,
    operations: [{ relativePath: "../outside.txt", content: "safe\n" }],
  }), /Unsafe relative path/);
  await assert.rejects(repairWatch.prepareRepairPlan({
    planId: "symlink-parent",
    repairRoot,
    operations: [{ relativePath: "redirect/file.txt", content: "safe\n" }],
  }), /symbolic link or junction/);
  await assert.rejects(lstat(join(outside, "file.txt")), /ENOENT/);
});

test("optional polling is single-flight, bounded, and cancellable", async (t) => {
  const root = await temporaryRoot(t);
  const cli = await createFile(join(root, "codex"), "cli\n");
  let intervalCallback;
  let intervalMs;
  let unrefCalled = false;
  let cleared = false;
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  let reports = 0;
  let pollErrors = 0;
  let resolvePollError;
  const pollError = new Promise((resolve) => { resolvePollError = resolve; });
  const watch = new DesktopCompatibilityWatch({
    enabled: true,
    pollingEnabled: true,
    pollIntervalMs: 60_000,
    stateRoot: join(root, "state"),
    products: [{ id: "codex-cli", kind: "command", commands: ["codex"] }],
    resolveExecutable: async () => cli,
    runProcess: async () => {
      await probe;
      return fakeResult("codex 1.0.0");
    },
    setIntervalFn(callback, milliseconds) {
      intervalCallback = callback;
      intervalMs = milliseconds;
      return { unref() { unrefCalled = true; } };
    },
    clearIntervalFn() { cleared = true; },
  });
  const polling = watch.startPolling(() => {
    reports += 1;
    if (reports > 1) throw new Error("report sink failed");
  }, {
    onError(error) {
      pollErrors += 1;
      assert.equal(error.reason, "poll");
      resolvePollError();
      throw new Error("poll error sink also failed");
    },
  });
  assert.equal(intervalMs, 60_000);
  assert.equal(unrefCalled, true);
  assert.equal(typeof intervalCallback, "function");
  const first = polling.runNow();
  const overlapping = await polling.runNow();
  assert.deepEqual(overlapping, { skipped: true, reason: "previous-poll-still-running" });
  releaseProbe();
  await first;
  assert.equal(reports, 1);
  intervalCallback();
  await pollError;
  assert.equal(pollErrors, 1);
  assert.equal(polling.stop(), true);
  assert.equal(cleared, true);
  assert.equal(watch.stopPolling(), false);
});
