import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CODEX_FULL_ACCESS_TRANSFORM_ID,
  codexFullAccessPolicyDescription,
  decodeCodexConfig,
  resolveCodexUserConfigPath,
  transformCodexFullAccessConfig,
} from "../codex/execution-policy.mjs";
import { COPY_NATURALIZER_VERSION } from "../core/copy-naturalizer.mjs";
import { COPY_CHECK_DISCLAIMER, COPY_CHECK_NO_PARTNERSHIP, COPY_CHECK_VERSION } from "../core/copy-check.mjs";
import { normalizeVoiceConfig } from "../core/voice-profiles.mjs";

const JSON_INDENT = 2;
const PLAN_VERSION = 1;
const ALL_TASK_SELF_HEAL = Object.freeze({
  enabled: true,
  taskTypes: Object.freeze(["research", "browser", "documents", "media", "operations", "provider-setup", "coding"]),
  checkpoints: Object.freeze(["task-planning", "direct-repair"]),
  phases: Object.freeze(["direct-repair", "focused-regression-evidence", "meta-recognizer-helper-process", "meta-meta-detection-coordination-review"]),
  directRepairFirst: true,
  focusedRegressionEvidenceRequired: true,
  capabilityDiscovery: Object.freeze({
    firstAction: "discover-and-reuse-installed-capabilities",
    sources: Object.freeze(["tools", "skills", "plugins", "provider-capabilities"]),
    evidenceKey: Object.freeze(["host", "provider", "model", "mode", "capability"]),
    providerNativeStrengthsFirst: true,
    crossProviderModelModeAssumptions: false,
    unknownPolicy: "unknown-until-bounded-check",
    selectionPolicy: "smallest-sufficient-non-overlapping-capability",
    selectionFactors: Object.freeze(["capability-fit", "live-availability", "privacy", "quota-cost", "expected-coordination-overhead"]),
    bounded: true,
    stopWhenSufficient: true,
    tokenBurningDiscoveryLoops: false,
  }),
  reusableCreation: Object.freeze({
    allowedFor: "recurring-or-generalizable-needs-only",
    artifactTypes: Object.freeze(["helper", "skill", "plugin"]),
    requirements: Object.freeze(["clear-trigger", "bounded-scope", "tests", "owner", "rollback-or-expiry", "portability", "no-overlap"]),
    oneOffAutoCreation: false,
    overlapPolicy: "reject-or-reuse-existing",
  }),
  direct: Object.freeze({ action: "repair-or-plan-with-reused-capability-first", evidence: "focused-task-appropriate" }),
  meta: Object.freeze({ updates: Object.freeze(["capability-discovery-registry", "selection-rules", "instructions"]) }),
  metaMeta: Object.freeze({ analyzes: Object.freeze(["why-capability-was-missed", "why-capability-was-duplicated"]) }),
  approvals: Object.freeze({
    thirdPartySkillOrPluginInstall: "normal-user-approval-required",
    permissionExpansion: "normal-user-approval-required",
  }),
  maxAnalysisDepth: 2,
  recursiveAnalysis: false,
  projectPolicy: "preserve-no-silent-override",
  agentOutput: "evidence-not-completion-authority",
  excludes: Object.freeze(["memory", "prompts", "credentials", "cross-host-state"]),
  reusableDefectProposal: "reviewed-sanitized-compatibility-watch-issue-or-pr",
});

export const COMPONENT_IDS = Object.freeze([
  "daemon",
  "cursor",
  "grok-build",
  "claude-code",
  "nous",
  "openrouter",
  "codex-native",
  "monitoring-fallback",
  "sidecar-ui",
  "installer-gui",
  "host-surfaces",
  "context-profiles",
  "continuity",
  "compatibility-watch",
  "voice-profiles",
]);

export const OPTIONAL_COMPONENT_IDS = Object.freeze([
  "beads",
  "project-bootstrap",
  "maximum-utilization",
  "tips",
]);
export const EXPLICIT_ONLY_COMPONENT_IDS = Object.freeze([
  "copy-naturalizer",
  "copy-check",
  "agentrouter-free",
  "mistral-api-free",
  "groqcloud-free",
  "cloudflare-workers-ai-free",
  "gemini-api-free",
  "codex-full-access",
]);
export const ALL_COMPONENT_IDS = Object.freeze([...COMPONENT_IDS, ...OPTIONAL_COMPONENT_IDS, ...EXPLICIT_ONLY_COMPONENT_IDS]);

export const CONTEXT_PROFILES = Object.freeze({
  "gpt-5.6-default": Object.freeze({
    model: "gpt-5.6-sol",
    contextWindow: 271_500,
    autoCompactTokenLimit: 192_000,
    optional: false,
  }),
  spark: Object.freeze({
    model: "gpt-5.3-codex-spark",
    contextWindow: 128_000,
    autoCompactTokenLimit: 80_000,
    optional: false,
  }),
  "gpt-5.6-600k": Object.freeze({
    model: "gpt-5.6-sol",
    contextWindow: 600_000,
    autoCompactTokenLimit: 480_000,
    optional: true,
  }),
  "gpt-5.6-1m": Object.freeze({
    model: "gpt-5.6-sol",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 800_000,
    optional: true,
  }),
});

