# Implementation status

**Snapshot date:** 2026-08-18
**Package version:** 0.4.0
**Assessment:** source and both-host release candidate. Linux and Windows provider/runtime acceptance is recorded below; Desktop visual acceptance and untested provider entitlements remain separate gates.

## What is complete

- OpenAI Responses-style buffered/SSE HTTP and convenience Consult/Delegate endpoints.
- MCP stdio tools plus connector-only `/mcp` remote-shim mode, so multiple Desktop processes can forward to one persistent daemon; explicit `--embedded-mcp` remains available.
- Cursor snapshot Consult and retained Delegate agents keyed by thread/model/workspace, with TTL/count/serialization/cancellation controls.
- Grok Build finite one-shot Consult/Delegate with executable/version/hash checks, profiles, strict argv, environment reduction, admission, process-tree cleanup, ledgering, and optional linked-worktree policy.
- Grok web/search and nested subagents enabled by operator policy, with opt-outs, inherited authority, attribution rules, and cross-session memory disabled.
- Fleet identity through CLI/MCP/HTTP/prompts/provider metadata/environment/ledger and count-only runtime diagnostics.
- Direct xAI, DeepSeek, Nous Portal, generic OpenAI-compatible, command, and custom adapter paths.
- In-memory response/thread continuity; Codex config/skills/prompts/examples; security and Windows-oriented support.
- Source-run installer window with component selection, grouped task protection, digest-bound apply, usage estimates, and native-host recovery metadata.
- Codex Primary, Grok Enhanced, Cursor Standard, and Hermes Preview reverse-host contracts.
- Scoped Streamable HTTP MCP for host connectors; its distinct bearer cannot call `/v1`, and the owner bearer cannot call `/mcp`.
- Connector-private token-file support for MCP shims and Windows `.cmd`/`.bat` process normalization.
- Optional maximum-utilization pure reducer, private durable journal/outbox, main-token event surface, sanitized HUD, and disabled-by-default installer component.
- Explicit AgentRouter-through-Claude-Code gateway isolation plus explicit-only, no-spend discovery candidates for Mistral API, GroqCloud, Cloudflare Workers AI, and Gemini API.

## Verification completed

On Linux, the complete 0.4.0 source gate passes: `npm run check` succeeds and the Node suite reports **434 tests, 434 passed, 0 failed, and 0 skipped**. A clean-installed native Windows package previously passed **339 tests**, with nine explicit platform/privilege skips. Live host checks then accepted Cursor Consult, Grok Consult and MCP startup, Nous Consult/Integrated/Delegate, OpenRouter free routing, service startup, and native Codex quota reads on both configured hosts. These are account- and revision-specific observations, not universal provider guarantees; Desktop visual acceptance remains separate.

## Implemented but not live-certified

| Surface | Implemented confidence | Remaining unknowns |
|---|---|---|
| Cursor SDK Consult/Delegate | Offline lifecycle, race, retention, cancellation, and cleanup coverage; Cursor Consult accepted live on both configured hosts. | Delegate entitlement/model drift/billing; whether some workloads should use official Cursor Cloud Agents. |
| Grok Build Consult/Delegate | Dedicated adapter plus live Consult/MCP startup on both configured hosts. | Sustained fleet capacity, nested-agent accounting, consumer weighting, and entitlement drift. |
| Shared Desktop MCP topology | Remote shim/generated config tested against local HTTP servers. | Exact current Desktop launch environment, picker/profile behavior, updates, and platform packaging. |
| Direct xAI / DeepSeek / Nous | Protocol transforms plus live Nous Consult/Integrated/Delegate on both configured hosts. | Catalog, limits, billing, and account state remain volatile. |
| AgentRouter through Claude Code | Linux and Windows Claude Code 2.1.234 returned `THREADSPAN_AGENTROUTER_OK` through `agentrouter.org` with `claude-opus-4-8` on separate USD 1 capped, no-payment-method tokens on 2026-08-18. | Offer/end date is unknown; evidence visibility expires after seven days without a fresh probe. Generic Claude remains Preview and generic OpenAI Chat/Codex are not fallbacks. |
| Mistral/Groq/Cloudflare/Gemini free candidates | Official documentation currently describes free or free-allocation tiers; disabled examples and installer metadata are offline-tested. | Current cardless eligibility, region, model, account, and endpoint must be live-checked before enablement. Cloudflare remains setup-candidate only. |
| Maximum utilization | Offline reducer, persistence/replay, auth, installer, and HUD privacy coverage. | A native quota receipt adapter and each requested host capability must be certified separately on every host; unsupported effects remain pending/unsupported. |

## Deliberately unsupported or incomplete

1. Cursor Integrated through the SDK; use a raw endpoint for caller-owned tools.
2. Grok Build Integrated; use direct xAI API for caller-owned tools.
3. Supported headless Grok consumer weekly-meter polling.
4. Automatic cross-provider failover. Opt-in account fallback is limited to one same-provider alternate under the exact boundaries below.
5. Durable bridge conversation/response state across restart.
6. Persistent Grok ACP outer workers; current outer jobs are fresh and finite, though they may use nested subagents.
7. Official Cursor Cloud Agent pooling; current persistence is daemon-retained SDK agents.
8. Universal multimodal forwarding, Hermes full-agent Delegate, hostile-code containment, multi-user auth, and distributed observability.

## Important boundaries

- Grok web and subagents do not receive independent authority. Nested agents inherit the parent packet; external content is untrusted evidence.
- Generic Grok defaults remain six active outer jobs. The fleet example permits nine outer/resident jobs behind one 1.4-second/18-turn controller; neither is a provider guarantee.
- Every writable outer worker needs its own linked worktree. Nested agents remain inside the parent boundary.
- One daemon must serve all Desktop coordinator trees for limits and retained agents to be genuinely shared.
- Consult snapshots isolate ordinary mutation, not provider visibility or hostile code. Delegate workers never receive acceptance/integration authority.
- Account fallback never changes provider, model, or mode and never cascades beyond one alternate: native Codex requires its exact pre-output/no-side-effect usage-limit class; OpenAI-compatible Chat Completions requires a pre-output HTTP 429. All other automatic cross-provider fallback remains unsupported.
- Maximum-utilization state does not make unsupported host actions real. Native quota and host-adapter capability evidence remain separate acceptance gates.
- Threadspan has no provider partnership, sponsorship, or endorsement. It never creates accounts/credentials, installs apps, changes billing, or enables these routes without explicit permission and a reviewed plan.

## Release recommendation

Suitable for a controlled personal workstation, Desktop/Codex prototyping, selective Consult, and bounded Grok/Cursor Delegate pilots. Before stronger claims, run `docs/TESTING.md` live checks and certify the actual accounts and native Desktop builds.
