# Host surfaces

Threadspan separates providers from hosts. A provider supplies inference or a worker. A host is the app or CLI that owns the current conversation.

## Codex Primary

Codex uses standalone Responses profiles and one shared MCP proxy. App Server v2 supplies native model discovery and active-task metadata. Threadspan preserves the native catalog and pairs `model` with `modelProvider` for routed starts.

## Grok Enhanced

Grok Build receives a user-scoped `threadspan` MCP server and the plugin/skill in `integrations/grok-threadspan`. Native `/dashboard`, `/tasks`, `/usage`, `/context`, plugin, hook, and ACP surfaces remain authoritative for Grok state. Threadspan adds cross-provider status and Consult/Integrated/Delegate.

Grok Bot and grok.com require public HTTPS MCP. `/mcp` accepts a dedicated `THREADSPAN_CONNECTOR_TOKEN`; it cannot access `/v1`. Put TLS/public reachability in an explicitly configured Cloudflare tunnel. Never publish the normal daemon token.

## Cursor Standard

Cursor receives a user-level `.cursor/mcp.json` entry generated without secret values. The source extension in `integrations/cursor-threadspan` reads the owner-private token file in extension memory and renders a provider pane. It does not patch Cursor's picker.

## Claude Code Preview

Claude Code receives a staged, credential-free stdio MCP document plus the source-only plugin, `/threadspan` command, Threadspan skill, and compact status-line command in `integrations/claude-code-threadspan`. Activation requires `--allow-preview`, review, current official-doc revalidation, and Claude Code's native user-scope installation workflow. Threadspan does not patch or replace Claude Code's native model picker.

Forward Claude Code is a separate `claude-code` provider adapter for plan/read-only Consult and finite, permission-preserving Delegate. Session recovery is bound to the provider-native local session ID. Cross-host transcript copying is forbidden. Both directions are **Preview / live-untested**; see [CLAUDE-CODE.md](CLAUDE-CODE.md).

## Hermes Preview

Hermes is a separate full-agent runtime, not another name for raw Nous inference. The preview reverse path allowlists status/model/Consult MCP tools. Full forward support must target Hermes sessions/runs, approvals, cancellation, SSE, and usage. Do not install Hermes merely to claim support.

## Native recovery

- Codex: App Server or `codex exec resume`.
- Grok: ACP or `grok --resume`.
- Cursor: Cursor SDK `Agent.resume()` or current `agent` CLI.
- Claude Code: local `claude --resume <session-id>` only; do not copy transcripts between hosts.
- Hermes: Hermes run/session API or Hermes CLI.

No origin may silently fall back through another provider's executable.
