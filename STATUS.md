# Implementation status

**Snapshot date:** 2026-08-18
**Package version:** 0.5.0 release candidate
**Assessment:** 0.4.2 remains the current signed public release. The 0.5.0 candidate has Linux source-gate evidence and live app-attached ChatGPT/Codex Desktop HUD acceptance on Linux and Windows, including real picker selection and owner-authenticated route read-back. It adds bounded Grok exploration recovery, the owner-only Needs-you action surface, canonical route ranking/picker projection, streaming-provider descendant reaping, Continuity read-back, a separately approved provider-activation successor transaction, and refreshed privacy-reviewed media.

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
- Versioned one-provider activation plan/apply with explicit component mapping, exact mode/provider/account/model routing, prerequisite gates, live discovery, one bounded request, crash-safe no-retry recovery, config rollback, fresh-uninstall composition, and sanitized receipts.
- Codex Primary, Grok Enhanced, Cursor Standard, and Hermes Preview reverse-host contracts.
- Scoped Streamable HTTP MCP for host connectors; its distinct bearer cannot call `/v1`, and the owner bearer cannot call `/mcp`.
- Connector-private token-file support for MCP shims and Windows `.cmd`/`.bat` process normalization.
- Optional maximum-utilization pure reducer, private durable journal/outbox, main-token event surface, sanitized HUD, and disabled-by-default installer component.
- Explicit AgentRouter-through-Claude-Code gateway isolation plus explicit-only, no-spend discovery candidates for Mistral API, GroqCloud, Cloudflare Workers AI, and Gemini API.
- Owner-only Continuity task tree and naming controls with opaque handles; guarded promotion works with or without an existing native Goal and delegates Goal transfer to the certified supervisor.
- Durable owner-private global/per-project action items with strict public projection, owner-only completion, one exact-owner delivery outbox entry, and a compact Needs-you HUD rail.
- Deterministic backend route scoring and one frozen catalog/health snapshot shared by smart selection, the route map, and the canonical picker route list.
- Default-off Grok Build exploration recovery with one exact-session continuation and fail-closed structured provider diagnostics.
- Shared POSIX descendant reaping for direct streaming Command and Claude Code providers after the group leader exits.
- Optional account-first automatic takeover for bridge-routed certified pre-output failures, compatible provider selection, same-daemon disconnect survival, and externally visible recovery state. Cross-process native-host replay still requires a certified host launcher.

## Verification completed

On Linux, the complete 0.5.0 candidate source gate passes: `npm run check` succeeds and the Node suite reports **689 tests, 689 passed, 0 failed, and 0 skipped**. Provider-activation coverage uses local fake executors only; no paid inference or real credential was used. `npm run test:release-bundle` passes **23/23**, and `npm pack --dry-run --json` includes the intended 0.5.0 source/media while excluding `.working` coordination state. A loopback-only synthetic browser smoke rendered the desktop HUD, picker, route map, and 390px layout with no console warnings; the Needs-you rail stacked below Continuity without horizontal overflow. The earlier 0.4.1 revision passed 43 focused native Windows tests and the configured two-host live matrix, but that evidence does not certify the 0.5.0 delta.

## Implemented but not live-certified

| Surface | Implemented confidence | Remaining unknowns |
|---|---|---|
| Cursor SDK Consult/Delegate | Offline lifecycle, race, retention, cancellation, and cleanup coverage; Cursor Consult accepted live on both configured hosts. | Delegate entitlement/model drift/billing; whether some workloads should use official Cursor Cloud Agents. |
| Grok Build Consult/Delegate | Dedicated adapter plus earlier live Consult/MCP startup on both configured hosts; the new default-off one-continuation exploration path is offline-tested. | Live terminal-envelope compatibility for exploration recovery, sustained fleet capacity, nested-agent accounting, consumer weighting, and entitlement drift. |
| Shared Desktop MCP topology | Remote shim/generated config tested against local HTTP servers; one persistent daemon and restart ownership accepted on both configured hosts. | Exact current Desktop picker/profile behavior after future app updates and broader platform packaging. |
| Direct xAI / DeepSeek / Nous | Protocol transforms plus live Nous Consult/Integrated/Delegate on both configured hosts. | Catalog, limits, billing, and account state remain volatile. |
| AgentRouter through Claude Code | Linux and Windows Claude Code 2.1.234 returned `THREADSPAN_AGENTROUTER_OK` through `agentrouter.org` with `claude-opus-4-8` in bounded no-spend probes on 2026-08-18. | Offer/end date is unknown; evidence visibility expires after seven days without a fresh probe. Generic Claude remains Preview and generic OpenAI Chat/Codex are not fallbacks. |
| Mistral/Groq/Cloudflare/Gemini free candidates | Official documentation currently describes free or free-allocation tiers; disabled examples and installer metadata are offline-tested. | Current cardless eligibility, region, model, account, and endpoint must be live-checked before enablement. Cloudflare remains setup-candidate only. |
| Maximum utilization | Offline reducer, persistence/replay, auth, installer, and HUD privacy coverage. | A native quota receipt adapter and each requested host capability must be certified separately on every host; unsupported effects remain pending/unsupported. |
| Provider activation | Digest-bound CLI/GUI transaction, exact-route raw-API path, fake-executor adversarial tests, terminal replay/rollback, stale-claim recovery, exact sentinel, and fresh uninstall composition are implemented offline. | No paid/live provider request was run for this delta. Nous/OpenRouter and every account/model remain live-uncertified until an exact approved request succeeds. Codex, Cursor, Grok Build, all Delegate routes, and Preview are intentionally blocked because one request/no internal retry/bounded termination is not yet provable. |
| Desktop Compatibility Watch | Disabled-by-default local observer, `compatibility doctor --after-update`, daemon polling lifecycle, bounded Linux/Windows probes, sanitized HUD state, and rollback-gated repair are offline-tested. | Exact installed Codex/ChatGPT Desktop builds still require separate native smoke on Linux and Windows; hashes do not certify Settings, Usage, picker, auth, or app lifecycle behavior. |

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

Suitable as a 0.5.0 source release after the final clean-commit and publication gates. The configured Linux and Windows hosts passed the earlier 0.4.1 live matrix; 0.5.0 claims are limited to the Linux source/release gates, simulated cross-platform coverage, and synthetic browser smoke until exact-revision native checks are recorded.
