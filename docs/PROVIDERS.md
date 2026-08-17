# Provider configuration

Provider entries live under `providers.<id>` in the JSONC configuration. The model route uses the configured ID, not the adapter name:

```text
<mode>/<provider-id>/<upstream-model-id>
```

Capabilities are explicit. A provider that does not list a mode rejects it even if the underlying endpoint might accept some request shape.

## Common fields

```jsonc
{
  "providers": {
    "example": {
      "adapter": "openai-chat",
      "enabled": true,
      "model": "model-id",
      "models": ["model-id", { "id": "another-model", "name": "Display name" }],
      "capabilities": ["consult", "integrated"],
      "timeoutMs": 1800000,
      "apiKeyEnv": "EXAMPLE_API_KEY"
    }
  }
}
```

- `adapter`: built-in adapter or registered custom adapter.
- `capabilities`: any of `consult`, `integrated`, `delegate` that the configured surface genuinely supports.
- `model`: default upstream model.
- `models`: optional configured model list. It avoids live discovery and can attach metadata.
- `apiKey` / `apiKeyEnv`: explicit credential or environment variable name. Prefer the environment.
- `timeoutMs`: provider/command default; an individual convenience call may override it.

## Cursor SDK

```jsonc
{
  "cursor-ultra": {
    "adapter": "cursor-sdk",
    "apiKeyEnv": "CURSOR_API_KEY",
    "model": "auto",
    "capabilities": ["consult", "delegate"],
    "consult": {
      "workspaceStrategy": "snapshot",
      "agentMode": "plan",
      "snapshotMaxBytes": 536870912,
      "snapshotMaxFiles": 100000,
      "copyInternalSymlinks": false,
      "exclude": [
        ".git",
        "node_modules",
        ".venv",
        "dist",
        "build",
        ".next",
        "target"
      ]
    },
    "delegate": {
      "agentMode": "agent",
      "agentTtlMs": 1800000,
      "maxAgents": 8,
      "includeToolStatus": false
    },
    "local": {
      "settingSources": [],
      "sandboxEnabled": true,
      "autoReview": false
    }
  }
}
```

Behavior:

- SDK loaded dynamically only when needed.
- Model list is requested through Cursor when possible; configured fallback remains available after discovery failure.
- Consult creates a temporary copy and a fresh SDK agent, sends one advisory turn, disposes both.
- Delegate requires `workspace`, creates or reuses a local SDK agent, and sends against the live path.
- Integrated is always unsupported because the SDK owns an agent harness rather than exposing a caller-owned raw model loop.

`local.sandboxEnabled` and `autoReview` are passed to the SDK where supported. They do not replace the bridge's own mode boundary.

### Snapshot exclusions

Exclusions match path segments and relative nested patterns. Symlinks are skipped by default. Enabling `copyInternalSymlinks` copies only links that resolve within the source root; external links remain skipped. Limits apply before a successful snapshot is returned, and failed destinations are removed.

## Grok Build managed worker

Use the dedicated `grok-build` adapter for the official Grok Build CLI:

```jsonc
{
  "grok-build": {
    "enabled": true,
    "adapter": "grok-build",
    "command": "~/.grok/bin/grok",
    "requireAbsoluteCommand": true,
    "versionPattern": "^grok\\s",
    "pin": { "recordSha256": true },
    "model": "grok-4.6",
    "discoverModels": true,
    "strictModelList": true,
    "capabilities": ["consult", "delegate"],
    "allowedEfforts": ["low", "medium", "high"],
    "maxTurnsCeiling": 24,
    "permissionMode": "dontAsk",
    "sandbox": "strict",
    "noAutoUpdate": true,
    "allowSubagents": true,
    "noMemory": true,
    "allowWebSearch": true,
    "inheritEnv": false,
    "envAllowlist": ["HOME", "USERPROFILE", "PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP"],
    "admission": {
      "maxActive": 6,
      "minStartIntervalMs": 1400,
      "maxUnitsPerWindow": 18,
      "windowMs": 60000
    },
    "ledger": { "enabled": true, "includeOutput": false },
    "consult": {
      "workspaceStrategy": "snapshot",
      "profile": "diagnose",
      "maxTurns": 8,
      "expectedTurns": 2,
      "allow": [],
      "deny": []
    },
    "delegate": {
      "profile": "balanced",
      "maxTurns": 16,
      "expectedTurns": 4,
      "requireGit": true,
      "requireLinkedWorktree": true,
      "requireCleanStart": true,
      "denyBranches": ["main", "master", "trunk"],
      "allow": [],
      "deny": []
    }
  }
}
```

