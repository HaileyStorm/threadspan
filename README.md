# cursor-codex-bridge

A local, provider-neutral bridge for using external model subscriptions, APIs, and coding-agent harnesses from Codex/ChatGPT Desktop, Cursor, MCP clients, and OpenAI-compatible clients.

The project preserves three materially different workflows instead of hiding them behind a vague “use another model” switch:

| Mode | Authority | Intended use |
|---|---|---|
| **Consult** | The primary agent remains in charge. The secondary returns advice only. | Second opinions, design review, debugging, risk analysis, critique, and cross-model adjudication. |
| **Integrated** | The secondary raw model is active, while the calling client owns tools, approvals, and the agent loop. | Run Codex's tool harness with DeepSeek, Nous Portal, xAI API, or another compatible raw model. |
| **Delegate** | The secondary provider's agent owns one bounded execution task. The primary retains acceptance and integration authority. | Scoped implementation, tests, migration, investigation, and mechanical repository work. |

**Direct was renamed to Consult.** There is no second overlapping Consult feature.

## Surfaces

The package exposes:

- an OpenAI **Responses API-compatible subset** over HTTP, including SSE;
- an **MCP stdio server** with `consult`, `delegate`, `bridge_status`, and `bridge_models`;
- a CLI for direct calls, diagnostics, configuration, Codex installation, and skill installation;
- a reusable **Consult skill** for asking a secondary model inside an existing thread;
- a **Managed Worker skill** for bounded provider-owned coding jobs with independent acceptance;
- modular adapters for Cursor SDK, Grok Build, direct xAI API, Nous Portal, DeepSeek, generic OpenAI-compatible endpoints, and arbitrary command-backed agents.

## Provider matrix

| Provider path | Consult | Integrated | Delegate | Boundary |
|---|:---:|:---:|:---:|---|
| **Cursor SDK** | Yes | No | Yes | Consult uses a disposable workspace snapshot. Delegate retains one serial local agent per thread/model/workspace. Cursor exposes an agent harness rather than a caller-owned raw-model loop, so Integrated is explicitly rejected. |
| **Grok Build CLI** | Yes | No | Yes | Fresh finite one-shot jobs. Consult uses a disposable snapshot or empty temporary workspace. Delegate can require a clean linked Git worktree on a non-canonical branch. Model/effort/turn/tool/permission/sandbox policy is explicit. |
| **xAI API** via `openai-chat` | Yes | Yes | No built-in agent loop | Raw Chat Completions path. Reasoning usage and `cost_in_usd_ticks` are preserved as bridge metadata when returned. |
| **Nous Portal** via Hermes proxy | Yes | Yes | No built-in agent loop | Raw inference through the local credential-attaching proxy; it does not run Hermes tools, memory, or skills. |
| **DeepSeek V4** | Yes | Yes | No built-in agent loop | Includes thinking/tool history compatibility and reasoning replay. |
| **Generic OpenAI-compatible Chat Completions** | Configurable | Configurable | Only when the endpoint genuinely owns an agent loop | Streaming, reasoning, usage, and function calls are normalized. |
| **Command-backed agent** | Configurable | Configurable | Configurable | Structured argv, bounded output/time, process-tree cleanup, and optional environment allowlisting. |

## Requirements

- Node.js 22 or newer.
- Credentials or a local authenticated provider proxy for the providers you enable.
- `@cursor/sdk` only when a Cursor provider is enabled. It is an optional dependency and dynamically imported.
- Official Grok Build CLI only when the `grok-build` adapter is enabled.
- Git when Grok Delegate worktree policy is enabled.

A non-Cursor installation can use:

```bash
npm install --omit=optional
```

## Quick start

```bash
npm install
node src/cli.mjs config init
```

The starter config is written to:

- Windows: `%USERPROFILE%\.cursor-codex-bridge\config.jsonc`
- Linux/macOS: `~/.cursor-codex-bridge/config.jsonc`

Set credentials in the environment rather than embedding them in JSONC:

```bash
export CURSOR_API_KEY='...'
export DEEPSEEK_API_KEY='...'
export XAI_API_KEY='...'
export CURSOR_BRIDGE_TOKEN='use-a-long-random-value'
```

PowerShell:

```powershell
$env:CURSOR_API_KEY = '...'
$env:DEEPSEEK_API_KEY = '...'
$env:XAI_API_KEY = '...'
$env:CURSOR_BRIDGE_TOKEN = 'use-a-long-random-value'
```

