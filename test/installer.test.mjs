import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
import { EXPLICIT_ONLY_COMPONENT_IDS, OPTIONAL_COMPONENT_IDS } from "../src/installer/components.mjs";

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

  assert.deepEqual(plan.selectedComponents, [...COMPONENT_IDS, ...OPTIONAL_COMPONENT_IDS]);
  assert.equal(plan.selectedComponents.includes("codex-full-access"), false);
  assert.deepEqual(EXPLICIT_ONLY_COMPONENT_IDS, [
    "agentrouter-free",
    "mistral-api-free",
    "groqcloud-free",
    "cloudflare-workers-ai-free",
    "gemini-api-free",
    "codex-full-access",
  ]);
  assert.equal(plan.selectedComponents.includes("agentrouter-free"), false);
  assert.equal(plan.credentialPolicy, "names-and-prerequisite-state-only");
  assert.equal(plan.prerequisites.find((item) => item.name === "NOUS_API_KEY").state, "available");
  assert.equal(plan.prerequisites.find((item) => item.name === "OPENROUTER_API_KEY").state, "available");
  assert.equal(plan.prerequisites.find((item) => item.name === "THREADSPAN_TOKEN").state, "missing");
  const claude = JSON.parse(plan.operations.find((item) => item.component === "claude-code").content);
  assert.equal(claude.communityUntested, true);
  assert.equal(claude.status, "preview");
  assert.equal(claude.liveTested, false);
  assert.equal(claude.selectionPolicy, "explicit-user-approval-required");
  assert.equal(claude.installerAgent.revalidateCurrentOfficialDocs, true);
  assert.match(claude.officialInstallerInstructions.linuxMacWsl, /claude\.ai\/install\.sh/);
  assert.match(claude.officialInstallerInstructions.windowsPowerShell, /claude\.ai\/install\.ps1/);
  assert.doesNotMatch(JSON.stringify(plan), /nous-secret-value|router-secret-value/);
  const continuity = JSON.parse(plan.operations.find((item) => item.component === "continuity").content);
  assert.deepEqual(continuity.excludes, ["memory", "multi-host-sync", "cross-host-communications"]);
  const hostSurfaces = JSON.parse(plan.operations.find((item) => item.component === "host-surfaces").content);
  assert.equal(hostSurfaces.effectiveSettings.rawApiOwner, "host");
  assert.equal(hostSurfaces.branching.synthesisOwner, "caller");
  assert.equal(hostSurfaces.branching.toolPolicy, "decision-useful-only");
  assert.deepEqual(hostSurfaces.connectionRecovery.healthDimensions, ["provider", "account", "transport"]);
  assert.equal(hostSurfaces.connectionRecovery.parentInterruptionHandleAudit, "required");
  assert.equal(hostSurfaces.connectionRecovery.genericUnavailableIsRecoveryAuthority, false);
  assert.equal(hostSurfaces.selfHeal.subsystemOwner, "compatibility-watch");
  assert.equal(hostSurfaces.selfHeal.behavior, "bounded-self-heal");
  assert.deepEqual(hostSurfaces.selfHeal.phases, ["repair", "meta", "meta-meta"]);
  assert.equal(hostSurfaces.selfHeal.maxAnalysisDepth, 2);
  assert.equal(hostSurfaces.selfHeal.immediateRecoveryFirst, true);
  assert.equal(hostSurfaces.selfHeal.recursiveAnalysis, false);
  const allTaskSelfHeal = hostSurfaces.selfHeal.allTasks;
  assert.deepEqual(allTaskSelfHeal.taskTypes, ["research", "browser", "documents", "media", "operations", "provider-setup", "coding"]);
  assert.deepEqual(allTaskSelfHeal.checkpoints, ["task-planning", "direct-repair"]);
  assert.equal(allTaskSelfHeal.directRepairFirst, true);
  assert.equal(allTaskSelfHeal.focusedRegressionEvidenceRequired, true);
  assert.deepEqual(allTaskSelfHeal.phases, ["direct-repair", "focused-regression-evidence", "meta-recognizer-helper-process", "meta-meta-detection-coordination-review"]);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.firstAction, "discover-and-reuse-installed-capabilities");
  assert.deepEqual(allTaskSelfHeal.capabilityDiscovery.sources, ["tools", "skills", "plugins", "provider-capabilities"]);
  assert.deepEqual(allTaskSelfHeal.capabilityDiscovery.evidenceKey, ["host", "provider", "model", "mode", "capability"]);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.providerNativeStrengthsFirst, true);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.crossProviderModelModeAssumptions, false);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.unknownPolicy, "unknown-until-bounded-check");
  assert.equal(allTaskSelfHeal.capabilityDiscovery.selectionPolicy, "smallest-sufficient-non-overlapping-capability");
  assert.deepEqual(allTaskSelfHeal.capabilityDiscovery.selectionFactors, ["capability-fit", "live-availability", "privacy", "quota-cost", "expected-coordination-overhead"]);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.bounded, true);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.stopWhenSufficient, true);
  assert.equal(allTaskSelfHeal.capabilityDiscovery.tokenBurningDiscoveryLoops, false);
  assert.equal(allTaskSelfHeal.reusableCreation.allowedFor, "recurring-or-generalizable-needs-only");
  assert.deepEqual(allTaskSelfHeal.reusableCreation.artifactTypes, ["helper", "skill", "plugin"]);
  assert.deepEqual(allTaskSelfHeal.reusableCreation.requirements, ["clear-trigger", "bounded-scope", "tests", "owner", "rollback-or-expiry", "portability", "no-overlap"]);
  assert.equal(allTaskSelfHeal.reusableCreation.oneOffAutoCreation, false);
  assert.equal(allTaskSelfHeal.reusableCreation.overlapPolicy, "reject-or-reuse-existing");
  assert.equal(allTaskSelfHeal.direct.action, "repair-or-plan-with-reused-capability-first");
  assert.deepEqual(allTaskSelfHeal.meta.updates, ["capability-discovery-registry", "selection-rules", "instructions"]);
  assert.deepEqual(allTaskSelfHeal.metaMeta.analyzes, ["why-capability-was-missed", "why-capability-was-duplicated"]);
  assert.equal(allTaskSelfHeal.approvals.thirdPartySkillOrPluginInstall, "normal-user-approval-required");
  assert.equal(allTaskSelfHeal.approvals.permissionExpansion, "normal-user-approval-required");
  assert.equal(allTaskSelfHeal.maxAnalysisDepth, 2);
  assert.equal(allTaskSelfHeal.projectPolicy, "preserve-no-silent-override");
  assert.equal(allTaskSelfHeal.agentOutput, "evidence-not-completion-authority");
  assert.deepEqual(allTaskSelfHeal.excludes, ["memory", "prompts", "credentials", "cross-host-state"]);
  assert.match(allTaskSelfHeal.reusableDefectProposal, /compatibility-watch-issue-or-pr/);
  assert.equal(hostSurfaces.selfHeal.contribution.autoMerge, false);
  assert.match(hostSurfaces.selfHeal.contribution.localMonitorReview, /triage-test-tweak/);
  assert.deepEqual(hostSurfaces.selfHeal.contribution.excludes, ["machine-local-credentials", "machine-local-state", "prompts"]);
  const compatibilityWatch = JSON.parse(plan.operations.find((item) => item.component === "compatibility-watch").content);
  assert.equal(compatibilityWatch.role, "subsystem-ui-history-owner");
  assert.deepEqual(compatibilityWatch.detects, ["app-drift", "provider-drift", "new-models", "new-providers"]);
  assert.equal(compatibilityWatch.sourcePolicy.officialDocumentation, "authoritative");
  assert.equal(compatibilityWatch.sourcePolicy.trustedTesterReports, "probe-nomination-and-risk-evidence");
  assert.equal(compatibilityWatch.sourcePolicy.preserveExistingModelBehavior, true);
  assert.equal(compatibilityWatch.sourceRegistry.filter(source => source.authority === "official").length >= 7, true);
  assert.equal(compatibilityWatch.reviewCadence.official, "on-release");
  assert.deepEqual(compatibilityWatch.hardeningPhases, ["direct", "meta", "meta-meta"]);
  assert.deepEqual(compatibilityWatch.allTaskSelfHeal, allTaskSelfHeal);
  assert.equal(compatibilityWatch.proposalPolicy, "reviewed-sanitized-github-issue-or-pr");
  const maximum = JSON.parse(plan.operations.find((item) => item.component === "maximum-utilization").content);
  assert.equal(maximum.enabled, false);
  assert.equal(maximum.sourceKind, "codex-native-quota");
  assert.equal(maximum.hostActionPolicy, "capability-tagged-request-only");
  assert.equal(maximum.unsupportedActionPolicy, "pending-or-unsupported");
  const beads = JSON.parse(plan.operations.find((item) => item.component === "beads").content);
  assert.equal(beads.enabled, false);
  assert.equal(beads.initializeAutomatically, false);
  assert.equal(beads.migrateAutomatically, false);
  assert.equal(beads.readinessMeansSchedulingEvidenceOnly, true);
  const bootstrap = JSON.parse(plan.operations.find((item) => item.component === "project-bootstrap").content);
  assert.equal(bootstrap.enabled, false);
  assert.equal(bootstrap.preserveExistingFiles, true);
  assert.deepEqual(bootstrap.excludes, ["memory", "multi-host-sync", "cross-host-communications"]);
});

