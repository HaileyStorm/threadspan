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
 * @returns {string}
 */
export function renderMessagesForAgent(messages) {
  return messages.map((message) => {
    const role = String(message.role ?? "user").toUpperCase();
    const sections = [`[${role}]`, String(message.content ?? "")];
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      sections.push(`TOOL CALLS\n${message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments ?? {})}) [${call.id}]`).join("\n")}`);
    }
    if (message.toolCallId) sections.push(`TOOL CALL ID: ${message.toolCallId}`);
    return sections.filter(Boolean).join("\n");
  }).join("\n\n");
}
