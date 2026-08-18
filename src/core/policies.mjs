import { summarizeRepetitiveOutput } from "./output-summary.mjs";

/**
 * System instruction used when a secondary provider is acting as an in-thread consultant.
 * The consultant may inspect supplied context but must return advice rather than claim ownership of execution.
 */
export const CONSULT_SYSTEM_PROMPT = `You are a consulting model embedded inside another agent's active work thread.

Your role is advisory. Analyze the supplied task state, code, artifacts, constraints, and exact question. Return a concrete second opinion that the primary agent can evaluate and incorporate.

Rules:
- Do not take over the conversation or pretend to be the primary agent.
- Do not claim that you changed files, ran commands, contacted services, or completed work unless the execution environment actually did so and the evidence is visible.
- Prefer specific findings, failure modes, alternatives, and recommended next actions over generic guidance.
- Call out uncertainty, missing evidence, and disagreements with the apparent current approach.
- When reviewing code, identify exact symbols/paths and explain the consequence of each issue.
- When asked for a plan, distinguish required work from optional improvements.
- Avoid repeating the supplied context. Spend the response on analysis.
- End with a compact recommendation the primary agent can act on.`;

/**
 * System instruction used when a secondary provider owns execution of a delegated subtask.
 */
export const DELEGATE_SYSTEM_PROMPT = `You are a delegated execution agent working for a primary agent.

Own the bounded subtask described in the latest user message. Inspect the workspace, make the requested changes, run appropriate validation, and report evidence. Stay within the delegated scope and do not broaden the project without a concrete reason.

Rules:
- Work autonomously through ordinary implementation decisions.
- Preserve unrelated user changes.
- Prefer root-cause fixes over cosmetic workarounds.
- Run the most relevant tests or checks available.
- Report changed files, commands/checks run, results, remaining risks, and anything the primary agent must decide.
- Do not claim success without evidence.
- Do not ask the end user questions unless execution is genuinely blocked and no reasonable default exists.`;

/**
 * Add the policy instruction appropriate for a bridge mode without duplicating an identical instruction.
 * @param {Array<Record<string, any>>} messages Provider-neutral messages.
 * @param {"consult"|"integrated"|"delegate"} mode Bridge execution mode.
 * @returns {Array<Record<string, any>>}
 */
export function applyModePolicy(messages, mode) {
  const policy = mode === "consult" ? CONSULT_SYSTEM_PROMPT : mode === "delegate" ? DELEGATE_SYSTEM_PROMPT : undefined;
  if (!policy) return structuredClone(messages);
  const alreadyPresent = messages.some((message) => message.role === "system" && message.content === policy);
  return alreadyPresent ? structuredClone(messages) : [{ role: "system", content: policy }, ...structuredClone(messages)];
}

/**
 * Render provider-neutral messages into a stable text transcript for agent-harness and command adapters.
 * @param {Array<Record<string, any>>} messages Provider-neutral messages.
 * @param {{outputSummary?: Record<string, any>, providerId?: string, adapter?: string, purpose?: string, path?: string, replayCritical?: boolean}} [options] Render-only summary policy.
 * @returns {string}
 */
export function renderMessagesForAgent(messages, options = {}) {
  return messages.map((message) => {
    const role = String(message.role ?? "user").toUpperCase();
    const content = renderMessageContent(message, options);
    const sections = [`[${role}]`, content];
    if (message.reasoningContent !== undefined) {
      sections.push(`REASONING CONTENT\n${String(message.reasoningContent)}`);
    }
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      sections.push(`TOOL CALLS\n${message.toolCalls.map(renderToolCall).join("\n")}`);
    }
    if (message.toolCallId) sections.push(`TOOL CALL ID: ${message.toolCallId}`);
    const metadata = messageMetadata(message);
    if (Object.keys(metadata).length > 0) sections.push(`MESSAGE METADATA\n${safeJson(metadata)}`);
    return sections.filter(Boolean).join("\n");
  }).join("\n\n");
}

/** Summarize only successful tool-result/output content on the derived agent-facing view. */
function renderMessageContent(message, options) {
  const content = String(message.content ?? "");
  if (!isSuccessfulToolOutput(message)) return content;
  return summarizeRepetitiveOutput(content, {
    ...(options.outputSummary ?? {}),
    providerId: options.providerId,
    adapter: options.adapter,
    purpose: options.purpose ?? "agent-prompt",
    path: options.path,
    replayCritical: options.replayCritical === true,
  }).content;
}

/** Recognize only explicit successful tool output; errors always remain exact. */
function isSuccessfulToolOutput(message) {
  const role = String(message.role ?? "").toLowerCase();
  const type = String(message.type ?? "").toLowerCase();
  const status = String(message.status ?? "").toLowerCase();
  const toolOutput = role === "tool" || Boolean(message.toolCallId) || /tool[-_ ]?(result|output)/.test(type);
  const failed = message.isError === true || message.error !== undefined || message.errors !== undefined || ["error", "failed", "failure", "cancelled"].includes(status);
  return toolOutput && !failed;
}

/** Render tool calls in original array order while retaining raw string arguments verbatim. */
function renderToolCall(call, index) {
  const rawArguments = typeof call?.arguments === "string"
    ? call.arguments
    : safeJson(call?.arguments ?? {});
  return [
    `TOOL CALL ${index + 1}`,
    `ID: ${String(call?.id ?? "")}`,
    `NAME: ${String(call?.name ?? "")}`,
    "RAW ARGUMENTS:",
    rawArguments,
  ].join("\n");
}

/** Retain all non-transcript fields as exact structured metadata in the derived render. */
function messageMetadata(message) {
  return Object.fromEntries(Object.entries(message).filter(([key, value]) => (
    !["role", "content", "reasoningContent", "toolCalls", "toolCallId"].includes(key)
    && value !== undefined
  )));
}

/** Serialize metadata without dropping Error fields or throwing on BigInt/cycles. */
function safeJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Error) {
      return {
        name: entry.name,
        message: entry.message,
        ...(entry.code === undefined ? {} : { code: entry.code }),
        ...(entry.status === undefined ? {} : { status: entry.status }),
      };
    }
    if (entry && typeof entry === "object") {
      if (seen.has(entry)) return "[Circular]";
      seen.add(entry);
    }
    return entry;
  });
}
