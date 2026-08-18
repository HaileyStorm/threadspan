# Claude Code Preview

Status: generic Claude Code is **Preview / live-untested**. The explicit AgentRouter gateway route has narrower, dated two-host evidence described below; that evidence does not certify generic Claude sign-in, another gateway, or reverse-host acceptance.

Threadspan supports two separate Claude Code directions:

- **Forward:** Claude Code is a local provider-owned coding CLI used for advisory Consult or a bounded Delegate task.
- **Reverse:** Claude Code remains the host and reaches Threadspan through a staged stdio MCP configuration plus the bundled command, skill, and compact status line.

Neither direction replaces Claude Code's native model picker, permission UI, session picker, account state, or usage display.

## Forward adapter

The `claude-code` adapter invokes the official `claude` executable with `shell: false` and a structured argv. It uses print mode with `--output-format stream-json`, `--verbose`, and partial messages. Every request supplies an explicit `--model`; `auto` is rejected.

Threadspan starts the first turn with a generated UUID passed through `--session-id`. Later calls on the same account/thread/mode/model/workspace/profile boundary use `--resume` with exactly that UUID. Every streamed session ID must match. Threadspan stores only the bounded in-memory ID binding; it does not copy Claude's provider-native transcript or use a session from another host.

The NDJSON parser accepts split frames and CRLF. Each normalized event retains the exact parsed source object and source line, including unknown fields. Terminal provider metadata retains the exact result object. Reported token/cost fields are telemetry only: Claude's reported cost is never treated as subscription quota or remaining allowance.

### Consult boundary

Consult always runs in a disposable workspace snapshot (or an empty temporary directory), with:

- `--permission-mode plan`;
- read-only built-ins `Read,Glob,Grep`;
- `--bare`, `--safe-mode`, disabled slash commands and Chrome;
- strict empty MCP configuration and `mcp__*` denied;
- finite `--max-turns`.

The snapshot is a cleanup and mutation boundary, not an operating-system security sandbox.

### Delegate boundary

Delegate requires an explicit workspace and defaults to the existing linked-worktree, clean-start, protected-branch checks. It uses finite turns, an explicit built-in-tool allowlist, and `acceptEdits` by default. `bypassPermissions` and `--dangerously-skip-permissions` are rejected. Web tools, subagents, plugins, hooks, skills, inherited MCP, Chrome, and implicit settings are not enabled by Threadspan.

Claude Code and the operating system remain the ultimate enforcement layers. Preview Delegate is not live-certified; independently inspect its diff and rerun acceptance commands before integration.

## Configuration

```jsonc
{
  "providers": {
    "claude-preview": {
      "enabled": false,
      "adapter": "claude-code",
      "command": "claude",
      "model": "sonnet",
      "models": ["sonnet", "opus"],
      "capabilities": ["consult", "delegate"],
      "maxTurnsCeiling": 12,
      "maxSessions": 100,
      "sessionTtlMs": 86400000,
      "consult": {
        "workspaceStrategy": "snapshot",
        "maxTurns": 3,
        "tools": ["Read", "Glob", "Grep"]
      },
      "delegate": {
        "maxTurns": 8,
        "permissionMode": "acceptEdits",
        "tools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
        "requireGit": true,
        "requireLinkedWorktree": true,
        "requireCleanStart": true,
        "denyBranches": ["main", "master", "trunk"]
      }
    }
  }
}
```

Do not put API keys, credential fields, raw environment overlays, hooks, plugins, or MCP servers in this provider entry. The adapter uses the existing Claude Code native sign-in and forwards a small non-credential process environment.

### Explicit AgentRouter gateway

`agentrouter-claude` is a separate disabled example using `gateway: { baseUrl, apiKeyEnv, model, provider }`. The gateway URL must be HTTPS without embedded credentials, the environment source must be a valid name, and the gateway model must equal the provider model. A missing key fails before launch. Only this explicit route maps its named token into the child-only Anthropic gateway variables; generic Claude never receives ambient `ANTHROPIC_*` values.

Linux and Windows Claude Code 2.1.234 returned `THREADSPAN_AGENTROUTER_OK` through `https://agentrouter.org` with `claude-opus-4-8` on 2026-08-18. That recent evidence is specific to separate USD 1 hard-capped, no-payment-method host tokens. It expires from installer visibility after seven days without a fresh probe and is not a permanent-free guarantee. Integrated, generic OpenAI Chat, and Codex gateway fallback remain unsupported. See [AgentRouter through Claude Code](AGENTROUTER.md).

### Isolated profiles

An alternate profile must be an existing directory registered through a canonical machine-local `CLAUDE_CONFIG_DIR` reference:

```jsonc
{
  "accounts": {
    "profileSources": {
      "claude-work": {
        "kind": "claude-config-dir",
        "root": "/absolute/existing/profile-directory"
      }
    }
  }
}
```

Create the account descriptor with `profileRef: "claude-work"`. Raw `claudeConfigDir` provider fields are rejected, and a reference cannot target the current/default Claude profile directory.

## Reverse host

The bundled source is in `integrations/claude-code-threadspan`. Generate staged artifacts with:

```text
threadspan host install --host claude-code --token-file /absolute/path/to/threadspan-connector-token --allow-preview
```

By default this writes review-only MCP and status-line JSON below `~/.claude/threadspan/`. It does not run `claude`, activate a plugin, merge native settings, or write a token value. After reviewing the files:

1. Revalidate the current official Claude Code MCP/plugin/settings documentation.
2. Use Claude Code's native user-scope MCP workflow to add the staged `threadspan` stdio server.
3. Merge the status-line fragment only if replacing the current status line is desired.
4. Install the bundled plugin/command/skill only with explicit approval.
5. Keep Claude Code's native picker and native session recovery authoritative.

## Optional self-install descriptor

The installer component is disabled by default and selection requires explicit user approval. Its Linux/macOS/WSL and Windows PowerShell commands are copied from the official installation documentation as reviewable instructions. At execution time an installer agent must revalidate the current official docs, obtain approval, perform installation/sign-in interactively, and leave any live provider probe separately gated. Threadspan never executes those instructions during planning.

Current upstream references:

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Claude Code setup and official installers](https://code.claude.com/docs/en/getting-started)

Threadspan does not install Claude Code, create an account or token, open a browser, alter billing, or enable AgentRouter during deterministic planning. Those actions each require user permission and a reviewed plan. Prompts and selected code context sent on the AgentRouter route go to that third party.

## Offline verification

`test/claude-code.test.mjs` and `test/fixtures/claude-code-cli.mjs` cover Linux/Windows argv construction, permissions, NDJSON framing and unknown fields, session binding/resume, canonical profile isolation, disposable Consult snapshots, bounded Delegate settings, missing executable failure, gateway validation, exact child environment replacement, missing-key closure, and ambient-secret isolation. Host and installer tests cover reverse staging and explicit provider approval.
