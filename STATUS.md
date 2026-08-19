# Implementation status

**Snapshot date:** 2026-08-18
**Package version:** 0.6.0 release source
**Assessment:** This source is prepared for the signed 0.6.0 release. Publication authority is the exact Git tag plus the public signed manifest, archive digest, and source-commit record; this file alone does not prove publication. The immutable public 0.5.0 history is retained. Earlier live Linux/Windows app-attached HUD and picker evidence predates the one-time authenticated Electron bootstrap and does not certify that replacement transport. The 0.6.0 source adds clean-install/service transactions, provider activation, strengthened Compatibility Watch/maximum-utilization/Continuity controls, the authenticated Desktop bootstrap, and an expanded staged Hermes reverse connector.

## What is complete

- OpenAI Responses-style buffered/SSE HTTP and convenience Consult/Delegate endpoints.
- MCP stdio tools plus connector-only `/mcp` remote-shim mode, so multiple Desktop processes can forward to one persistent daemon; explicit `--embedded-mcp` remains available.
- Cursor snapshot Consult and retained Delegate agents keyed by thread/model/workspace, with TTL/count/serialization/cancellation controls.
- Grok Build finite one-shot Consult/Delegate with executable/version/hash checks, profiles, strict argv, environment reduction, admission, process-tree cleanup, ledgering, and optional linked-worktree policy.
- Grok web/search and nested subagents enabled by operator policy, with opt-outs, inherited authority, attribution rules, and cross-session memory disabled.
- Fleet identity through CLI/MCP/HTTP/prompts/provider metadata/environment/ledger and count-only runtime diagnostics.
- Direct xAI, DeepSeek, Nous Portal, generic OpenAI-compatible, command, and custom adapter paths.
- Hermes' staged reverse connector exposes only read-only status/models/accounts plus Consult/Integrated. Full-agent forward execution is deliberately unavailable because current ACP tools cannot be source-bound or exclude all native configured MCPs. Raw Nous remains the distinct Consult/Integrated inference route.
- In-memory response/thread continuity; Codex config/skills/prompts/examples; security and Windows-oriented support.
- Source-run installer window with component selection, grouped task protection, digest-bound apply, usage estimates, and native-host recovery metadata.
- Versioned one-provider activation plan/apply with explicit component mapping, exact mode/provider/account/model routing, prerequisite gates, live discovery, one bounded request, crash-safe no-retry recovery, config rollback, fresh-uninstall composition, and sanitized receipts.
- Codex Primary, Grok Enhanced, Cursor Standard, and Hermes Preview reverse-host contracts.
- Scoped Streamable HTTP MCP for host connectors; its distinct bearer cannot call `/v1`, and the owner bearer cannot call `/mcp`.
- Connector-private token-file support for MCP shims and Windows `.cmd`/`.bat` process normalization.
- Optional maximum-utilization pure reducer, source-bound selected-account native receipt validation/recheck, process-shared claimed journal/outbox with non-replayable indeterminate outcomes, main-token event surface, sanitized HUD, and disabled-by-default installer component.
- Explicit AgentRouter-through-Claude-Code gateway isolation plus explicit-only, no-spend discovery candidates for Mistral API, GroqCloud, Cloudflare Workers AI, and Gemini API.
- Owner-only Continuity task tree and naming controls with closed opaque projections; schema-v2 cooperative process-shared claim/conflict checks, validated receipt-plus-exact-request evidence, explicit non-replayable recovery, exact successor/predecessor gates, and Goal-free or supported identity/objective/status/accounting parity are implemented offline while Goal lifecycle remains supervisor-owned.
- Durable owner-private global/per-project action items with strict public projection, owner-only completion, one exact-owner delivery outbox entry, and a compact Needs-you HUD rail.
- One-time Electron inspector bootstrap with exact target/launched-source binding, a distinct per-generation timing-safe successor capability, closed HUD/action protocol, event-driven renderer reattachment, cooperative durable crash phases, inspector closure/reappearance proof, exact package/`app.asar` immutability evidence, non-app-owning attach/service semantics, and authenticated supervisor-only rollback.
- Deterministic backend route scoring and one frozen catalog/health snapshot shared by smart selection, the route map, and the canonical picker route list.
- Default-off Grok Build exploration recovery with one exact-session continuation and fail-closed structured provider diagnostics.
- Shared POSIX descendant reaping for direct streaming Command and Claude Code providers after the group leader exits.
- Optional account-first automatic takeover for bridge-routed certified pre-output failures, compatible provider selection, same-daemon disconnect survival, and externally visible recovery state. Cross-process native-host replay still requires a certified host launcher.

