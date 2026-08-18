# Codex integration

The package provides two complementary Codex paths:

1. **MCP Consult/Delegate tools** — the normal way to ask a secondary provider inside the current Codex thread.
2. **Responses model-provider profiles** — use a raw provider as the active model, primarily for Integrated mode.

## Install the managed config block

```bash
node src/cli.mjs codex install
```

Default target:

```text
~/.codex/config.toml
```

Override it with:

```bash
node src/cli.mjs codex install --codex-config /path/to/config.toml
```

The installer:

- preserves unrelated TOML;
- replaces only a marker-delimited managed block;
- creates a timestamped backup by default;
- writes atomically;
- sets restrictive file permissions where supported.

Preview without writing:

```bash
node src/cli.mjs codex snippet
```

Remove only the managed block:

```bash
node src/cli.mjs codex uninstall
```

## Explicit optional full-access policy

The portable installer also exposes `codex-full-access`. This component is never a default and is never included by `selection: "all"`; it can be selected only by its exact ID or the setup window's initially unchecked warning checkbox.

When selected, Threadspan applies this policy to the selected host's user-level `$CODEX_HOME/config.toml`:

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
approvals_reviewer = "user"

[apps._default]
approvals_reviewer = "user"
default_tools_approval_mode = "approve"
```

It also sets `approvals_reviewer = "user"` and `default_tools_approval_mode = "approve"` in every existing `[apps.<id>]` table, and sets `default_tools_approval_mode = "approve"` in every existing `[mcp_servers.<id>]` and `[plugins.<plugin>.mcp_servers.<server>]` table. Per-tool approval overrides are deliberately left untouched and reported as residual conflicts.

This removes command approval pauses and command sandboxing and preapproves app/MCP tools. It does not set `destructive_enabled`, `open_world_enabled`, tool enablement, app enablement, plugin enablement, or server enablement. The transform preserves comments, order, and unrelated TOML and fails closed on duplicate or ambiguous target tables/keys. Plans, previews, manifests, and logs contain only setting names, the target path, hashes, modes, effects, and bounded conflict descriptors—not raw config, tokens, headers, or credential values.

Codex loads user-level configuration from `~/.codex/config.toml` by default and may layer trusted project `.codex/config.toml`, a selected profile, and CLI flags over it. Threadspan does not overwrite those project/profile/CLI layers, so they remain visible residual overrides where applicable. Per-tool app/MCP values also retain their narrower precedence. Review the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for current key definitions and layer behavior.

## Generated provider

The block creates a custom model provider similar to:

```toml
[model_providers.threadspan_bridge]
name = "Threadspan Bridge"
base_url = "http://127.0.0.1:8743/v1"
env_key = "THREADSPAN_TOKEN"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 1800000
```

Current Codex configuration supports custom provider `base_url`, environment-key auth, and the Responses wire API. The daemon must be running before a model-provider profile is used.

## Generated profile documents

```toml
# threadspan_consult.config.toml
model_provider = "threadspan_bridge"
model = "consult/cursor-ultra/auto"

# threadspan_integrated.config.toml
model_provider = "threadspan_bridge"
model = "integrated/nous/deepseek/deepseek-v4-flash-0731"

# threadspan_delegate.config.toml
model_provider = "threadspan_bridge"
model = "delegate/grok-build/grok-4.6"
```

These standalone profile documents are installed beside `config.toml`; Threadspan does not emit legacy inline `[profiles.*]` tables. The routes are configuration defaults, not hard-coded provider requirements. Re-run `codex install` with explicit choices when needed:

```bash
node src/cli.mjs codex install \
  --integrated-provider deepseek \
  --integrated-model deepseek-v4-pro \
  --delegate-provider cursor-ultra \
  --delegate-model auto