const COMPONENTS = Object.freeze({
  daemon: component(
    "threadspan/components/daemon.json",
    {
      bind: "127.0.0.1",
      port: 8743,
      authentication: { source: "environment", variable: "THREADSPAN_TOKEN" },
      storesCredentialValues: false,
    },
    [
      permission("Bind a loopback port and write product-local daemon state"),
      environmentAuth("THREADSPAN_TOKEN"),
    ],
  ),
  cursor: component(
    "threadspan/components/cursor.json",
    {
      mode: "consult-and-delegate",
      authentication: { source: "existing-cli-session", product: "Cursor" },
      storesCredentialValues: false,
    },
    [manualAuth("Sign in with the Cursor CLI before live use")],
  ),
  "grok-build": component(
    "threadspan/components/grok-build.json",
    {
      mode: "bounded-worker",
      command: "grok",
      authentication: { source: "existing-cli-session", product: "Grok Build" },
      storesCredentialValues: false,
    },
    [
      manualAuth("Install and sign in with Grok Build before live use"),
      permission("Approve Grok Delegate's bypassPermissions mode only inside isolated linked worktrees; Consult remains non-mutating"),
    ],
  ),
  "claude-code": component(
    "threadspan/components/claude-code.json",
    {
      mode: "consult-and-delegate",
      adapter: "claude-code",
      command: "claude",
      authentication: { source: "existing-cli-session", product: "Claude Code" },
      enabledByDefault: false,
      communityUntested: true,
      status: "preview",
      liveTested: false,
      selectionPolicy: "explicit-user-approval-required",
      installerAgent: {
        revalidateCurrentOfficialDocs: true,
        performInstallOnlyAfterApproval: true,
        signInInteractivelyOutsideThreadspan: true,
        runLiveProviderProbe: false,
      },
      officialInstallerInstructions: {
        revalidateAtExecution: true,
        linuxMacWsl: "curl -fsSL https://claude.ai/install.sh | bash",
        windowsPowerShell: "& ([scriptblock]::Create((irm https://claude.ai/install.ps1)))",
      },
      storesCredentialValues: false,
    },
    [
      permission("Select Claude Code only after explicit user approval; the installer agent must revalidate the current official installer documentation before executing anything"),
      manualAuth("Preview/live-untested: install and sign in interactively outside Threadspan, then separately approve any live capability probe"),
    ],
  ),
  "agentrouter-free": component(
    "threadspan/components/agentrouter-free.json",
    {
      enabled: false,
      mode: "claude-code-gateway",
      adapter: "claude-code",
      provider: "agentrouter",
      model: "claude-opus-4-8",
      capabilities: ["consult", "delegate"],
      integratedSupported: false,
      gateway: {
        baseUrl: "https://agentrouter.org",
        apiKeyEnv: "AGENTROUTER_API_KEY",
        model: "claude-opus-4-8",
        provider: "agentrouter",
      },
      selectionPolicy: "explicit-only",
      paidUpgradeAllowed: false,
      paymentMethodRequired: false,
      hardCappedTokenRequired: true,
      separateTokenPerHost: true,
      offerEndDate: null,
      visibilityFreshnessDays: 7,
      requiresLiveProbe: true,
      requiresLiveCardlessCheck: true,
      lastLiveProbe: { date: "2026-08-18", hosts: ["linux", "windows"], result: "THREADSPAN_AGENTROUTER_OK" },
      staleVisibility: "check-availability",
      expiredVisibility: "hidden-without-fresh-proof",
      officialDocs: ["https://co.agentrouter.org/portal/guide", "https://docs.agentrouter.org/"],
      installerActions: {
        createAccount: false,
        configurePayment: false,
        captureToken: false,
        installClaudeCode: false,
        enableProvider: false,
      },
      storesCredentialValues: false,
    },
    [
      permission("Check the current AgentRouter offer and official documentation before setup; no free access or end date is guaranteed"),
      permission("Install the official Claude Code CLI only after reviewed user approval; browser account or token actions require separate explicit authorization"),
      environmentAuth("AGENTROUTER_API_KEY"),
      permission("Use a separate hard-capped token on each host and complete a fresh live probe before enabling; disable when stale, expired, or unavailable"),
      permission("Prompts and selected code context are sent to the third-party AgentRouter service; Integrated mode and OpenAI/Codex fallbacks are unsupported"),
    ],
  ),
  "mistral-api-free": freeProviderCandidate("mistral-api", {
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    model: "mistral-small-latest",
    officialUrl: "https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key",
  }),
  "groqcloud-free": freeProviderCandidate("groqcloud", {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    model: "openai/gpt-oss-120b",
    officialUrl: "https://console.groq.com/docs/rate-limits",
  }),
  "cloudflare-workers-ai-free": freeProviderCandidate("cloudflare-workers-ai", {
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
    apiKeyEnv: "CLOUDFLARE_API_TOKEN",
    model: "@cf/openai/gpt-oss-120b",
    officialUrl: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    setupCandidateOnly: true,
  }),
  "gemini-api-free": freeProviderCandidate("gemini-api", {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    model: "gemini-3.5-flash",
    officialUrl: "https://ai.google.dev/gemini-api/docs/pricing",
  }),
  nous: component(
    "threadspan/components/nous.json",
    {
      mode: "openai-compatible",
      authentication: { source: "environment", variable: "NOUS_API_KEY" },
      storesCredentialValues: false,
    },
    [environmentAuth("NOUS_API_KEY")],
  ),
  openrouter: component(
    "threadspan/components/openrouter.json",
    {
      mode: "openai-compatible",
      authentication: { source: "environment", variable: "OPENROUTER_API_KEY" },
      storesCredentialValues: false,
    },
    [environmentAuth("OPENROUTER_API_KEY")],
  ),
  "codex-native": component(
    "threadspan/components/codex-native.json",
    {
      picker: "native-plus-threadspan-sidecar",
      catalog: "merge-native-and-live-threadspan-routes",
      replaceModelCatalogOnlyAfterMerge: true,
      profileDirectory: ".",
      compatibilityWatch: "threadspan/components/compatibility-watch.json",
      effectiveSettings: {
        inheritance: "native-user-project",
        authenticationProfiles: "isolated",
        bridgeDivergences: "explicit-scoped-digest-bound-reversible",
        approvalSystem: "native-host-only",
      },
      storesCredentialValues: false,
    },
    [manualAuth("Sign in with Codex before using native models")],
  ),
  "monitoring-fallback": component(
    "threadspan/components/monitoring-fallback.json",
    {
      healthEndpoint: "http://127.0.0.1:8743/health",
      fallbackPolicy: "explicit-compatible-route-only",
      automaticCredentialFallback: false,
    },
    [permission("Read local health state and write product-local monitoring state")],
  ),
  "sidecar-ui": component(
    "threadspan/components/sidecar-ui.json",
    {
      bind: "127.0.0.1",
      readOnlyByDefault: true,
      exposesCredentialValues: false,
    },
    [permission("Bind a loopback UI port and read product-local status")],
  ),
  "installer-gui": component(
    "threadspan/components/installer-gui.json",
    {
      launch: "source-run-app-window",
      browserMode: "chromium-app-window",
      planEngine: "shared-cli-plan-preview-apply",
      originRecovery: "native-host-only",
      defaultTaskDisposition: "wait",
      storesCredentialValues: false,
    },
    [permission("Launch a loopback companion window and write product-local recovery metadata")],
  ),
  "host-surfaces": component(
    "threadspan/components/host-surfaces.json",
    {
      tiers: { codex: "primary", grok: "enhanced", cursor: "standard", hermes: "preview" },
      reverseTransport: "mcp",
      nativeOriginRecoveryRequired: true,
      effectiveSettings: {
        rawApiOwner: "host",
        managedWorkerDefault: "provider-native-inheritance",
        preserveProjectAndUserSettings: true,
        exclusionsRequireVisibleReason: true,
      },
      branching: {
        activationReasons: ["independent-evidence", "divergent-ideation", "disjoint-writes"],
        routeBy: ["capability", "live-availability", "quota", "credit", "privacy", "latency", "diversity-value"],
        bounded: true,
        stopOnConvergence: true,
        toolPolicy: "decision-useful-only",
        imageDivergenceTool: "imagegen",
        synthesisOwner: "caller",
      },
      connectionRecovery: {
        healthDimensions: ["provider", "account", "transport"],
        failureStages: ["pre-output-auth", "pre-output-transport", "mid-turn-provider", "parent-interruption"],
        reconnect: "bounded-adapter-specific",
        reauth: "provider-native-only",
        preserveResumableState: true,
        staleProcessAndConfigDetection: true,
        parentInterruptionHandleAudit: "required",
        reroute: "existing-privacy-account-authority-gates-only",
        genericUnavailableIsRecoveryAuthority: false,
      },
      selfHeal: {
        subsystemOwner: "compatibility-watch",
        behavior: "bounded-self-heal",
        maxAnalysisDepth: 2,
        phases: ["repair", "meta", "meta-meta"],
        immediateRecoveryFirst: true,
        stopAfterMetaMeta: true,
        requiredClosure: ["owner", "evidence", "regression", "host-rollout", "rollback-or-expiry-when-relevant"],
        updateRecognizerAndProcess: true,
        analyzeRetryChurn: true,
        recursiveAnalysis: false,
        allTasks: ALL_TASK_SELF_HEAL,
        contribution: {
          policy: "sanitized-github-issue-or-pr-proposal",
          requiredEvidence: ["affected-versions-hosts", "evidence", "rollback", "residual-gaps"],
          localMonitorReview: "triage-test-tweak-accept-or-reject",
          localApplyAfterAcceptance: true,
          excludes: ["machine-local-credentials", "machine-local-state", "prompts"],
          autoMerge: false,
        },
      },
      storesCredentialValues: false,
    },
    [permission("Write reviewed host-specific MCP/plugin configuration without credential values")],
  ),
  continuity: component(
    "threadspan/components/continuity.json",
    {
      enabled: true,
      scope: "product-local",
      checkpointDirectory: "threadspan/state/continuity/checkpoints",
      rolloverDirectory: "threadspan/state/continuity/rollovers",
      includes: ["task-checkpoints", "rollover-metadata"],
      excludes: ["memory", "multi-host-sync", "cross-host-communications"],
    },
    [permission("Write product-local checkpoints and rollover metadata")],
  ),
  "compatibility-watch": component(
    "threadspan/components/compatibility-watch.json",
    {
      enabled: true,
      role: "subsystem-ui-history-owner",
      detects: ["app-drift", "provider-drift", "new-models", "new-providers"],
      checks: ["codex-profile-schema", "native-model-catalog", "provider-cli-versions", "official-provider-release-sources"],
      sourcePolicy: {
        officialDocumentation: "authoritative",
        trustedTesterReports: "probe-nomination-and-risk-evidence",
        preserveExistingModelBehavior: true,
        requireModelSpecificCompatibility: true,
      },
      sourceRegistry: [
        { provider: "openai", authority: "official", url: "https://developers.openai.com/api/docs/models/all" },
        { provider: "xai", authority: "official", url: "https://docs.x.ai/developers/release-notes" },
        { provider: "cursor", authority: "official", url: "https://www.cursor.com/changelog" },
        { provider: "anthropic", authority: "official", url: "https://platform.claude.com/docs/en/release-notes/overview" },
        { provider: "google", authority: "official", url: "https://ai.google.dev/gemini-api/docs/models" },
        { provider: "mistral", authority: "official", url: "https://docs.mistral.ai/resources/changelogs" },
        { provider: "nous", authority: "upstream", url: "https://github.com/NousResearch/hermes-agent/releases" },
        { provider: "openrouter", authority: "official", url: "https://openrouter.ai/docs/overview/models" },
        { provider: "cross-provider", authority: "trusted-benchmark", url: "https://artificialanalysis.ai/methodology/coding-agents-benchmarking" },
      ],
      reviewCadence: { official: "on-release", upstream: "weekly-while-active", trustedBenchmark: "weekly-while-active" },
      restoreCompatibility: true,
      hardeningPhases: ["direct", "meta", "meta-meta"],
      hardeningBound: 2,
      allTaskSelfHeal: ALL_TASK_SELF_HEAL,
      proposalPolicy: "reviewed-sanitized-github-issue-or-pr",
      mutationPolicy: "report-only",
      networkPolicy: "prompt-before-live-check",
    },
    [permission("Read installed product versions; network checks require separate approval")],
  ),
  "voice-profiles": component(
    "threadspan/components/voice-profiles.json",
    {
      selectedProfile: "technical-partner",
      profiles: [],
      appliesTo: ["user-facing-assistant-prose", "progress-cadence"],
      excludes: ["machine-protocols", "tool-calls-results", "json-schemas", "exact-evidence", "mandated-formats", "permissions", "provider-native-settings", "factual-confidence"],
      memory: false,
      storesCredentialValues: false,
    },
    [permission("Write the reviewed managed Voice selection; adapters without an explicit user-facing prose hook remain unchanged")],
  ),
  beads: component(
    "threadspan/components/beads.json",
    {
      enabled: false,
      mode: "activation-audit",
      trackerLocation: "repository-root",
      officialPluginPreferred: true,
      initializeAutomatically: false,
      migrateAutomatically: false,
      lifecycleMutationsRequireExplicitIssueId: true,
      readinessMeansSchedulingEvidenceOnly: true,
      automaticContinuationRequires: "continuation_mode=continuous",
      activationAudit: ["exact-project-root", "composed-policy-hashes", "bd-version", "static-tracker-routing"],
      workingReservations: "shared-working-sentinel",
      preserves: ["existing-project-policy", "historical-trackers", "user-selected-workflow"],
      storesCredentialValues: false,
    },
    [permission("Install or activate Beads only after a repo-local preview; never initialize, migrate, or mutate a tracker during discovery")],
  ),
  "project-bootstrap": component(
    "threadspan/components/project-bootstrap.json",
    {
      enabled: false,
      mode: "agent-assisted-preview",
      requiredDiscovery: ["architecture", "entry-points", "protocols", "tests", "automation", "existing-policy"],
      proposedOutputs: ["AGENTS.md", ".codex/config.toml", "scripts/test_all.sh", "tracker-policy", "ci-policy"],
      preserveExistingFiles: true,
      createPrivateRemoteOnlyWhenAuthorizedAndAbsent: true,
      requireExactPreviewBeforeWrites: true,
      requireRollbackAndVerificationEvidence: true,
      reservationRecovery: {
        enabledByDefault: false,
        authorization: "explicit-owner-only",
        visibility: "required-before-action",
        evidence: "preserve-claim-and-release-receipt",
        firstAction: "exact-working-sentinel-tool-release",
        scope: "exact-claim-only",
        activeWork: "never-interrupt",
        fallback: "no-silent-default",
      },
      excludes: ["memory", "multi-host-sync", "cross-host-communications"],
      storesCredentialValues: false,
    },
    [permission("Scout the selected repository and preview every project-local file before any bootstrap write")],
  ),
  "maximum-utilization": component(
    "threadspan/components/maximum-utilization.json",
    {
      enabled: false,
      sourceKind: "codex-native-quota",
      triggerUsedRatio: 0.96,
      fastCanaryUsedRatio: 0.99,
      normalRolloverConsideration: 0.78,
      pressuredRolloverConsideration: 0.75,
      hostActionPolicy: "capability-tagged-request-only",
      unsupportedActionPolicy: "pending-or-unsupported",
      requireExactSameBucketNativeRecovery: true,
      storesCredentialValues: false,
    },
    [permission("Enable separately only with authoritative native quota and a capable host adapter; otherwise operation remains observational or pending")],
  ),
  tips: component(
    "threadspan/components/tips.json",
    {
      enabled: false,
      selection: "local-heuristic-capability-and-state",
      maximumPerSession: 1,
      cooldownMs: 86_400_000,
      dismissible: true,
      userCanDisable: true,
      defaultModelCalls: 0,
      defaultNetworkCalls: 0,
      modelRefinement: {
        enabled: false,
        activation: "explicit-user-action-after-local-heuristic",
        provider: null,
        model: null,
        privacy: "deny",
        maxCallsPerSession: 1,
        maxOutputTokens: 96,
        maxLatencyMs: 4000,
        cooldownMs: 86_400_000,
      },
      ask: { enabled: false, opensOnExplicitUserAction: true, maxTurnsPerSession: 3, sessionBounded: true, memory: false },
      excludes: ["prompts", "identifiers", "credentials"],
      storesCredentialValues: false,
    },
    [permission("Enable separately to show at most one heuristic HUD tip per browser session; model refinement and Ask require separate provider/privacy configuration and explicit user action")],
  ),
  "copy-naturalizer": component(
    "threadspan/components/copy-naturalizer.json",
    {
      version: COPY_NATURALIZER_VERSION,
      enabled: false,
      activation: "explicit-user-action",
      profile: "human",
      localHeuristics: {
        available: true,
        networkAccess: false,
        automaticRuns: false,
      },
      configuredRewrite: {
        enabled: false,
        adapterSource: "caller-configured-only",
        automaticSelection: false,
        automaticEnablement: false,
      },
      reviewRequiredBeforeApply: true,
      autoApply: false,
      storesCredentialValues: false,
    },
    [permission("Install the disabled review-only copy helper descriptor; enabling it or configuring a rewrite adapter requires a separate user action")],
  ),
  "copy-check": component(
    "threadspan/components/copy-check.json",
    {
      version: COPY_CHECK_VERSION,
      enabled: true,
      permissionMode: "ask-every-time",
      activation: "explicit-user-action",
      automaticRuns: false,
      credentialsEnableFeature: false,
      selectionAllDoesNotEnable: true,
      storesCredentialValues: false,
      advisoryOnly: true,
      neverAveraged: true,
      cannotProveAuthorship: true,
      cannotFailRelease: true,
      neverControlsRewrite: true,
      persist: ["status", "score", "adapter", "timestamp", "displayText"],
      neverPersist: ["sourceText", "keys", "rawProviderBodies", "sensitiveUrls"],
      partnership: false,
      partnershipNote: COPY_CHECK_NO_PARTNERSHIP,
      disclaimer: COPY_CHECK_DISCLAIMER,
      adapters: {
        pangram: {
          enabled: true,
          kind: "manual-handoff",
          officialUrl: "https://www.pangram.com/",
          destination: "Official Pangram checker page only",
          payload: "Selected text copied locally; Threadspan never submits or reads the page",
          networkUntilClick: false,
        },
        sapling: {
          enabled: false,
          kind: "api",
          destination: "https://api.sapling.ai/api/v1/aidetect",
          apiKeyEnv: "SAPLING_API_KEY",
          payload: "JSON { text } up to copyCheck.maxInputChars",
          retention: "Sapling stores submitted text and uses it to improve its service",
          requiresAcknowledgement: true,
          trial: "Developer keys are rate-limited and not a permanent free API",
        },
        winston: {
          enabled: false,
          kind: "api",
          destination: "https://api.gowinston.ai/v1/ai-content-detection",
          apiKeyEnv: "WINSTON_API_KEY",
          payload: "JSON { text }; Winston documents 300–150,000 characters",
          trial: "Limited 2,000-credit developer trial with no card required. Availability can change; it is not permanently free.",
        },
        gptzero: { kind: "unsupported-later", advertisedAsWorkingFreeApi: false },
        copyleaks: { kind: "unsupported-later", advertisedAsWorkingFreeApi: false, sandboxNumbersNeverReal: true },
      },
    },
    [permission("Install external copy checks in Ask every time mode with Pangram manual handoff; API adapters remain disabled until their separate key and retention setup is complete")],
  ),
});