Check configuration, credentials, optional SDKs, command paths, and Grok version/hash policy without paid inference:

```bash
node src/cli.mjs doctor
```

`doctor --live` may query configured `/v1/models` endpoints. It still cannot prove a Grok consumer account's subscription entitlement or remaining weekly percentage without an authenticated product request/manual usage check.

Start the HTTP bridge:

```bash
node src/cli.mjs serve
```

Default address:

```text
http://127.0.0.1:8743
```

## Codex / ChatGPT Desktop integration

Install a marker-scoped provider/MCP block and the packaged skills:

```bash
node src/cli.mjs codex install
node src/cli.mjs skill install --skill all
```

The managed Codex block adds:

- a Responses provider pointing at the local daemon;
- `bridge_consult`, `bridge_integrated`, and `bridge_delegate` profiles;
- a stdio MCP server for Consult/Delegate tools;
- no replacement model catalog;
- no modification outside the marked block.

The installer creates a timestamped backup and updates only:

```text
# >>> cursor-codex-bridge managed block >>>
...
# <<< cursor-codex-bridge managed block <<<
```

The HTTP profiles and the default MCP entry use the **same persistent daemon**. Each Desktop process still launches a tiny stdio MCP shim, but that shim forwards to the daemon so provider admission, ledgers, retained Cursor agents, and thread state are shared. Pass `--embedded-mcp` to `codex install` only when an intentionally independent in-process MCP bridge is preferred.

Codex custom-provider configuration and the Responses lifecycle are offline-tested. Exact model-picker presentation in every current ChatGPT/Codex Desktop build remains an external compatibility variable. The package therefore supplies working profiles/MCP integration without pretending stock picker behavior is guaranteed; a future Desktop augmentation can consume the same provider/model discovery surface.

## Consult examples

Raw-model Consult:

```bash
node src/cli.mjs consult \
  "Review this concurrency design for races and recommend the smallest safe fix" \
  --provider deepseek \
  --model deepseek-v4-pro \
  --context-file ./consult-packet.md
```

Continue the same consultant thread:

```bash
node src/cli.mjs consult \
  "Challenge your prior recommendation against the new test result" \
  --thread thread_abc123 \
  --provider deepseek
```

Cursor Consult over a disposable repository copy:

```bash
node src/cli.mjs consult \
  "Inspect the implementation and identify correctness defects, not style nits" \
  --provider cursor-ultra \
  --workspace .
```

Grok Build Consult with a bounded diagnostic profile:

```bash
node src/cli.mjs consult \
  "Characterize the failing behavior and propose a discriminating test" \
  --provider grok-build \
  --model grok-4.6 \
  --workspace . \
  --profile diagnose \
  --effort medium \
  --max-turns 8 \
  --expected-turns 2 \
  --coordinator-id cgpt-a \
  --worker-group grok-nine
```

Consult remains advisory even when the provider internally has tools. The primary evaluates the result and owns edits, validation, and the final answer.

## Delegate examples

Cursor Delegate against the supplied workspace:

```bash
node src/cli.mjs delegate \
  "Implement the accepted fix, run focused tests, and report changed files and evidence" \
  --provider cursor-ultra \
  --workspace .
```

Grok Build Delegate should use a dedicated linked worktree:

```bash
node src/cli.mjs delegate \
  "Add deterministic characterization tests for the parser; do not change production behavior" \
  --provider grok-build \
  --model grok-4.6 \
  --workspace /path/to/repo-worktree \
  --profile mechanical \
  --effort low \
  --max-turns 8 \
  --expected-turns 2 \
  --no-plan \
  --coordinator-id cgpt-a \
  --worker-group grok-nine \
  --acceptance-command "npm test -- test/parser.test.mjs"
```

The acceptance command is part of the authoritative task packet; it does not automatically expand the CLI permission allowlist. Configure exact Grok `allow`/`deny` rules separately, then independently rerun acceptance after the worker returns.

## Grok Build operating model

The dedicated adapter incorporates the generalizable findings in `docs/research/GrokReport.md` without hard-coding another account's observed model, hash, entitlement, or rate limits as universal truth.

Implemented controls include:

- exact executable resolution, optional absolute-path requirement, version regex/pin, and SHA-256 recording or enforcement;
- explicit model and allowed effort values; no silent model/effort fallback;
- finite one-shot `--single` jobs with `--max-turns`;
- default `dontAsk`, strict sandbox, no cross-session memory, and no auto-update; Grok subagents and web/search are allowed by the package's current operator policy, with explicit per-job opt-outs;
- structured argv with `shell: false`;
- optional environment allowlist instead of broad process inheritance;
- provider-local admission with active-worker, cold-start spacing, rolling-start, and expected-turn budgets;
- reconciliation of expected turns to reported `model_calls`/`turns`;
- append-only private JSONL lifecycle/usage ledger and optional hashed/raw evidence;
- process-tree termination on abort, timeout, output overflow, or shutdown;
- optional clean linked-worktree and denied-branch gates for Delegate;
- no automatic retry for quota, rate-limit, entitlement, malformed-output, or worker failures.

The generic packaged defaults—six active outer workers, 1.4-second start spacing, and 18 expected model turns per rolling minute—are conservative starting values derived from one bounded report, not xAI service guarantees. The included fleet preset raises the outer process ceiling to nine while retaining the shared 18-turn admission budget; nine resident/outer workers are therefore possible without pretending nine simultaneous model turns are safe. Re-canary after account, subscription, model, CLI, or provider behavior changes.

Consumer weekly usage remains partly manual: detailed per-job CLI telemetry is ledgered, but no supported headless endpoint is assumed for the compute-weighted weekly percentage. Direct xAI API is the better path when exact cost and API rate policy matter more than consumer-plan convenience.

Read [docs/GROK-BUILD.md](docs/GROK-BUILD.md) before enabling automatic batches.

## Multi-coordinator fleet

For the intended Desktop-heavy topology, run **one bridge daemon** and point every ChatGPT/Codex coordinator and subagent MCP shim at it:

```text
CGPT coordinator A + subagents ┐
                               ├─ stdio MCP shims ─> one bridge daemon
CGPT coordinator B + subagents ┘                       ├─ Grok outer-worker fleet
                                                       └─ retained Cursor Delegate agents
```

This avoids the dangerous version of “nine workers” in which each Desktop process owns a separate admission controller. The daemon is the single source of truth for Grok launch spacing, rolling turn reservations, queue depth, run ledgers, and retained Cursor agents. Use stable `coordinator_id`, `worker_group`, and `thread_id` values so logs and retained-agent lineage remain intelligible.

Grok web/search and nested subagents are enabled by default in this package because that is the requested operating policy. They do not receive broader authority: nested agents inherit the parent packet and workspace, and web-derived instructions cannot modify scope, permissions, acceptance, or integration rules. Use `--no-web` and/or `--no-subagents` for a particular job when isolation is more valuable than breadth.

See [docs/MULTI-COORDINATOR-FLEET.md](docs/MULTI-COORDINATOR-FLEET.md) and [examples/fleet/](examples/fleet/).

## Responses API example

```bash
curl http://127.0.0.1:8743/v1/responses \
  -H 'Authorization: Bearer YOUR_BRIDGE_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "integrated/deepseek/deepseek-v4-pro",
    "input": "Analyze this failure and call tools only when evidence is missing.",
    "stream": true,
    "tools": [
      {
        "type": "function",
        "name": "read_file",
        "description": "Read a repository file",
        "parameters": {
          "type": "object",
          "properties": { "path": { "type": "string" } },
          "required": ["path"],
          "additionalProperties": false
        }
      }
    ]
  }'
```

Route IDs:

```text
<mode>/<provider>/<upstream-model>
```

Examples:

```text
consult/cursor-ultra/auto
consult/grok-build/grok-4.6
integrated/xai-api/grok-4.6
integrated/nous/Hermes-4-70B
integrated/deepseek/deepseek-v4-pro
delegate/cursor-ultra/auto
delegate/grok-build/grok-4.6
```

## Thread continuity

There are two continuity mechanisms:

1. Responses clients pass `previous_response_id`. The bridge restores normalized messages, tool-call IDs/arguments, tool outputs, and hidden reasoning required by provider history rules.
2. MCP, CLI, `/v1/consult`, and `/v1/delegate` return a `threadId`. Reuse it for follow-ups. Calls on one convenience thread are serialized; unrelated threads may run concurrently.

Bridge-managed thread and response state is currently **memory-only**, bounded by TTL and count. Restarting loses that continuity. Cursor Delegate retains SDK agents only for the process lifetime. Grok Build intentionally uses fresh bounded sessions by default.

## Provider metadata

