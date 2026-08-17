# Implementation status

**Snapshot date:** 2026-08-16  
**Package version:** 0.2.1  
**Assessment:** substantial alpha / implementation-complete local prototype, not yet live-certified against paid providers or current Desktop builds.

## What is complete

- OpenAI Responses-style buffered/SSE HTTP and convenience Consult/Delegate endpoints.
- MCP stdio tools plus default remote-shim mode, so multiple Desktop processes forward to one persistent daemon; `--embedded-mcp` remains available.
- Cursor snapshot Consult and retained Delegate agents keyed by thread/model/workspace, with TTL/count/serialization/cancellation controls.
- Grok Build finite one-shot Consult/Delegate with executable/version/hash checks, profiles, strict argv, environment reduction, admission, process-tree cleanup, ledgering, and optional linked-worktree policy.
- Grok web/search and nested subagents enabled by operator policy, with opt-outs, inherited authority, attribution rules, and cross-session memory disabled.
- Fleet identity through CLI/MCP/HTTP/prompts/provider metadata/environment/ledger and count-only runtime diagnostics.
- Direct xAI, DeepSeek, Nous Portal, generic OpenAI-compatible, command, and custom adapter paths.
- In-memory response/thread continuity; Codex config/skills/prompts/examples; security and Windows-oriented support.

## Verification completed

`npm run verify` passes:

- **86 offline tests**;
- source syntax checks;
- no network or paid inference calls;
- Linux runtime in the implementation environment.

Version 0.2.1's **39 focused changed-path checks** cover policy defaults/opt-outs, fleet identity, remote MCP authentication/forwarding/errors, asynchronous status, runtime diagnostics, config conflicts, generated Codex shared-daemon routing, and convenience-HTTP normalization with explicit route metadata. The complete established regression suite still runs.

## Implemented but not live-certified

| Surface | Implemented confidence | Remaining unknowns |
|---|---|---|
| Cursor SDK Consult/Delegate | Offline lifecycle, race, retention, cancellation, and cleanup coverage. | Actual entitlement/model IDs/event drift/billing/native Windows; whether some workloads should use official Cursor Cloud Agents. |
| Grok Build Consult/Delegate | Dedicated adapter follows the supplied report and offline lifecycle/accounting/workspace fixtures. | Current entitlement/model/effort/output/capacity, nested-agent accounting, consumer weighting, native Windows. |
| Shared Desktop MCP topology | Remote shim/generated config tested against local HTTP servers. | Exact current Desktop launch environment, picker/profile behavior, updates, and platform packaging. |
| Direct xAI / DeepSeek / Nous | Protocol transforms and proxy contracts tested offline. | Current models, live streams, limits, billing, and account state. |

## Deliberately unsupported or incomplete

1. Cursor Integrated through the SDK; use a raw endpoint for caller-owned tools.
2. Grok Build Integrated; use direct xAI API for caller-owned tools.
3. Supported headless Grok consumer weekly-meter polling.
4. Automatic retries or cross-provider failover.
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

## Release recommendation

Suitable for a controlled personal workstation, Desktop/Codex prototyping, selective Consult, and bounded Grok/Cursor Delegate pilots. Before stronger claims, run `docs/TESTING.md` live checks and certify the actual accounts and native Desktop builds.
