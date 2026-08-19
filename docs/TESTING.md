# Testing and validation

## Offline verification

Run:

```bash
npm run verify
```

This executes source syntax checks and Node's built-in test runner over `test/*.test.mjs`.

Current 0.6.0 Linux release-source result:

```text
npm run check: passed
752 tests
752 passed
0 failed
0 skipped
```

The suite uses local fakes, local HTTP servers, and isolated temporary paths. It makes no paid inference calls and does not certify provider credentials, subscription quota, current live models/events, native Windows behavior, Desktop integration, or end-to-end host acceptance.

## Coverage map

| Area | Covered behavior |
|---|---|
| Configuration | JSONC comments/trailing commas, environment expansion, deep merge, invalid server/provider/mode/command/Grok policy settings, token-source separation, single-alternate normalization, and static starter-config parity. |
| CLI | GNU-style parsing, repeated options, POSIX PATH lookup, Windows PATHEXT lookup, and human/JSON continuity-id output. |
| Codex config | Responses wire API, profiles, MCP stanza, marker replacement, backup, atomic install/uninstall. |
| Routing | Mode/provider/model route parsing, defaults, capability errors, dynamic adapter registration, isolated account state, native Codex exact usage-limit fallback, OpenAI-compatible pre-output HTTP 429 fallback, one same-provider alternate before compatible cross-provider takeover, and explicit-route preservation. |
| Responses | Text lifecycle, reasoning visibility, function-call events, terminal object, continuation linkage, and bounded opt-in body logs. |
| OpenAI-compatible provider | SSE parsing, text/reasoning/tool calls/usage, streaming-unsupported buffered retry, safe error shaping, pre-output HTTP 429 account fallback, single-alternate enforcement, and split CRLF framing. |
| Continuity/takeover | Opaque task trees, closed HTTP/browser projection, source-bound App Server receipt validation, cooperative process-shared claim/revision conflict races, non-replayable indeterminate dispatch, schema migration, exact worker/rw successor and predecessor fencing, Goal-free/objective/status/accounting parity, owner-only controls, externally monitored liveness, deduplicated account-first replacement, exact-reset cancellation, maximum-utilization protection, staggered child recovery, and restart replay. |
| DeepSeek | Thinking controls and required reasoning/content replay. |
| Command provider | JSON/JSONL normalization, substitutions, timeout, malformed output, missing executable errors, environment allowlisting, and managed process-tree behavior. |
| HTTP | Health/models, buffered/streaming Responses, auth/origin policy, CORS preflight, connector-only `/mcp`, owner-token rejection, legacy remote-route failure, and snake_case managed-worker control normalization. |
| MCP | Version negotiation, initialization/list/call, tool-error results, concurrent dispatch, and in-flight cancellation. |
| Threads/queues | Same-thread ordering, unrelated concurrency, abort-safe queue behavior. |
| Cursor adapter | Integrated rejection, simultaneous Delegate creation dedupe, queued Delegate cancellation/overtake prevention. |
| Hermes blocker/reverse | Raw Nous remains Consult/Integrated and distinct; no full-agent provider route exists; host metadata records the source-bound-tool/configured-MCP blocker; reverse YAML allowlists status/models/accounts/Consult/Integrated only; installer remains staged and does not start, sign in, or merge native config. |
| Snapshots | Copy/exclusions, canonical symlink confinement and snapshot-local rewriting, byte limit, cleanup after failed copy, and pattern behavior. |
| Grok Build | Non-consuming executable/version/hash preflight, model/usage/error parsing, finite safety argv, profiles/overrides, snapshot Consult, quota failure/no retry, Integrated rejection, and opt-in Delegate exploration classification with trusted top-level fields, exact session echo, workspace-keyed serialization, and one same-session patch/test recovery. |
| Managed workers | Weighted FIFO admission and expected/actual turn reconciliation, private run ledger/evidence, Git linked-worktree/branch/clean gates, and multi-skill installation. |
| xAI-compatible accounting | Reasoning usage plus exact `cost_in_usd_ticks` preservation as provider metadata. |
| Compatibility Watch | Exact N→N+1 artifact/version identities, retained N acceptance, separate attach/protocol/routing/provider/settings outcomes, manual/passive evidence rules, process-shared transition and repair-target claims, transition-bound preimages, truthful retry/rollback states, and sanitized actionable/diagnostic HUD projection. Linux/Windows plans are synthetic unless run natively. |
| Electron HUD bootstrap | Exact single-target discovery, source-bound acknowledgement, per-generation capability privacy, session-HMAC/sequence/action replay rejection, bounded pre-auth connections/frame queues/results/backpressure, process-shared whole-host admission, cooperative transaction/CAS phases, indeterminate no-replay, exact persisted-port refusal/reappearance, transactional injection failure cleanup, multi-window/navigation HUD cleanup, resumable teardown, route-action schema, launch-vs-attach non-disturbance, dead-generation recovery, exact package/`app.asar` immutability, rollback→relaunch, and synthetic Linux/Windows endpoint semantics. Native app/ACL evidence remains separate. |