/** Read an existing valid managed Voice selection without mutating or repairing it. */
export function readInstalledVoiceConfig(installRoot) {
  const target = resolve(installRoot, COMPONENTS["voice-profiles"].relativePath);
  try {
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    if (parsed?.schemaVersion !== 1 || parsed?.component !== "voice-profiles") return normalizeVoiceConfig({});
    return normalizeVoiceConfig({ selectedProfile: parsed.selectedProfile, profiles: parsed.profiles ?? [] });
  } catch {
    return normalizeVoiceConfig({});
  }
}

/**
 * Create a deterministic, serializable installer plan without writing files.
 * @param {{
 *   installRoot: string,
 *   selection?: "all" | string[],
 *   longContextProfiles?: "all" | string[],
 *   voice?: Record<string, any>,
 *   environment?: NodeJS.ProcessEnv,
 *   planId?: string,
 * }} options Planning options.
 * @returns {Readonly<Record<string, any>>}
 */
export function createInstallerPlan(options) {
  if (!options || typeof options.installRoot !== "string" || !options.installRoot.trim()) {
    throw new TypeError("installRoot is required");
  }
  const installRoot = resolve(options.installRoot);
  const selectedComponents = normalizeSelection(options.selection ?? "all");
  const profileNames = normalizeLongContextProfiles(options.longContextProfiles ?? []);
  if (profileNames.length > 0 && !selectedComponents.includes("context-profiles")) {
    throw new Error("Optional context profiles require the context-profiles component");
  }
  if (options.voice !== undefined && !selectedComponents.includes("voice-profiles")) {
    throw new Error("Voice selection requires the voice-profiles component");
  }
  const voice = normalizeVoiceConfig(options.voice ?? {});
  const environment = options.environment ?? process.env;
  const planId = normalizePlanId(options.planId ?? `install-${Date.now()}`);
  const operations = [];
  const prerequisites = [];
  const unchanged = [];
  const exclusions = [];

  for (const id of selectedComponents) {
    if (id === "codex-full-access") {
      const inspected = inspectCodexFullAccessOperation(environment);
      if (inspected.operation) {
        operations.push(inspected.operation);
        prerequisites.push({
          component: id,
          kind: "permission",
          state: "manual",
          name: "Codex user configuration",
          message: "Approve the digest-bound full-access transform of the selected host's user-level Codex config",
        });
      } else {
        unchanged.push(inspected.unchanged);
      }
      continue;
    }
    if (id === "context-profiles") {
      const operationCount = operations.length;
      for (const name of ["gpt-5.6-default", "spark", ...profileNames]) {
        const profile = CONTEXT_PROFILES[name];
        appendInspectedOperation({ operations, unchanged, exclusions }, installRoot, {
          component: id,
          relativePath: `${name}.config.toml`,
          content: renderContextProfile(name, profile),
          mode: 0o600,
        });
      }
      if (operations.length > operationCount) {
        prerequisites.push({
          component: id,
          kind: "permission",
          state: "manual",
          name: "Codex profile directory",
          message: "Allow writes to the selected product-local Codex profile directory",
        });
      }
      continue;
    }
    const definition = COMPONENTS[id];
    const operationCount = operations.length;
    const configuration = id === "voice-profiles"
      ? { ...definition.configuration, ...voice }
      : definition.configuration;
    appendInspectedOperation({ operations, unchanged, exclusions }, installRoot, {
      component: id,
      relativePath: definition.relativePath,
      content: jsonDocument({ schemaVersion: 1, component: id, ...configuration }),
      mode: 0o600,
    });
    if (operations.length > operationCount) {
      prerequisites.push(...definition.prerequisites.map((item) => resolvePrerequisite(id, item, environment)));
    }
  }

  const basePlan = {
    schemaVersion: PLAN_VERSION,
    kind: "install",
    planId,
    installRoot,
    selectedComponents,
    selectedLongContextProfiles: profileNames,
    ...(selectedComponents.includes("voice-profiles") ? { voice } : {}),
    operations,
    prerequisites,
    unchanged,
    exclusions,
    hasChanges: operations.length > 0,
    backupRoot: `.threadspan-installer/backups/${planId}`,
    rollbackManifest: `.threadspan-installer/rollbacks/${planId}.json`,
    credentialPolicy: "names-and-prerequisite-state-only",
  };
  const plan = { ...basePlan, digest: computePlanDigest(basePlan) };
  return deepFreeze(plan);
}