```

### Recommended use

- Use **MCP + skill** for Consult. It keeps the primary Codex model in charge and supplies a compact current-thread packet.
- Use `threadspan_integrated.config.toml` when you intentionally want the external raw model to become the active model under Codex's tool loop.
- Use MCP `delegate` rather than making Delegate the active model profile unless a specific client workflow benefits from the Responses route.

Profile selection and exact CLI flags can evolve. The installed TOML is the stable artifact; inspect the current Codex CLI help on the target machine for the invocation syntax supported by that version.

## Generated MCP server

```toml
[mcp_servers.consult]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/src/cli.mjs", "mcp", "--config", "/absolute/path/to/config.jsonc", "--remote", "http://127.0.0.1:8743/mcp", "--token-file", "/absolute/path/to/threadspan-connector-token"]
startup_timeout_sec = 30
tool_timeout_sec = 7200
```

The long tool timeout is intentional: Cursor/agent delegation may be long-running. The MCP server itself remains cancellable. Adjust the timeout in Codex config if the local policy should be stricter.

The MCP entry launches a tiny dedicated stdio process, but by default that process forwards to the same HTTP daemon used by the Responses profiles. The remote shim is restricted to `/mcp` and reads a connector-only bearer from `--token-file`; it must never reuse the daemon owner token file. This centralizes Grok admission/ledgers, retained Cursor agents, and thread state across multiple Desktop coordinators. Install with `--embedded-mcp` only when an intentionally independent bridge inside each MCP process is desired. The stdio shim itself exposes no additional TCP port.

## Multiple Desktop coordinators

Install the same daemon URL into each ChatGPT/Codex Desktop environment. Each app process may own several subagents and its own stdio MCP shim, while the daemon owns the shared provider resources. Pass stable `coordinator_id` and `worker_group` fields on Grok calls; reuse `thread_id` for retained Cursor Delegate work.

The fleet example uses two coordinators with independent subagents, nine configured Grok outer slots, and a single rolling Grok turn controller. See [MULTI-COORDINATOR-FLEET.md](MULTI-COORDINATOR-FLEET.md).

## Install the packaged skills

```bash
node src/cli.mjs skill install --skill all
```

This installs two deliberately separate skills:

- `consult` — selective in-thread advisory review; the primary retains execution and final authority.
- `managed-worker` — bounded Delegate task packets, isolated workspaces, finite budgets, and independent acceptance.

Install only one when appropriate:

```bash
node src/cli.mjs skill install --skill consult
node src/cli.mjs skill install --skill managed-worker
node src/cli.mjs skill install --skill all --target /path/to/skills --force
```

The Consult skill preserves consultant thread continuity and treats the answer as advice. The managed-worker skill never turns Delegate self-report into acceptance or integration authority.

## Add project-level AGENTS instructions

Copy or adapt [../examples/codex/AGENTS.fragment.md](../examples/codex/AGENTS.fragment.md) into the host project's `AGENTS.md`.

The important directives are:

- invoke Consult selectively on hard, uncertain, or consequential decisions;
- reuse `thread_id` for follow-ups on the same question;
- never claim the consultant edited or tested the primary workspace;
- verify consultant claims against code/tests/docs;
- use Delegate only when provider-owned execution is intended;
- give each writable managed worker a dedicated worktree and exact acceptance commands;
- inspect the diff and independently rerun acceptance before integration;
- retain Codex's normal approvals for Integrated tool calls.

## Thread behavior in Codex

### MCP Consult

The MCP tool returns `threadId`. The skill should retain it in the current task state and pass it as `thread_id` for follow-ups. The bridge serializes simultaneous calls on that ID.

### Responses provider

Use `previous_response_id` on subsequent requests. This is the mechanism that reconstructs prior normalized messages. `metadata.bridge_thread_id` labels and groups a route but, by itself, does not inject old messages into arbitrary raw Responses calls.

The bridge preserves:

- assistant text;
- function-call IDs, names, and arguments;
- function-call outputs;
- provider reasoning required by later tool turns;
- provider/model/mode linkage.

State is lost when the bridge process restarts.

## Desktop caveat

The package deliberately does not install a custom `model_catalog_json`. The bridge already exposes live provider/model/capability data for a future Codex++-style Desktop augmentation, including Grok worker profiles and admission state, without making the daemon depend on undocumented Desktop internals. Current Codex custom-provider configuration is supported at the config level, but model-picker presentation and profile discoverability have varied across clients. Treat command-line/profile selection as the first validation target. Do not promise a polished Desktop picker until it has been smoke-tested on the exact current build.

## Authentication

Codex sends the environment variable named by `env_key` as a bearer token. The bridge compares it against the process environment variable named by `server.authTokenEnv`.

Set the owner token in the environment that launches both Codex and the daemon. The default MCP shim traverses loopback HTTP with the distinct connector token file configured by `server.connectorTokenFile`; it never receives the owner token. Only `--embedded-mcp` avoids that HTTP hop; unauthenticated loopback remains an explicit server setting, not an assumption.

## Failure diagnosis

1. `node src/cli.mjs doctor`
2. `node src/cli.mjs providers`
3. `node src/cli.mjs models`
4. Start the daemon with `logging.level = "debug"` but leave `logBodies = false`.
5. Test buffered `/v1/responses` with the mock provider before testing Codex.
6. Validate MCP independently by launching `node src/cli.mjs mcp --config ...` through an MCP inspector/client.
7. Only then enable `--live` provider checks or paid inference.
## Native Continuity and Goals

Threadspan reads task, status, name, lineage, and Goal state through Codex App Server. The HUD never edits Codex databases. Promotion and rollover are requests to the installed certified Continuity supervisor, which performs native Goal lifecycle operations and proves predecessor fencing, exactly one successor, receipts, and fresh read-back before changing the accepted generation. Goal-free tasks may be promoted without fabricating a Goal; existing Goals retain one logical identity while their native binding generation advances.