test("AgentRouter free route is explicit-only, cardless, freshness-bound, and value-free", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({
    installRoot: root,
    selection: ["agentrouter-free"],
    environment: { AGENTROUTER_API_KEY: "never-render-this-value" },
    planId: "agentrouter-free",
  });
  assert.deepEqual(plan.selectedComponents, ["agentrouter-free"]);
  const installed = JSON.parse(plan.operations[0].content);
  assert.equal(installed.enabled, false);
  assert.equal(installed.paidUpgradeAllowed, false);
  assert.equal(installed.paymentMethodRequired, false);
  assert.equal(installed.hardCappedTokenRequired, true);
  assert.equal(installed.separateTokenPerHost, true);
  assert.equal(installed.offerEndDate, null);
  assert.equal(installed.visibilityFreshnessDays, 7);
  assert.equal(installed.requiresLiveProbe, true);
  assert.equal(installed.integratedSupported, false);
  assert.equal(installed.gateway.apiKeyEnv, "AGENTROUTER_API_KEY");
  assert.equal(plan.prerequisites.find((item) => item.name === "AGENTROUTER_API_KEY").state, "available");
  assert.equal(installed.installerActions.createAccount, false);
  assert.equal(installed.installerActions.configurePayment, false);
  assert.equal(installed.installerActions.enableProvider, false);
  assert.doesNotMatch(JSON.stringify(plan), /never-render-this-value/);
});