function inspectCodexFullAccessOperation(environment) {
  const targetPath = resolveCodexUserConfigPath({ environment });
  const parent = dirname(targetPath);
  const parentStats = safeLstatSync(parent);
  if (parentStats?.isSymbolicLink()) throw new Error(`Refusing Codex user config through symbolic-link parent: ${parent}`);
  if (parentStats && !parentStats.isDirectory()) throw new Error(`Codex user config parent is not a directory: ${parent}`);
  const stats = safeLstatSync(targetPath);
  if (stats?.isSymbolicLink()) throw new Error(`Refusing symbolic-link Codex user config: ${targetPath}`);
  if (stats && !stats.isFile()) throw new Error(`Codex user config is not a regular file: ${targetPath}`);
  const previousBytes = stats ? readFileSync(targetPath) : Buffer.alloc(0);
  const previous = decodeCodexConfig(previousBytes);
  const transformed = transformCodexFullAccessConfig(previous);
  const mode = stats ? stats.mode & 0o777 : 0o600;
  if (!transformed.changed) {
    return {
      unchanged: {
        component: "codex-full-access",
        targetPath,
        reason: "codex-full-access-policy-match",
        contentSha256: sha256(previousBytes),
        mode,
        conflicts: transformed.conflicts,
        effects: transformed.effects,
      },
    };
  }
  return {
    operation: {
      component: "codex-full-access",
      operationKind: "codex-config-transform",
      transformId: CODEX_FULL_ACCESS_TRANSFORM_ID,
      targetPath,
      expectedPreimageSha256: stats ? sha256(previousBytes) : null,
      expectedNextSha256: transformed.contentSha256,
      expectedMode: stats ? mode : null,
      mode,
      conflicts: transformed.conflicts,
      effects: transformed.effects,
      preview: codexFullAccessPolicyDescription(),
      change: {
        kind: stats ? "update" : "create",
        scope: "codex:user-config:execution-policy",
        reason: "Explicitly selected Codex full-access execution and tool-approval policy differs.",
        previousSha256: stats ? sha256(previousBytes) : null,
        nextSha256: transformed.contentSha256,
        reversible: true,
        rollback: "exact-preimage-backup-and-manifest",
      },
    },
  };
}

