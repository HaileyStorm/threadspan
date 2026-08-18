import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { asBridgeError, RequestError } from "../core/errors.mjs";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_PROXY_DRAIN_GRACE_MS = 250;
const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const CONNECTOR_TOOL_NAMES = Object.freeze(new Set([
  "consult",
  "integrated",
  "bridge_status",
  "bridge_models",
  "bridge_accounts",
]));

/**
 * Run a newline-delimited JSON-RPC MCP server over stdio.
 *
 * The implementation deliberately keeps stdout protocol-clean; all diagnostics must use the supplied logger,
 * which writes to stderr. Active tool calls are cancellable through `notifications/cancelled`.
 *
 * @param {{
 *   service: import("../bridge/service.mjs").BridgeService,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   logger?: any,
 *   serverName?: string,
 *   serverVersion?: string,
 * }} options Server options.
 * @returns {Promise<void>}
 */
export async function runMcpServer(options) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const logger = options.logger;
  const serverName = options.serverName ?? "cursor-codex-bridge";
  const serverVersion = options.serverVersion ?? "0.2.1";
  const activeRequests = new Map();
  const pendingTasks = new Set();
  const writeJsonRpc = createJsonRpcWriter(output);
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      await writeJsonRpc(jsonRpcError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)));
      continue;
    }

    if (message.method === "notifications/cancelled") {
      const requestId = message.params?.requestId;
      activeRequests.get(requestIdKey(requestId))?.abort(new Error(message.params?.reason ?? "MCP request cancelled"));
      continue;
    }
    if (message.method?.startsWith("notifications/")) continue;
    if (message.id === undefined) continue;

    const activeKey = requestIdKey(message.id);
    if (activeRequests.has(activeKey)) {
      await writeJsonRpc(jsonRpcError(message.id, -32600, "Duplicate active JSON-RPC request id"));
      continue;
    }
    const controller = new AbortController();
    activeRequests.set(activeKey, controller);
    const task = (async () => {
      try {
        const result = await dispatchMcpRequest(options.service, message.method, message.params ?? {}, controller.signal, {
          serverName,
          serverVersion,
        });
        await writeJsonRpc({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        const bridgeError = asBridgeError(error);
        logger?.error("MCP request failed", { method: message.method, code: bridgeError.code, message: bridgeError.message });
        if (message.method === "tools/call") {
          await writeJsonRpc({
            jsonrpc: "2.0",
            id: message.id,
            result: toolErrorResult(bridgeError),
          });
        } else {
          await writeJsonRpc(jsonRpcError(message.id, -32000, bridgeError.message, {
            code: bridgeError.code,
            status: bridgeError.status,
            details: bridgeError.details,
          }));
        }
      } finally {
        if (activeRequests.get(activeKey) === controller) activeRequests.delete(activeKey);
      }
    })();
    pendingTasks.add(task);
    task.finally(() => pendingTasks.delete(task)).catch(() => undefined);
  }

  for (const controller of activeRequests.values()) controller.abort(new Error("MCP input closed"));
  await Promise.allSettled([...pendingTasks]);
  await writeJsonRpc.flush();
}

/**
 * Proxy newline-delimited stdio MCP to the daemon's scoped Streamable HTTP `/mcp` endpoint.
 * The connector token is loaded only from its owner-local file; owner-token environment fallback is forbidden.
 *
 * @param {{
 *   endpoint: string,
 *   tokenFile: string,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   fetchImpl?: typeof fetch,
 * }} options Proxy options.
 * @returns {Promise<void>}
 */
