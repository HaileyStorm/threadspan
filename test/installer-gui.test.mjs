import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import { InstallerGuiController, resolveOfferVisibility } from "../src/installer/gui-controller.mjs";
import { createInstallerPlan } from "../src/installer/components.mjs";
import { InstallerRecoveryStore } from "../src/installer/recovery-store.mjs";
import { InstallerStableUpdater } from "../src/installer/update-check.mjs";

test("GUI checks stable release first, reuses the digest plan, and defaults active tasks to wait", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  let inventoryCalls = 0;
  let updateCalls = 0;
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: {
      checkAndUpdate: async () => {
        updateCalls += 1;
        assert.equal(inventoryCalls, 0, "stable update must complete before task/component bootstrap");
        return { status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0", canContinueCurrent: true, retryable: true };
      },
    },
    listTasks: async () => inventoryCalls++ === 0
      ? [{ project: "/repo", defaultDisposition: "wait", tasks: [{ id: "t1", name: "Build", status: "active", defaultDisposition: "wait" }] }]
      : [],
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  const bootstrap = await controller.bootstrap(nonce);
  assert.equal(updateCalls, 1);
  assert.equal(bootstrap.update.status, "current");
  assert.equal(bootstrap.taskGroups[0].defaultDisposition, "wait");
  assert.equal(bootstrap.defaults.includes("maximum-utilization"), false);
  assert.equal(bootstrap.defaults.includes("beads"), false);
  assert.equal(bootstrap.defaults.includes("project-bootstrap"), false);
  assert.equal(bootstrap.defaults.includes("codex-full-access"), false);
  assert.equal(bootstrap.defaults.includes("copy-naturalizer"), false);
  assert.equal(bootstrap.defaults.includes("copy-check"), false);
  assert.equal(bootstrap.defaults.includes("agentrouter-free"), false);
  for (const id of ["mistral-api-free", "groqcloud-free", "cloudflare-workers-ai-free", "gemini-api-free"]) {
    assert.equal(bootstrap.defaults.includes(id), false);
    assert.equal(bootstrap.components.find(item => item.id === id).optional, true);
  }
  assert.equal(bootstrap.components.find(item => item.id === "beads").optional, true);
  assert.equal(bootstrap.components.find(item => item.id === "project-bootstrap").optional, true);
  assert.equal(bootstrap.components.find(item => item.id === "codex-full-access").optional, true);
  const copyNaturalizer = bootstrap.components.find(item => item.id === "copy-naturalizer");
  assert.equal(copyNaturalizer.optional, true);
  assert.equal(copyNaturalizer.group, "writing-tools");
  assert.match(copyNaturalizer.localHeuristicsTooltip, /without leaving this device/);
  assert.match(copyNaturalizer.configuredRewriteTooltip, /already configured and explicitly choose/);
  assert.match(copyNaturalizer.configuredRewriteTooltip, /does not select or enable one/);
  assert.match(copyNaturalizer.localDisclaimer, /never auto-apply/i);
  const copyCheck = bootstrap.components.find(item => item.id === "copy-check");
  assert.equal(copyCheck.optional, true);
  assert.equal(copyCheck.group, "writing-tools");
  assert.match(copyCheck.destinationTooltip, /api.sapling.ai\/api\/v1\/aidetect/);
  assert.match(copyCheck.payloadTooltip, /12,000/);
  assert.match(copyCheck.retentionTooltip, /stores submitted text and uses it to improve/i);
  assert.match(copyCheck.trialTooltip, /limited 2,000-credit developer trial/i);
  assert.match(copyCheck.trialTooltip, /not permanently free/i);
  assert.match(copyCheck.partnershipTooltip, /no partnership/i);
  assert.match(copyCheck.detectorDisclaimer, /cannot prove authorship/i);
  assert.equal(bootstrap.components.find(item => item.id === "agentrouter-free").optional, true);
  assert.equal(bootstrap.components.find(item => item.id === "agentrouter-free").offerEndDate, null);
  assert.equal(bootstrap.components.find(item => item.id === "agentrouter-free").visibilityFreshnessDays, 7);
  assert.equal(bootstrap.components.find(item => item.id === "agentrouter-free").requiresLiveProbe, true);
  assert.equal(bootstrap.defaults.includes("voice-profiles"), true);
  assert.equal(bootstrap.voice.selectedProfile, "technical-partner");
  assert.deepEqual(bootstrap.voice.presets.map((profile) => profile.id), ["technical-partner", "concise-operator", "teaching-explainer", "diagnostic-reviewer", "calm-guide"]);
  assert.deepEqual(bootstrap.voice.profiles, []);
  const planned = await controller.plan(nonce, { components: ["daemon"] });
  await assert.rejects(controller.apply(nonce, { approvedDigest: planned.plan.digest }), /closure approval/);
  await controller.protect(nonce, { taskIds: ["t1"], disposition: "wait" });
  const applied = await controller.apply(nonce, { approvedDigest: planned.plan.digest, desktopClosureApproved: true });
  assert.equal(applied.status, "applied");
});