## Verification completed

On Linux, the complete 0.6.0 source gate passes: `npm run check` succeeds and the Node suite reports **752 tests, 752 passed, 0 failed, and 0 skipped**. Provider-activation, Compatibility Watch transition, maximum-utilization receipt/dispatch, strengthened Continuity native authority, Electron bootstrap, and Hermes reverse/blocker coverage use local fake/synthetic evidence only; no paid inference or real credential was used. `npm run test:release-bundle` passes **23/23**, and `npm pack --dry-run --json` includes the intended 0.6.0 source/media while excluding `.working` coordination state. A loopback-only true-browser smoke exercised Continuity Rename and confirmed Promote against a synthetic local API: the renamed task refreshed, actionable pending recovery rendered, both controls disabled, the 390px panel had no horizontal overflow, no console warnings appeared, and no native task, Goal, recovery, or operation IDs entered the DOM. This is browser interaction evidence, not exact Linux or Windows native App Server authority. Earlier native Windows/two-host evidence remains provenance only and does not certify the 0.6.0 delta.

## Implemented but not live-certified

| Surface | Implemented confidence | Remaining unknowns |
|---|---|---|
| Cursor SDK Consult/Delegate | Offline lifecycle, race, retention, cancellation, and cleanup coverage; Cursor Consult accepted live on both configured hosts. | Delegate entitlement/model drift/billing; whether some workloads should use official Cursor Cloud Agents. |
| Grok Build Consult/Delegate | Dedicated adapter plus earlier live Consult/MCP startup on both configured hosts; the new default-off one-continuation exploration path is offline-tested. | Live terminal-envelope compatibility for exploration recovery, sustained fleet capacity, nested-agent accounting, consumer weighting, and entitlement drift. |
| Shared Desktop MCP topology | Remote shim/generated config tested against local HTTP servers; one persistent daemon and restart ownership accepted on both configured hosts. | Exact current Desktop picker/profile behavior after future app updates and broader platform packaging. |
| Direct xAI / DeepSeek / Nous | Protocol transforms plus live Nous Consult/Integrated/Delegate on both configured hosts. | Catalog, limits, billing, and account state remain volatile. |
| Hermes reverse Preview | Staged MCP configuration allowlists read-only status/models/accounts plus Consult/Integrated and excludes Delegate/owner controls; raw Nous remains distinct. | Full-agent forward and native recovery are unavailable: current `hermes-acp` tools are not source-bound or narrowable, and enabled native MCPs are included per session. Recheck only after upstream provides verifiable isolation. |
| AgentRouter through Claude Code | Linux and Windows Claude Code 2.1.234 returned `THREADSPAN_AGENTROUTER_OK` through `agentrouter.org` with `claude-opus-4-8` in bounded no-spend probes on 2026-08-18. | Offer/end date is unknown; evidence visibility expires after seven days without a fresh probe. Generic Claude remains Preview and generic OpenAI Chat/Codex are not fallbacks. |
| Mistral/Groq/Cloudflare/Gemini free candidates | Official documentation currently describes free or free-allocation tiers; disabled examples and installer metadata are offline-tested. | Current cardless eligibility, region, model, account, and endpoint must be live-checked before enablement. Cloudflare remains setup-candidate only. |
| Maximum utilization | Offline reducer, full native batch/receipt binding and freshness checks, selection-generation/native-identity commit binding, source-bound host receipts, cross-process outbox claim/CAS, cancellation/lease/crash races, manual separation, auth, installer, and HUD privacy coverage. | Native App Server quota and every requested host capability remain live-uncertified until independently certified on each host; unsupported effects remain unsupported and indeterminate effects require explicit review rather than replay. |
| Continuity controls | Offline schema-v2 migration, cooperative process-shared claim/revision conflict checks, source-bound receipt validation, crash/indeterminate no-replay, exact worker/rw successor, predecessor archive/inactive read-back, Goal-free/objective/status/accounting parity, HTTP privacy, adapter contamination, repeatable no-browser fixtures, and a Linux local true-browser Rename/Promote/recovery/390px privacy smoke. | Exact current Linux and Windows App Server methods/results and Windows browser parity remain separately unverified; no Desktop/provider/service restart or live native call was performed for this delta. |
| Provider activation | Digest-bound CLI/GUI transaction, exact-route raw-API path, fake-executor adversarial tests, terminal replay/rollback, stale-claim recovery, exact sentinel, and fresh uninstall composition are implemented offline. | No paid/live provider request was run for this delta. Nous/OpenRouter and every account/model remain live-uncertified until an exact approved request succeeds. Codex, Cursor, Grok Build, all Delegate routes, and Preview are intentionally blocked because one request/no internal retry/bounded termination is not yet provable. |
| Desktop Compatibility Watch | Disabled-by-default observer plus exact `{platform, product, N, N+1}` ledger, atomic artifact/version recheck, retained N/sidecar, separate attach/protocol/routing/provider/settings outcomes, process-shared claims, transition-bound repair, rollback truth, and sanitized actionable/diagnostic HUD projection are offline-tested. | Linux and Windows transition plans/evidence in this delta are synthetic. Exact installed builds still require separate native manual/passive checks; hashes and simulated outcomes do not certify Settings, Usage, picker, auth, provider inference, or app lifecycle behavior. |
| Electron HUD bootstrap | Exact target/source receipt, private capability/auth, frame/replay bounds, crash phases, inspector closure/reappearance, navigation/window hooks, route-action schema, launch-vs-attach non-disturbance, package/`app.asar` immutability, reconnect, and rollback are offline-tested with synthetic Linux/Windows semantics. | Exact current Linux and Windows Desktop builds remain native-unverified for this transport. Windows ACL/packaged-path behavior, real process ownership, update/restart rebootstrap, renderer navigation, and installed-service reconnect must be accepted independently without disturbing live tasks. |

## Deliberately unsupported or incomplete

1. Cursor Integrated through the SDK; use a raw endpoint for caller-owned tools.
2. Grok Build Integrated; use direct xAI API for caller-owned tools.
3. Supported headless Grok consumer weekly-meter polling.
4. Cross-process takeover of an already-running native host task when no certified host launcher can reconstruct and resume it. Bridge-routed pre-output takeover is implemented; unsupported native replay remains visible and fail-closed.
5. Durable bridge conversation/response state across restart.
6. Persistent Grok ACP outer workers; current outer jobs are fresh and finite, though they may use nested subagents.
7. Official Cursor Cloud Agent pooling; current persistence is daemon-retained SDK agents.
8. Universal multimodal forwarding, Hermes full-agent forward/recovery pending source-bound ACP tool isolation and configured-MCP exclusion, hostile-code containment, multi-user auth, and distributed observability.

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

Suitable as the 0.6.0 source release once the exact clean commit, signed bundle, tag, CI, and public-asset verification gates pass. Claims remain limited to Linux source/release gates, simulated cross-platform coverage, and the local synthetic browser smoke until exact-revision native Linux and Windows checks are recorded separately.