Behavior:

- Consult runs one fresh finite CLI job over a disposable snapshot or empty temporary workspace.
- Delegate runs one fresh finite CLI job in the supplied workspace after configured Git/worktree gates.
- Integrated is always rejected because Grok Build owns an agent/tool loop.
- `doctor` resolves and inspects the executable without inference; version/hash policy can be warning-only or strict.
- `grok models` discovery is non-consuming and cached when `discoverModels` is enabled.
- Expected model turns are reserved before launch and reconciled to reported `model_calls`/`turns`.
- Terminal token classes, estimated cost, process identity, executable identity, Git summaries, and evidence hashes can be appended to a private JSONL ledger.
- Quota, entitlement, authentication, rate-limit, malformed-output, timeout, and worker failures are terminal; no implicit retry occurs.

Provider controls include `profiles`, `reasoningEffort`, `maxTurns`, `expectedTurns`, `noPlan`, `grokTools`, `disallowedTools`, `rules`, `allow`, `deny`, `permissionMode`, `sandbox`, `allowSubagents`, `noMemory`, `allowWebSearch` (legacy `noSubagents` / `disableWebSearch` opt-outs remain accepted), and optional `jsonSchema`/`resultSchema`.

The packaged admission values are calibration from one bounded report, not provider guarantees. See [GROK-BUILD.md](GROK-BUILD.md) and [MANAGED-WORKERS.md](MANAGED-WORKERS.md).

## Direct xAI API

Use the existing raw `openai-chat` adapter when the host should own the tool loop:

```jsonc
{
  "xai-api": {
    "enabled": true,
    "adapter": "openai-chat",
    "baseUrl": "https://api.x.ai/v1",
    "apiKeyEnv": "XAI_API_KEY",
    "model": "grok-4.6",
    "models": ["grok-4.6"],
    "capabilities": ["consult", "integrated"],
    "extraBody": { "reasoning_effort": "high" },
    "retryWithoutStreaming": false
  }
}
```

Use a model currently listed for the authenticated API team; the consumer CLI model list is not proof of API-team availability. The generic adapter preserves common reasoning/function-call fields and exposes `cost_in_usd_ticks` as provider metadata when returned.


## Grok Build CLI

The dedicated `grok-build` adapter treats the official CLI as a provider-owned coding worker. It supports Consult and Delegate, but never Integrated. Use the direct xAI API configuration below when the host must own tools.

```jsonc
{
  "grok-build": {
    "enabled": true,
    "adapter": "grok-build",
    "command": "~/.grok/bin/grok",
    "requireAbsoluteCommand": true,
    "versionPattern": "^grok\\s",
    "pin": { "recordSha256": true },
    "model": "grok-4.6",
    "models": ["grok-4.6"],
    "strictModelList": true,
    "capabilities": ["consult", "delegate"],
    "allowedEfforts": ["low", "medium", "high"],
    "maxTurnsCeiling": 24,
    "noAutoUpdate": true,
    "allowSubagents": true,
    "noMemory": true,
    "allowWebSearch": true,
    "inheritEnv": false,
    "envAllowlist": ["PATH", "PATHEXT", "HOME", "USERPROFILE", "TEMP", "TMP", "SystemRoot", "ComSpec"],
    "permissionMode": "dontAsk",
    "sandbox": "strict",
    "admission": {
      "maxActive": 6,
      "minStartIntervalMs": 1400,
      "maxUnitsPerWindow": 18,
      "windowMs": 60000
    },
    "ledger": { "enabled": true, "includeOutput": false },
    "consult": {
      "workspaceStrategy": "snapshot",
      "profile": "diagnose",
      "maxTurns": 8,
      "expectedTurns": 2,
      "noPlan": true,
      "allow": [],
      "deny": []
    },
    "delegate": {
      "profile": "balanced",
      "maxTurns": 16,
      "expectedTurns": 4,
      "requireGit": true,
      "requireLinkedWorktree": true,
      "requireCleanStart": true,
      "denyBranches": ["main", "master", "trunk"],
      "allow": [],
      "deny": []
    }
  }
}
```

