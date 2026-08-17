import { createInterface } from "node:readline";
import { asBridgeError, RequestError } from "../core/errors.mjs";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

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
      activeRequests.get(requestId)?.abort(new Error(message.params?.reason ?? "MCP request cancelled"));
      continue;
    }
    if (message.method?.startsWith("notifications/")) continue;
    if (message.id === undefined) continue;

    const controller = new AbortController();
    activeRequests.set(message.id, controller);
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
        if (activeRequests.get(message.id) === controller) activeRequests.delete(message.id);
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
 * Dispatch one MCP JSON-RPC method.
 * @param {import("../bridge/service.mjs").BridgeService} service Bridge service.
 * @param {string} method JSON-RPC method.
 * @param {Record<string, any>} params Method parameters.
 * @param {AbortSignal} signal Abort signal.
 * @param {{serverName: string, serverVersion: string}} identity Server identity.
 * @returns {Promise<Record<string, any>>}
 */
async function dispatchMcpRequest(service, method, params, signal, identity) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: identity.serverName, version: identity.serverVersion },
        instructions: "Use consult for an advisory second opinion within the active thread. Use delegate only when the secondary agent should own a bounded execution task.",
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: MCP_TOOLS };
    case "tools/call":
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
  if (name === "bridge_status") {
    const result = await service.stats();
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  if (name === "bridge_models") {
    const result = { providers: await service.describeProviders(), models: await service.listModels() };
    return toolResult(JSON.stringify(result, null, 2), result);
  }
  throw new RequestError(`Unknown MCP tool '${name}'`);
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
    allowSubagents: args.allow_subagents ?? args.allowSubagents,
    allowWebSearch: args.allow_web_search ?? args.allowWebSearch,
    coordinatorId: args.coordinator_id ?? args.coordinatorId,
    workerGroup: args.worker_group ?? args.workerGroup,
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
    description: "Ask a configured secondary provider for an advisory second opinion inside the current work thread. The primary agent remains responsible for judgment and execution.",
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
        acceptance_commands: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1 },
          description: "Exact validation commands to include in the bounded task packet. Provider permission policy still controls whether they can run.",
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "bridge_status",
    title: "Bridge status",
    description: "Return count-only bridge health and session diagnostics without exposing prompts or credentials.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "bridge_models",
    title: "Bridge providers and models",
    description: "Return configured provider capabilities and discovered or configured routed model ids.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
]);

export { MCP_TOOLS, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_PROTOCOL_VERSIONS };
