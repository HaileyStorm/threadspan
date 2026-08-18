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

## Effective settings and ownership

Every provider description and completed response carries a digest-bound `effectiveSettings` report. Raw API adapters report `owner: "host"`: the calling host keeps tools, approvals, sandboxing, web, memory, and native user/project policy. Threadspan transports inference and never invents a parallel approval system.

Managed workers report provider ownership. Their default is still native inheritance: the selected provider profile's user settings compose with the supplied workspace's project settings. A bridge-required difference is listed under `divergences` with its source, scope, reason, value, reversal instruction, and report digest. Unknown or unmanaged project/user settings are preserved; any installer exclusion is visible with a reason and is included in the reviewed plan digest.

Authentication and execution policy are separate. An isolated account may select a different provider-native profile root without copying credentials or changing the current host profile. That isolation does not authorize hidden sandbox, approval, tool, web, memory, model-provider, or base-URL overrides.

## Bounded branching and brainstorming

`branching` is provider-neutral orchestration policy, not an automatic fan-out switch. A host should recognize brainstorming-worthy requests and branch only for independent evidence paths, genuinely divergent ideation, or disjoint writes whose decision value exceeds coordination cost. Candidate selection considers capability, live availability, quota, credit, privacy, latency, and diversity value while preserving explicit user/project routes and settings.

`maxBranches`, `maxTurnsPerBranch`, and optional `maxCostUsd` are hard planning bounds. Stop when findings converge, and retain one caller as final synthesis and acceptance owner. Tools and plugins are invoked only when decision-useful; for example, ImageGen is appropriate for materially divergent UI visual directions, not merely because it is installed. Threadspan exposes this policy through status and MCP guidance; the host that owns available tools performs recognition and invocation.

## Connection lifecycle and recovery

Provider discovery and completed responses expose separate provider, account, and transport health plus an adapter-specific lifecycle digest. A generic `unavailable` summary is diagnostic shorthand, never recovery authority. Failure evidence distinguishes pre-output authentication failure, pre-output transport failure, mid-turn provider failure, and parent-turn interruption.

`connectionRecovery` bounds reconnect, rebind, and handle-audit attempts but does not create a generic retry loop. Pre-output transport failures may use the adapter's bounded reconnect/rebind path. Authentication failures require truthful provider-native re-authentication outside Threadspan; Threadspan never asks for a credential value. Mid-turn failure preserves any resumable provider state and forbids automatic reroute. Any reroute still needs the existing same-account/provider, privacy, mode, side-effect, and authority gates.

Adapters own exact recovery and rollback. They must detect stale process/config bindings, report whether a handle is resumable, and state the precise resume, fresh-turn, re-auth, or rollback action. Parent-turn interruption triggers a provider-handle audit; it must not silently orphan or duplicate work. One-shot Codex workers report non-resumable process-tree cleanup and preserve the task packet/workspace for a newly authorized turn.

### Compatibility Watch: bounded self-heal

**Compatibility Watch — Recover, learn, harden.** Compatibility Watch is the subsystem, UI, and history owner. Its bounded self-heal behavior detects app/provider drift, restores compatibility, runs direct/meta/meta-meta hardening, and may produce reviewed sanitized issue/PR proposals. It is privacy-safe and depth-limited so operational learning does not become recursive analysis or token churn.

When self-heal is triggered, depth 0 performs immediate incident repair or recovery first. Depth 1 analyzes why recognition, prevention, or routing did not happen earlier and updates the recognizer/process plus a regression. Depth 2 analyzes why the self-heal machinery missed that process gap or created excess retries/churn, updates that machinery, and then stops. There is no recursive fourth phase and no analysis delay before useful recovery.

Every phase records a concrete owner, evidence, regression, and affected-host rollout boundary. Temporary behavior also records rollback or expiry when relevant. A generic unavailable state, repeated commentary, or speculative root-cause narrative is not closure evidence.

Portable fixes may be prepared as sanitized GitHub issue or pull-request proposals. Each proposal names affected versions and hosts, bounded evidence, rollback, and residual gaps. It excludes machine-local credentials, account/session state, paths that reveal private host state, prompts, and private provider output. A local persistent monitor owns triage, tests, revisions, acceptance or rejection, and may apply the fix locally only after acceptance. Agent submission is never merge authority and `autoMerge` remains false.

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

