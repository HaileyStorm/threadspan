import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { AsyncQueue } from "../core/async-queue.mjs";
import { ProviderError, RequestError } from "../core/errors.mjs";
import { KeyedSerialQueue } from "../core/keyed-serial-queue.mjs";
import { spawnManagedChild, terminateProcessTree } from "../core/managed-process.mjs";
import { renderMessagesForAgent } from "../core/policies.mjs";
import { enforceGitWorkspacePolicy } from "../workspace/git-workspace.mjs";
import { createWorkspaceSnapshot, isPathInside } from "../workspace/snapshot.mjs";
import { ProviderAdapter } from "./base.mjs";

const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const CONSULT_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
const DELEGATE_TOOLS = Object.freeze(["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH", "Path", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SHELL", "USER", "USERNAME",
  "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "WSL_DISTRO_NAME",
  "WSL_INTEROP", "CLAUDE_CODE_GIT_BASH_PATH",
]);

/** Claude Code CLI adapter. Generic Claude remains Preview; explicit gateways may carry narrower evidence. */
export class ClaudeCodeProvider extends ProviderAdapter {
  constructor(id, config, context) {
    super(id, config, context);
    this.sessions = new Map();
    this.sessionQueue = new KeyedSerialQueue();
  }

  capabilities() {
    const configured = new Set(this.config.capabilities ?? ["consult", "delegate"]);
    const route = routeMetadata(this.config.gateway);
    return {
      modes: {
        consult: {
          supported: configured.has("consult"),
          readOnlyBoundary: "disposable-workspace-snapshot-plus-plan-permissions",
        },
        integrated: {
          supported: false,
          reason: "Claude Code owns its agent/tool loop and is not a raw inference endpoint",
        },
        delegate: {
          supported: configured.has("delegate"),
          mutationBoundary: "bounded-isolated-live-worktree",
        },
      },
      streaming: true,
      tools: false,
      images: false,
      durableThreads: false,
      retainedWithinProcess: true,
      providerOwnsTools: true,
      localRuntime: true,
      authentication: this.config.gateway ? "explicit-gateway-environment" : "existing-claude-code-session",
      status: route.status,
      liveTested: route.liveTested,
      liveEvidence: route.liveEvidence,
    };
  }

  async listModels() {
    return super.listModels();
  }