Behavior:

- non-consuming executable/version/hash preflight;
- fresh finite `--single` job with machine-readable JSON output;
- explicit model, effort, turn cap, permissions, sandbox, tools, memory, web, and subagent policy;
- structured argv with no shell;
- snapshot-isolated Consult and optional linked-worktree gates for Delegate;
- weighted admission and terminal `model_calls`/`turns` reconciliation;
- private lifecycle/usage ledger and evidence hashes;
- process-tree cleanup;
- no automatic retry on quota, rate, entitlement, malformed-output, or worker failures.

The default 6-worker / 1.4-second / 18-unit policy is a configurable starting point derived from one bounded report, not a provider guarantee. The CLI's per-job token/cost records do not reproduce the compute-weighted consumer weekly percentage. See [GROK-BUILD.md](GROK-BUILD.md).

### Task overrides

Convenience API, CLI, and MCP support:

- `profile`;
- `reasoningEffort` / `reasoning_effort`;
- `maxTurns` / `max_turns`;
- `expectedTurns` / `expected_turns`;
- `noPlan` / `no_plan`;
- `acceptanceCommands` / `acceptance_commands`;
- `allowSubagents` / `allow_subagents`;
- `allowWebSearch` / `allow_web_search`;
- `coordinatorId` / `coordinator_id`;
- `workerGroup` / `worker_group`.

Acceptance commands are prompt/evidence contract data. They are not converted into permission allow rules.

## Nous Portal through Hermes subscription proxy

Start and authenticate Hermes according to its own documentation:

```bash
hermes portal
hermes proxy start
```

Configuration:

```jsonc
{
  "nous": {
    "adapter": "nous",
    "baseUrl": "http://127.0.0.1:8645/v1",
    "apiKey": "unused-proxy-attaches-real-creds",
    "model": "Hermes-4-70B",
    "models": ["Hermes-4-70B", "Hermes-4.3-36B", "Hermes-4-405B"],
    "capabilities": ["consult", "integrated"]
  }
}
```

The `nous` adapter is a thin preset over the generic Chat Completions adapter. Hermes' proxy:

- accepts an arbitrary non-empty bearer value;
- attaches/refreshed the real subscription credential;
- forwards Chat Completions bodies;
- preserves SSE;
- does **not** run the Hermes tool/memory/skill agent loop.

Keep the proxy on loopback. If exposed to a LAN, anyone who can reach it may consume the subscription unless another auth layer is added.

## DeepSeek V4

```jsonc
{
  "deepseek": {
    "adapter": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-v4-pro",
    "models": ["deepseek-v4-pro", "deepseek-v4-flash"],
    "capabilities": ["consult", "integrated"],
    "thinking": { "type": "enabled" },
    "reasoningEffort": "high"
  }
}
```

The adapter adds current V4 behavior:

- `thinking` and `reasoning_effort` are placed in the request body when configured;
- `tool_choice` is removed in thinking mode because V4 rejects it;
- sampling controls that have no effect in thinking mode are removed;
- assistant messages containing tool calls preserve `reasoning_content`;
- tool-call assistant messages get non-null `content`.

This compatibility matters only if the caller also preserves prior normalized messages. The bridge does so for `previous_response_id` and convenience thread continuation.