## Claude Code Preview

The dedicated `claude-code` adapter wraps the official local Claude Code CLI for Consult and bounded Delegate. Integrated is unsupported because Claude Code owns its tool loop. The adapter uses shell-free structured argv, stream-json NDJSON, explicit models, local session-ID binding/resume, disposable plan/read-only Consult snapshots, and finite Delegate turns without bypass permissions.

It does not configure credentials, plugins, hooks, skills, inherited MCP, cross-host transcript transfer, or subscription quota. Any reported cost is telemetry, not remaining allowance. Isolated accounts may select only canonical `accounts.profileSources` entries with `kind: "claude-config-dir"`.

Status is **Preview / live-untested**. See [CLAUDE-CODE.md](CLAUDE-CODE.md) for configuration, safety boundaries, reverse-host staging, and offline test coverage.

### AgentRouter via Claude Code

The explicit `agentrouter-claude` example uses the Claude Code adapter, `claude-opus-4-8`, and Consult/Delegate only. It never routes through `openai-chat` or Codex. The child receives only the explicitly named gateway credential and URL/model variables; absent keys fail before spawn and ambient Anthropic variables never leak into generic Claude.

Linux and Windows returned `THREADSPAN_AGENTROUTER_OK` on 2026-08-18 with Claude Code 2.1.234, separate USD 1 capped host tokens, and no payment method. Treat this as dated route evidence. The installer uses `offerEndDate: null`, seven-day freshness, a required live probe, **Check availability** after staleness, and hidden-after-end behavior if a future end date is recorded without newer proof. See [AGENTROUTER.md](AGENTROUTER.md).

### Card-free and free-credit discovery candidates

The explicit-only installer can also surface Mistral API, GroqCloud, Cloudflare Workers AI, and Google Gemini API as disabled check-first candidates. OpenRouter is already live-supported and is not duplicated. Each candidate names an official URL and environment variable only, forbids paid upgrade, has no assumed end date, and requires a fresh cardless/model/region check. Cloudflare remains a documented generic-config candidate with an account-specific URL; there is no custom Cloudflare adapter.

| Route | Current evidence class | Deterministic action |
|---|---|---|
| AgentRouter + Claude Code | Verified on two hosts on 2026-08-18; refresh after 7 days | Metadata/plan only |
| Mistral API | Official Free mode says no card; live account check still required | Disabled generic example |
| GroqCloud | Official Free Plan limits; live cardless/account check required | Disabled generic example |
| Cloudflare Workers AI | Official daily free allocation; account-specific setup candidate | Documentation only until reviewed |
| Google Gemini API | Official Free Tier for eligible models/regions; live project check required | Disabled generic example |

Threadspan is not partnered with, sponsored by, or endorsed by these providers. It surfaces public documentation and user-discovered options without promising permanent free access. Signup, credential creation, app installation, billing changes, and route enablement always require user permission and a reviewed plan. Provider prompts/code go to the selected third party under its terms and data policy.

## Provider-native OpenAI Codex account worker

Use `codex-native-worker` for a bounded Delegate owned by the official Codex CLI and authenticated by one isolated, already-signed-in `CODEX_HOME`. This is a distinct adapter from `codex-worker`: the existing `codex-worker` remains the Integrated-route wrapper that selects `threadspan_integrated` and an `integrated/...` model route.

```jsonc
{
  "openai-codex": {
    "enabled": true,
    "adapter": "codex-native-worker",
    "command": "codex",
    "model": "gpt-5.6-sol",
    "models": ["gpt-5.6-sol"],
    "capabilities": ["delegate"],
    "delegate": {
      "requireCleanStart": true,
      "denyBranches": ["main", "master", "trunk"]
    }
  }
}
```

Each account descriptor must use native login auth plus an opaque `profileRef`. That reference must resolve through machine-local `accounts.profileSources` to a canonical non-default `codex-home` containing an existing non-empty `auth.json`. Keep profile roots and account descriptors out of portable examples; never put account emails or credentials in configuration.

