# Changelog

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