## Why offline fakes are not enough

Fast-moving external SDKs and clients can change:

- event names/shapes;
- authentication/entitlement behavior;
- model IDs;
- local transport requirements;
- function-call semantics;
- retry behavior;
- client tolerance for Responses fields/events;
- Windows process lifecycle.

Live smoke tests are therefore a separate release gate, not hidden inside the default unit suite.

## Live smoke matrix

Use disposable repositories and low cost limits.

### Common bridge

- [ ] `doctor` succeeds without `--live`.
- [ ] `doctor --live` returns expected model endpoint status.
- [ ] HTTP bearer accepted and invalid bearer rejected.
- [ ] Browser preflight succeeds only for allowlisted origin.
- [ ] Buffered mock response succeeds.
- [ ] SSE client receives terminal event then `[DONE]`.
- [ ] Disconnect/cancel ends provider work.
- [ ] Process shutdown leaves no child/SDK process.

### Electron HUD bootstrap (run separately on each exact Linux/Windows build)

- [ ] Explicit canonical launch binds the expected executable, PID/start generation, and package/`app.asar` preimage.
- [ ] Exactly one Node target is acknowledged and the bootstrap inspector HTTP/WebSocket close after successor readiness.
- [ ] The authenticated supervisor attaches the sanitized HUD and route selection reads back through the owner daemon.
- [ ] Renderer navigation and largest-window replacement reattach once without stale/duplicate actions.
- [ ] Attach/service restart reconnects the exact generation but never launches, restarts, signals, focuses, or navigates Desktop.
- [ ] App update/restart without a reviewed bootstrap fails closed to daemon plus detachable sidecar.
- [ ] Native owner/ACL checks reject another local principal; Windows evidence is not inferred from Linux.
- [ ] Authenticated rollback removes only Threadspan state/supervisor, leaves the inspector closed, and preserves exact package/`app.asar` digests.

### Codex

- [ ] Managed config installs without altering unrelated TOML.
- [ ] Codex initializes the MCP server.
- [ ] Consult skill is discovered after restart.
- [ ] Skill invokes `consult` with a compact packet.
- [ ] Follow-up reuses `thread_id`.
- [ ] Integrated profile can call a trivial tool and submit output.
- [ ] Long SSE response does not trip client idle timeout.
- [ ] Current Desktop model/profile presentation documented accurately.

### Cursor Consult

- [ ] `@cursor/sdk` imports under Node 22.
- [ ] Current account can list or use configured model.
- [ ] Tiny repo Consult returns text.
- [ ] Source tree hash/status unchanged.
- [ ] Snapshot removed after success.
- [ ] Snapshot removed after provider error/cancel.
- [ ] Project-specific exclusions prevent secret/huge directory copy.

### Cursor Delegate

- [ ] Agent edits a disposable live repo.
- [ ] Focused test runs and output is captured in report.
- [ ] Same thread/model/workspace retains context.
- [ ] Two simultaneous first calls create one agent.
- [ ] Active cancellation ends send.
- [ ] Queued cancellation never sends.
- [ ] Idle/count eviction disposes agents.
- [ ] Bridge close disposes all retained agents.

### DeepSeek V4

- [ ] Non-tool Consult in thinking mode.
- [ ] Integrated tool request without `tool_choice` rejection.
- [ ] Function call → tool output → follow-up succeeds with reasoning replay.
- [ ] Streaming reasoning/text/tool chunks parse correctly.
- [ ] V4 Pro and Flash model IDs accepted.
- [ ] Rate-limit/5xx error maps cleanly.

### Hermes Agent forward recheck

- [ ] Confirm exact upstream source provides source-bound/narrowable ACP tool selection and exact exclusion of enabled native MCP servers from each session.
- [ ] Reconcile the official Host Integration and ACP Internals claims about process-restoration behavior for the exact Hermes version.
- [ ] Only after both gates pass, design adversarial offline coverage for authority, model/cwd/session binding, permissions, cancellation, malformed protocol, bounded lifecycle, and no-replay behavior.
- [ ] Repeat every runtime/process/path/permission gate independently on Linux and Windows. Success on one host does not certify the other.

### Grok Build

Keep this phase intentionally small and account-aware:

- [ ] `doctor` resolves the intended absolute executable and reports the reviewed version/hash.
- [ ] `models` returns the model list for the CLI's authenticated account.
- [ ] Settings → Usage confirms the expected Build entitlement and weekly reset/remaining percentage.
- [ ] Tiny low/medium/high effort canaries establish which values the installed model accepts; no silent fallback occurs.
- [ ] One tiny Consult runs over a disposable snapshot and leaves the source tree unchanged.
- [ ] One mechanical Delegate runs in a clean linked worktree on a non-canonical branch.
- [ ] `dontAsk` plus exact permission/sandbox policy denies an unapproved command without hanging.
- [ ] Default invocation keeps web/search and subagents enabled, still emits `--no-memory`, finite `--max-turns`, and no-auto-update; explicit opt-out calls add `--no-subagents` and/or `--disable-web-search`.
- [ ] Terminal JSON contains the expected text and available usage/model-call/cost fields.
- [ ] Quota/rate/entitlement error produces one terminal failure and no retry.
- [ ] With exploration recovery explicitly enabled, one canary emits adapter-owned `--session-id`, reserves final/test turns below the overall ceiling, and uses exactly one same-session `--resume` only after repeated structured plan/read activity leaves Git unchanged.
- [ ] Initial and recovery terminal envelopes both echo the exact adapter-bound session ID; omission, mismatch, or nested model-authored spoof fields fail closed.
- [ ] A changed worktree, missing structured activity, Consult request, ordinary successful finish, or failed recovery never produces another invocation; a recovery entitlement failure remains terminal with failed-attempt evidence hashes.
- [ ] Root/subdirectory/symlink aliases, Windows case aliases, and separate Grok adapter instances for one physical worktree serialize across Git-before through final Git-after; unrelated worktrees overlap and disabled/Consult requests do not enter that queue.
- [ ] The spawned child uses the canonical physical Git top-level for cwd, `--cwd`, and workspace environment; deterministically retargeting the admitted lexical symlink cannot escape that binding.
- [ ] Only one trusted nonzero initial max-turn terminal envelope from an enabled Delegate reaches classification; Consult, disabled Delegate, message-only failure, mixed authentication/credential/access-denied, expired token/API key, HTTP 401/402/403/429, insufficient quota/`RESOURCE_EXHAUSTED`, rate, insufficient funds/credits, billing/payment, subscription/entitlement diagnostics, malformed output, recovery nonzero, and ordinary process failures remain terminal. Bare issue numbers and assistant `output_text` discussions remain non-signals for valid envelopes.
- [ ] Managed-process failures record only prompt/stderr hashes available from that boundary and never expose raw stdout merely to claim a hash.
- [ ] Cancellation and timeout terminate the actual Grok process tree on Windows and Ubuntu.
- [ ] Admission values are re-canary-tested; six generic or nine fleet outer slots / 1.4-second spacing / 18 turns per minute are not assumed universal, and all coordinators demonstrably share one daemon/controller.
- [ ] The local ledger is reconciled with the provider usage surface after a meaningful batch.
- [ ] The coordinator inspects the full diff and independently reproduces every acceptance command.

### Direct xAI API

- [ ] Authenticated model is available to the API team; do not infer availability from the consumer CLI.
- [ ] Non-tool Consult succeeds with selected reasoning effort.
- [ ] Integrated function call → host tool output → follow-up succeeds.
- [ ] Reasoning token usage and exact cost ticks appear when returned.
- [ ] API 429/limits map cleanly and local budget policy stops before the configured ceiling.

### Nous Portal

- [ ] `hermes portal` login complete.
- [ ] `hermes proxy start` listens on `127.0.0.1:8645/v1`.
- [ ] `/models` or configured fallback behaves as expected.
- [ ] Buffered and streaming Consult.
- [ ] Integrated tool call if the selected model supports function calling.
- [ ] Bridge cannot accidentally expose the proxy to LAN.
- [ ] Usage/rate limits visible at Portal and understood.

### Windows native

- [ ] `npm install` and `npm run verify` in PowerShell.
- [ ] Config init path and file permissions/ACL behavior.
- [ ] `doctor` finds `.EXE`/`.CMD` commands through PATHEXT.
- [ ] HTTP daemon starts/stops cleanly.
- [ ] MCP stdio works from Codex/Cursor.
- [ ] Command timeout kills process tree sufficiently for chosen CLI.
- [ ] Cursor SDK process cleanup verified.
- [ ] Paths containing spaces and non-ASCII characters.

## Cost controls for live tests

- Use tiny repositories.
- Set strict task scope and provider timeout.
- Configure a cheap/fast model first.
- For Grok Build, use one worker first, then measured three/six-worker canaries behind the same admission queue.
- Avoid repeated model discovery where a configured model list is sufficient.
- Test one streaming/tool round trip before long conversations.
- Record provider/model/version/date and approximate usage.

## Adding tests

- Use local HTTP servers or fake SDK objects.
- Test the failure or race, not only output text.
- Keep default tests deterministic and under a few seconds.
- Ensure timers are cleared/unref'd and streams/processes close.
- For concurrency bugs, prove ordering with deferred promises rather than sleeps where possible.
- For protocol tests, validate complete frame/order/terminal behavior.
