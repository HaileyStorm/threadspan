---
name: threadspan
description: Use the Preview Threadspan MCP surface for provider status, advisory Consult, or a separately bounded Delegate task while Claude Code remains the host.
---

# Threadspan from Claude Code

Claude Code remains the active host. Threadspan is a secondary routing surface and does not replace Claude Code's native model picker, session UI, permission controls, or status.

1. Call `bridge_status` when current availability matters.
2. Use `bridge_models` only when a route is not already known.
3. Treat `consult` output as advisory evidence.
4. Use `delegate` only for an explicit isolated workspace with allowed and denied paths, non-goals, and finite acceptance commands.
5. Never send credentials or unapproved private material to another provider.
6. Resume Claude Code through its native local session ID. Never copy a provider transcript between hosts.
7. Label this integration **Preview / live-untested** until a separate native acceptance run is recorded.