test("volatile offer visibility expires to check-first and hides after a known end without fresh proof", () => {
  const policy = { offerEndDate: null, visibilityFreshnessDays: 7, requiresLiveProbe: true, lastLiveProbeDate: "2026-08-18" };
  assert.deepEqual(resolveOfferVisibility(policy, Date.parse("2026-08-20T00:00:00Z")), { hidden: false, readiness: "available", label: "Recently live-probed" });
  assert.deepEqual(resolveOfferVisibility(policy, Date.parse("2026-08-26T00:00:00Z")), { hidden: false, readiness: "unknown", label: "Check availability" });
  assert.deepEqual(resolveOfferVisibility({ ...policy, offerEndDate: "2026-08-24" }, Date.parse("2026-08-26T00:00:00Z")), { hidden: true, readiness: "unavailable", label: "Offer ended — fresh proof required" });
  assert.deepEqual(resolveOfferVisibility({ ...policy, offerEndDate: "2026-08-17" }, Date.parse("2026-08-20T00:00:00Z")), { hidden: false, readiness: "available", label: "Recently live-probed" });
});

test("installer GUI presents Codex full access as an explicit unchecked warning", async () => {
  const source = await readFile(new URL("../ui/install.js", import.meta.url), "utf8");
  assert.match(source, /c\.id==="codex-full-access"/);
  assert.match(source, /explicit-only and separately confirmed/);
  assert.match(source, /Existing tools may read and write files, execute commands, and use the network without approvals/);
  assert.match(source, /does not install or enable new tools, apps, plugins, or servers/);
  assert.match(source, /state\.selected\.has\(c\.id\)\?"checked":""/);
});

