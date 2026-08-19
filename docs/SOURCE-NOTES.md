# External source notes

Accessed through 2026-08-18. These sources informed compatibility decisions; this package is an independent implementation.

## Cursor

- Cursor changelog, “Build programmatic agents with the Cursor SDK”  
  https://cursor.com/changelog/sdk-release
- Cursor public plugin repository, Cursor SDK skill and references  
  https://github.com/cursor/plugins/tree/main/cursor-sdk
- Cursor SDK package target used by this package: `@cursor/sdk` 1.0.23-compatible surface.

Key interpretation: SDK agents use the same runtime/harness/models as Cursor and support programmatic create/send/stream. The inspected type/examples exposed agent and plan behavior, not a raw model endpoint or hard read-only Ask mode.

## OpenAI Codex

- Configuration reference  
  https://developers.openai.com/codex/config-reference
- Model Context Protocol configuration  
  https://developers.openai.com/codex/mcp
- Skills  
  https://developers.openai.com/codex/skills
- Codex repository  
  https://github.com/openai/codex

Key interpretation: custom model providers use a base URL and Responses wire API; MCP stdio servers accept command/args/timeouts; skills are directories containing `SKILL.md` with name/description metadata.

## DeepSeek

- Thinking mode  
  https://api-docs.deepseek.com/guides/thinking_mode
- DeepSeek V4 integration notes / critical compatibility fields  
  https://api-docs.deepseek.com/quick_start/agent_integrations/oh_my_pi/
- API changelog and V4 model names  
  https://api-docs.deepseek.com/updates

Key interpretation: thinking-mode tool turns require `reasoning_content` replay; `tool_choice` is rejected in V4 thinking mode; current model IDs are `deepseek-v4-pro` and `deepseek-v4-flash`.

## Nous / Hermes

- Hermes Agent subscription proxy  
  https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/subscription-proxy.md
- Hermes Agent programmatic integration: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md
- Hermes Agent ACP host integration and process-local session behavior: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md
- Hermes Agent ACP internals: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/acp-internals.md
- Hermes ACP session construction: https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/session.py
- Hermes ACP entry point and background-MCP skip marker: https://github.com/NousResearch/hermes-agent/blob/main/acp_adapter/entry.py
- Official ACP TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk

Key interpretation: the proxy listens on `127.0.0.1:8645/v1` by default, accepts any bearer, attaches the real OAuth credential, preserves Chat Completions/SSE, and intentionally does not run the Hermes agent tool/memory loop. Full Hermes Agent exposes `hermes acp` as JSON-RPC over stdio, but current source constructs each session with the non-narrowable `hermes-acp` toolset and every enabled native MCP server. `HERMES_ACP_SKIP_CONFIGURED_MCP=1` skips background discovery only; it does not remove configured MCPs from `_make_agent`. Threadspan therefore cannot prove advisory Consult or task-bounded Delegate authority and ships no forward adapter. The official Host Integration page also says load/resume/fork is process-scoped while ACP Internals says SessionDB restores sessions across restarts, so no native recovery contract is claimed. Recheck only when upstream offers verifiable source-bound/narrowable tools, exact configured-MCP exclusion, and consistent process-restoration semantics.

## Model Context Protocol

- Current specification (2025-11-25)  
  https://modelcontextprotocol.io/specification/2025-11-25
- Lifecycle and version negotiation  
  https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- Key changes since 2025-06-18  
  https://modelcontextprotocol.io/specification/2025-11-25/changelog

Key interpretation: a server must echo a requested version it supports or return another version it actually supports; tool execution and input-validation failures should be represented as tool errors so the model can self-correct, rather than as JSON-RPC protocol failures.

## Prior art

- `pi-cursor-sdk`  
  https://github.com/fitchmultz/pi-cursor-sdk

Reviewed as prior art for Cursor agent lifecycle, tool-bridge concerns, testing depth, and local resume complexities. No source was copied into this package.

## Grok Build / xAI

- Bundled user-supplied research and probe report: [research/GrokReport.md](research/GrokReport.md), dated 2026-08-16.
- Grok Build overview and CLI/headless/permissions/settings documentation listed in that report.
- xAI consumer usage FAQ, reasoning-effort, API rate-limit, and API cost-tracking sources listed in that report.

Key interpretation applied by this package:

- Grok Build is a provider-owned coding-agent harness, so it maps to Consult/Delegate rather than Integrated.
- The report's per-task controls and safe one-shot pattern are implemented in a dedicated adapter.
- Its observed binary/model/entitlement/rate values are retained as provenance and canary guidance, not universal constants.
- Detailed CLI token/cost output supports a local ledger, but the consumer plan's compute-weighted weekly percentage remains externally checked.
- Direct xAI API access is a separate raw-model route appropriate for Integrated mode and exact API accounting.

No source code from the report's friend's implementation was supplied or copied; the package merges the report's findings into its existing architecture.