  async *run(request) {
    this.assertMode(request.mode);
    if (typeof request.model !== "string" || !request.model || request.model === "auto") {
      throw new RequestError("Claude Code Preview requires an explicit model or model alias");
    }
    if (request.mode === "delegate" && !request.workspace) {
      throw new RequestError("Claude Code Delegate requires an explicit workspace path");
    }

    const boundary = this.#sessionBoundary(request);
    const output = new AsyncQueue();
    const execution = this.sessionQueue.run(boundary, request.signal, async () => {
      try {
        for await (const event of this.#runBoundTurn(request, boundary)) output.push(event);
        output.close();
      } catch (error) {
        output.fail(error);
        throw error;
      }
    });
    execution.catch((error) => output.fail(error));
    for await (const event of output) yield event;
    await execution;
  }

  runtimeStats() {
    this.#sweepSessions();
    const route = routeMetadata(this.config.gateway);
    return {
      kind: "claude-code",
      authentication: this.config.gateway ? "explicit-gateway-environment" : "existing-claude-code-session",
      retainedSessionBindings: this.sessions.size,
      status: route.status,
      liveTested: route.liveTested,
      liveEvidence: route.liveEvidence,
      quotaSource: "not-observed",
    };
  }

  async *#runBoundTurn(request, boundary) {
    let snapshot;
    let emptyWorkspace;
    let mcpConfigDirectory;
    let workspace = resolveClaudeCodeInputWorkspace(request);
    try {
      if (request.mode === "consult") {
        if (workspace) {
          snapshot = await createWorkspaceSnapshot(workspace, {
            root: this.config.consult?.snapshotRoot,
            exclude: this.config.consult?.exclude,
            maxBytes: this.config.consult?.snapshotMaxBytes,
            maxFiles: this.config.consult?.snapshotMaxFiles,
            copyInternalSymlinks: this.config.consult?.copyInternalSymlinks === true,
            prefix: "threadspan-claude-consult-",
            logger: this.logger,
          });
          workspace = snapshot.path;
        } else {
          emptyWorkspace = await mkdtemp(join(tmpdir(), "threadspan-claude-consult-"));
          workspace = emptyWorkspace;
        }
      } else if (this.config.delegate?.requireGit !== false) {
        await enforceGitWorkspacePolicy(workspace, {
          requireLinkedWorktree: this.config.delegate?.requireLinkedWorktree !== false,
          requireCleanStart: this.config.delegate?.requireCleanStart !== false,
          denyBranches: this.config.delegate?.denyBranches ?? ["main", "master", "trunk"],
        });
      }

      this.#sweepSessions();
      let binding = this.sessions.get(boundary);
      const newBinding = !binding;
      binding ??= { sessionId: randomUUID(), updatedAt: Date.now() };
      this.sessions.set(boundary, binding);
      this.#enforceSessionLimit();

      const transcript = renderMessagesForAgent(newBinding ? request.messages : latestTurnMessages(request.messages), {
        outputSummary: this.config.outputSummary,
        providerId: this.id,
        adapter: "claude-code",
        purpose: "agent-prompt",
      });
      const prompt = request.mode === "delegate"
        ? renderClaudeDelegatePrompt(transcript, resolveClaudeCodeDelegateContract(request, workspace), workspace)
        : transcript;
      let observedSession = false;
      const route = routeMetadata(this.config.gateway);
      try {
        mcpConfigDirectory = await mkdtemp(join(tmpdir(), "threadspan-claude-mcp-"));
        const mcpConfigPath = join(mcpConfigDirectory, "empty-mcp.json");
        await writeFile(mcpConfigPath, EMPTY_MCP_CONFIG, { mode: 0o600 });
        const invocation = buildClaudeCodeInvocation({
          command: this.config.command ?? "claude",
          model: request.model,
          mode: request.mode,
          sessionId: binding.sessionId,
          resume: !newBinding,
          maxTurns: this.#maxTurns(request),
          permissionMode: request.mode === "consult"
            ? "plan"
            : this.config.delegate?.permissionMode ?? "acceptEdits",
          tools: request.mode === "consult"
            ? normalizeToolSubset(this.config.consult?.tools, CONSULT_TOOLS, CONSULT_TOOLS)
            : normalizeToolSubset(this.config.delegate?.tools, DELEGATE_TOOLS, DELEGATE_TOOLS),
          allowedTools: request.mode === "delegate" ? this.config.delegate?.allowedTools : undefined,
          workspace,
          environment: process.env,
          claudeConfigDir: this.config.__threadspanClaudeConfigDir,
          gateway: this.config.gateway,
          mcpConfigPath,
        });
        yield { type: "status", status: "started", providerMetadata: { claudeCode: route } };
        for await (const event of runClaudeCodeProcess({
          ...invocation,
          prompt,
          providerId: this.id,
          signal: request.signal,
          timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? 30 * 60 * 1000,
          maxOutputBytes: this.config.maxOutputBytes ?? 16 * 1024 * 1024,
          maxStderrBytes: this.config.maxStderrBytes ?? 256 * 1024,
          expectedSessionId: binding.sessionId,
          terminationGraceMs: this.config.terminationGraceMs ?? 2000,
          routeMetadata: route,
        })) {
          if (event.providerMetadata?.claudeCode?.observedSession === true) observedSession = true;
          yield event;
        }
        binding.updatedAt = Date.now();
      } catch (error) {
        if (newBinding && !observedSession && this.sessions.get(boundary) === binding) this.sessions.delete(boundary);
        throw error;
      }
    } finally {
      const cleanup = await Promise.allSettled([
        snapshot?.dispose(),
        emptyWorkspace ? rm(emptyWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) : undefined,
        mcpConfigDirectory ? rm(mcpConfigDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) : undefined,
      ]);
      const failedCleanup = cleanup.find((result) => result.status === "rejected");
      if (failedCleanup) throw failedCleanup.reason;
    }
  }

  #maxTurns(request) {
    const requested = Number(request.metadata?.bridge_max_turns);
    const maximum = this.config.maxTurnsCeiling ?? 24;
    if (request.metadata?.bridge_max_turns !== undefined) {
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > maximum) {
        throw new RequestError(`Claude Code maxTurns must be an integer from 1 through ${maximum}`);
      }
      return requested;
    }
    const configured = this.config[request.mode]?.maxTurns;
    return configured ?? (request.mode === "consult" ? 4 : 12);
  }

  #sessionBoundary(request) {
    const profile = this.config.__threadspanClaudeConfigDir ?? "default-profile";
    const workspace = resolveClaudeCodeInputWorkspace(request) ?? "no-workspace";
    return [request.accountId ?? "default", request.threadId ?? "stateless", request.mode, request.model, profile, workspace].join("\0");
  }

  #sweepSessions() {
    const cutoff = Date.now() - (this.config.sessionTtlMs ?? 24 * 60 * 60 * 1000);
    for (const [key, binding] of this.sessions) if (binding.updatedAt < cutoff) this.sessions.delete(key);
  }

  #enforceSessionLimit() {
    const maximum = this.config.maxSessions ?? 200;
    while (this.sessions.size > maximum) {
      let oldestKey;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, binding] of this.sessions) {
        if (binding.updatedAt < oldest) {
          oldestKey = key;
          oldest = binding.updatedAt;
        }
      }
      if (oldestKey === undefined) return;
      this.sessions.delete(oldestKey);
    }
  }
}

