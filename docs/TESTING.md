# Testing and validation

## Offline verification

Run:

```bash
npm run verify
```

This executes source syntax checks and Node's built-in test runner over `test/*.test.mjs`.

Current result in the delivery environment:

```text
86 tests passed
0 failed
```

No test requires network access, provider credentials, subscription quota, or a real Cursor SDK process.

## Coverage map

| Area | Covered behavior |
|---|---|
| Configuration | JSONC comments/trailing commas, environment expansion, deep merge, invalid server/provider/mode/command/Grok policy settings, and static starter-config parity. |
| CLI | GNU-style parsing, repeated options, POSIX PATH lookup, Windows PATHEXT lookup, and human/JSON continuity-id output. |
| Codex config | Responses wire API, profiles, MCP stanza, marker replacement, backup, atomic install/uninstall. |
| Routing | Mode/provider/model route parsing, defaults, capability errors, dynamic adapter registration. |
| Responses | Text lifecycle, reasoning visibility, function-call events, terminal object, continuation linkage, and bounded opt-in body logs. |
| OpenAI-compatible provider | SSE parsing, text/reasoning/tool calls/usage, buffered fallback before output, split CRLF framing. |
| DeepSeek | Thinking controls and required reasoning/content replay. |
| Command provider | JSON/JSONL normalization, substitutions, timeout, malformed output, missing executable errors, environment allowlisting, and managed process-tree behavior. |
| HTTP | Health/models, buffered/streaming Responses, auth/origin policy, CORS preflight, and snake_case managed-worker control normalization. |
| MCP | Version negotiation, initialization/list/call, tool-error results, concurrent dispatch, and in-flight cancellation. |
| Threads/queues | Same-thread ordering, unrelated concurrency, abort-safe queue behavior. |
| Cursor adapter | Integrated rejection, simultaneous Delegate creation dedupe, queued Delegate cancellation/overtake prevention. |
| Snapshots | Copy/exclusions, canonical symlink confinement and snapshot-local rewriting, byte limit, cleanup after failed copy, and pattern behavior. |
| Grok Build | Non-consuming executable/version/hash preflight, model/usage/error parsing, finite safety argv, profiles/overrides, snapshot Consult, quota failure/no retry, and Integrated rejection. |
| Managed workers | Weighted FIFO admission and expected/actual turn reconciliation, private run ledger/evidence, Git linked-worktree/branch/clean gates, and multi-skill installation. |
| xAI-compatible accounting | Reasoning usage plus exact `cost_in_usd_ticks` preservation as provider metadata. |

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

## Changed-area checks for 0.2.1

**39/39 focused checks pass.** The focused set runs the six changed provider/orchestration suites plus the restored convenience-HTTP normalization regression.

- Grok policy defaults permit subagents and web/search; explicit provider, mode, and request opt-outs win without silent fallback.
- Fleet identity reaches task packets, provider metadata, and ledger records.
- MCP remote shims forward Consult/Delegate/status/providers/models to one authenticated daemon and preserve structured failures.
- Generated Codex configuration uses the shared daemon by default and retains an `--embedded-mcp` escape hatch.
- Provider runtime diagnostics expose counts/policy only, not prompts, source, credentials, or raw outputs.
- The nine-worker fleet example retains one rolling admission controller rather than multiplying limits per coordinator.

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
