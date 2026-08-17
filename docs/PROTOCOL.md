# Protocol reference

## HTTP endpoints

Default base URL:

```text
http://127.0.0.1:8743
```

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` or `/v1/health` | Count-only service status. |
| `GET` | `/v1/models` | OpenAI-shaped routed model list. |
| `GET` | `/v1/bridge/providers` | Provider capabilities and discovered/configured models. |
| `POST` | `/v1/responses` | Buffered or SSE Responses request. |
| `POST` | `/v1/consult` | Convenience advisory call. |
| `POST` | `/v1/delegate` | Convenience delegated execution call. |
| `OPTIONS` | any path | CORS preflight for explicitly allowed origins. |

## Authentication

Bearer header:

```http
Authorization: Bearer <value of server.authTokenEnv>
```

A non-browser loopback client can omit it only if `allowUnauthenticatedLoopback` is true. Browser-origin behavior is described in `SECURITY.md`.

## Model routing

Preferred model ID:

```text
<mode>/<provider>/<upstream-model>
```

The upstream model portion may itself contain `/`; everything after the first two path segments is retained.

Alternate route controls in `metadata`:

| Field | Meaning |
|---|---|
| `bridge_mode` | `consult`, `integrated`, or `delegate`. |
| `bridge_provider` | Configured provider ID. |
| `bridge_thread_id` | Stable bridge thread label. |
| `bridge_workspace` | Workspace path supplied to provider adapters. |
| `cwd` | Alias/fallback for workspace. |
| `bridge_no_default_workspace` | Prevent fallback to the bridge process working directory. |
| `bridge_timeout_ms` | Positive per-call provider timeout. |
| `bridge_expose_reasoning` | Emit visible reasoning summary events/output for this request. |
| `bridge_profile` | Provider task profile, currently used by managed workers. |
| `bridge_reasoning_effort` | Explicit provider effort override such as `low`, `medium`, or `high`. |
| `bridge_max_turns` | Finite managed-worker turn cap. |
| `bridge_expected_turns` | Rolling-admission reservation for expected internal model turns. |
| `bridge_no_plan` | Managed-worker no-plan override. |
| `bridge_acceptance_commands` | Array of exact validation commands included in the worker task/evidence contract. |

Explicit metadata takes precedence over route segments. Missing values fall back to `defaults` and the provider's model.

## Responses request subset

The bridge accepts the common fields needed by Codex/custom providers:

- `model`
- `input` as string or item array
- `instructions`
- `stream`
- `previous_response_id`
- `tools`
- `tool_choice`
- `temperature`
- `max_output_tokens`
- `parallel_tool_calls`
- `metadata`
- common top-level fields that are retained in the terminal response object

Input item support:

- message items with roles/content;
- `function_call`;
- `function_call_output`;
- `computer_call_output` as a textual placeholder;
- inline tool calls on message items.

Unsupported image/file/binary content is converted to an explicit text placeholder. This avoids silently dropping the fact that media existed, but it is not native multimodal forwarding.

## Responses output

The terminal object is shaped as:

```json
{
  "id": "resp_...",
  "object": "response",
  "status": "completed",
  "model": "integrated/deepseek/deepseek-v4-pro",
  "output": [],
  "output_text": "...",
  "previous_response_id": null,
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "total_tokens": 0
  },
  "metadata": {
    "bridge_thread_id": "thread_...",
    "bridge_provider": "deepseek",
    "bridge_mode": "integrated",
    "bridge_upstream_model": "deepseek-v4-pro"
  }
}
```

The package aims at useful Codex compatibility, not full parity with every OpenAI Responses feature.


### Provider metadata extension

Adapters may attach nonstandard execution/accounting data to a terminal `done` event. Buffered Responses expose it under the namespaced top-level field `bridge_provider_metadata`; convenience CLI/MCP results expose `providerMetadata`.

Examples include Grok job/profile/turn/cost/Git evidence and raw xAI `cost_in_usd_ticks`. This is deliberately separate from standardized `usage`; clients must treat it as an optional bridge extension. Streaming lifecycle events do not currently define a separate provider-metadata delta event, but the terminal `response.completed` object contains the extension.

## SSE events

For `stream: true`, each frame includes both `event:` and JSON `data:`. The stream ends with `data: [DONE]` after a terminal event.

Lifecycle/events implemented:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`
- `response.reasoning_summary_part.done`
- `response.function_call_arguments.delta`
- `response.function_call_arguments.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`

