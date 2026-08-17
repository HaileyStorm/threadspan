/** Build a Codex model catalog that preserves native entries and adds Threadspan routes. */
export function buildMergedModelCatalog(nativeCatalog, routedModels, providerDescriptions = [], options = {}) {
  if (!nativeCatalog || !Array.isArray(nativeCatalog.models)) throw new TypeError("Native Codex catalog must contain a models array");
  if (!Array.isArray(routedModels)) throw new TypeError("routedModels must be an array");
  const providers = new Map(providerDescriptions.map((provider) => [provider.id, provider]));
  const favorites = new Set(options.favorites ?? []);
  const existing = new Set(nativeCatalog.models.map((model) => model.slug));
  const additions = [];

  for (const route of routedModels) {
    if (!route?.id || existing.has(route.id)) continue;
    const metadata = route.metadata ?? {};
    const provider = providers.get(metadata.provider);
    const smart = metadata.threadspan_smart === true;
    const visible = smart || favorites.has(route.id) || (options.showFree === true && metadata.free === true);
    additions.push(toCodexModelInfo(route, provider, { smart, visible }));
    existing.add(route.id);
  }

  return {
    ...structuredClone(nativeCatalog),
    models: [...structuredClone(nativeCatalog.models), ...additions],
  };
}

/** Render one routed bridge model using the current Codex ModelInfo wire schema. */
export function toCodexModelInfo(route, provider, options = {}) {
  const metadata = route.metadata ?? {};
  const mode = String(metadata.bridge_mode ?? "consult");
  const providerId = String(metadata.provider ?? route.owned_by ?? "threadspan");
  const upstreamModel = String(metadata.upstream_model ?? "auto");
  const adapter = provider?.adapter;
  const managedWorker = ["cursor-cli", "cursor-sdk", "grok-build", "claude-code"].includes(adapter);
  const contextWindow = positiveInteger(metadata.context_window);
  const reasoningLevels = normalizeReasoningLevels(metadata.supported_reasoning_levels);
  const defaultReasoning = adapter === "nous"
    ? "max"
    : reasoningLevels.find((entry) => entry.effort === metadata.default_reasoning_level)?.effort
      ?? reasoningLevels[0]?.effort
      ?? null;
  const displayProvider = options.smart ? "Threadspan" : providerLabel(providerId);
  const displayName = options.smart
    ? `Threadspan ${title(mode)}`
    : `${displayProvider} · ${compactModelName(upstreamModel)} · ${title(mode)}`;

  return {
    slug: route.id,
    display_name: displayName,
    description: options.smart
      ? `Best currently eligible ${mode} route selected by Threadspan.`
      : `${title(mode)} through ${displayProvider}; live availability and limits remain authoritative.`,
    default_reasoning_level: managedWorker ? null : defaultReasoning,
    supported_reasoning_levels: managedWorker ? [] : reasoningLevels,
    shell_type: "unified_exec",
    visibility: options.visible ? "list" : "hide",
    supported_in_api: true,
    priority: options.smart ? 900 : 100,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    model_messages: null,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: !managedWorker,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text_and_image",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: metadata.images === true ? ["text", "image"] : ["text"],
    used_fallback_model_metadata: false,
    supports_search_tool: false,
    use_responses_lite: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    auto_review_model_override: null,
    model_specialty: options.smart ? "adaptive routing" : provider?.capabilities?.specialty ?? null,
    tool_mode: "direct",
  };
}

function normalizeReasoningLevels(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const effort = typeof entry === "string" ? entry : entry?.effort;
    if (typeof effort !== "string" || effort.length === 0) return [];
    return [{ effort, description: typeof entry?.description === "string" ? entry.description : title(effort) }];
  });
}

function providerLabel(value) {
  return ({ cursor: "Cursor", "cursor-ultra": "Cursor", "grok-build": "Grok Build", nous: "Nous", openrouter: "OpenRouter", "claude-code": "Claude Code" })[value]
    ?? value.split(/[-_.]/).map(title).join(" ");
}

function compactModelName(value) {
  const pieces = value.split("/");
  return pieces.at(-1) || value;
}

function title(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
