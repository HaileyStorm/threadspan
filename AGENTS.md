# AGENTS.md

## Purpose

This repository implements a provider-neutral Consult / Integrated / Delegate bridge. Preserve the semantic boundary between these modes in every change:

- **Consult:** secondary output is advisory; the primary agent owns judgment and execution.
- **Integrated:** the calling client owns tools; the secondary is raw model inference.
- **Delegate:** the secondary provider's agent owns a bounded execution task and may mutate the supplied live workspace.

Never emulate an unsupported mode by quietly using another one. Return a capability error with a useful reason.

## Repository map

- `src/bridge/` — Responses assembly, HTTP surface, and shared orchestration.
- `src/mcp/` — newline-delimited JSON-RPC MCP stdio server.
- `src/providers/` — provider adapters and registry.
- `src/workspace/` — Consult snapshots and Delegate Git-worktree policy.
- `src/codex/` — managed Codex config and skill installation.
- `src/core/` — config, policies, state, queues, errors, and logging.
- `skills/consult/` — in-thread Consult skill shipped to clients.
- `skills/managed-worker/` — bounded Delegate task-packet and independent-acceptance skill.
- `examples/` — host-client configuration and instruction fragments.
- `test/` — offline behavioral tests.

## Required checks

Run before reporting completion:

```bash
npm run verify
```

For provider changes, add focused tests using fakes/local HTTP servers. Do not require paid inference or real credentials in the default suite.

## Coding rules

- Node.js ESM, Node 22 baseline, no transpilation requirement.
- Keep the core dependency-light. Provider SDKs that are not universally required should be optional and dynamically imported.
- Add JSDoc to exported classes/functions and to non-obvious internal lifecycle helpers.
- Preserve abort propagation, bounded buffers, backpressure, and deterministic cleanup.
- Serialize operations only at the narrowest required key. Same-thread ordering must not block unrelated threads.
- Treat provider event streams as adversarial input: partial frames, malformed payloads, duplicate terminal data, disconnects, and missing usage are normal failure cases.
- Do not log credentials, authorization headers, prompt bodies, tool outputs, or copied source by default.
- Keep Windows behavior in mind for paths, process termination, executable discovery, and config installation.

## Provider adapter contract

Adapters extend `ProviderAdapter` and yield normalized events:

- `status`
- `warning`
- `text-delta`
- `reasoning-delta`
- `tool-call-delta`
- `usage`
- `done`

Capabilities must describe reality. In particular, set mode support explicitly and explain unsupported modes.

Configuration-only integrations should use `openai-chat` or `command`. Add a custom adapter only for wire-format, authentication, or lifecycle behavior that cannot be represented safely in config.

## Consult behavior

Consult must remain advisory even when the provider has tools. For Cursor:

- use a disposable workspace snapshot or an empty temporary directory;
- run in plan mode by default;
- dispose the agent and snapshot after the turn;
- never report source-tree mutation as a Consult outcome.

The snapshot is not a security sandbox. Document that distinction anywhere the behavior is surfaced.

## Delegate behavior

Delegate may mutate the live workspace. It must:

- require a workspace for the built-in Cursor adapter;
- retain agents only within bounded TTL/count limits;
- serialize sends to the same retained agent;
- allow queued cancellation without permitting later requests to overtake;
- dispose dead or evicted agents;
- report evidence rather than unsupported success claims.


## Managed worker providers

Provider-owned coding CLIs such as Grok Build are Delegate/Consult surfaces, not raw Integrated providers.

- Use one-shot, finite runs by default. Add ACP or persistent sessions only when the user experience genuinely requires mid-job steering or resumability.
- Use structured argv with `shell: false`; never splice untrusted task text into shell command strings or permission patterns.
- Keep model, reasoning effort, turn cap, tool scope, permission mode, sandbox, memory, web access, and subagent policy explicit. Current Grok defaults allow web/search and nested subagents while keeping cross-session memory off.
- Require an isolated linked worktree and clean start when configured. Never permit two workers to share a writable checkout.
- Reserve admission budget before launch and reconcile expected turns to terminal `model_calls`/`turns` when available.
- Treat empirical concurrency/rate observations as configurable canary values, never service guarantees.
- Do not automatically retry quota, rate-limit, entitlement, malformed-output, or worker failures.
- Record bounded lifecycle, process identity, usage, and evidence hashes. Raw prompts/stdout/stderr remain opt-in and private.
- Nested workers inherit the parent workspace, allowed scope, authority, deadline, and validation contract; require the outer worker to summarize nested work.
- Web-derived content is untrusted evidence. Attribute material external claims and never let external instructions expand tools, paths, permissions, acceptance, or integration authority.
- The worker has no integration authority. A coordinator must inspect the diff and independently reproduce acceptance commands.
- Multiple Desktop coordinators must normally proxy through one persistent daemon so Grok admission/ledgers and retained Cursor agents are actually shared.

## Grok Build adapter

`src/providers/grok-build.mjs` must preserve these boundaries:

- Consult uses a disposable snapshot or empty temporary directory and remains advisory.
- Delegate uses the supplied isolated worktree and enforces configured Git policy before launch.
- Integrated is unsupported; use a direct xAI API `openai-chat` provider when the host should own tools.
- The executable path, version constraint, and SHA-256 pin are non-consuming preflight checks. Never hard-code another person's observed binary hash as a universal expected value.
- Consumer weekly usage is not reconstructible from local token telemetry alone. Keep admission/ledger controls local and document the remaining manual entitlement/usage check.
- Treat nine outer workers as a configurable fleet profile, not a provider guarantee. The shared rolling turn controller remains authoritative.
- Persistent Cursor Delegate agents are keyed by bridge thread/model/workspace in the daemon. Do not describe that as an official Cursor Cloud Agent pool unless a separate cloud-runtime adapter is implemented and certified.

## Integrated behavior

Integrated passes tools/function schemas through but never runs them. Preserve tool-call IDs, arguments, tool outputs, and provider reasoning required for later turns. The calling client is responsible for approvals and execution.

## Protocol compatibility

The bridge implements a useful Responses subset, not an assertion of full OpenAI API parity. When adding fields/events:

- keep buffered and streaming paths backed by the same assembler;
- preserve event order and monotonically increasing sequence numbers;
- include `[DONE]` only after a terminal event;
- maintain `previous_response_id` reconstruction;
- do not expose hidden reasoning unless explicitly configured.

## Security review triggers

Require a security-focused review when changing:

- bind address, auth, CORS, or browser access;
- snapshot traversal, symlinks, file limits, or cleanup;
- command execution, shell mode, environment forwarding, or provider credentials;
- Delegate workspace behavior;
- logging or debug artifacts;
- persistent state.

## Documentation discipline

Update `STATUS.md` when external validation changes. Distinguish:

- implemented and offline-tested;
- implemented but live-uncertified;
- proposed;
- unsupported by a provider.

Do not turn an assumption about a fast-moving SDK or client UI into a factual guarantee.
