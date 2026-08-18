# Architecture

## Design goals

The bridge exists to compose model subscriptions and agent harnesses without pretending that all provider integrations are equivalent. Its main architectural requirements are:

1. Preserve the distinction between advisory calls, raw-model calls, and provider-owned agent execution.
2. Give Codex and other callers one stable Responses/MCP surface while isolating provider quirks behind adapters.
3. Keep local deployment understandable: one Node process, no database, no mandatory framework, and no hidden cloud control plane.
4. Fail explicitly when a provider cannot support a requested mode.
5. Retain enough conversation state for tool-call and reasoning round trips without logging or persisting sensitive bodies by default.
6. Put cancellation, cleanup, ordering, and bounded resource use in the core rather than leaving them to every caller.

## Component map

```mermaid
flowchart LR
    C[Codex / ChatGPT / other Responses client] -->|HTTP /v1/responses| H[HTTP server]
    M[Codex / Cursor / other MCP client] -->|stdio JSON-RPC| S[MCP server]
    L[CLI user / script] --> Q[CLI]

    H --> B[BridgeService]
    S --> B
    Q --> B

    B --> R[ProviderRegistry]
    B --> T[SessionStore]
    B --> K[KeyedSerialQueue]
    B --> A[ResponsesAssembler]

    R --> CU[Cursor SDK adapter]
    R --> GB[Grok Build adapter]
    R --> DS[DeepSeek adapter]
    R --> NO[Nous proxy adapter]
    R --> OA[Generic OpenAI Chat adapter]
    R --> CP[Command adapter]

    CU --> W[Workspace snapshot manager]
    GB --> W
    GB --> GA[Weighted admission]
    GB --> GL[Worker ledger]
    GB --> GP[Managed process tree]
    GB --> GW[Git worktree policy]
    CU --> CS[@cursor/sdk]
    DS --> DAPI[DeepSeek API]
    NO --> HP[Hermes subscription proxy]
    OA --> API[Compatible /v1/chat/completions]
    CP --> PROC[Child process / external CLI]
```

## Request flow

### Responses request

1. `http-server.mjs` applies timeout, disconnect propagation, authentication/CORS policy, body size limits, and a FIFO concurrency gate.
2. `BridgeService.executeResponse()` validates the request and resolves a route from:
   - `model = <mode>/<provider>/<model>`;
   - optional `metadata.bridge_mode` and `metadata.bridge_provider` overrides;
   - configured defaults.
3. `input-normalizer.mjs` reconstructs provider-neutral messages, optionally from `previous_response_id` state.
4. `policies.mjs` inserts the Consult or Delegate system policy.
5. The selected adapter yields normalized provider events.
6. `ResponsesAssembler` turns those events into one consistent Responses object and, when streaming, ordered SSE lifecycle events.
7. Normalized transcript state is stored in memory for later response/thread continuation.

### MCP Consult/Delegate

1. The MCP server reads newline-delimited JSON-RPC messages.
2. Requests are dispatched concurrently rather than blocking the read loop, so `notifications/cancelled` can interrupt an active tool call.
3. Writes are serialized and backpressured to prevent interleaved JSON-RPC frames.
4. `consult` and `delegate` call the same `BridgeService` convenience methods used by HTTP and CLI.
5. The caller receives text plus `threadId`, `responseId`, provider, mode, model, usage, and the terminal Responses object.

## Mode boundaries

### Consult

- The secondary receives the current question and selected context.
- The primary agent retains ownership of decisions and execution.
- Tools are not forwarded through raw-model adapters.
- Cursor and Grok Build can inspect copied workspaces through their own harnesses, but the copies are disposed after the turn.
- Follow-ups can reuse a bridge thread ID; calls on that ID are serialized.

### Integrated

- The raw provider receives tool schemas and may emit function calls.
- The bridge translates calls but does not execute them.
- Codex or another client performs approval, execution, and tool-result submission.
- Provider reasoning and call linkage are retained when needed for valid subsequent requests.

### Delegate

- A provider-owned agent receives a bounded task.
- Cursor Delegate works on the supplied live workspace.
- Grok Build Delegate uses one fresh finite CLI job and can require a clean linked worktree, denied-branch policy, strict permissions/sandbox, and exact turn/profile limits.
- One retained SDK agent is keyed by `threadId + model + resolved workspace`.
- Sends to the same agent are serial; unrelated agents/threads can run concurrently.
- Idle and count limits bound retained Cursor agents. Grok Build remains fresh-session by design and is bounded by provider-local admission plus wall/turn limits.
- Provider-owned workers never receive merge/push/release or acceptance authority from the bridge.

## Provider-neutral event contract

Adapters yield objects with these event types:

| Event | Required data | Meaning |
|---|---|---|
| `status` | `status` | Non-content lifecycle information. |
| `warning` | `message` | Recoverable condition, such as buffered retry after an early stream failure. |
| `text-delta` | `delta` | Assistant text fragment. |
| `reasoning-delta` | `delta` | Provider reasoning fragment. Retained internally; emitted to clients only when enabled. |
| `tool-call-delta` | `index`, optional ID/name/argument deltas | Partial function call. |
| `usage` | normalized token counts | Usage update. |
| `done` | terminal message/finish reason/usage, optional provider metadata | Provider terminal state. |

