# Managed provider workers

A managed worker is a provider-owned coding agent invoked for one bounded assignment while the primary coordinator retains scope, acceptance, and integration authority. Grok Build is the first dedicated implementation; Cursor Delegate and carefully configured command adapters share parts of the same operating model.

## Appropriate tasks

Prefer work that is narrow and independently verifiable:

- deterministic unit or characterization tests;
- one component with an exact contract;
- mechanical migrations/refactors;
- focused bug reproduction and repair;
- source-only validators, adapters, fixtures, or documentation;
- static audits with no write authority;
- parallel tasks in genuinely non-overlapping worktrees.

Do not make a worker the sole authority for broad architecture, security-critical design, ambiguous product requirements, irreversible operations, protected-data discovery, or final visual/subjective acceptance.

## Authoritative task packet

Every Delegate request should define:

1. one concrete outcome;
2. exact base commit, branch, and isolated worktree;
3. allowed files/components and explicit non-goals;
4. compatibility, dependency, security, performance, and style constraints;
5. exact acceptance commands;
6. required evidence: changed files, commands/results, remaining risks;
7. finite provider profile/effort/turn/wall-time budget.

The packaged `skills/managed-worker/references/task-packet.md` contains a compact template.

## Safety envelope

- Never give two workers the same writable checkout.
- Prefer a clean linked Git worktree on a non-canonical branch.
- Use structured argv with no shell.
- Deny unneeded tools, network, credentials, browser profiles, package installation, integration commands, and external paths.
- Keep cross-session memory disabled by default. This package allows Grok nested subagents and web/search by default under the operator's policy; nested work inherits the parent boundary, and web content is treated as untrusted evidence. Explicitly disable either when it adds no value.
- Bound active jobs, start rate, model-turn budget, output, and wall time.
- Terminate descendant processes on abort/timeout/shutdown.
- Record durable lifecycle, usage, process, Git, and evidence data.
- Do not automatically retry quota, entitlement, malformed-output, or worker failure.

Provider-specific permissions and the operating-system sandbox are separate layers. Configure both.

## Acceptance

A worker's terminal JSON and prose are claims. The primary must independently:

- verify provider/model/profile and workspace identity;
- inspect the full diff and changed paths;
- check for credentials and unexpected artifacts;
- rerun every acceptance command;
- add discriminating/adversarial tests where warranted;
- verify no push/merge/rebase/tag/release/canonical-branch action occurred;
- accept, reject, or issue one bounded correction through the normal reviewed workflow.

The packaged `managed-worker` skill encodes this flow for Codex/Cursor agents.

## Provider-neutral future work

The bridge's shared primitives—managed process trees, weighted admission, run ledgers, task metadata, and Git policy—are intentionally reusable. A future official coding CLI can receive a dedicated adapter without changing the mode model or weakening existing providers. ACP/persistent sessions should be added only when mid-job steering/resume materially outweighs their protocol and state complexity.


## Shared-daemon fleet

Every ChatGPT/Codex coordinator and its subagents should use an MCP shim that forwards to the same bridge daemon. The daemon—not the number of Desktop processes—is the owner of provider admission, queues, ledgers, thread state, and retained Cursor Delegate agents.

The included fleet preset permits nine outer Grok jobs while retaining one 18-unit rolling admission budget and 1.4-second launch spacing. Nested Grok subagents live inside an admitted outer job; they must not be counted as independent authority or used to evade outer-job admission. Provider terminal accounting is reconciled when available.

Set `coordinator_id` and `worker_group` on calls. Give every writable outer job its own linked worktree. Nested agents may share only their parent's worktree and exact assignment boundary.