test("installer theme control is accessible, enum-only, host-aware, and dark before CSS", async () => {
  const [html, source, styles] = await Promise.all([
    readFile(new URL("../ui/install.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<html[^>]+data-theme="dark"[^>]+data-theme-mode="system"/);
  assert.match(html, /meta name="color-scheme" content="dark light"/);
  assert.ok(html.indexOf("threadspanInstallerTheme") < html.indexOf("install.css"), "theme bootstrap must run before the stylesheet");
  assert.match(html, /fieldset class="theme-picker" aria-label="Installer theme"/);
  assert.match(html, /legend class="sr-only">Installer theme/);
  for (const mode of ["system", "dark", "light"]) assert.match(html, new RegExp(`name="installer-theme" value="${mode}"`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Installed HUD accents are unchanged/);
  assert.match(styles, /:root\{color-scheme:dark/);
  assert.match(styles, /html\[data-theme="light"\]\{color-scheme:light/);
  assert.match(styles, /theme-picker label:has\(input:focus-visible\)/);
  assert.match(source, /THEME_MODES=new Set\(\["system","dark","light"\]\)/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /bootstrapThemeHint/);
  assert.match(source, /bootstrap\?\.recovery\?\.appearance\?\.theme/);
  assert.match(source, /localStorage\.setItem\(THEME_STORAGE_KEY,mode\)/);
  assert.equal((source.match(/localStorage\.setItem/g) ?? []).length, 1);
  assert.doesNotMatch(html + source, /threadspanAccent/);
});

test("provider readiness fails closed into Add providers and selection retains digest-bound prerequisites", async (t) => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../ui/install.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<details class="add-providers">/);
  assert.match(source, /Extra providers stay here until installed or live-checked/);
  assert.match(source, /Free and no-card access can change/);
  assert.match(source, /Selecting one only adds setup steps/);
  assert.match(source, /nothing is installed, authenticated, enabled, or billed without approval/);
  assert.match(source, /No provider partnership is implied/);
  assert.match(source, /componentReadiness\(component\)!=="ready"\)state\.selected\.delete/);
  assert.match(source, /return"unknown"/);
  assert.match(source, /const readinessText=c\.availabilityLabel\|\|readinessLabel\(readiness\)/);
  assert.match(source, /Readiness: \$\{esc\(readinessText\)\}/);
  assert.match(styles, /\.add-providers>summary/);
  assert.match(styles, /\.readiness\.unknown/);
  assert.doesNotMatch(source, /localStorage\.setItem\([^)]*provider/i);

  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-provider-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grok = createInstallerPlan({ installRoot: root, selection: ["grok-build"], planId: "add-grok" });
  assert.equal(grok.selectedComponents[0], "grok-build");
  assert.match(grok.prerequisites.map(item => item.message).join("\n"), /Install and sign in with Grok Build/);
  const claude = createInstallerPlan({ installRoot: root, selection: ["claude-code"], planId: "add-claude" });
  assert.match(claude.prerequisites.map(item => item.message).join("\n"), /explicit user approval/);
  assert.match(claude.prerequisites.map(item => item.message).join("\n"), /Preview\/live-untested/);
  const agentrouter = createInstallerPlan({ installRoot: root, selection: ["agentrouter-free"], planId: "add-agentrouter" });
  assert.match(agentrouter.prerequisites.map(item => item.message).join("\n"), /fresh live probe before enabling/i);
  assert.match(agentrouter.prerequisites.map(item => item.message).join("\n"), /browser account or token actions require separate explicit authorization/i);
  assert.doesNotMatch(JSON.stringify({ grok, claude, agentrouter }), /Bearer |credential-value/i);
});

test("installer GUI exposes a separate exact provider-activation review without credentials or implicit routing", async () => {
  const source = await readFile(new URL("../ui/install.js", import.meta.url), "utf8");
  assert.match(source, /Activate one provider/);
  assert.match(source, /Choose one exact mode\/provider\/account\/model request/);
  assert.match(source, /No smart routing, fallback, takeover, retry/);
  assert.match(source, /providerActivation:true/);
  assert.match(source, /Exact one-attempt provider plan created/);
  assert.doesNotMatch(source, /activation-(?:token|api-key|credential-value)/i);
});

test("GUI plans and applies Codex full access against its selected host environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-codex-policy-"));
  const installRoot = join(root, "install");
  const codexHome = join(root, "codex-home");
  await Promise.all([mkdir(installRoot), mkdir(codexHome)]);
  await writeFile(join(codexHome, "config.toml"), "model = \"owner\"\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    environment: { CODEX_HOME: codexHome },
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0" }) },
    listTasks: async () => [],
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  await controller.bootstrap(nonce);
  const planned = await controller.plan(nonce, { components: ["codex-full-access"] });
  assert.equal(planned.plan.operations[0].targetPath, join(codexHome, "config.toml"));
  await controller.protect(nonce, { taskIds: [], disposition: "wait" });
  const applied = await controller.apply(nonce, { approvedDigest: planned.plan.digest, desktopClosureApproved: true });
  assert.equal(applied.status, "applied");
  assert.match(await readFile(join(codexHome, "config.toml"), "utf8"), /sandbox_mode = "danger-full-access"/);
});

test("installer presents maximum utilization as optional unchecked with fail-closed tooltip copy", async () => {
  const source = await readFile(new URL("../ui/install.js", import.meta.url), "utf8");
  assert.match(source, /id:"maximum-utilization"/);
  assert.match(source, /Needs authoritative native quota \+ capable host adapter; otherwise remains observational\/pending\./);
  assert.match(source, /state\.selected\.has\(c\.id\)\?"checked":""/);
  assert.doesNotMatch(source, /Roadmap[^<]*maximum utilization/i);
});

test("installer presents Copy Naturalizer collapsed and unchecked without setup metrics", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../ui/install.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /<details class="writing-tools">/);
  assert.doesNotMatch(source, /<details class="writing-tools"[^>]*\bopen\b/);
  assert.match(source, />Writing tools <span>/);
  assert.match(source, /groups\.writingTools\.map\(componentChoiceMarkup\)/);
  assert.match(source, /state\.selected\.has\(c\.id\)\?"checked":""/);
  assert.match(source, /data-tooltip=.*localHeuristicsTooltip/);
  assert.match(source, /data-tooltip=.*configuredRewriteTooltip/);
  assert.match(source, /\.help-tip"\)\.forEach\(el=>el\.addEventListener\("click",event=>\{event\.preventDefault\(\);event\.stopPropagation\(\);el\.focus\(\)\}\)\)/);
  assert.match(source, /copy-disclaimer/);
  const copyMarkup = source.slice(source.indexOf("function copyNaturalizerDetails"), source.indexOf("function componentReadiness"));
  assert.doesNotMatch(copyMarkup, /story|build|metric|score|cost/i);
  assert.match(styles, /\.writing-tools/);
  assert.match(styles, /\.writing-tools \.choice-list\{overflow:visible\}/);
  assert.match(styles, /\.help-tip:hover::after,\.help-tip:focus::after/);
  assert.match(styles, /\.copy-disclaimer/);
});

test("installer GUI presents Voice presets, customization, live preview, and reset", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("../ui/install.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /data-voice-preset/);
  assert.match(source, /Advanced controls/);
  assert.match(source, /Live preview/);
  assert.match(source, /Reset to Technical partner/);
  assert.match(source, /voicePlanInput\(\)/);
  assert.match(source, /Changes wording and progress cadence only\. Tools, permissions, and evidence stay the same/);
  assert.match(styles, /\.voice-grid/);
  assert.match(styles, /\.voice-sliders/);
  assert.match(styles, /\.voice-preview/);
});

test("GUI forwards the exact custom Voice selection into the digest-bound plan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-voice-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0" }) },
    listTasks: async () => [],
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  await controller.bootstrap(nonce);
  const voice = { selectedProfile: "custom", profiles: [{
    id: "custom", name: "Custom", userPromise: "A custom installer voice.",
    parameters: { directness: 5, warmth: 4, technicalDepth: 4, progressCadence: 2, uncertaintyDisclosure: 5, correctionExplicitness: 5 },
    preferredTerms: ["evidence"], avoidedTerms: [],
  }] };
  const planned = await controller.plan(nonce, { components: ["voice-profiles"], voice });
  assert.equal(planned.plan.voice.selectedProfile, "custom");
  assert.equal(JSON.parse(planned.plan.operations[0].content).profiles[0].preferredTerms[0], "evidence");
  assert.match(planned.preview.text, /voice-profiles\.json/);
});