The Responses assembler ignores provider-specific status/warning events for API output, while logs and direct adapters may use them diagnostically.

## State model

`SessionStore` holds two bounded maps:

- response ID → terminal response and normalized transcript linkage;
- bridge thread ID → normalized messages and route metadata.

Properties:

- in-memory only;
- TTL refreshed on access;
- oldest-updated eviction over the configured count;
- no headers, credentials, or raw transport frames stored;
- tool IDs, arguments, outputs, and hidden reasoning can remain in normalized messages because some providers require them for valid continuation.

This is sufficient for a personal local process but not durable or multi-process. SQLite/file journaling is a high-priority future feature.


### Provider worker ledger

Grok Build uses a separate append-only JSONL ledger for lifecycle, bounded process/Git identity, token classes, model calls/turns, estimated cost, and evidence hashes. Optional raw prompt/stdout/stderr evidence is stored only when explicitly enabled. This ledger survives process restarts, but it is not conversation state and cannot resume a bridge thread.

## Concurrency and cancellation

### HTTP request gate

`ConcurrencyGate` bounds simultaneous provider work. It is FIFO and abort-aware. An aborted queued request is removed rather than consuming a slot later.

### Convenience thread queue

`KeyedSerialQueue` serializes Consult/Delegate convenience calls by thread ID. This prevents simultaneous follow-ups from reading the same prior transcript and overwriting one another. Different thread IDs proceed independently.

### Cursor Delegate lock

Each retained Cursor agent has an abort-aware serial lock. Agent creation is also deduplicated by key, so simultaneous first calls cannot create and leak duplicate agents.


### Provider worker admission

`WeightedAdmissionController` is provider-local and FIFO. It can bound active jobs, cold-start spacing, starts per rolling window, and approximate expected model turns per rolling window. Grok reserves `expectedTurns` before launch and reconciles the record to terminal `model_calls`/`turns`. Overage becomes immediate rolling-window debt. These limits shape local dispatch; they are not an exact reconstruction of a provider subscription meter.

### Managed process trees

Grok, generic command, and Claude Code adapters launch structured argv without a shell by default. POSIX jobs run in a process group; Windows cleanup uses descendant-aware `taskkill`. Abort, timeout, output overflow, provider shutdown, early iterator return, failed startup, or a group leader exiting before its descendants triggers bounded graceful-then-forced cleanup. POSIX streaming wrappers reap the managed group after leader exit; Windows intentionally does not sweep an exited leader's PID because native Job Object ownership is not yet implemented and PID reuse must fail safe.

### MCP dispatcher

The read loop does not await tool completion. Active request controllers are addressable by JSON-RPC ID, allowing cancellation notifications to abort provider work. Response writes still remain ordered at the byte-stream boundary.

### Streaming backpressure

Both HTTP SSE and MCP output wait for `drain` when the kernel buffer fills. This prevents a fast provider from accumulating an unbounded write queue behind a slow client.

## Error model

Errors are normalized to `BridgeError` subclasses with:

- HTTP status;
- stable code;
- public message;
- optional details;
- retryability where relevant.

Buffered HTTP returns an OpenAI-style error envelope. Streaming sends `response.failed` when possible and then closes. MCP returns JSON-RPC errors with public bridge details. Debug details are printed by the CLI only when `CURSOR_BRIDGE_DEBUG=1`.

## Provider extension

Use a built-in configuration adapter first:

- `openai-chat` for OpenAI-compatible Chat Completions;
- `command` for a CLI/process boundary.

A custom adapter is justified when a provider needs:

- nonstandard authentication;
- request/response transformation;
- a durable agent lifecycle;
- provider-specific cancellation or resource cleanup;
- protocol behavior that cannot be expressed in `extraBody`/headers.

Applications embedding the package can call `registerProviderAdapter(name, Adapter)` before constructing `ProviderRegistry`. Tests demonstrate registration without modifying core routing.

## Files with highest semantic weight

- `src/bridge/service.mjs` — routing, continuity, mode orchestration.
- `src/bridge/responses.mjs` — Responses object/event compatibility.
- `src/providers/cursor-sdk.mjs` — snapshot Consult and retained Delegate lifecycle.
- `src/providers/openai-chat.mjs` — generic streaming/function-call translation.
- `src/providers/grok-build.mjs` — bounded worker profiles, preflight, admission, ledgering, workspace policy, and terminal accounting.
- `src/core/admission-controller.mjs` — rolling weighted provider admission.
- `src/core/managed-process.mjs` — descendant-aware process lifecycle.
- `src/core/run-ledger.mjs` — private append-only worker evidence/accounting.
- `src/workspace/git-workspace.mjs` — Delegate Git/worktree gates.
- `src/providers/deepseek.mjs` — V4 compatibility rules.
- `src/mcp/server.mjs` — concurrent/cancellable stdio JSON-RPC.
- `src/workspace/snapshot.mjs` — source-tree mutation boundary.
- `src/core/input-normalizer.mjs` — transcript and tool/reasoning round trips.