When an adapter has useful nonstandard accounting or execution evidence, the buffered Responses result may include the namespaced extension:

```json
{
  "bridge_provider_metadata": {
    "grokBuild": {
      "jobId": "job_...",
      "reasoningEffort": "medium",
      "turns": 4,
      "modelCalls": 4,
      "estimatedCostUsd": 0.08,
      "allowSubagents": true,
      "allowWebSearch": true,
      "coordinatorId": "cgpt-a",
      "workerGroup": "grok-nine"
    }
  }
}
```

Convenience CLI/MCP results expose the same data as `providerMetadata`. Generic xAI API responses preserve exact `cost_in_usd_ticks` under `providerMetadata.upstream` when present. This metadata is an extension, not standardized OpenAI usage.

## Security summary

- The default listener is loopback only.
- Non-browser loopback calls may be unauthenticated only when explicitly configured.
- Browser origins must be allowlisted or supply a valid bearer token.
- Cursor and Grok Consult snapshots isolate mutations; they do not provide confidentiality, a VM, or hostile-code containment.
- Delegate is destructive-capable. Use disposable branches/worktrees and inspect the complete diff.
- Grok Delegate can enforce Git/worktree policy, but the worker never receives integration authority.
- Provider CLI allow/deny rules and sandboxing are separate layers; configure both. Grok web access and nested subagents do not override those boundaries.
- Command providers can disable broad environment inheritance and terminate descendant process trees.
- Grok Build records private lifecycle/usage JSONL and evidence hashes by default; raw prompt/stdout/stderr files remain opt-in. Consumer weekly usage still requires a manual provider-meter check.
- Prompt bodies are not logged by default. Grok ledger output bodies are also opt-in; hashes and bounded lifecycle/accounting remain available without raw content.
- Keep the Hermes subscription proxy on loopback.

Read [docs/SECURITY.md](docs/SECURITY.md) before exposing the bridge beyond one trusted local user.

## Verification

```bash
npm run verify
```

The 0.2.1 package passes **86 offline tests** plus source syntax checks. A **39/39 focused changed-path set** concentrated on: Grok web/subagent policy resolution and opt-outs, fleet identity propagation, remote MCP-to-daemon forwarding, asynchronous daemon status, runtime counters, configuration conflicts, generated Codex routing, and convenience-HTTP control normalization/route parsing. The established provider and protocol regressions still run in the complete offline suite.

No paid Cursor, Grok, xAI, Nous, or DeepSeek inference is performed by the suite. Live provider certification remains explicit work documented in [docs/TESTING.md](docs/TESTING.md).

## Documentation

- [STATUS.md](STATUS.md) — honest implementation and live-certification status.
- [DELIVERY.md](DELIVERY.md) — package contents and release delta.
- [docs/GROK-BUILD.md](docs/GROK-BUILD.md) — dedicated Grok Build setup, safety, accounting, and unknowns.
- [docs/GROK-REPORT-MERGE.md](docs/GROK-REPORT-MERGE.md) — finding-by-finding application and operator-policy overrides.
- [docs/MULTI-COORDINATOR-FLEET.md](docs/MULTI-COORDINATOR-FLEET.md) — one-daemon topology for multiple Desktop coordinators, Grok workers, and retained Cursor agents.
- [docs/MANAGED-WORKERS.md](docs/MANAGED-WORKERS.md) — provider-neutral task packets, authority, admission, and independent acceptance.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, state, concurrency, and extension points.
- [docs/MODES-AND-USE-CASES.md](docs/MODES-AND-USE-CASES.md) — mode selection and scenarios.
- [docs/PROVIDERS.md](docs/PROVIDERS.md) — provider configuration and adapter contracts.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — Responses/MCP subset and extensions.
- [docs/CODEX-INTEGRATION.md](docs/CODEX-INTEGRATION.md) — Codex/ChatGPT integration.
- [docs/CURSOR-INTEGRATION.md](docs/CURSOR-INTEGRATION.md) — Cursor host-project setup.
- [docs/SECURITY.md](docs/SECURITY.md) — threat model and hardening.
- [docs/TESTING.md](docs/TESTING.md) — offline coverage and live smoke matrix.
- [docs/WINDOWS.md](docs/WINDOWS.md) — Windows-specific setup.
- [docs/ROADMAP.md](docs/ROADMAP.md) — prioritized remaining work.
- [docs/SOURCE-NOTES.md](docs/SOURCE-NOTES.md) — source/provenance notes.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