function resolveClaudeCodeInputWorkspace(request) {
  if (!request?.workspace) return undefined;
  if (request.mode !== "consult") return resolve(request.workspace);
  const metadata = request.metadata;
  const bridgeRouted = metadata && typeof metadata === "object"
    && (metadata.bridge_mode !== undefined || metadata.bridge_provider !== undefined || metadata.bridge_thread_id !== undefined);
  const bridgeWorkspaceExplicit = metadata?.bridge_workspace !== undefined || metadata?.cwd !== undefined;
  return bridgeRouted && !bridgeWorkspaceExplicit ? undefined : resolve(request.workspace);
}

function latestTurnMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  let start = messages.length - 1;
  while (start > 0 && messages[start].role !== "user") start -= 1;
  return messages.slice(start);
}

/** Build the exact shell-free Claude Code argv and credential-free environment for one turn. */
export function buildClaudeCodeInvocation(options) {
  if (typeof options?.model !== "string" || !options.model || options.model === "auto") {
    throw new TypeError("model must be explicit");
  }
  if (!isUuid(options.sessionId)) throw new TypeError("sessionId must be a UUID");
  if (!["consult", "delegate"].includes(options.mode)) throw new TypeError("mode must be consult or delegate");
  if (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1) throw new TypeError("maxTurns must be a positive integer");
  const permissionMode = options.mode === "consult" ? "plan" : options.permissionMode;
  const allowedPermissionModes = options.mode === "consult"
    ? ["plan"]
    : ["acceptEdits", "dontAsk", "default", "manual"];
  if (!allowedPermissionModes.includes(permissionMode)) {
    throw new TypeError("Delegate permissionMode must not bypass permissions");
  }
  const tools = normalizeToolSubset(options.tools, options.mode === "consult" ? CONSULT_TOOLS : DELEGATE_TOOLS, options.mode === "consult" ? CONSULT_TOOLS : DELEGATE_TOOLS);
  if (typeof options.mcpConfigPath !== "string" || !isAbsolute(options.mcpConfigPath)) {
    throw new TypeError("mcpConfigPath must be an absolute path");
  }
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", options.model,
    "--permission-mode", permissionMode,
    "--bare",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-chrome",
    "--strict-mcp-config",
    "--mcp-config", options.mcpConfigPath,
    "--tools", tools.join(","),
    "--disallowedTools", "mcp__*",
    "--max-turns", String(options.maxTurns),
    options.resume ? "--resume" : "--session-id", options.sessionId,
  ];
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  return Object.freeze({
    command: String(options.command ?? "claude"),
    args: Object.freeze(args),
    cwd: resolve(options.workspace),
    env: Object.freeze(buildClaudeEnvironment(options.environment, options.claudeConfigDir, options.gateway)),
    shell: false,
    platform: options.platform ?? process.platform,
  });
}

/** Parse Claude Code stream-json NDJSON while retaining every source object and exact source line. */
export async function* parseClaudeCodeNdjson(stream, options = {}) {
  const decoder = new StringDecoder("utf8");
  const maximum = options.maxBytes ?? 16 * 1024 * 1024;
  let bytes = 0;
  let buffer = "";
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maximum) throw new ProviderError(options.providerId ?? "claude-code", `Claude Code output exceeded ${maximum} bytes`, { retryable: false });
    buffer += decoder.write(data);
    while (true) {
      const boundary = buffer.indexOf("\n");
      if (boundary < 0) break;
      const rawLine = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (rawLine.trim()) yield parseClaudeLine(redactText(rawLine, options.redactValues), options.providerId);
    }
  }
  buffer += decoder.end();
  if (buffer.trim()) yield parseClaudeLine(redactText(buffer, options.redactValues), options.providerId);
}

