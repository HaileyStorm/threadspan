import { createHash } from "node:crypto";
import { resolve } from "node:path";

const JSON_INDENT = 2;
const PLAN_VERSION = 1;

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
  "context-profiles",
  "continuity",
  "compatibility-watch",
]);

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
      adapter: "managed-cli",
      command: "claude",
      authentication: { source: "existing-cli-session", product: "Claude Code" },
      enabledByDefault: false,
      communityUntested: true,
      storesCredentialValues: false,
    },
    [manualAuth("Optional and untested: install and sign in with Claude Code, then run the capability probe before enabling")],
  ),
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
      checks: ["codex-profile-schema", "native-model-catalog", "provider-cli-versions"],
      mutationPolicy: "report-only",
      networkPolicy: "prompt-before-live-check",
    },
    [permission("Read installed product versions; network checks require separate approval")],
  ),
});

/**
 * Create a deterministic, serializable installer plan without writing files.
 * @param {{
 *   installRoot: string,
 *   selection?: "all" | string[],
 *   longContextProfiles?: "all" | string[],
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
  const environment = options.environment ?? process.env;
  const planId = normalizePlanId(options.planId ?? `install-${Date.now()}`);
  const operations = [];
  const prerequisites = [];

  for (const id of selectedComponents) {
    if (id === "context-profiles") {
      for (const name of ["gpt-5.6-default", "spark", ...profileNames]) {
        const profile = CONTEXT_PROFILES[name];
        operations.push({
          component: id,
          relativePath: `${name}.config.toml`,
          content: renderContextProfile(name, profile),
          mode: 0o600,
        });
      }
      prerequisites.push({
        component: id,
        kind: "permission",
        state: "manual",
        name: "Codex profile directory",
        message: "Allow writes to the selected product-local Codex profile directory",
      });
      continue;
    }
    const definition = COMPONENTS[id];
    operations.push({
      component: id,
      relativePath: definition.relativePath,
      content: jsonDocument({ schemaVersion: 1, component: id, ...definition.configuration }),
      mode: 0o600,
    });
    prerequisites.push(...definition.prerequisites.map((item) => resolvePrerequisite(id, item, environment)));
  }

  const basePlan = {
    schemaVersion: PLAN_VERSION,
    kind: "install",
    planId,
    installRoot,
    selectedComponents,
    operations,
    prerequisites,
    backupRoot: `.threadspan-installer/backups/${planId}`,
    rollbackManifest: `.threadspan-installer/rollbacks/${planId}.json`,
    credentialPolicy: "names-and-prerequisite-state-only",
  };
  const plan = { ...basePlan, digest: computePlanDigest(basePlan) };
  return deepFreeze(plan);
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
  const values = selection === "all" ? COMPONENT_IDS : selection;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("selection must be 'all' or a non-empty component array");
  const unique = [...new Set(values)];
  for (const id of unique) if (!COMPONENT_IDS.includes(id)) throw new RangeError(`Unknown installer component '${id}'`);
  return COMPONENT_IDS.filter((id) => unique.includes(id));
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