export async function runMcpHttpProxy(options) {
  const endpoint = new URL(String(options?.endpoint ?? ""));
  if (endpoint.pathname.replace(/\/+$/, "") !== "/mcp") throw new TypeError("Remote MCP proxy endpoint must end in /mcp");
  if (endpoint.username || endpoint.password) throw new TypeError("Remote MCP proxy endpoint must not contain credentials");
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHost(endpoint.hostname))) {
    throw new TypeError("Remote MCP proxy requires HTTPS except for verified loopback HTTP");
  }
  if (typeof options?.tokenFile !== "string" || !options.tokenFile) throw new TypeError("Remote MCP proxy requires a connector token file");
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const writeJsonRpc = createJsonRpcWriter(output);
  const activeRequests = new Map();
  const pendingTasks = new Set();
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  let sessionId;

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      await writeJsonRpc(jsonRpcError(null, -32700, "Parse error", error instanceof Error ? error.message : String(error)));
      continue;
    }

    const hasId = message.id !== undefined;
    const activeKey = hasId ? requestIdKey(message.id) : undefined;
    if (hasId && activeRequests.has(activeKey)) {
      await writeJsonRpc(jsonRpcError(message.id, -32600, "Duplicate active JSON-RPC request id"));
      continue;
    }
    const controller = new AbortController();
    if (hasId) activeRequests.set(activeKey, controller);
    const task = (async () => {
      try {
        const token = (await readFile(options.tokenFile, "utf8")).trim();
        if (!token) throw new Error("connector token file is empty");
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        const nextSessionId = response.headers.get("mcp-session-id");
        if (nextSessionId) sessionId = nextSessionId;
        if (response.status === 202 || !hasId) return;
        const text = await response.text();
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch (error) {
          throw new Error(`Remote MCP returned non-JSON HTTP ${response.status}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!response.ok) {
          const upstream = payload?.error ?? {};
          await writeJsonRpc(jsonRpcError(message.id, -32000, upstream.message ?? `Remote MCP returned HTTP ${response.status}`, {
            code: upstream.code ?? upstream.type ?? "remote_mcp_error",
            status: response.status,
          }));
          return;
        }
        await writeJsonRpc(payload);
      } catch (error) {
        if (hasId) await writeJsonRpc(jsonRpcError(message.id, -32000, error instanceof Error ? error.message : String(error)));
      } finally {
        if (hasId && activeRequests.get(activeKey) === controller) activeRequests.delete(activeKey);
      }
    })();
    pendingTasks.add(task);
    task.finally(() => pendingTasks.delete(task)).catch(() => undefined);
  }

  const drained = pendingTasks.size === 0 || await Promise.race([
    Promise.allSettled([...pendingTasks]).then(() => true),
    new Promise((resolve) => setTimeout(resolve, MCP_PROXY_DRAIN_GRACE_MS, false)),
  ]);
  if (!drained) {
    for (const controller of activeRequests.values()) controller.abort(new Error("MCP proxy input closed before active transport drained"));
  }
  await Promise.allSettled([...pendingTasks]);
  await writeJsonRpc.flush();
}

/**
 * Dispatch one MCP JSON-RPC method.
 * @param {import("../bridge/service.mjs").BridgeService} service Bridge service.
 * @param {string} method JSON-RPC method.
 * @param {Record<string, any>} params Method parameters.
 * @param {AbortSignal} signal Abort signal.
 * @param {{serverName: string, serverVersion: string, allowedTools?: ReadonlySet<string>}} identity Server identity and optional tool scope.
 * @returns {Promise<Record<string, any>>}
 */
export async function dispatchMcpRequest(service, method, params, signal, identity) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: identity.serverName, version: identity.serverVersion },
        instructions: identity.allowedTools
          ? "This connector is read-only: use Consult or Integrated inference plus status, model, and account discovery. Delegate and mutation surfaces are unavailable. Preserve native host/project settings."
          : "Use consult for an advisory second opinion and delegate only for bounded execution. Automatically recognize brainstorming-worthy requests, but branch only when independent evidence, genuine ideation divergence, or disjoint writes justify coordination cost. Select routes by capability, live availability/quota/credit, privacy, latency, and diversity value; bound branches, turns, and cost; stop at convergence; keep one caller-owned synthesis and acceptance. Invoke suitable host tools/plugins, including ImageGen for UI visual divergence, only when decision-useful. On parent interruption, audit provider handles and preserve resumable state before retrying or rerouting through existing gates. Compatibility Watch detects app/provider drift, restores compatibility, runs bounded direct/meta/meta-meta hardening, and produces reviewed sanitized issue/PR proposals.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: identity.allowedTools ? connectorScopedTools(identity.allowedTools) : MCP_TOOLS };
    case "tools/call":
      if (identity.allowedTools && !identity.allowedTools.has(params.name)) throw new RequestError(`MCP tool '${params.name}' is outside this connector's read-only scope`);
      if (identity.allowedTools && params.name === "consult" && params.arguments?.workspace !== undefined) {
        throw new RequestError("Connector Consult cannot authorize filesystem workspace access");
      }
      return callMcpTool(service, params, signal);
    default:
      throw new RequestError(`Unsupported MCP method '${method}'`);
  }
}

/**
 * Invoke one bridge MCP tool.
 * @param {import("../bridge/service.mjs").BridgeService} service Bridge service.
 * @param {Record<string, any>} params Tool-call parameters.
 * @param {AbortSignal} signal Abort signal.
 * @returns {Promise<Record<string, any>>}
 */
async function callMcpTool(service, params, signal) {
  const name = params.name;
  const args = params.arguments ?? {};
  if (name === "consult") {
    const result = await service.consult(normalizeMcpTaskArguments(args), { signal });
    return toolResult(result.text, result);
  }
  if (name === "delegate") {
    const result = await service.delegate(normalizeMcpTaskArguments(args), { signal });
    return toolResult(result.text, result);
  }
  if (name === "integrated") {
    if (typeof args.question !== "string" || args.question.trim().length === 0) throw new RequestError("Integrated requires a non-empty question");
    const provider = args.provider ?? service.config?.defaults?.provider;
    const upstreamModel = args.model ?? service.config?.defaults?.model;
    if (!provider || !upstreamModel) throw new RequestError("Integrated requires a provider and model");
    const model = String(upstreamModel).startsWith("integrated/")
      ? String(upstreamModel)
      : `integrated/${provider}/${upstreamModel}`;
    const prompt = args.context ? `${args.context}\n\n${args.question}` : args.question;
    const result = await service.executeResponse({ model, input: prompt, stream: false, metadata: { ...(args.account_id ?? args.accountId ? { bridge_account_id: args.account_id ?? args.accountId } : {}), ...(args.account_fallback === true || args.accountFallback === true ? { bridge_account_fallback: true } : {}) } }, { signal });
    const text = extractResponseText(result);
    return toolResult(text, result);
  }
  if (name === "bridge_status") {
    const result = await service.stats();
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  if (name === "bridge_models") {
    const result = { providers: await service.describeProviders(), models: await service.listModels() };
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  if (name === "bridge_accounts") {
    const result = await service.describeAccounts();
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  throw new RequestError(`Unknown MCP tool '${name}'`);
}

function isLoopbackHost(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function extractResponseText(response) {
  const parts = [];
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("");
}

/**
 * Normalize MCP snake_case arguments to the service input contract.
 * @param {Record<string, any>} args MCP arguments.
 * @returns {Record<string, any>}
 */
function normalizeMcpTaskArguments(args) {
  return {
    question: args.question,
    context: args.context,
    artifacts: args.artifacts,
    system: args.system,
    provider: args.provider,
    model: args.model,
    threadId: args.thread_id ?? args.threadId,
    workspace: args.workspace,
    timeoutMs: args.timeout_ms ?? args.timeoutMs,
    profile: args.profile,
    reasoningEffort: args.reasoning_effort ?? args.reasoningEffort,
    maxTurns: args.max_turns ?? args.maxTurns,
    expectedTurns: args.expected_turns ?? args.expectedTurns,
    noPlan: args.no_plan ?? args.noPlan,
    acceptanceCommands: args.acceptance_commands ?? args.acceptanceCommands,
    scope: args.scope,
    allowSubagents: args.allow_subagents ?? args.allowSubagents,
    allowWebSearch: args.allow_web_search ?? args.allowWebSearch,
    coordinatorId: args.coordinator_id ?? args.coordinatorId,
    workerGroup: args.worker_group ?? args.workerGroup,
    accountId: args.account_id ?? args.accountId,
    accountFallback: args.account_fallback ?? args.accountFallback,
    continuityHandoff: args.continuity_handoff ?? args.continuityHandoff,
  };
}

/**
 * Build a standard MCP tool result with text and structured content.
 * @param {string} text User-visible text.
 * @param {Record<string, any>} structured Structured result.
 * @returns {Record<string, any>}
 */
function toolResult(text, structured) {
  return {
    content: [{ type: "text", text: String(text ?? "") }],
    structuredContent: structured,
    isError: false,
  };
}

/**
 * Convert a bridge failure into a tool execution error so MCP hosts/models can inspect and correct
 * their call without treating the entire JSON-RPC connection as failed.
 * @param {import("../core/errors.mjs").BridgeError} error Normalized bridge error.
 * @returns {Record<string, any>}
 */
function toolErrorResult(error) {
  const structured = {
    error: {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
  return {
    content: [{ type: "text", text: `${error.code}: ${error.message}` }],
    structuredContent: structured,
    isError: true,
  };
}

/**
 * Select a supported MCP protocol version while remaining tolerant of older clients.
 * @param {unknown} requested Requested version.
 * @returns {string}
 */
function negotiateProtocolVersion(requested) {
  return typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/** Preserve JSON-RPC request id type when indexing active requests. */
function requestIdKey(id) {
  return `${id === null ? "null" : typeof id}:${JSON.stringify(id)}`;
}

/** Return connector-safe tool definitions without filesystem-bearing Consult inputs. */
function connectorScopedTools(allowedTools) {
  return MCP_TOOLS.filter((tool) => allowedTools.has(tool.name)).map((tool) => {
    if (tool.name !== "consult") return tool;
    const { workspace: _workspace, ...properties } = tool.inputSchema.properties;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  });
}

/**
 * Create a serialized, backpressured JSON-RPC line writer safe for concurrent requests.
 * @param {NodeJS.WritableStream} output Output stream.
 * @returns {((payload: Record<string, any>) => Promise<void>) & {flush: () => Promise<void>}}
 */
function createJsonRpcWriter(output) {
  let tail = Promise.resolve();
  const write = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    const operation = tail.then(() => writeLine(output, line));
    tail = operation.catch(() => undefined);
    return operation;
  };
  write.flush = () => tail;
  return write;
}

/** Write one complete protocol line and honor stream backpressure. */
function writeLine(output, line) {
  return new Promise((resolve, reject) => {
    if (output.destroyed || output.writableEnded) {
      reject(new Error("MCP output stream is closed"));
      return;
    }
    const cleanup = () => {
      output.off?.("drain", onDrain);
      output.off?.("error", onError);
      output.off?.("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("MCP output stream closed before drain")); };
    output.once?.("error", onError);
    output.once?.("close", onClose);
    if (output.write(line)) {
      cleanup();
      resolve();
    } else {
      output.once?.("drain", onDrain);
    }
  });
}

/**
 * Build a JSON-RPC error response.
 * @param {string|number|null} id Request id.
 * @param {number} code JSON-RPC error code.
 * @param {string} message Error message.
 * @param {unknown} [data] Optional data.
 * @returns {Record<string, any>}
 */
function jsonRpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** @type {Array<Record<string, any>>} */
const MCP_TOOLS = Object.freeze([
  {
    name: "consult",
    title: "Consult a secondary model",
    description: "Ask a configured secondary provider for an advisory second opinion inside the current work thread. The primary agent remains responsible for judgment and execution. For brainstorming, branch only when independent evidence or genuine divergence is decision-useful; stop when findings converge.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1, description: "The exact question the consultant should answer." },
        context: { type: "string", description: "Compact current-thread/task state, decisions, constraints, and uncertainty." },
        artifacts: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content"],
            properties: {
              label: { type: "string" },
              path: { type: "string" },
              content: { type: "string" },
            },
          },
        },
        system: { type: "string", description: "Optional additional consultant instruction; the bridge's advisory policy still applies." },
        provider: { type: "string", description: "Configured provider id. Defaults to bridge defaults.provider." },
        model: { type: "string", description: "Upstream model id. Defaults to the provider model." },
        account_id: { type: "string", description: "Opaque local account id. Defaults to the provider's persisted active account." },
        account_fallback: { type: "boolean", description: "Opt in to the configured same-provider account fallback policy; only safe pre-output/pre-side-effect failures qualify." },
        thread_id: { type: "string", description: "Stable consultant-thread id for follow-up consultations." },
        workspace: { type: "string", description: "Workspace to snapshot for providers that can inspect files." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 7200000 },
        profile: { type: "string", minLength: 1, description: "Named provider task profile, such as Grok Build mechanical, balanced, diagnose, or deep." },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high"], description: "Provider-specific effort override when supported and allowed by configuration." },
        max_turns: { type: "integer", minimum: 1, maximum: 128, description: "Finite agent-loop cap when supported; provider policy may impose a lower ceiling." },
        expected_turns: { type: "integer", minimum: 1, maximum: 128, description: "Admission-budget estimate for agent providers that reconcile actual model calls afterward." },
        no_plan: { type: "boolean", description: "Skip provider plan mode for a fully specified mechanical task when supported." },
        allow_subagents: { type: "boolean", description: "Allow provider-native nested agents. Grok Build defaults to true in this package." },
        allow_web_search: { type: "boolean", description: "Allow provider-native web/search retrieval. Grok Build defaults to true in this package." },
        coordinator_id: { type: "string", minLength: 1, description: "Optional coordinator identity recorded in provider telemetry." },
        worker_group: { type: "string", minLength: 1, description: "Optional worker/fleet group recorded in provider telemetry." },
        continuity_handoff: { type: "boolean", description: "Explicitly authorize a mode-changing continuation on an existing bridge thread." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "integrated",
    title: "Call a raw secondary model",
    description: "Route one tool-free response through a configured raw API adapter while the current host retains tools, approvals, web, memory, and native project/user settings.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: { type: "string", minLength: 1 },
        context: { type: "string" },
        provider: { type: "string", description: "Configured provider id." },
        model: { type: "string", description: "Upstream model id." },
        account_id: { type: "string", description: "Opaque local account id." },
        account_fallback: { type: "boolean", description: "Opt in to safe same-provider account fallback." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "delegate",
    title: "Delegate a bounded subtask",
    description: "Hand a bounded execution task to a provider-owned agent loop. The delegated agent may modify the supplied live workspace; review its report and diff afterward.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["question", "workspace"],
      properties: {
        question: { type: "string", minLength: 1, description: "The bounded implementation or investigation task." },
        context: { type: "string", description: "Relevant current-thread state and acceptance criteria." },
        artifacts: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content"],
            properties: { label: { type: "string" }, path: { type: "string" }, content: { type: "string" } },
          },
        },
        system: { type: "string", description: "Optional additional worker instruction; bridge execution boundaries still apply." },
        provider: { type: "string" },
        model: { type: "string" },
        account_id: { type: "string", description: "Opaque local account id. Delegate never auto-falls back between accounts." },
        thread_id: { type: "string" },
        workspace: { type: "string", minLength: 1 },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 7200000 },
        profile: { type: "string", minLength: 1, description: "Named provider task profile." },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high"], description: "Provider-specific effort override when supported and allowed by configuration." },
        max_turns: { type: "integer", minimum: 1, maximum: 128, description: "Finite agent-loop cap when supported; provider policy may impose a lower ceiling." },
        expected_turns: { type: "integer", minimum: 1, maximum: 128, description: "Admission-budget estimate for agent providers that reconcile actual model calls afterward." },
        no_plan: { type: "boolean", description: "Skip provider plan mode for a fully specified mechanical task when supported." },
        allow_subagents: { type: "boolean", description: "Allow provider-native nested agents. Grok Build defaults to true in this package." },
        allow_web_search: { type: "boolean", description: "Allow provider-native web/search retrieval. Grok Build defaults to true in this package." },
        coordinator_id: { type: "string", minLength: 1, description: "Optional coordinator identity recorded in provider telemetry." },
        worker_group: { type: "string", minLength: 1, description: "Optional worker/fleet group recorded in provider telemetry." },
        continuity_handoff: { type: "boolean", description: "Explicitly authorize a mode-changing continuation on an existing bridge thread." },
        acceptance_commands: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1 },
          description: "Exact validation commands to include in the bounded task packet. Provider permission policy still controls whether they can run.",
        },
        scope: {
          type: "object",
          additionalProperties: false,
          required: ["allowed"],
          properties: {
            allowed: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", minLength: 1 } },
            denied: { type: "array", maxItems: 128, items: { type: "string", minLength: 1 } },
            non_goals: { type: "array", maxItems: 128, items: { type: "string", minLength: 1 } },
          },
          description: "Explicit disjoint-write scope for managed workers. Scope narrows authority and never changes native host/project settings.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_status",
    title: "Bridge status",
    description: "Return count-only bridge health, bounded connection recovery, Compatibility Watch self-heal policy, and session diagnostics without exposing prompts or credentials. Exact provider/account/transport lifecycle remains adapter-specific.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "bridge_models",
    title: "Bridge providers and models",
    description: "Return configured provider capabilities, effective-settings ownership/digests, exact provider/account/transport lifecycle reports, and discovered or configured routed model ids.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "bridge_accounts",
    title: "Bridge accounts",
    description: "Return privacy-minimized local account descriptors, active selections, health, and usage. Account mutation is intentionally unavailable through MCP.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
]);

export { CONNECTOR_TOOL_NAMES, MCP_TOOLS, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS };
