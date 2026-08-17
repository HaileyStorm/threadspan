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

## Generated provider

The block creates a custom model provider similar to:

```toml
[model_providers.cursor_bridge]
name = "Cursor Codex Bridge"
base_url = "http://127.0.0.1:8743/v1"
env_key = "CURSOR_BRIDGE_TOKEN"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 3
stream_idle_timeout_ms = 1800000
```

Current Codex configuration supports custom provider `base_url`, environment-key auth, and the Responses wire API. The daemon must be running before a model-provider profile is used.

## Generated profiles

```toml
[profiles.bridge_consult]
model_provider = "cursor_bridge"
model = "consult/cursor-ultra/auto"

[profiles.bridge_integrated]
model_provider = "cursor_bridge"
model = "integrated/nous/Hermes-4-70B"

[profiles.bridge_delegate]
model_provider = "cursor_bridge"
model = "delegate/cursor-ultra/auto"
```

These routes are configuration defaults, not hard-coded provider requirements. Re-run `codex install` with explicit choices when needed:

```bash
node src/cli.mjs codex install \
  --integrated-provider deepseek \
  --integrated-model deepseek-v4-pro \
  --delegate-provider cursor-ultra \
  --delegate-model auto
```

### Recommended use

- Use **MCP + skill** for Consult. It keeps the primary Codex model in charge and supplies a compact current-thread packet.
- Use `bridge_integrated` when you intentionally want the external raw model to become the active model under Codex's tool loop.
- Use MCP `delegate` rather than making Delegate the active model profile unless a specific client workflow benefits from the Responses route.

Profile selection and exact CLI flags can evolve. The installed TOML is the stable artifact; inspect the current Codex CLI help on the target machine for the invocation syntax supported by that version.

## Generated MCP server

```toml
[mcp_servers.consult]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/src/cli.mjs", "mcp", "--config", "/absolute/path/to/config.jsonc", "--remote", "http://127.0.0.1:8743"]
startup_timeout_sec = 30
tool_timeout_sec = 7200
```

The long tool timeout is intentional: Cursor/agent delegation may be long-running. The MCP server itself remains cancellable. Adjust the timeout in Codex config if the local policy should be stricter.

The MCP entry launches a tiny dedicated stdio process, but by default that process forwards to the same HTTP daemon used by the Responses profiles. This centralizes Grok admission/ledgers, retained Cursor agents, and thread state across multiple Desktop coordinators. Install with `--embedded-mcp` only when an intentionally independent bridge inside each MCP process is desired. The stdio shim itself exposes no additional TCP port.

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

Set the token in the environment that launches both Codex and the daemon. The default MCP shim traverses loopback HTTP and therefore follows the daemon's auth policy. Only `--embedded-mcp` avoids that HTTP hop; unauthenticated loopback remains an explicit server setting, not an assumption.

## Failure diagnosis

1. `node src/cli.mjs doctor`
2. `node src/cli.mjs providers`
3. `node src/cli.mjs models`
4. Start the daemon with `logging.level = "debug"` but leave `logBodies = false`.
5. Test buffered `/v1/responses` with the mock provider before testing Codex.
6. Validate MCP independently by launching `node src/cli.mjs mcp --config ...` through an MCP inspector/client.
7. Only then enable `--live` provider checks or paid inference.