async function* runClaudeCodeProcess(options) {
  const redactValues = [options.env?.ANTHROPIC_API_KEY, options.env?.ANTHROPIC_AUTH_TOKEN].filter((value, index, values) => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);
  let child;
  try {
    child = spawnManagedChild(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      killTree: true,
    });
  } catch (error) {
    throw providerSpawnError(options.providerId, options.command, error);
  }
  const exitPromise = once(child, "exit");
  exitPromise.catch(() => undefined);
  let stderr = "";
  const stderrTask = (async () => {
    for await (const chunk of child.stderr) {
      stderr += chunk.toString("utf8");
      if (Buffer.byteLength(stderr) > options.maxStderrBytes) stderr = Buffer.from(stderr).subarray(-options.maxStderrBytes).toString("utf8");
    }
  })();
  let stdinError;
  child.stdin.on("error", (error) => { stdinError = error; });
  child.stdin.end(options.prompt);
  let timedOut = false;
  const abort = () => { void terminateProcessTree(child, { graceMs: options.terminationGraceMs, killTree: true }); };
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(child, { graceMs: options.terminationGraceMs, killTree: true });
  }, options.timeoutMs);
  timer.unref?.();

  let text = "";
  let reasoning = "";
  let usage;
  let rawResult;
  let observedSession = false;
  let terminalError;
  try {
    for await (const frame of parseClaudeCodeNdjson(child.stdout, { maxBytes: options.maxOutputBytes, providerId: options.providerId, redactValues })) {
      const sessionId = claudeSessionId(frame.raw);
      if (sessionId) {
        observedSession = true;
        if (sessionId !== options.expectedSessionId) {
          throw new ProviderError(options.providerId, `Claude Code session '${sessionId}' does not match the bound session`, { retryable: false });
        }
      }
      const normalized = normalizeClaudeEvent(frame.raw, frame.rawLine, { text, reasoning });
      for (const event of normalized.events) {
        if (event.type === "text-delta") text += event.delta ?? "";
        if (event.type === "reasoning-delta") reasoning += event.delta ?? "";
        if (event.type === "usage") usage = event.usage;
        yield {
          ...event,
          providerMetadata: {
            claudeCode: {
              rawEvent: frame.raw,
              rawLine: frame.rawLine,
              observedSession,
              ...options.routeMetadata,
            },
          },
        };
      }
      if (frame.raw.type === "result") {
        rawResult = frame.raw;
        usage = normalizeClaudeUsage(frame.raw.usage) ?? usage;
        if (frame.raw.is_error === true || ![undefined, "success"].includes(frame.raw.subtype)) {
          terminalError = String(frame.raw.result ?? frame.raw.error ?? `Claude Code result subtype '${frame.raw.subtype}'`);
        }
      }
    }

    let exitCode;
    let exitSignal;
    try { [exitCode, exitSignal] = await exitPromise; }
    catch (error) { throw providerSpawnError(options.providerId, options.command, error); }
    await stderrTask;
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Claude Code request aborted");
    if (timedOut) throw new ProviderError(options.providerId, `Claude Code timed out after ${options.timeoutMs} ms`, { status: 504, retryable: true });
    if (exitCode !== 0 || terminalError) {
      stderr = redactText(stderr, redactValues);
      throw new ProviderError(options.providerId, terminalError || `Claude Code exited with code ${exitCode ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}${stderr ? ` — ${truncate(stderr, 2000)}` : ""}`, {
        retryable: false,
        details: { exitCode, exitSignal, stderr: truncate(stderr, 8000), rawResult },
      });
    }
    if (stdinError) throw new ProviderError(options.providerId, `Could not deliver the prompt to Claude Code: ${stdinError.message}`, { retryable: false });
    if (!observedSession) throw new ProviderError(options.providerId, "Claude Code stream did not identify its session", { retryable: false });
    if (!rawResult) throw new ProviderError(options.providerId, "Claude Code stream ended without a result event", { retryable: false });
    if (!text && typeof rawResult.result === "string" && rawResult.result) {
      text = rawResult.result;
      yield { type: "text-delta", delta: text, providerMetadata: { claudeCode: { rawEvent: rawResult, observedSession: true, ...options.routeMetadata } } };
    }
    if (usage) yield { type: "usage", usage, providerMetadata: { claudeCode: { rawEvent: rawResult, observedSession: true, ...options.routeMetadata } } };
    yield {
      type: "done",
      finishReason: "stop",
      message: { role: "assistant", content: text, ...(reasoning ? { reasoningContent: reasoning } : {}) },
      usage,
      providerMetadata: {
        evidenceClass: "live-provider",
        claudeCode: {
          ...options.routeMetadata,
          sessionId: options.expectedSessionId,
          rawResult,
          costIsQuotaEvidence: false,
          transcriptStorage: "provider-native-local-session",
        },
      },
    };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof ProviderError) throw error;
    throw providerSpawnError(options.providerId, options.command, error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) await terminateProcessTree(child, { graceMs: options.terminationGraceMs, killTree: true }).catch(() => undefined);
    await stderrTask.catch(() => undefined);
  }
}