Sequence numbers increase monotonically. Writes are backpressured. A comment keepalive is sent every 15 seconds while the response is open.

Reasoning deltas are retained internally but are visible only when `responses.exposeReasoning` or request metadata enables them.

## Continuation

### `previous_response_id`

Use for raw Responses continuation. The bridge loads the prior normalized transcript and appends new input. Unknown/expired IDs are rejected.

### Convenience `threadId`

`/v1/consult`, `/v1/delegate`, CLI, and MCP return a thread ID. Reuse it in `thread_id`/`threadId` to continue. Same-thread calls are serialized.

A thread ID alone does not automatically restore messages for an arbitrary manually constructed `/v1/responses` request. Use `previous_response_id` there.

## Convenience HTTP calls

Consult:

```json
{
  "question": "What race conditions remain?",
  "context": "Current design and observed evidence...",
  "artifacts": [
    {
      "label": "queue implementation",
      "path": "src/core/queue.mjs",
      "content": "..."
    }
  ],
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "thread_id": "thread_optional",
  "workspace": "/optional/path",
  "timeout_ms": 1800000,
  "profile": "diagnose",
  "reasoning_effort": "medium",
  "max_turns": 8,
  "expected_turns": 2,
  "no_plan": true,
  "acceptance_commands": ["npm test -- test/queue.test.mjs"]
}
```

Delegate uses the same fields; the built-in Cursor provider requires `workspace`.

Response:

```json
{
  "responseId": "resp_...",
  "threadId": "thread_...",
  "provider": "deepseek",
  "mode": "consult",
  "model": "deepseek-v4-pro",
  "text": "...",
  "usage": {},
  "providerMetadata": {},
  "response": {}
}
```

## Error envelope

HTTP:

```json
{
  "error": {
    "message": "...",
    "type": "stable_code",
    "code": "stable_code",
    "details": {}
  }
}
```

Common categories include invalid request/configuration, unsupported capability, provider errors, auth/origin failures, body limits, timeout, and unknown/expired continuation IDs.

## MCP

Transport: newline-delimited JSON-RPC 2.0 over stdio.  
Default protocol version: `2025-11-25`. The server returns an exact match for `2025-11-25`, `2025-06-18`, `2025-03-26`, or `2024-11-05`; unknown versions receive the latest implemented version so the client can accept or disconnect according to MCP negotiation rules.

Methods:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`
- `notifications/cancelled`

Tools:

### `consult`

Required:

- `question`

Optional:

- `context`
- `artifacts[]` with required `content` and optional `label`/`path`
- `system`
- `provider`
- `model`
- `thread_id`
- `workspace`
- `timeout_ms` from 1,000 to 7,200,000
- `profile`
- `reasoning_effort`
- `max_turns`
- `expected_turns`
- `no_plan`
- `acceptance_commands[]`

Annotations: read-only hint true, destructive false.

### `delegate`

Required:

- `question`
- `workspace`

Optional fields otherwise parallel Consult. Annotations mark it destructive.

### `bridge_status`

Returns count-only session/provider/config status.

### `bridge_models`

Returns provider capability records and routed models.

Successful tool results include MCP text content and `structuredContent` containing the full result object. Tool execution/validation failures are returned with `isError: true` and structured error details; JSON-RPC errors are reserved for protocol/method failures.

Cancellation notification:

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": {
    "requestId": 12,
    "reason": "user cancelled"
  }
}
```

The MCP dispatcher continues reading while tools run, so cancellation can reach an active provider request.

## Command provider protocol

Input:

- rendered transcript on stdin unless disabled;
- argument/environment placeholders;
- four `CURSOR_BRIDGE_*` environment variables.

Normalized JSONL output can use:

```jsonl
{"type":"status","status":"started"}
{"type":"reasoning-delta","delta":"..."}
{"type":"text-delta","delta":"..."}
{"type":"tool-call-delta","index":0,"id":"call_1","nameDelta":"read_file","argumentsDelta":"{\"path\":"}
{"type":"usage","usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120}}
{"type":"done","finishReason":"stop","message":{"role":"assistant","content":"..."}}
```

The command adapter can set `inheritEnv: false` with an explicit `envAllowlist`, and it terminates descendant process trees on abort/timeout where supported.

The shorthand below is translated to `text-delta`:

```json
{"type":"text","text":"fragment"}
```

Malformed JSON, nonzero exit, timeout, output overflow, and abort become provider errors.