function safeLstatSync(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function appendInspectedOperation(collections, installRoot, candidate) {
  const inspected = inspectInstallerOperation(installRoot, candidate);
  if (inspected.operation) collections.operations.push(inspected.operation);
  else if (inspected.exclusion) collections.exclusions.push(inspected.exclusion);
  else collections.unchanged.push(inspected.unchanged);
}

function inspectInstallerOperation(installRoot, candidate) {
  const target = resolve(installRoot, candidate.relativePath);
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") return excludedCandidate(candidate, `Existing target could not be inspected and was preserved: ${error.message}`);
  }
  if (!stats) return changedCandidate(candidate, undefined, "create", "Selected component is not installed.");
  if (stats.isSymbolicLink() || !stats.isFile()) return excludedCandidate(candidate, "Existing target is not a regular managed file and was preserved.");

  let previous;
  try {
    previous = readFileSync(target, "utf8");
  } catch (error) {
    return excludedCandidate(candidate, `Existing target could not be read and was preserved: ${error.message}`);
  }
  const merged = mergeManagedContent(previous, candidate);
  if (merged.exclusion) return excludedCandidate(candidate, merged.exclusion, previous);
  const content = merged.content;
  const modeMatches = process.platform === "win32" || (stats.mode & 0o777) === candidate.mode;
  if (previous === content && modeMatches) {
    return { unchanged: { component: candidate.component, relativePath: candidate.relativePath, reason: "content-and-mode-match", contentSha256: sha256(previous), mode: stats.mode & 0o777 } };
  }
  const kind = previous === content ? "permissions" : "update";
  return changedCandidate({ ...candidate, content }, previous, kind, kind === "permissions" ? "Managed file permissions differ." : "Managed content differs; unowned settings were preserved.");
}