The child environment keeps ordinary host variables needed by native project tools but removes Threadspan variables, provider API/auth/session secret variables, and custom provider base URLs. Provider authentication therefore comes from the selected isolated `CODEX_HOME`; unrelated project credentials are neither copied into configuration nor reported in settings/lifecycle metadata.

The native invocation selects the configured native catalog slug and isolated `CODEX_HOME`, then lets that profile's user configuration and the workspace's project configuration compose normally. It does not use `--ignore-user-config`, select a Threadspan profile/provider/base URL, or silently set context, reasoning effort, sandbox, approval, tools, web, memory, goals, or retry policy. Optional `contextWindow`, `reasoningEffort`, `sandbox`, `approvalPolicy`, and `disableGoals: true` remain explicit native-Codex overrides; each is visible and reversible in `effectiveSettings`. The supplied linked writable worktree, explicit scope, explicit acceptance-command list, no-integration-authority packet, and independent coordinator acceptance remain mandatory.

Existing host configuration is not silently migrated. A host generated from the older example may still contain `contextWindow`, `reasoningEffort`, `sandbox`, `approvalPolicy`, or `disableGoals`; those values now remain valid but are reported as explicit divergences. To adopt native inheritance, review and remove only those fields from that host's `openai-codex` entry, preserve its machine-local `accounts.profileSources`, restart the daemon, and verify the new `effectiveSettings` digest plus provider/account/transport lifecycle report. Repeat independently on each host.

`openai-codex` is enabled in the starter configuration so setup remains visible. With no account it describes `setupRequired` / unavailable and the +Account and state surfaces remain reachable; execution routes still fail closed and no default `CODEX_HOME` adapter is constructed.

### Account fallback boundary

Account fallback is opt-in at both configuration and request level. It supports only two certified pre-output failure classes:

- native Codex's exact `You've hit your usage limit.` class, with no model output, tool activity, or other side effect; and
- an OpenAI-compatible Chat Completions HTTP 429 in Consult or Integrated mode, before text, reasoning, tool calls, usage, or other side effects.

Either class may try at most one validated isolated alternate for the same provider, model, and mode. There is no further account cascade and no cross-provider fallback. If the OpenAI-compatible adapter has already retried an unsupported streaming request as buffered, a failure from that buffered retry cannot trigger account fallback.

For native Codex, an authoritative reset timestamp is persisted with `AccountStore.observeQuota(...)` when present. Authentication, transport, timeout, malformed output, partial output, tool activity, HTTP 408, HTTP 5xx, and every uncertified error are terminal for account routing. Invalid alternate isolation is marked unavailable and skipped; an invalid primary fails closed.

`maximumUtilization` and its native polling are disabled by default. When explicitly enabled, the daemon reads the selected isolated account through Codex App Server `account/rateLimits/read`; callers cannot submit automatic events. The separate owner-only manual full-push mode is provider/app/account labeled and quota-independent. Local token counts and forecasts never activate automatic mode, exact native same-account/bucket recovery is required, and unsupported host actions stay truthful in the durable outbox.

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
- `scope` with `allowed`, `denied`, and `non_goals` for an explicit managed-worker write boundary.

Acceptance commands are prompt/evidence contract data. They are not converted into permission allow rules.

## Nous Portal

The portable default talks directly to Nous Portal with `NOUS_API_KEY`; no separate local proxy is required:

```jsonc
{
  "nous": {
    "adapter": "nous",
    "baseUrl": "https://inference-api.nousresearch.com/v1",
    "apiKeyEnv": "NOUS_API_KEY",
    "model": "deepseek/deepseek-v4-flash-0731",
    "discoverModels": true,
    "capabilities": ["consult", "integrated"]
  }
}
```

The `nous` adapter preserves thinking content and ordered tool-call/result linkage. It buffers a complete provider turn before exposing tool calls, accepts up to 16 calls in one turn, and fails closed above that bound. Consult and Integrated use the direct adapter; Delegate uses the bounded Codex worker over the same daemon route. Keep the API key environment-only. Hermes Agent remains a separate optional host/runtime rather than a required credential proxy.

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
- opt-in pre-output HTTP 429 account fallback to at most one validated same-provider alternate;
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
