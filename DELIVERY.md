# Implementation package delivery report

**Package:** `threadspan` 0.4.0

**Snapshot:** 2026-08-18

**State:** source-verified and live-accepted on the configured Linux and Windows hosts; Desktop visual acceptance and untested provider/account combinations remain pending.

## Delivered in 0.4.0

- Provider-neutral Consult, Integrated, and Delegate semantics over Responses HTTP/SSE, MCP stdio, and connector-only Streamable HTTP MCP.
- Cursor snapshot Consult and retained Delegate; finite Grok Build, Codex, and Claude Code workers; direct xAI, DeepSeek, Nous, OpenRouter, generic OpenAI-compatible, and command adapters.
- Account-scoped routing, privacy-minimized quota/usage state, connector/main-token separation, durable ledgers, worktree/scope gates, installer/recovery surfaces, and offline compatibility checks.
- Opt-in account fallback with no cross-provider failover: native Codex exact pre-output usage-limit failures and OpenAI-compatible pre-output HTTP 429 failures may each try at most one validated alternate for the same provider, model, and mode.
- Explicit `--embedded-mcp` plus shared-daemon routing for centralized provider pools, retained agents, admission, and usage state.
- Explicit-only AgentRouter through Claude Code with strict gateway env isolation, dated Linux/Windows evidence, and no-spend installer boundaries.
- Disabled check-first discovery candidates for Mistral API, GroqCloud, Cloudflare Workers AI, and Gemini API; OpenRouter remains the existing live route and is not duplicated.

## Verification evidence

On Linux, the complete 0.4.0 source gate reports **434 tests, 434 passed, 0 failed, and 0 skipped**. Coverage includes routing/account isolation, provider protocol transforms, MCP/HTTP authorization, process and worktree boundaries, installer/recovery behavior, release-bundle safety, and documentation/config parity. A clean-installed native Windows package previously passed **339 tests**, with nine explicit platform/privilege skips. Account-specific live checks on both configured hosts accepted Cursor Consult, Grok Consult/MCP startup, Nous Consult/Integrated/Delegate, OpenRouter free routing, service startup, and native Codex quota reads.

The current signed artifact predates this documentation closure and will be regenerated after the docs are finalized; it is not the final 0.4.0 distribution artifact.

AgentRouter's dated two-host success does not establish a permanent free offer. Generic Claude remains Preview, and the four additional provider entries are setup candidates pending fresh account/card/model/region checks. Threadspan is not partnered with, sponsored by, or endorsed by any listed provider. Signup, credentials, installs, billing, probes, and route enablement remain explicit reviewed user actions.

## Honest limits

Nine outer workers are an operator preset, not a universal provider limit; nested calls may not be perfectly exposed in terminal accounting. Grok weekly usage still needs provider-meter reconciliation. Cursor persistence means retained SDK agents, not certified Cursor Cloud Agent jobs. Live results bind only the tested accounts, versions, routes, and hosts. Desktop picker/visual behavior, Claude Code, Hermes full-agent mode, sustained fleets, and provider entitlement drift remain uncertified.

See `README.md`, `docs/GROK-REPORT-MERGE.md`, `docs/MULTI-COORDINATOR-FLEET.md`, `docs/TESTING.md`, and `STATUS.md`.