test("GUI hydrates an existing managed custom Voice instead of resetting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-voice-hydrate-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const voice = { selectedProfile: "custom", profiles: [{
    id: "custom", name: "Existing custom", userPromise: "Preserve this custom voice.",
    parameters: { directness: 4, warmth: 5, technicalDepth: 4, progressCadence: 2, uncertaintyDisclosure: 5, correctionExplicitness: 5, futureParameter: 8 },
    preferredTerms: ["evidence"], avoidedTerms: [], futureProfile: { retained: true },
  }] };
  const seed = createInstallerPlan({ installRoot, selection: ["voice-profiles"], voice, planId: "seed-voice" });
  const target = join(installRoot, seed.operations[0].relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, seed.operations[0].content);
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0" }) },
    listTasks: async () => [],
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const bootstrap = await controller.bootstrap(new URL(created.url).hash.slice("#session=".length));
  assert.equal(bootstrap.voice.selectedProfile, "custom");
  assert.equal(bootstrap.voice.profiles[0].parameters.futureParameter, 8);
  assert.deepEqual(bootstrap.voice.profiles[0].futureProfile, { retained: true });
});

test("GUI treats matching managed files as a no-op with no closure, task, or write approval", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-no-op-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = createInstallerPlan({ installRoot, selection: ["daemon"], planId: "seed" });
  const target = join(installRoot, initial.operations[0].relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, initial.operations[0].content, { mode: 0o600 });

  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    listTasks: async () => { throw new Error("no-op plan must not inspect or protect tasks"); },
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  const planned = await controller.plan(nonce, { components: ["daemon"] });
  assert.equal(planned.plan.hasChanges, false);
  assert.equal(planned.plan.operations.length, 0);
  const protectedResult = await controller.protect(nonce, { taskIds: ["should-not-be-read"], disposition: "wait" });
  assert.equal(protectedResult.noChanges, true);
  const applied = await controller.apply(nonce, { approvedDigest: planned.plan.digest });
  assert.equal(applied.status, "unchanged");
  assert.deepEqual(applied.written, []);

  const staleSession = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const staleNonce = new URL(staleSession.url).hash.slice("#session=".length);
  const stalePlan = await controller.plan(staleNonce, { components: ["daemon"] });
  await writeFile(target, stalePlan.plan.unchanged[0].contentSha256 ? `${initial.operations[0].content}\n` : initial.operations[0].content);
  await assert.rejects(controller.apply(staleNonce, { approvedDigest: stalePlan.plan.digest }), /changed after review/);

  await writeFile(target, "owner-managed elsewhere\n");
  const preservedSession = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const preservedNonce = new URL(preservedSession.url).hash.slice("#session=".length);
  const preservedPlan = await controller.plan(preservedNonce, { components: ["daemon"] });
  assert.equal(preservedPlan.plan.operations.length, 0);
  assert.equal(preservedPlan.plan.exclusions.length, 1);
  const preserved = await controller.apply(preservedNonce, { approvedDigest: preservedPlan.plan.digest });
  assert.equal(preserved.status, "preserved");
  assert.equal(await readFile(target, "utf8"), "owner-managed elsewhere\n");

  const source = await readFile(new URL("../ui/install.js", import.meta.url), "utf8");
  assert.match(source, /Nothing to approve/);
  assert.match(source, /No writable installation changes are planned/);
  assert.match(source, /Compatibility Watch — Recover, learn, harden/);
  assert.match(source, /deterministic early code-work failures/);
  assert.match(source, /agent output remains evidence, not completion authority/);
  assert.match(source, /Detect app\/provider drift, restore compatibility, run bounded direct\/meta\/meta-meta hardening/);
  assert.match(source, /sanitized GitHub issue\/PR proposals/);
  assert.match(source, /agent-submitted auto-merge/);
});