function mergeManagedContent(previous, candidate) {
  if (candidate.component === "context-profiles") {
    if (!previous.startsWith("# Generated by Threadspan.")) {
      return { exclusion: "Existing Codex profile is not Threadspan-managed; native user/project settings were preserved." };
    }
    return { content: candidate.content };
  }
  try {
    const existing = JSON.parse(previous);
    const desired = JSON.parse(candidate.content);
    if (!existing || existing.component !== candidate.component || existing.schemaVersion !== 1) {
      return { exclusion: "Existing component file has no matching current Threadspan schema/ownership marker and was preserved." };
    }
    const merged = mergePreservingExisting(existing, desired);
    if (candidate.component === "copy-naturalizer" && merged && typeof merged === "object") delete merged.detectors;
    return { content: jsonDocument(merged) };
  } catch {
    return { exclusion: "Existing component file is not valid managed JSON and was preserved." };
  }
}

function mergePreservingExisting(existing, desired) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing) || !desired || typeof desired !== "object" || Array.isArray(desired)) return desired;
  const result = { ...existing };
  for (const [key, value] of Object.entries(desired)) {
    result[key] = key in result ? mergePreservingExisting(result[key], value) : value;
  }
  return result;
}

function changedCandidate(candidate, previous, kind, reason) {
  return {
    operation: {
      ...candidate,
      change: {
        kind,
        scope: `component:${candidate.component}`,
        reason,
        previousSha256: previous === undefined ? null : sha256(previous),
        nextSha256: sha256(candidate.content),
        reversible: true,
        rollback: "preimage-backup-and-manifest",
      },
    },
  };
}

