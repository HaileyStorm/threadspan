---
name: consult
description: Ask a configured secondary model or agent for an advisory second opinion inside the current work thread. Use when independent analysis would materially improve a difficult design, debugging diagnosis, code/security/concurrency review, plan, consequential decision, or disputed conclusion. Do not use for routine facts, trivial tasks, or when the secondary should own file edits; use Delegate for provider-owned execution.
---

# Consult inside the current thread

Use the MCP tool `consult` to obtain independent advisory analysis while keeping the current agent responsible for judgment, tools, edits, validation, and the final response.

## Trigger selectively

Consult when at least one is true:

- material uncertainty remains after ordinary inspection;
- the decision is expensive, destructive, security-sensitive, concurrency-sensitive, or difficult to reverse;
- debugging has multiple plausible root causes or repeated failed fixes;
- a plan/architecture would benefit from adversarial review;
- another provider has meaningfully complementary strengths;
- the user explicitly asks for another model's view;
- two approaches or model conclusions need adjudication.

Do not Consult merely to create the appearance of rigor. Skip it when the answer is straightforward, evidence is missing, latency/cost outweighs likely value, or the user has asked not to use external providers.

## Preserve the active thread

Before calling the tool, construct a compact packet from the current thread:

1. **Exact question** — one clear review/decision target.
2. **Current approach or hypothesis** — what the primary currently believes or plans.
3. **Evidence** — observed behavior, tests, errors, measurements, source findings.
4. **Constraints/non-goals** — compatibility, scope, security, performance, cost.
5. **Artifacts** — only the smallest relevant excerpts.
6. **Requested answer shape** — findings, recommendation, discriminating tests, red-team review, etc.

Do not dump the entire transcript unless the full chronology is genuinely necessary. Resolve pronouns and implicit references so the consultant can understand the packet independently.

## Invoke Consult

Call `consult` with:

- `question`: the exact question;
- `context`: the compact task/thread state;
- `artifacts`: labeled excerpts where useful;
- `workspace`: current workspace only when the provider should inspect files;
- `provider` and `model`: only when the user chose them or a deliberate routing reason exists;
- `thread_id`: the prior returned ID for follow-ups on the same consultation topic;
- `timeout_ms`: only when the task needs a non-default bound.

For a new consultation, omit `thread_id`. Record the returned `threadId` in current task state.

## Follow up rather than restarting

Reuse the same consultant thread when:

- new evidence changes the analysis;
- challenging a specific recommendation;
- asking the consultant to compare its advice with an implementation/test result;
- narrowing an unresolved point.

Start a new consultant thread when the topic or assumptions change materially, or when an independent blind opinion is desired.

## Evaluate the answer

Treat the result as advisory evidence, not authority.

- Check claims against code, tests, docs, and tool output.
- Identify where it agrees or disagrees with the primary analysis.
- Reject generic or unsupported recommendations.
- Convert useful advice into concrete next actions or tests.
- Do not imply the consultant edited the primary workspace or ran validations unless its environment actually did so and provided evidence.
- Do not paste a long consultant answer to the user without synthesis unless the user requested the raw response.

## Mode boundary

- **Consult:** advice; primary retains execution.
- **Integrated:** external raw model is active; current client owns tools.
- **Delegate:** external agent owns bounded execution and may modify the live workspace.

Never silently substitute one mode for another. Cursor Consult may inspect a disposable workspace snapshot, but that remains Consult because its intended outcome is advice and the source workspace is not the execution target.

## Output after consulting

Continue the original task. Briefly incorporate:

- the strongest useful finding;
- any important disagreement/uncertainty;
- the verification performed;
- the resulting decision or next action.

Read `references/thread-packet.md` for packet examples and `references/consult-rubric.md` when judging response quality.