test("GUI exposes offline update failure while allowing the current installer to continue", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-offline-"));
  await mkdir(join(root, "install"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "unavailable", reason: "github-unavailable", canContinueCurrent: true, retryable: true, message: "offline" }) },
    listTasks: async () => [],
  });
  const created = await controller.createSession({ installRoot: join(root, "install"), origin: { kind: "direct" } });
  const bootstrap = await controller.bootstrap(new URL(created.url).hash.slice("#session=".length));
  assert.equal(bootstrap.update.status, "unavailable");
  assert.equal(bootstrap.update.canContinueCurrent, true);
  assert.ok(bootstrap.components.length > 0);
});

test("verified staged relaunch resumes against the staged root instead of repeating the bundle update", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-resume-"));
  const installRoot = join(root, "install");
  const stagedRoot = join(root, "staged", "threadspan-0.5.0");
  await Promise.all([mkdir(installRoot, { recursive: true }), mkdir(stagedRoot, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: {
      checkAndUpdate: async (context) => {
        calls.push(context);
        return calls.length === 1
          ? { status: "relaunching", currentVersion: "0.4.0", latestVersion: "0.5.0", preparedRoot: stagedRoot }
          : { status: "current", currentVersion: "0.5.0", latestVersion: "0.5.0", canContinueCurrent: true, retryable: true };
      },
    },
    listTasks: async () => [],
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  const first = await controller.bootstrap(nonce);
  assert.equal(first.update.status, "relaunching");
  assert.equal("preparedRoot" in first.update, false);
  assert.equal(first.donation.show, false, "the pre-relaunch window does not consume the session donation claim");
  const resumed = await controller.bootstrap(nonce);
  assert.equal(resumed.update.status, "current");
  assert.equal(resumed.donation.show, true, "the staged relaunch receives the session's one donation display");
  assert.equal(calls[1].currentRoot, stagedRoot);
  assert.ok(resumed.components.length > 0);
  const reloaded = await controller.bootstrap(nonce);
  assert.equal(reloaded.donation.show, false, "reload cannot display the donation card again");
});

test("untrusted empty task inventory can proceed only with explicit manual confirmation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-manual-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0" }) },
    listTasks: async () => ({ groups: [], evidence: { trusted: false, total: 1, active: 0, notLoaded: 1 } }),
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  await controller.bootstrap(nonce);
  const planned = await controller.plan(nonce, { components: ["daemon"], taskProtection: { taskIds: [], disposition: "wait" } });
  const protection = await controller.protect(nonce, { taskIds: [], disposition: "wait" });
  assert.equal(protection.manualConfirmationRequired, true);
  await assert.rejects(controller.apply(nonce, { approvedDigest: planned.plan.digest, desktopClosureApproved: true }), /manual task confirmation/);
  const applied = await controller.apply(nonce, { approvedDigest: planned.plan.digest, desktopClosureApproved: true, manualTaskConfirmation: true });
  assert.equal(applied.status, "applied");
});

