# Modes and use cases

## Decision rule

Use the smallest mode that gives the second provider the authority it actually needs.

```text
Do you want advice, critique, or an independent judgment?
  └─ Yes → Consult

Do you want the secondary model to be the active reasoning model while your current client owns tools?
  └─ Yes → Integrated

Do you want the secondary provider's own agent to inspect/edit/run autonomously?
  └─ Yes → Delegate
```

Do not choose Delegate merely because the task is difficult. Choose it when provider-owned execution is useful. Do not choose Integrated for Cursor SDK or Grok Build, because those surfaces already own agent harnesses. Use a raw API/provider route when the host must own tools.

## Consult

### Strong use cases

- **Architecture review:** ask a second model to challenge service boundaries, invariants, scaling assumptions, or data consistency.
- **Debugging adversary:** provide the failing behavior, current hypothesis, key code, and test evidence; request alternative root causes and discriminating tests.
- **Patch review before execution:** ask for correctness, security, concurrency, compatibility, or maintainability defects while the primary retains the edit loop.
- **Plan critique:** identify missing work, unnecessary work, sequencing errors, and unverifiable acceptance criteria.
- **Cross-model adjudication:** present two proposed approaches and ask for a reasoned comparison rather than another fresh plan.
- **Research interpretation:** ask a model with different strengths to examine implications or edge cases after the primary has gathered sources.
- **Risk review:** migrations, destructive operations, auth changes, state-machine changes, money/cost-bearing calls, or difficult rollback.
- **Creative/UX divergence:** generate a deliberately independent perspective without surrendering the active project thread.

### Consult packet

A useful packet contains:

1. the exact question;
2. the current approach or hypothesis;
3. the evidence already observed;
4. constraints and non-goals;
5. the smallest relevant artifacts;
6. what kind of answer is useful: findings, decision, test plan, red-team review, etc.

Avoid pasting an entire long thread when a compact state summary and selected artifacts are enough. A consultant should spend tokens analyzing, not reconstructing what matters.

### Follow-up behavior

Reuse the returned `threadId` when:

- asking the consultant to reconsider after new evidence;
- challenging one of its claims;
- comparing its recommendation to an implementation result;
- requesting a narrower second pass.

Start a new thread when the topic, assumptions, provider, or desired independent perspective changes materially.

### Cases where Consult is a poor fit

- The answer is a simple fact better obtained from docs/search.
- The primary lacks enough evidence to ask a meaningful question.
- The task requires edits and tests that the secondary should own.
- The same model has already been consulted repeatedly and is merely rephrasing itself.
- Confidential files should not leave the primary environment. A Cursor snapshot still sends copied content through Cursor's runtime.

## Integrated

### Strong use cases

- Run Codex's established tools/approval model with a different raw model.
- Compare DeepSeek V4 and a Nous Portal model under the same file/shell/MCP harness.
- Preserve one client-side policy boundary while swapping reasoning providers.
- Use a subscription proxy where API credentials are managed externally but the endpoint is OpenAI-compatible.
- Evaluate provider quality without also changing agent harness behavior.

### Tool-loop implications

The client must:

- expose tool schemas;
- execute requested calls;
- submit tool results with original call IDs;
- preserve any reasoning fields the provider requires;
- decide approvals and sandbox policy;
- stop loops and enforce budgets.

The bridge translates but does not run Integrated tools. This is important for both security and architectural clarity.

### Cases where Integrated is a poor fit

- The provider only offers a full agent SDK, not raw inference.
- You specifically want the provider's indexing, skills, memory, subagents, or execution behavior.
- The upstream Chat Completions endpoint does not support function calls reliably.
- Tool-call latency/cost makes the chosen provider unsuitable for an iterative coding loop.

## Delegate

### Strong use cases

- Implement a bounded feature or bug fix in a workspace.
- Run a contained migration with explicit acceptance criteria.
- Investigate a failure by reading code, running tests, and returning evidence.
- Generate or update tests after the primary has specified behavior.
- Offload a parallel subtask whose diff can be reviewed independently.
- Use a provider's own codebase indexing, MCP, hooks, skills, or subagents.

### Good delegation boundary

A Delegate request should specify:

- exact workspace;
- bounded objective;
- acceptance criteria;
- allowed and forbidden scope;
- relevant existing decisions;
- validation commands or expected evidence;
- whether commits/branches are permitted.

### Cases where Delegate is a poor fit

- The task is advisory only.
- The workspace contains unrelated fragile changes and cannot be snapshotted/branched safely.
- The provider's agent permissions are broader than the task justifies.
- The primary cannot review the resulting diff or evidence.
- The task depends heavily on context that cannot be transferred reliably.

## Fine-grained scenarios

### “Review this proposed fix, then I will implement it”

Use Consult. Supply the failing test, the proposed change, and the invariant it must preserve.

### “Use DeepSeek as the model in Codex, with Codex still reading and editing files”

Use Integrated through `integrated/deepseek/<model>`.

### “Let Cursor Ultra inspect the repo and implement the accepted change”

Use Delegate with a live workspace.

### “Ask Cursor Ultra to inspect the repo but do not risk edits”

Use Consult with a workspace. The bridge copies the workspace and runs Cursor over the copy. This prevents source-tree mutation but does not make Cursor itself read-only.

### “Ask Nous Portal for a second opinion using my subscription”

Run `hermes proxy start`, configure the `nous` adapter, and use Consult. No Hermes tools/memory are involved; it is raw model inference through the credential-attaching proxy.

### “Use the full Hermes agent as a delegated worker”

Not built in. Configure a command provider around a stable Hermes CLI/API invocation or add a dedicated adapter. Do not label the raw subscription proxy as Delegate.

### “Have two consultants argue”

Use two independent Consult threads/providers. Give the second the first recommendation only if adjudication is desired; otherwise keep them blind for genuine independence. Ask the primary to synthesize and verify both.

### “Automatically Consult on every task”

Usually wasteful. Trigger on uncertainty, meaningful risk, difficult diagnosis, irreversible decisions, or expected model complementarity. The included skill encodes a selective trigger rather than mandatory double inference.

## Managed coding workers

Provider-owned coding CLIs belong in Consult or Delegate according to authority, not according to model quality.

### “Ask Grok Build to inspect this failure but keep my current agent in charge”

Use **Consult**. Supply a compact thread packet and optional workspace. The bridge runs one finite job over a disposable copy and returns advice; the primary decides what to believe and whether to edit.

### “Give Grok Build a small implementation task”

Use **Delegate** only after creating a dedicated clean linked worktree. Supply exact scope, non-goals, constraints, finite profile/effort/turn/time budget, and acceptance commands. The worker may edit/test in that worktree but cannot accept, merge, push, or release its own work.

### “Use Grok as Codex's active model while Codex owns tools”

Use **Integrated** through a direct xAI API `openai-chat` provider, not the Grok Build CLI adapter. Grok Build's agent harness owns its own execution loop and is deliberately rejected as Integrated.

### “Run several Grok workers in parallel”

Use genuinely non-overlapping worktrees and one shared provider admission queue. Process count is not the controlling resource: active model jobs, cold-start spacing, rolling model turns, subscription reserve, and independent review capacity all matter. The packaged admission defaults are configurable canary values, not service guarantees.

### “Trust the worker because its JSON says tests passed”

Do not. Inspect the complete diff and repository state, then reproduce acceptance commands under coordinator authority. Use the packaged `managed-worker` skill and [MANAGED-WORKERS.md](MANAGED-WORKERS.md).