test("free API discovery candidates are explicit-only, check-first, and non-mutating", async (t) => {
  const root = await temporaryRoot(t);
  const candidates = [
    ["mistral-api-free", "MISTRAL_API_KEY"],
    ["groqcloud-free", "GROQ_API_KEY"],
    ["cloudflare-workers-ai-free", "CLOUDFLARE_API_TOKEN"],
    ["gemini-api-free", "GEMINI_API_KEY"],
  ];
  for (const [id, envName] of candidates) {
    const plan = createInstallerPlan({ installRoot: root, selection: [id], planId: id });
    const configuration = JSON.parse(plan.operations[0].content);
    assert.equal(configuration.enabled, false);
    assert.equal(configuration.paidUpgradeAllowed, false);
    assert.equal(configuration.requiresLiveCardlessCheck, true);
    assert.equal(configuration.offerEndDate, null);
    assert.equal(configuration.visibilityFreshnessDays, 7);
    assert.equal(configuration.apiKeyEnv, envName);
    assert.equal(configuration.installerActions.createAccount, false);
    assert.equal(configuration.installerActions.createCredential, false);
    assert.equal(configuration.installerActions.installApp, false);
    assert.equal(configuration.installerActions.changeBilling, false);
    assert.equal(configuration.installerActions.enableRoute, false);
    assert.match(configuration.officialUrl, /^https:\/\//);
  }
});

test("Codex full access is explicit-only, contentless in plans, reversible, and no-ops when matched", async (t) => {
  const root = await temporaryRoot(t);
  const codexHome = join(root, "selected-codex-home");
  const configPath = join(codexHome, "config.toml");
  await mkdir(codexHome);
  const previous = `# owner config\nmodel = "owner-model"\nhttp_headers = { Authorization = "secret-token" }\n\n[apps.drive]\nenabled = false\n\n[apps.drive.tools.delete]\napproval_mode = "prompt"\n\n[mcp_servers.local]\ncommand = "secret-command"\n`;
  await writeFile(configPath, previous);
  await chmod(configPath, 0o640);
  const environment = { CODEX_HOME: codexHome };
  const plan = createInstallerPlan({ installRoot: root, selection: ["codex-full-access"], environment, planId: "codex-full-access" });
  const operation = plan.operations[0];

  assert.deepEqual(plan.selectedComponents, ["codex-full-access"]);
  assert.equal("content" in operation, false);
  assert.equal("relativePath" in operation, false);
  assert.equal(operation.targetPath, configPath);
  assert.equal(operation.transformId, "codex-full-access-v1");
  assert.match(operation.expectedPreimageSha256, /^[0-9a-f]{64}$/);
  assert.match(operation.expectedNextSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(operation.conflicts, [{ kind: "app-tool", table: "apps.drive.tools.delete", setting: "approval_mode" }]);
  assert.doesNotMatch(JSON.stringify(plan), /secret-token|secret-command|owner-model/);
  const preview = previewInstallerPlan(plan);
  assert.match(preview.text, /approval_policy=never/);
  assert.match(preview.text, /sandbox_mode=danger-full-access/);
  assert.match(preview.text, /app and MCP tools are preapproved/i);
  assert.match(preview.text, /does not enable destructive_enabled or open_world_enabled/i);
  assert.match(preview.text, /Residual conflict: apps\.drive\.tools\.delete\.approval_mode/);
  assert.doesNotMatch(preview.text, /secret-token|secret-command|owner-model/);

  const applied = await applyInstallerPlan(plan, { approvedDigest: plan.digest, environment });
  const manifest = JSON.parse(await readFile(applied.manifestPath, "utf8"));
  const installed = await readFile(configPath, "utf8");
  assert.match(installed, /^# owner config\nmodel = "owner-model"/);
  assert.match(installed, /approval_policy = "never"/);
  assert.match(installed, /sandbox_mode = "danger-full-access"/);
  assert.match(installed, /\[apps\.drive\][\s\S]*approvals_reviewer = "user"[\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(installed, /\[mcp_servers\.local\][\s\S]*default_tools_approval_mode = "approve"/);
  assert.match(installed, /\[apps\.drive\.tools\.delete\]\napproval_mode = "prompt"/);
  assert.equal((await lstat(configPath)).mode & 0o777, 0o640);
  assert.equal(await readFile(join(root, manifest.entries[0].backup), "utf8"), previous);
  assert.equal(manifest.entries[0].originalMode, 0o640);
  assert.doesNotMatch(JSON.stringify(manifest), /secret-token|secret-command|owner-model/);

  const unchanged = createInstallerPlan({ installRoot: root, selection: ["codex-full-access"], environment, planId: "codex-full-access-noop" });
  assert.equal(unchanged.hasChanges, false);
  assert.equal(unchanged.operations.length, 0);
  assert.equal(unchanged.unchanged[0].reason, "codex-full-access-policy-match");
  assert.deepEqual(unchanged.unchanged[0].conflicts, operation.conflicts);
  assert.match(previewInstallerPlan(unchanged).text, /Residual conflict: apps\.drive\.tools\.delete\.approval_mode/);
});

test("Codex full-access apply rejects content drift and a symlinked config parent", async (t) => {
  const root = await temporaryRoot(t);
  const codexHome = join(root, "codex-home");
  await mkdir(codexHome);
  const configPath = join(codexHome, "config.toml");
  await writeFile(configPath, "model = \"owner\"\n");
  const environment = { CODEX_HOME: codexHome };
  const driftPlan = createInstallerPlan({ installRoot: root, selection: ["codex-full-access"], environment, planId: "codex-drift" });
  await writeFile(configPath, "model = \"changed\"\n");
  await assert.rejects(applyInstallerPlan(driftPlan, { approvedDigest: driftPlan.digest, environment }), /content changed after preview/);
  assert.equal(await readFile(configPath, "utf8"), "model = \"changed\"\n");

  const realHome = join(root, "real-codex-home");
  const redirectedHome = join(root, "redirected-codex-home");
  await Promise.all([mkdir(realHome), mkdir(redirectedHome)]);
  await writeFile(join(realHome, "config.toml"), "model = \"owner\"\n");
  const symlinkEnvironment = { CODEX_HOME: realHome };
  const symlinkPlan = createInstallerPlan({ installRoot: root, selection: ["codex-full-access"], environment: symlinkEnvironment, planId: "codex-parent-link" });
  const movedHome = join(root, "moved-codex-home");
  await rename(realHome, movedHome);
  await symlink(redirectedHome, realHome, "dir");
  await assert.rejects(applyInstallerPlan(symlinkPlan, { approvedDigest: symlinkPlan.digest, environment: symlinkEnvironment }), /symbolic-link parent/);
  await assert.rejects(readFile(join(redirectedHome, "config.toml")), /ENOENT/);
});

test("Beads and project bootstrap are independent opt-in preview-only components", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({
    installRoot: root,
    selection: ["beads", "project-bootstrap"],
    planId: "project-foundation",
  });
  assert.deepEqual(plan.selectedComponents, ["beads", "project-bootstrap"]);
  assert.deepEqual(plan.operations.map((item) => item.relativePath), [
    "threadspan/components/beads.json",
    "threadspan/components/project-bootstrap.json",
  ]);
  assert.equal(plan.prerequisites.every((item) => item.state === "manual"), true);
  assert.match(plan.prerequisites[0].message, /never initialize, migrate, or mutate/i);
  assert.match(plan.prerequisites[1].message, /preview every project-local file/i);
});

test("maximum utilization is selectable alone and writes disabled-by-default safe configuration", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({ installRoot: root, selection: ["maximum-utilization"], planId: "max-util" });
  assert.deepEqual(plan.selectedComponents, ["maximum-utilization"]);
  assert.equal(plan.operations.length, 1);
  const configuration = JSON.parse(plan.operations[0].content);
  assert.equal(configuration.enabled, false);
  assert.match(plan.prerequisites[0].message, /authoritative native quota/i);
  assert.match(plan.prerequisites[0].message, /capable host adapter/i);
});

test("Tips is an optional heuristic-first component and remains disabled by default", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({ installRoot: root, selection: ["tips"], planId: "tips" });
  assert.deepEqual(plan.selectedComponents, ["tips"]);
  assert.equal(plan.operations[0].relativePath, "threadspan/components/tips.json");
  const configuration = JSON.parse(plan.operations[0].content);
  assert.equal(configuration.enabled, false);
  assert.equal(configuration.maximumPerSession, 1);
  assert.equal(configuration.defaultModelCalls, 0);
  assert.equal(configuration.defaultNetworkCalls, 0);
  assert.equal(configuration.modelRefinement.enabled, false);
  assert.equal(configuration.modelRefinement.maxCallsPerSession, 1);
  assert.equal(configuration.modelRefinement.maxOutputTokens, 96);
  assert.equal(configuration.modelRefinement.privacy, "deny");
  assert.equal(configuration.ask.enabled, false);
  assert.equal(configuration.ask.sessionBounded, true);
  assert.equal(configuration.ask.memory, false);
  assert.deepEqual(configuration.excludes, ["prompts", "identifiers", "credentials"]);
  assert.match(plan.prerequisites[0].message, /model refinement and Ask require separate provider\/privacy configuration and explicit user action/i);
});

test("Voice selection writes exact managed configuration with forward fields and rollback", async (t) => {
  const root = await temporaryRoot(t);
  const target = join(root, "threadspan", "components", "voice-profiles.json");
  await mkdir(dirname(target), { recursive: true });
  const previous = `${JSON.stringify({ schemaVersion: 1, component: "voice-profiles", selectedProfile: "technical-partner", profiles: [], futureManagedField: { retain: true } }, null, 2)}\n`;
  await writeFile(target, previous);
  const voice = {
    selectedProfile: "custom",
    profiles: [{
      id: "custom", name: "Custom", userPromise: "Custom release voice.",
      parameters: { directness: 4, warmth: 3, technicalDepth: 5, progressCadence: 2, uncertaintyDisclosure: 5, correctionExplicitness: 5, futureParameter: 7 },
      preferredTerms: ["evidence"], avoidedTerms: ["obviously"], futureProfile: true,
    }],
  };
  const plan = createInstallerPlan({ installRoot: root, selection: ["voice-profiles"], voice, planId: "voice-managed" });
  assert.equal(plan.operations[0].relativePath, "threadspan/components/voice-profiles.json");
  assert.equal(plan.voice.selectedProfile, "custom");
  assert.match(previewInstallerPlan(plan).text, /voice-profiles\.json/);
  const result = await applyInstallerPlan(plan, { approvedDigest: plan.digest });
  const installed = JSON.parse(await readFile(target, "utf8"));
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
  assert.deepEqual(installed.futureManagedField, { retain: true });
  assert.equal(installed.profiles[0].futureProfile, true);
  assert.equal(installed.profiles[0].parameters.futureParameter, 7);
  assert.equal(await readFile(join(root, manifest.entries[0].backup), "utf8"), previous);
  const digestRoot = await temporaryRoot(t);
  const baseline = createInstallerPlan({ installRoot: digestRoot, selection: ["voice-profiles"], voice, planId: "voice-changed" });
  const changed = createInstallerPlan({ installRoot: digestRoot, selection: ["voice-profiles"], voice: { ...voice, profiles: [{ ...voice.profiles[0], parameters: { ...voice.profiles[0].parameters, warmth: 4 } }] }, planId: "voice-changed" });
  assert.notEqual(changed.digest, baseline.digest);
});

test("project bootstrap reservation recovery is explicit, exact, visible, and non-interrupting", async (t) => {
  const root = await temporaryRoot(t);
  const plan = createInstallerPlan({ installRoot: root, selection: ["project-bootstrap"], planId: "reservation-recovery" });
  const configuration = JSON.parse(plan.operations[0].content);
  assert.deepEqual(configuration.reservationRecovery, {
    enabledByDefault: false,
    authorization: "explicit-owner-only",
    visibility: "required-before-action",
    evidence: "preserve-claim-and-release-receipt",
    firstAction: "exact-working-sentinel-tool-release",
    scope: "exact-claim-only",
    activeWork: "never-interrupt",
    fallback: "no-silent-default",
  });
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
  const previous = `${JSON.stringify({ schemaVersion: 1, component: "daemon", projectSetting: { preserveMe: true }, port: 9999 }, null, 2)}\n`;
  await writeFile(target, previous);
  const plan = createInstallerPlan({ installRoot: root, selection: ["daemon"], planId: "safe-apply" });

  await assert.rejects(applyInstallerPlan(plan, { approvedDigest: "not-previewed" }), /requires the digest/);
  assert.equal(await readFile(target, "utf8"), previous);

  const preview = previewInstallerPlan(plan);
  assert.match(preview.text, /Rollback manifest: \.threadspan-installer\/rollbacks\/safe-apply\.json/);
  assert.match(preview.text, /threadspan\/components\/daemon\.json/);
  assert.equal(plan.operations[0].change.scope, "component:daemon");
  assert.equal(plan.operations[0].change.reversible, true);
  assert.match(plan.operations[0].change.previousSha256, /^[0-9a-f]{64}$/);
  const result = await applyInstallerPlan(plan, { approvedDigest: preview.digest });
  const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

  assert.equal(manifest.status, "applied");
  assert.equal(manifest.entries[0].target, "threadspan/components/daemon.json");
  assert.equal(await readFile(join(root, manifest.entries[0].backup), "utf8"), previous);
  const installed = JSON.parse(await readFile(target, "utf8"));
  assert.equal(installed.component, "daemon");
  assert.deepEqual(installed.projectSetting, { preserveMe: true });
  assert.equal(installed.port, 8743);
  await assert.rejects(applyInstallerPlan(plan, { approvedDigest: preview.digest }), /already has a rollback manifest/);
});

test("installer skips matching files and visibly excludes unmanaged native settings", async (t) => {
  const root = await temporaryRoot(t);
  const first = createInstallerPlan({ installRoot: root, selection: ["daemon"], planId: "initial" });
  await applyInstallerPlan(first, { approvedDigest: first.digest });

  const unchanged = createInstallerPlan({ installRoot: root, selection: ["daemon"], planId: "no-op" });
  assert.equal(unchanged.hasChanges, false);
  assert.equal(unchanged.operations.length, 0);
  assert.equal(unchanged.prerequisites.length, 0);
  assert.deepEqual(unchanged.unchanged.map((item) => item.relativePath), ["threadspan/components/daemon.json"]);
  assert.match(unchanged.digest, /^[0-9a-f]{64}$/);

  const profile = join(root, "gpt-5.6-default.config.toml");
  await writeFile(profile, "# Owner profile\nmodel = \"owner-choice\"\n");
  const excluded = createInstallerPlan({ installRoot: root, selection: ["context-profiles"], planId: "preserve-native" });
  assert.equal(excluded.exclusions.some((item) => item.relativePath === "gpt-5.6-default.config.toml"), true);
  assert.match(excluded.exclusions.find((item) => item.relativePath === "gpt-5.6-default.config.toml").reason, /native user\/project settings were preserved/i);
  assert.equal(await readFile(profile, "utf8"), "# Owner profile\nmodel = \"owner-choice\"\n");

  const futureTarget = join(root, "threadspan", "components", "cursor.json");
  const future = `${JSON.stringify({ schemaVersion: 2, component: "cursor", futureSetting: true }, null, 2)}\n`;
  await writeFile(futureTarget, future);
  const futurePlan = createInstallerPlan({ installRoot: root, selection: ["cursor"], planId: "preserve-future" });
  assert.equal(futurePlan.operations.length, 0);
  assert.match(futurePlan.exclusions[0].reason, /current Threadspan schema\/ownership marker/);
  assert.equal(await readFile(futureTarget, "utf8"), future);
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
