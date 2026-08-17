# Shared Desktop/Grok/Cursor fleet example

This preset is for one persistent bridge daemon shared by multiple ChatGPT/Codex coordinator trees. It enables Grok Build, permits web/search and nested subagents, keeps Grok cross-session memory disabled, allows nine outer Grok jobs behind one 18-unit rolling controller, and retains up to 16 Cursor Delegate agents for six hours.

## Use

```bash
cp examples/fleet/bridge.config.jsonc ~/.cursor-codex-bridge/config.jsonc
export CURSOR_BRIDGE_TOKEN='replace-with-a-long-random-value'
export CURSOR_API_KEY='...'
cursor-bridge doctor
cursor-bridge serve
```

In each Desktop/Codex installation, run `cursor-bridge codex install`. The generated MCP shim forwards to the same daemon by default. The static Cursor example also uses `--remote http://127.0.0.1:8743`.

Set `coordinator_id`, `worker_group`, and stable `thread_id` values on requests. Give every writable outer Grok Delegate job a unique linked worktree. Canary one, three, and six jobs before enabling all nine slots; the values are local policy, not provider guarantees.
