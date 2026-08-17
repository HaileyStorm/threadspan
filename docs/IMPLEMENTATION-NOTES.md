# Implementation notes and initial unknowns

## What was known going in

The desired product behavior was clearer than the provider surfaces:

- “Direct” should become **Consult**.
- The prior overlapping Consult concept should disappear.
- A primary agent should be able to invoke Consult inside its existing thread.
- Integrated and Delegate should remain distinct.
- Cursor Ultra was the motivating provider, but the design should include Nous Portal, DeepSeek, and easy future adapters.
- The deliverable needed working code, not merely an architecture proposal.

## Important unknowns going in

1. Whether Cursor exposed a raw model endpoint suitable for caller-owned tools.
2. Whether Cursor had a genuinely read-only SDK mode.
3. How much conversation state the SDK itself retained and whether local agents were durable.
4. How Codex custom providers currently represent models/profiles across CLI and Desktop.
5. Whether Nous Portal could be used through subscription auth without reimplementing OAuth.
6. DeepSeek V4's exact tool/thinking history requirements.
7. Whether MCP cancellation could be implemented safely without a framework dependency.
8. Windows process/path behavior for a provider bridge.

## Findings that changed the design

### Cursor is an agent provider, not an Integrated raw-model provider

The official SDK exposes agent creation, sends, streams, local/cloud runtimes, and the Cursor harness. That is useful for Consult and Delegate. It does not justify claiming that Codex owns Cursor's tool loop. The adapter therefore rejects Integrated explicitly.

### Cursor Consult needed a filesystem boundary

A policy prompt or `plan` label is not a hard security boundary. The practical solution was to copy the workspace, let Cursor inspect the copy, and dispose it. This gives a real source-tree mutation boundary while honestly documenting residual privacy/runtime risks.

### Nous Portal already had the right raw-inference auth bridge

Hermes Agent's subscription proxy performs OAuth credential attachment and exposes an OpenAI-compatible local endpoint. Reimplementing Portal auth would add fragility and risk. The built-in Nous adapter simply targets that proxy. Full Hermes agent execution remains a separate Delegate integration.

### DeepSeek V4 could not be treated as generic OpenAI Chat

Thinking mode has compatibility rules around `tool_choice`, ignored sampling fields, non-null assistant content, and mandatory `reasoning_content` replay after tool calls. A small dedicated adapter was warranted.

### MCP cancellation required concurrent dispatch

A simple sequential readline loop can parse requests, but it cannot read a cancellation notification while awaiting an active tool call. The server now dispatches requests concurrently, tracks controllers by JSON-RPC ID, and serializes only writes.

### Thread continuation needed preserved hidden state

Flattening prior turns to text loses function-call IDs/outputs and DeepSeek reasoning needed for future requests. The normalization layer now round-trips those structures.

## Defects found during implementation review

The review pass caught and fixed issues that would have survived a superficial demo:

- duplicate retained Cursor agents during simultaneous first Delegate calls;
- queued cancellation/overtake hazards;
- CORS preflight incorrectly blocked by bearer auth;
- allowed browser origins missing response CORS headers;
- SSE CRLF delimiters split across chunks;
- MCP cancellation impossible under serial dispatch;
- command timeout/executable diagnostics;
- a full-test discovery hang caused by fixture selection;
- snapshot path/exclusion behavior;
- duplicate terminal metadata key in the Responses compact result.

Regression tests were added for the material cases.

## Design tradeoffs

### No framework-heavy server

Node's HTTP/readline/child-process primitives keep installation small and make lifecycle behavior visible. This increases the amount of code the package owns, but the critical paths are tested.

### Chat Completions upstream, Responses downstream

Many subscription/local endpoints expose Chat Completions, while Codex custom providers require Responses. The bridge normalizes between them. This is narrower and more honest than claiming arbitrary API compatibility.

### In-memory state first

Persistence would add encryption, migration, cleanup, and corruption decisions. The initial implementation prioritizes correct live semantics and clearly states restart loss. Persistence is P1, not silently simulated.

### Explicit capabilities over probing/guessing

Configuration declares supported modes. This avoids accidentally giving a raw endpoint destructive Delegate semantics or calling an agent SDK Integrated. Future probes can supplement, not replace, explicit policy.

### One default bridge token

Adequate for loopback personal use, inadequate for multi-user deployment. The package does not blur those threat models.

## Honest current assessment

The core implementation is considerably beyond a scaffold and passes a meaningful offline test suite. The largest remaining uncertainty is external integration drift, not known missing core logic. Until live smoke tests are run, statements about exact Cursor account behavior, current Codex Desktop UX, Portal model availability, and provider event variants remain hypotheses supported by current documentation and inspected interfaces rather than demonstrated facts on the user's accounts.

## 0.2.0 findings-report merge

A separate Grok Build probe report arrived after the original bridge package. The merge deliberately preserved the existing mode model rather than reshaping everything around one CLI.

### What generalized cleanly

- Provider-owned coding CLIs need bounded task packets, isolated workspaces, finite turns/time, explicit tools/permissions/sandbox, durable accounting, and independent acceptance.
- One-shot headless JSON is a safer default than a long-lived ACP client for fully specified work.
- Process count is not a capacity model. Active model jobs, cold starts, rolling turns, quota state, and reviewer capacity require one admission queue.
- Cached-context tokens and reasoning tokens matter to local usage accounting.
- A CLI's cached identity/entitlement and current model list must be canaried rather than inferred from a browser session or receipt.
- Worker self-report must not become integration authority.

These became reusable core pieces: `WeightedAdmissionController`, `RunLedger`, managed process helpers, Git worktree policy, and the `managed-worker` skill.

### What remained Grok-specific

- The observed six overlapping workers, two starts/second, 21 requests/minute, current `grok-4.6` list, executable version/hash, and subscription behavior came from one account/client/time window.
- The starter uses the report's safer six-active, 1.4-second, 18-turn values as configurable canary defaults. The code does not label them service guarantees.
- Another machine's executable SHA-256 is never used as a universal pin. The local binary is resolved, inspected, optionally recorded, and optionally enforced.
- The consumer weekly percentage cannot be reconstructed from local CLI token records, so the package keeps that human/provider meter as an explicit operational dependency.

### Why Grok Build is not Integrated

The CLI is an agent harness with its own tools, permissions, sandbox, sessions, and execution loop. Treating it as Integrated would misstate who owns tool execution. The dedicated adapter therefore supports Consult and Delegate only. Direct xAI API access uses the existing raw OpenAI-compatible adapter for Consult/Integrated.

### Why acceptance commands are not auto-allowed

The task packet can carry exact commands, but the bridge does not automatically turn those strings into Grok permission patterns. Opaque shell strings can include chaining, aliases, or broad prefixes. Permission policy remains separately configured, while the coordinator independently reruns acceptance commands after inspecting the diff.

### Why admission reserves expected turns

The CLI reports actual model calls only at terminal output. Reserving expected turns before launch prevents a queue of nominally “one job” tasks from immediately oversubscribing the rolling model-turn budget. Reconciliation adjusts the same rolling record afterward; overages create temporary budget debt instead of being forgotten.

### Why raw ledger evidence is opt-in

Durable prompts/stdout/stderr are useful for forensics but can contain proprietary code, secrets, or model reasoning. The default ledger stores lifecycle/accounting plus hashes. Raw evidence requires an explicit configuration decision and private file permissions.