/** Normalize one raw Claude Code frame without deleting or rewriting the supplied object. */
export function normalizeClaudeCodeEvent(raw, state = {}) {
  return normalizeClaudeEvent(raw, JSON.stringify(raw), { text: state.text ?? "", reasoning: state.reasoning ?? "" }).events;
}

/** Require and normalize the prompt-level Delegate scope contract. */
export function resolveClaudeCodeDelegateContract(request, workspace = request?.workspace) {
  const raw = request?.metadata?.bridge_scope ?? request?.metadata?.bridge_allowed_paths;
  const scope = normalizeScope(raw);
  if (scope.allowed.length === 0) throw new RequestError("Claude Code Delegate requires non-empty metadata.bridge_scope (or bridge_allowed_paths)");
  const root = resolve(workspace);
  for (const entry of scope.allowed) {
    const candidate = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
    if (!isPathInside(root, candidate)) throw new RequestError(`Claude Code Delegate allowed path escapes its workspace: ${entry}`);
  }
  const acceptanceCommands = request?.metadata?.bridge_acceptance_commands === undefined
    ? []
    : normalizeStringArray(request.metadata.bridge_acceptance_commands, "bridge_acceptance_commands");
  return { scope, acceptanceCommands };
}

function normalizeClaudeEvent(raw, rawLine, state) {
  const metadata = { claudeCode: { rawEvent: raw, rawLine } };
  if (raw?.type === "stream_event") {
    const delta = raw.event?.delta;
    if (raw.event?.type === "content_block_delta" && delta?.type === "text_delta") {
      return { events: [{ type: "text-delta", delta: String(delta.text ?? ""), providerMetadata: metadata }] };
    }
    if (raw.event?.type === "content_block_delta" && ["thinking_delta", "signature_delta"].includes(delta?.type)) {
      const value = delta.thinking ?? delta.text ?? "";
      return { events: value ? [{ type: "reasoning-delta", delta: String(value), providerMetadata: metadata }] : [] };
    }
    return { events: [{ type: "status", status: "provider-event", providerMetadata: metadata }] };
  }
  if (raw?.type === "assistant") {
    const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
    const fullText = content.filter((block) => block?.type === "text").map((block) => String(block.text ?? "")).join("");
    const fullReasoning = content.filter((block) => ["thinking", "reasoning"].includes(block?.type)).map((block) => String(block.thinking ?? block.text ?? "")).join("");
    const events = [];
    if (!state.text && fullText) events.push({ type: "text-delta", delta: fullText, providerMetadata: metadata });
    if (!state.reasoning && fullReasoning) events.push({ type: "reasoning-delta", delta: fullReasoning, providerMetadata: metadata });
    const usage = normalizeClaudeUsage(raw.message?.usage);
    if (usage) events.push({ type: "usage", usage, providerMetadata: metadata });
    return { events };
  }
  if (raw?.type === "result") return { events: [{ type: "status", status: "provider-result", providerMetadata: metadata }] };
  return { events: [{ type: "status", status: "provider-event", providerMetadata: metadata }] };
}

function renderClaudeDelegatePrompt(transcript, contract, workspace) {
  const scope = [
    ...contract.scope.allowed.map((entry) => `- May change: ${entry}`),
    ...contract.scope.denied.map((entry) => `- Must not change: ${entry}`),
    ...contract.scope.nonGoals.map((entry) => `- Non-goal: ${entry}`),
  ].join("\n");
  const acceptance = contract.acceptanceCommands.length > 0
    ? contract.acceptanceCommands.map((command, index) => `${index + 1}. ${command}`).join("\n")
    : "- No runnable acceptance command was authorized; report this verification gap.";
  return `EXECUTION BOUNDARY\nYou own only this finite delegated task inside ${workspace}. Stay within the explicit scope. Do not merge, rebase, push, force-push, tag, publish, release, alter credentials, or claim independent acceptance. Preserve unrelated work and report exact changed files, commands, results, and risks.\n\nSCOPE CONTRACT\n${scope}\n\nACCEPTANCE CONTRACT\nRun only these exact commands when the active Claude Code permissions allow them.\n${acceptance}\n\nAUTHORITATIVE TASK TRANSCRIPT\n${transcript}`;
}

