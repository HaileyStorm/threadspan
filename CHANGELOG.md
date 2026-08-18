# Changelog

## 0.4.2 - 2026-08-18

- Added `CURSOR_API_KEY` to the starter Cursor CLI's explicit child-environment allowlist. This preserves API-key authentication under the 0.4.1 minimal-environment hardening without restoring broad daemon credential inheritance.

## 0.4.1 - 2026-08-18

- Added a compact native Continuity task tree with opaque handles, task naming, goal-free promotion, and source-matched successor/Goal reconciliation through the certified supervisor.
- Added optional bridge-routed automatic takeover: one certified same-provider account first, then a live compatible provider for smart or explicitly opted-in routes; explicit accounts stay fixed by default.
- Added same-daemon disconnect survival, stable failure identities, visible recovery state, exact-reset shutdown, bounded late-subagent recovery, and maximum-utilization protection against a second writable Delegate.
- Added optional all-user Copy review with local readability checks, protected-span enforcement, Voice preservation, and separately configured provider rewriting that never auto-applies.
- Added a separate, default-off External copy check policy with owner-only HTTP, HUD manual Pangram handoff, documented Sapling/Winston environment-key adapters, and a user-started release companion. Offline-tested only; not live-certified.
- Prevented computer/screenshot metadata, signed media references, upstream error bodies, private key material, high-confidence secrets, and unintended personal data from entering routed transcripts, logs, or release bundles.
- Added the owner-only Continuity/takeover/copy controls and a compact HUD presentation without exposing native task, Goal, account, receipt, or recovery identifiers.
- Moved trusted CI to a repository-scoped self-hosted Linux runner and disabled GitHub-hosted and untrusted pull-request execution; release acceptance still requires a green run on the exact release commit.
- Added a reproducible build report and chart based on local task/provider ledgers, with cached, uncached, output, and reasoning tokens separated.

## 0.4.0 - 2026-08-18

- Renamed the broader bridge and orchestration project to Threadspan.
- Added one authenticated daemon for Codex, Grok Build, Cursor, Nous, OpenRouter, and optional Claude Code gateways.
- Added explicit Consult, Integrated, and Delegate boundaries with provider-specific tool and workspace policy.
- Added Grok fleet admission/accounting, Cursor CLI/SDK routes, direct Nous Consult/Integrated plus bounded Delegate, OpenRouter discovery, and dated AgentRouter support.
- Added account-aware routing, quota/renewal visibility, compatible fallback, and optional maximum-utilization policy.
- Added a compact HUD/picker with search, favorites, filters, hiding, manual order, provider links, usage, forecasts, and route-map visualization.
- Added a source-run setup window with task protection, exact preview, signed release updates, theme/accent controls, rollback, and proof.
- Added Codex, Grok, and Cursor reverse surfaces; Hermes remains status/models/Consult Preview only.
- Added context profiles, request-local Continuity handoffs, Voice profiles, optional Tips, Beads, and project bootstrap.
- Added Compatibility Watch and bounded direct/meta/meta-meta self-heal across coding and non-code task types.
- Added explicit-only Codex Full Access configuration without enabling destructive/open-world capabilities.
- Fixed Windows command shims, PowerShell transport limits, detached service restart, and Claude Code file-backed MCP configuration.
- Verified the Linux source gate at 434/434 and completed revision-specific live provider checks on Linux and Windows.

## 0.2.1 — 2026-08-16

Focused fleet/orchestration follow-up to the Grok Build findings-report merge. No provider, mode, endpoint, or existing workflow was removed.

### Added

- Shared-daemon MCP proxy mode so multiple ChatGPT/Codex Desktop coordinators and their subagents use one provider registry, one Grok admission controller/ledger, and one retained Cursor-agent pool.
- Positive Grok execution-policy controls: `allowSubagents` and `allowWebSearch`, both enabled by default under the operator's explicit policy, with per-job and legacy negative opt-outs.
- Coordinator/worker-group identity fields across CLI, MCP, convenience HTTP, task packets, provider metadata, and Grok lifecycle records.
- Count-only provider runtime diagnostics, including Grok admission/ledger state and retained Cursor Delegate-agent counts.
- A nine-outer-worker fleet preset and multi-coordinator operating guide; the generic starter remains at the report-derived six-active conservative default.
- Focused tests for remote MCP proxying, policy resolution, fleet metadata, asynchronous status, configuration conflicts, runtime diagnostics, and generated Codex MCP routing.
- Restored convenience-HTTP managed-worker normalization coverage, which exposed and fixed route-prefix stripping when explicit provider/mode metadata is also present.