function excludedCandidate(candidate, reason, previous) {
  return { exclusion: { component: candidate.component, relativePath: candidate.relativePath, reason, visible: true, ...(previous === undefined ? {} : { observedSha256: sha256(previous) }) } };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Validate and render a Codex context profile.
 * @param {string} name Profile name.
 * @param {{model:string, contextWindow:number, autoCompactTokenLimit:number}} profile Profile values.
 * @returns {string}
 */
export function renderContextProfile(name, profile) {
  validateContextProfile(name, profile);
  return `# Generated by Threadspan. Select with: codex --profile ${name}\nmodel = ${JSON.stringify(profile.model)}\nmodel_context_window = ${profile.contextWindow}\nmodel_auto_compact_token_limit = ${profile.autoCompactTokenLimit}\n`;
}

/**
 * Enforce positive integer limits and an auto-compact threshold no greater than 90%.
 * @param {string} name Profile name.
 * @param {{model:string, contextWindow:number, autoCompactTokenLimit:number}} profile Profile values.
 * @returns {void}
 */
export function validateContextProfile(name, profile) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(name)) throw new TypeError("Context profile name contains unsupported characters");
  if (!profile || typeof profile.model !== "string" || !profile.model) throw new TypeError(`${name}: model is required`);
  if (!Number.isSafeInteger(profile.contextWindow) || profile.contextWindow <= 0) throw new TypeError(`${name}: contextWindow must be a positive integer`);
  if (!Number.isSafeInteger(profile.autoCompactTokenLimit) || profile.autoCompactTokenLimit <= 0) {
    throw new TypeError(`${name}: autoCompactTokenLimit must be a positive integer`);
  }
  if (profile.autoCompactTokenLimit > Math.floor(profile.contextWindow * 0.9)) {
    throw new RangeError(`${name}: autoCompactTokenLimit must not exceed 90% of contextWindow`);
  }
}