test("manual task fallback follows the fresh protection inventory, not stale bootstrap evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-inventory-change-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  const groups = [{ project: "/repo", tasks: [{ id: "t1", name: "Build", status: "active" }] }];
  let inventoryCall = 0;
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore: new InstallerRecoveryStore({ root: join(root, "state") }),
    stableUpdater: { checkAndUpdate: async () => ({ status: "current", currentVersion: "0.4.0", latestVersion: "0.4.0" }) },
    listTasks: async () => inventoryCall++ === 0
      ? groups
      : { groups: [], evidence: { trusted: false, total: 1, active: 0, notLoaded: 1 } },
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  await controller.bootstrap(nonce);
  const planned = await controller.plan(nonce, { components: ["daemon"], taskProtection: { taskIds: ["t1"], disposition: "wait" } });
  const protection = await controller.protect(nonce, { taskIds: ["t1"], disposition: "wait" });
  assert.equal(protection.manualConfirmationRequired, true);
  assert.equal(protection.nativeInventory.trusted, false);
  const applied = await controller.apply(nonce, {
    approvedDigest: planned.plan.digest,
    desktopClosureApproved: true,
    manualTaskConfirmation: true,
  });
  assert.equal(applied.status, "applied");
});

test("GUI forwards installer-request cancellation into stable release work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-abort-"));
  const installRoot = join(root, "install");
  await mkdir(installRoot);
  t.after(() => rm(root, { recursive: true, force: true }));
  let observedSignal;
  const recoveryStore = new InstallerRecoveryStore({ root: join(root, "state") });
  let resolveReadyCurrent;
  const readyCurrentPersisted = new Promise((resolvePromise) => { resolveReadyCurrent = resolvePromise; });
  const persistRecoveryUpdate = recoveryStore.update.bind(recoveryStore);
  recoveryStore.update = async (sessionId, patch) => {
    const record = await persistRecoveryUpdate(sessionId, patch);
    if (patch.state === "ready-current") resolveReadyCurrent(record);
    return record;
  };
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore,
    stableUpdater: {
      checkAndUpdate: async (context) => {
        observedSignal = context.signal;
        return new Promise((_resolve, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
      },
    },
    listTasks: async () => [],
  });
  t.after(() => controller.dispose());
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  const request = new AbortController();
  const bootstrap = controller.bootstrap(nonce, { signal: request.signal });
  await waitFor(() => observedSignal, "stable updater to receive the installer request signal");
  request.abort(new Error("client disconnected"));
  await assert.rejects(bootstrap, /client disconnected/);
  assert.equal(observedSignal.aborted, true);
  const recoveryRecord = await waitForPromise(readyCurrentPersisted, "request cancellation to persist resumable recovery");
  assert.equal(recoveryRecord.state, "ready-current");
  assert.equal(recoveryRecord.result.stableUpdate.status, "blocked");
  assert.equal(recoveryRecord.result.stableUpdate.reason, "update-check-failed");
});