### Boundary decisions

- Grok Build remains a finite one-shot managed worker by default. Nested Grok subagents may run inside the parent job, but inherit its exact workspace, scope, authority, deadline, and validation contract.
- Web/search is permitted by default for Grok jobs. External content is treated as untrusted evidence, must be attributed, and cannot enlarge repository or integration authority.
- Cross-session Grok memory remains disabled by default.
- Nine configured outer worker slots are an operator fleet preset, not a claimed provider guarantee. All outer workers share the rolling admission budget.
- Cursor Delegate agents are retained per thread/model/workspace in the shared daemon. This is local Cursor SDK-agent retention with provider-backed inference, not a claim that official Cursor Cloud Agent jobs are pooled.

### Verification

- `86` offline tests plus source syntax checks pass.
- The focused changed-path set passes `39/39` checks.
- No paid/network provider calls are made by the automated suite.

## 0.2.0 — 2026-08-16

Targeted report-driven provider and worker-safety expansion.

### Added

- Dedicated Grok Build CLI adapter for Consult and Delegate.
- Direct xAI API raw-model configuration for Consult/Integrated.
- Grok profiles, reasoning effort, finite turn caps, no-plan, acceptance-command metadata, and CLI/MCP controls.
- Executable path/version/SHA-256 preflight and optional pin enforcement.
- Weighted provider admission with expected-to-actual model-turn reconciliation.
- Private JSONL worker ledger, evidence hashes, and opt-in raw evidence.
- Git linked-worktree/clean-start/denied-branch Delegate policy.
- Process-tree termination and environment allowlisting shared with command providers.
- Namespaced provider metadata in Responses, convenience API, CLI JSON, and MCP structured results.
- Managed Worker skill, references, Grok prompts, dedicated guide, and preserved findings report.
- Public exports for the Grok adapter and reusable worker-control primitives.

### Correctness and hardening

- Grok Build Integrated is rejected explicitly rather than substituted with an agent loop.
- Model and effort values never silently fall back.
- Quota/rate/entitlement and malformed-output failures are terminal; Grok performs no automatic retry.
- JSON quota errors written to stderr are parsed and classified.
- Wrapper `commandArgs` are applied exactly once to version/model/job invocations.
- Admission can reconcile zero terminal model calls without corrupting provider cleanup.
- Direct xAI example disables pre-output streaming fallback to avoid duplicating quota/rate failures.
- Cache-read and reasoning tokens remain distinct; exact xAI cost ticks are preserved without guessed conversion.

### Verification

- Expanded changed-path coverage to 76 offline tests, all passing.
- No paid/network provider calls in the automated suite.

## 0.1.0 — 2026-08-16

Initial implementation package.

### Added

- Consult / Integrated / Delegate mode model.
- OpenAI Responses-compatible HTTP bridge and SSE lifecycle.
- MCP stdio server with Consult, Delegate, status, and model discovery.
- Cursor SDK Consult snapshots and retained Delegate agents.
- DeepSeek V4 thinking/tool compatibility.
- Nous Portal support through Hermes' subscription proxy.
- Generic OpenAI-compatible and command-backed providers.
- Codex managed configuration and Consult skill installation.
- Windows-oriented scripts and Cursor/Codex host-project examples.
- In-memory thread/response continuity.
- Security, architecture, protocol, provider, testing, and roadmap documentation.
- 56-test offline verification suite.

### Correctness and hardening included before release

- Same-thread serialization without cross-thread blocking.
- Cursor Delegate first-call creation deduplication.
- Abort-safe queued Delegate and Consult calls.
- Concurrent MCP dispatch so cancellation can be processed in flight.
- Serialized/backpressured MCP and SSE writes.
- CORS preflight handling before bearer authentication.
- Split-CRLF-safe SSE parsing.
- Bounded request bodies, request timeouts, output limits, and graceful shutdown.
- Cross-platform executable lookup in `doctor`.
- Current MCP protocol negotiation with tool-execution errors returned as tool results.
- Snapshot-local rewrite of copied internal symlinks and canonical rejection of external symlink chains.
- Bounded, credential-redacted opt-in body logging.
- Human CLI continuity IDs on stderr and complete JSON results via `--json`.
- DeepSeek/Nous default endpoint validation aligned with their adapters.
- Starter config drift test and exact Cursor SDK dependency pin.
- Normalized malformed command output and missing-executable failures.
- Installed npm bin symlink detection so the packaged `cursor-bridge` CLI actually executes its entry point.