function parseClaudeLine(rawLine, providerId = "claude-code") {
  const jsonText = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  try {
    const raw = JSON.parse(jsonText);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("event must be a JSON object");
    return { raw, rawLine };
  } catch (error) {
    throw new ProviderError(providerId, `Claude Code returned malformed stream-json NDJSON: ${error instanceof Error ? error.message : String(error)}`, {
      retryable: false,
      details: { sample: truncate(rawLine, 1000) },
      cause: error,
    });
  }
}

function normalizeClaudeUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = numberOrZero(value.input_tokens ?? value.inputTokens);
  const outputTokens = numberOrZero(value.output_tokens ?? value.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: numberOrZero(value.cache_read_input_tokens ?? value.cacheReadInputTokens),
    cacheCreationInputTokens: numberOrZero(value.cache_creation_input_tokens ?? value.cacheCreationInputTokens),
  };
}

function claudeSessionId(raw) {
  const value = raw?.session_id ?? raw?.sessionId;
  return typeof value === "string" && value ? value : undefined;
}

function buildClaudeEnvironment(environment = process.env, claudeConfigDir, gateway) {
  const output = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) if (typeof environment[key] === "string") output[key] = environment[key];
  output.DISABLE_AUTOUPDATER = "1";
  if (claudeConfigDir) output.CLAUDE_CONFIG_DIR = resolve(claudeConfigDir);
  if (gateway) {
    const token = environment[gateway.apiKeyEnv];
    if (typeof token !== "string" || token.length === 0) {
      throw new TypeError(`Claude Code gateway key environment variable '${gateway.apiKeyEnv}' is not set`);
    }
    output.ANTHROPIC_AUTH_TOKEN = token;
    output.ANTHROPIC_API_KEY = token;
    output.ANTHROPIC_BASE_URL = gateway.baseUrl;
    output.ANTHROPIC_MODEL = gateway.model;
  }
  return output;
}

function normalizeToolSubset(configured, allowed, fallback) {
  const values = configured === undefined ? fallback : configured;
  if (!Array.isArray(values) || values.length === 0) throw new TypeError("Claude Code tools must be a non-empty array");
  const unique = [...new Set(values.map(String))];
  for (const tool of unique) if (!allowed.includes(tool)) throw new TypeError(`Claude Code tool '${tool}' is outside the Preview allowlist`);
  return unique;
}

function normalizeScope(value) {
  if (typeof value === "string" || Array.isArray(value)) {
    return { allowed: normalizeStringArray(value, "bridge_scope"), denied: [], nonGoals: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { allowed: [], denied: [], nonGoals: [] };
  return {
    allowed: normalizeStringArray(value.allowed ?? value.allow ?? value.mayChange ?? value.paths ?? [], "bridge_scope.allowed"),
    denied: normalizeStringArray(value.denied ?? value.deny ?? value.mustNotChange ?? [], "bridge_scope.denied"),
    nonGoals: normalizeStringArray(value.nonGoals ?? value.non_goals ?? [], "bridge_scope.nonGoals"),
  };
}

function normalizeStringArray(value, field) {
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new RequestError(`Claude Code ${field} must contain only non-empty strings`);
  }
  return values.map((entry) => entry.trim());
}

function providerSpawnError(providerId, command, error) {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(providerId, `Could not start or monitor Claude Code command '${command}': ${message}`, {
    retryable: false,
    cause: error,
  });
}

function routeMetadata(gateway) {
  if (gateway?.provider === "agentrouter" && gateway.baseUrl === "https://agentrouter.org" && gateway.model === "claude-opus-4-8") {
    return {
      status: "live-verified-route",
      liveTested: true,
      liveEvidence: { date: "2026-08-18", hosts: ["linux", "windows"], model: "claude-opus-4-8" },
      costIsQuotaEvidence: false,
    };
  }
  return { status: "preview", liveTested: false, costIsQuotaEvidence: false };
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function numberOrZero(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function truncate(value, maximum) {
  const text = String(value ?? "");
  return text.length <= maximum ? text : `${text.slice(0, maximum)}...`;
}

function redactText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets ?? []) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    text = text.split(secret).join("[REDACTED]");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) text = text.split(escaped).join("[REDACTED]");
  }
  return text;
}