test("explicit Cancel remains terminal when an in-flight stable check returns a relaunch result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-gui-cancel-race-"));
  const installRoot = join(root, "install");
  const preparedRoot = join(root, "prepared");
  await Promise.all([mkdir(installRoot), mkdir(preparedRoot)]);
  let observedSignal;
  let releaseUpdate;
  let resolveUpdateStarted;
  let resolveUpdaterReturned;
  let taskInventoryCalls = 0;
  const updateStarted = new Promise((resolvePromise) => { resolveUpdateStarted = resolvePromise; });
  const updaterReturned = new Promise((resolvePromise) => { resolveUpdaterReturned = resolvePromise; });
  const recoveryStore = new InstallerRecoveryStore({ root: join(root, "state") });
  const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 8743 } }, {
    recoveryStore,
    stableUpdater: {
      checkAndUpdate: async (context) => {
        observedSignal = context.signal;
        resolveUpdateStarted();
        await new Promise((resolvePromise) => { releaseUpdate = resolvePromise; });
        resolveUpdaterReturned();
        return { status: "relaunching", currentVersion: "0.4.0", latestVersion: "0.5.0", preparedRoot };
      },
    },
    listTasks: async () => { taskInventoryCalls += 1; return []; },
  });
  t.after(async () => {
    controller.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
  const nonce = new URL(created.url).hash.slice("#session=".length);
  const bootstrap = controller.bootstrap(nonce);
  const bootstrapRejected = assert.rejects(bootstrap, /cancelled/);
  await updateStarted;

  const closed = await controller.close(nonce, "cancel");
  const cancelledRecord = await recoveryStore.read(created.sessionId);
  assert.deepEqual(closed, { ok: true, intent: "cancel" });
  assert.equal(observedSignal.aborted, true, "explicit Cancel aborts stable release work");
  assert.equal(cancelledRecord.state, "cancelled");
  assert.equal(cancelledRecord.closeIntent, "cancel");

  releaseUpdate();
  await updaterReturned;
  await bootstrapRejected;
  await assertPredicateRemains(async () => {
    const session = controller.authorize(nonce);
    const record = await recoveryStore.read(created.sessionId);
    return session.state === "cancelled"
      && session.closeIntent === "cancel"
      && session.updateRoot === undefined
      && session.update === undefined
      && record.state === "cancelled"
      && record.closeIntent === "cancel"
      && record.updatedAt === cancelledRecord.updatedAt;
  }, "late stable-check completion to leave Cancel terminal");
  assert.equal(taskInventoryCalls, 0, "cancelled bootstrap cannot continue into task inventory");
  assert.deepEqual(await controller.close(nonce, "relaunch"), { ok: true, intent: "cancel" }, "later close intents cannot defeat Cancel");
});

