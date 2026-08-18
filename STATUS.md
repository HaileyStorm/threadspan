# Implementation status

**Snapshot date:** 2026-08-18
**Package version:** 0.4.1 release candidate
**Assessment:** 0.4.0 is the current signed public release. Native Continuity controls, automatic account-first takeover, copy review, privacy hardening, and the first-class provider routes are source-verified for 0.4.1. The listed provider routes, native Continuity state, and daemon restart behavior are live-accepted on the configured Linux and Windows hosts; signed publication remains the release gate.

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
- Owner-only Continuity task tree and naming controls with opaque handles; guarded promotion works with or without an existing native Goal and delegates Goal transfer to the certified supervisor.
- Optional account-first automatic takeover for bridge-routed certified pre-output failures, compatible provider selection, same-daemon disconnect survival, and externally visible recovery state. Cross-process native-host replay still requires a certified host launcher.

## Verification completed

On Linux, the complete 0.4.1 release-candidate source gate passes: `npm run check` succeeds and the Node suite reports **517 tests, 517 passed, 0 failed, and 0 skipped**. The deployed native Windows 0.4.1 source passed the 43 focused cross-platform tests selected for this delta. Live revision-bound acceptance then passed on both configured hosts for Cursor Consult, Grok Build, Nous Consult/Integrated/Delegate, OpenRouter routing, daemon restart durability, and native Continuity state. Windows deployment preserved the already-running Codex task. These are account-, revision-, and host-specific observations, not universal provider guarantees; Desktop visual acceptance remains separate.

## Implemented but not live-certified

| Surface | Implemented confidence | Remaining unknowns |
|---|---|---|
| Cursor SDK Consult/Delegate | Offline lifecycle, race, retention, cancellation, and cleanup coverage; Cursor Consult accepted live on both configured hosts. | Delegate entitlement/model drift/billing; whether some workloads should use official Cursor Cloud Agents. |
| Grok Build Consult/Delegate | Dedicated adapter plus live Consult/MCP startup on both configured hosts. | Sustained fleet capacity, nested-agent accounting, consumer weighting, and entitlement drift. |
| Shared Desktop MCP topology | Remote shim/generated config tested against local HTTP servers; one persistent daemon and restart ownership accepted on both configured hosts. | Exact current Desktop picker/profile behavior after future app updates and broader platform packaging. |
| Direct xAI / DeepSeek / Nous | Protocol transforms plus live Nous Consult/Integrated/Delegate on both configured hosts. | Catalog, limits, billing, and account state remain volatile. |
| AgentRouter through Claude Code | Linux and Windows Claude Code 2.1.234 returned `THREADSPAN_AGENTROUTER_OK` through `agentrouter.org` with `claude-opus-4-8` in bounded no-spend probes on 2026-08-18. | Offer/end date is unknown; evidence visibility expires after seven days without a fresh probe. Generic Claude remains Preview and generic OpenAI Chat/Codex are not fallbacks. |
| Mistral/Groq/Cloudflare/Gemini free candidates | Official documentation currently describes free or free-allocation tiers; disabled examples and installer metadata are offline-tested. | Current cardless eligibility, region, model, account, and endpoint must be live-checked before enablement. Cloudflare remains setup-candidate only. |
| Maximum utilization | Offline reducer, persistence/replay, auth, installer, and HUD privacy coverage. | A native quota receipt adapter and each requested host capability must be certified separately on every host; unsupported effects remain pending/unsupported. |

## Deliberately unsupported or incomplete

1. Cursor Integrated through the SDK; use a raw endpoint for caller-owned tools.
2. Grok Build Integrated; use direct xAI API for caller-owned tools.
3. Supported headless Grok consumer weekly-meter polling.
4. Cross-process takeover of an already-running native host task when no certified host launcher can reconstruct and resume it. Bridge-routed pre-output takeover is implemented; unsupported native replay remains visible and fail-closed.
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
- Account fallback never changes model or mode and never cascades beyond one alternate: native Codex requires its exact pre-output/no-side-effect usage-limit class; OpenAI-compatible Chat Completions requires a pre-output HTTP 429. Optional takeover may then change provider only for a smart or explicitly opted-in route whose source and candidate publish the same non-empty privacy class and that passes mode, workspace, context, intelligence, and live-health gates.
- Maximum-utilization state does not make unsupported host actions real. Native quota and host-adapter capability evidence remain separate acceptance gates.
- Threadspan has no provider partnership, sponsorship, or endorsement. It never creates accounts/credentials, installs apps, changes billing, or enables these routes without explicit permission and a reviewed plan.

## Release recommendation

Suitable for controlled personal-workstation use, Desktop/Codex integration, selective Consult, and bounded provider Delegate work. The configured Linux and Windows hosts passed the 0.4.1 live matrix; other hosts and accounts must still run `docs/TESTING.md` and record their exact provider, package, host, and Desktop evidence.