Use current V4 names. Legacy `deepseek-chat` and `deepseek-reasoner` were scheduled for discontinuation in July 2026 and should not be used in new configuration.

## Generic OpenAI-compatible Chat Completions

```jsonc
{
  "compatible": {
    "adapter": "openai-chat",
    "baseUrl": "http://127.0.0.1:8000/v1",
    "apiKeyEnv": "COMPATIBLE_API_KEY",
    "model": "my-model",
    "capabilities": ["consult", "integrated"],
    "streaming": true,
    "retryWithoutStreaming": true,
    "discoverModels": false,
    "developerAsSystem": false,
    "images": false,
    "headers": {
      "X-Custom-Header": "value"
    },
    "extraBody": {
      "reasoning_effort": "high"
    }
  }
}
```

The adapter supports:

- streaming and buffered completion;
- an automatic buffered retry only when streaming fails before meaningful output;
- common reasoning fields (`reasoning_content`, `reasoning`, `thinking`);
- streamed and buffered function calls;
- usage normalization;
- optional `/models` discovery.

Do not enable Delegate merely because an endpoint accepts Chat Completions. Delegate implies a provider-owned execution loop, not a raw model with function calling.

## Command-backed provider

```jsonc
{
  "external-agent": {
    "adapter": "command",
    "command": "external-agent",
    "args": [
      "--mode", "{mode}",
      "--model", "{model}",
      "--workspace", "{workspace}",
      "--thread", "{threadId}"
    ],
    "cwd": "workspace",
    "stdin": true,
    "outputFormat": "jsonl",
    "timeoutMs": 1800000,
    "maxOutputBytes": 16777216,
    "shell": false,
    "durableThreads": true,
    "tools": true,
    "capabilities": ["consult", "delegate"],
    "env": {
      "EXTERNAL_AGENT_PROFILE": "bridge-{mode}"
    }
  }
}
```

Template values in `args` and `env`:

- `{mode}`
- `{model}`
- `{workspace}`
- `{threadId}`

The rendered provider-neutral transcript is sent on stdin unless `stdin` is false. The process also receives:

- `CURSOR_BRIDGE_MODE`
- `CURSOR_BRIDGE_MODEL`
- `CURSOR_BRIDGE_THREAD_ID`
- `CURSOR_BRIDGE_WORKSPACE`

Output formats:

- `text`: stdout chunks become `text-delta` events.
- `json`: one terminal JSON value; common text fields are extracted.
- `jsonl`: one normalized provider event per line. `{"type":"text","text":"..."}` is accepted as shorthand.

The process is terminated on abort/timeout, output is bounded, stderr diagnostics are bounded, and descendant process trees are terminated with a graceful-then-forced sequence (`taskkill /T` on Windows, detached process-group signals on POSIX).

By default the process inherits the bridge environment for backward compatibility. Set `inheritEnv: false` plus `envAllowlist` to forward only reviewed variables. This is strongly recommended for provider CLIs that do not need the bridge's full credential environment.

Set `inheritEnv: false` plus an explicit `envAllowlist` when broad process-environment inheritance is unnecessary. Avoid `shell: true` unless the configured command itself requires trusted shell syntax; structured argv with `shell: false` is the safer default.

## Adding a custom adapter

```js
import { ProviderAdapter, registerProviderAdapter } from "cursor-codex-bridge";

class ExampleProvider extends ProviderAdapter {
  capabilities() {
    return {
      ...super.capabilities(),
      tools: true,
      durableThreads: false,
    };
  }

  /** Execute one provider-neutral request and yield normalized events. */
  async *run(request) {
    this.assertMode(request.mode);
    yield { type: "status", status: "started" };
    yield { type: "text-delta", delta: "example" };
    yield {
      type: "done",
      finishReason: "stop",
      message: { role: "assistant", content: "example" }
    };
  }
}

registerProviderAdapter("example", ExampleProvider);
```

A production adapter should also handle cancellation, transport errors, usage, cleanup, redaction, streaming frame boundaries, and provider-specific history requirements.