test("HTTP installer disconnect aborts release discovery and download while preserving resumable recovery", async (t) => {
  for (const scenario of [
    { phase: "discovery", interruptedStatus: "unavailable" },
    { phase: "manifest-download", interruptedStatus: "blocked" },
  ]) {
    await t.test(scenario.phase, async (st) => {
      const root = await mkdtemp(join(tmpdir(), `threadspan-http-abort-${scenario.phase}-`));
      const currentRoot = join(root, "current");
      const installRoot = join(root, "install");
      const recoveryStore = new InstallerRecoveryStore({ root: join(root, "state") });
      await Promise.all([writeInstallerSourceRoot(currentRoot, "0.4.0"), mkdir(installRoot)]);
      let releaseRequestCount = 0;
      let abortObserved = false;
      let resolvePhaseStarted;
      const phaseStarted = new Promise((resolvePromise) => { resolvePhaseStarted = resolvePromise; });
      const fetchImpl = async (url, options = {}) => {
        if (String(url).startsWith("https://api.github.com/")) {
          releaseRequestCount += 1;
          if (scenario.phase === "discovery" && releaseRequestCount === 1) {
            resolvePhaseStarted();
            return rejectWhenAborted(options.signal, () => { abortObserved = true; });
          }
          return jsonResponse([stableRelease(releaseRequestCount === 1 ? "0.5.0" : "0.4.0")]);
        }
        assert.equal(scenario.phase, "manifest-download");
        assert.match(String(url), /\/SHA256SUMS$/);
        resolvePhaseStarted();
        return rejectWhenAborted(options.signal, () => { abortObserved = true; });
      };
      const controller = new InstallerGuiController({ server: { host: "127.0.0.1", port: 0 } }, {
        recoveryStore,
        stableUpdater: new InstallerStableUpdater({
          currentRoot,
          ownerRoot: root,
          stagingRoot: join(root, "staging"),
          fetchImpl,
          runGit: async () => { throw new Error("not a git checkout"); },
        }),
        listTasks: async () => [],
      });
      const config = { server: { host: "127.0.0.1", port: 0, allowUnauthenticatedLoopback: true, maxConcurrentRequests: 2, requestTimeoutMs: 30_000 } };
      const server = createHttpServer({}, config, { installerGui: controller });
      st.after(async () => {
        controller.dispose();
        await closeHttpServer(server);
        await rm(root, { recursive: true, force: true });
      });
      const bound = await listenHttpServer(server, { host: "127.0.0.1", port: 0 });
      const created = await controller.createSession({ installRoot, origin: { kind: "direct" } });
      const nonce = new URL(created.url).hash.slice("#session=".length);

      await disconnectBootstrapRequest(bound.port, nonce, phaseStarted);
      const interrupted = await waitForRecoveryState(recoveryStore, created.sessionId, "ready-current");
      assert.equal(abortObserved, true, `${scenario.phase} receives the HTTP disconnect signal`);
      assert.equal(interrupted.result.stableUpdate.status, scenario.interruptedStatus);
      assert.equal(interrupted.result.stableUpdate.canContinueCurrent, true);

      const retry = await fetch(`http://127.0.0.1:${bound.port}/threadspan/install/api/bootstrap`, {
        headers: { "x-threadspan-install-session": nonce },
      });
      assert.equal(retry.status, 200);
      const resumed = await retry.json();
      assert.equal(resumed.update.status, "current");
      assert.equal(resumed.update.canContinueCurrent, true);
    });
  }
});

async function writeInstallerSourceRoot(root, version) {
  await mkdir(join(root, "ui"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "package.json"), `${JSON.stringify({ name: "threadspan", version })}\n`),
    writeFile(join(root, "README.md"), "https://github.com/HaileyStorm/threadspan\n"),
    writeFile(join(root, "ui", "install.html"), "<p>Threadspan</p>"),
    writeFile(join(root, "ui", "install.css"), "/* Threadspan */"),
    writeFile(join(root, "ui", "install.js"), "globalThis.threadspan=true;"),
    writeFile(join(root, "ui", "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
  ]);
}

function stableRelease(version) {
  const tag = `v${version}`;
  const archiveName = `threadspan-${version}.tar.gz`;
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/HaileyStorm/threadspan/releases/tag/${tag}`,
    assets: [
      { name: archiveName, browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/${archiveName}` },
      { name: "SHA256SUMS", browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/SHA256SUMS` },
      { name: "SHA256SUMS.sig", browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/SHA256SUMS.sig` },
    ],
  };
}

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

function rejectWhenAborted(signal, onAbort) {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason ?? new Error("aborted"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function disconnectBootstrapRequest(port, nonce, phaseStarted) {
  return new Promise((resolvePromise, reject) => {
    let receivedResponse = false;
    const clientRequest = request({
      host: "127.0.0.1",
      port,
      path: "/threadspan/install/api/bootstrap",
      method: "GET",
      headers: { "x-threadspan-install-session": nonce },
    }, (response) => {
      receivedResponse = true;
      response.resume();
      reject(new Error(`bootstrap unexpectedly completed with HTTP ${response.statusCode}`));
    });
    clientRequest.on("error", () => resolvePromise());
    clientRequest.on("close", () => { if (!receivedResponse) resolvePromise(); });
    clientRequest.end();
    phaseStarted.then(() => clientRequest.destroy()).catch(reject);
  });
}

async function waitForRecoveryState(store, sessionId, expectedState) {
  return waitFor(async () => {
    const record = await store.read(sessionId);
    return record.state === expectedState ? record : false;
  }, `recovery state ${expectedState}`);
}

async function waitFor(predicate, description, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function waitForPromise(promise, description, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPredicateRemains(predicate, description, options = {}) {
  const durationMs = options.durationMs ?? 250;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + durationMs;
  while (Date.now() <= deadline) {
    assert.equal(await predicate(), true, description);
    await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}
