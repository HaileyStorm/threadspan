# Claude Code Preview host surface

This source-only bundle is the reverse Threadspan surface for Claude Code. It contains a user-reviewable stdio MCP definition, a compact status-line command, one `/threadspan` command, and one Threadspan skill. It does not install Claude Code, sign in, call a provider, replace Claude Code's native model picker, or copy Claude transcripts between hosts.

Generate staged files with:

```text
threadspan host install --host claude-code --token-file /absolute/path/to/connector-token --allow-preview
```

The command writes staged files only (by default below `~/.claude/threadspan/`). Review them, revalidate the current official Claude Code documentation, and use Claude Code's native user-scope MCP/plugin workflow to activate them. Keep the dedicated connector token in its owner-only file; no token value is written to MCP or settings JSON.

Status: **Preview / live-untested**. See `docs/CLAUDE-CODE.md` for the forward and reverse safety boundaries.