/** Compute the integrity digest for a plan payload or complete plan. */
export function computePlanDigest(plan) {
  const { digest: _digest, ...payload } = plan;
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function component(relativePath, configuration, prerequisites) {
  return Object.freeze({ relativePath, configuration: Object.freeze(configuration), prerequisites: Object.freeze(prerequisites) });
}

function permission(message) {
  return { kind: "permission", state: "manual", name: "Filesystem or local runtime permission", message };
}

function manualAuth(message) {
  return { kind: "authentication", state: "manual", name: "Existing product sign-in", message };
}

function environmentAuth(name) {
  return { kind: "authentication", state: "environment", name, message: `Set ${name} in the runtime environment` };
}

function freeProviderCandidate(provider, options) {
  return component(
    `threadspan/components/${provider}-free.json`,
    {
      enabled: false,
      setupCandidate: true,
      setupCandidateOnly: options.setupCandidateOnly === true,
      adapter: "openai-chat",
      provider,
      baseUrl: options.baseUrl,
      apiKeyEnv: options.apiKeyEnv,
      model: options.model,
      capabilities: ["consult", "integrated"],
      paidUpgradeAllowed: false,
      requiresLiveCardlessCheck: true,
      offerEndDate: null,
      visibilityFreshnessDays: 7,
      officialUrl: options.officialUrl,
      installerActions: {
        createAccount: false,
        createCredential: false,
        installApp: false,
        changeBilling: false,
        enableRoute: false,
      },
      storesCredentialValues: false,
    },
    [
      permission(`Check the current public ${provider} offer, card/payment requirements, model availability, and official documentation before setup`),
      environmentAuth(options.apiKeyEnv),
      permission("Account signup, credential creation, app installation, billing changes, and route enablement require separate user permission and a reviewed plan"),
    ],
  );
}

function resolvePrerequisite(componentId, item, environment) {
  if (item.state !== "environment") return { component: componentId, ...item };
  return {
    component: componentId,
    kind: item.kind,
    name: item.name,
    state: Object.prototype.hasOwnProperty.call(environment, item.name) && environment[item.name] ? "available" : "missing",
    message: item.message,
  };
}

function normalizeSelection(selection) {
  const values = selection === "all" ? [...COMPONENT_IDS, ...OPTIONAL_COMPONENT_IDS] : selection;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("selection must be 'all' or a non-empty component array");
  const unique = [...new Set(values)];
  for (const id of unique) if (!ALL_COMPONENT_IDS.includes(id)) throw new RangeError(`Unknown installer component '${id}'`);
  return ALL_COMPONENT_IDS.filter((id) => unique.includes(id));
}

function normalizeLongContextProfiles(selection) {
  const optionalNames = Object.entries(CONTEXT_PROFILES).filter(([, value]) => value.optional).map(([name]) => name);
  const values = selection === "all" ? optionalNames : selection;
  if (!Array.isArray(values)) throw new TypeError("longContextProfiles must be 'all' or an array");
  const unique = [...new Set(values)];
  for (const name of unique) if (!optionalNames.includes(name)) throw new RangeError(`Unknown optional context profile '${name}'`);
  return optionalNames.filter((name) => unique.includes(name));
}

function normalizePlanId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new TypeError("planId contains unsupported characters");
  return value;
}

function jsonDocument(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
