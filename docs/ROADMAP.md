# Roadmap

Priorities are ordered by risk reduction and usefulness. This roadmap starts after 0.4; the older 0.2.1-era sections below remain only as historical design context and may include shipped work.

## P0 — post-0.4 safe maintenance

1. Expand Compatibility Watch into one plan-first maintenance surface for Threadspan, provider apps, and safe user-owned PC upkeep.
2. Require an allowlist, exact preview, active-work check, rollback, bounded runtime, and post-health proof before any automatic action.
3. Never surprise-upgrade, restart apps, touch projects or credentials, or turn a provider on because a newer version exists.
4. Refresh dated provider, model, card-free, and host evidence; keep Unknown visible when a live check is absent.
5. Rebuild, sign, clean-install, and verify every public release artifact.
6. Retire shipped or superseded 0.2.1 roadmap items after preserving useful provenance.
7. Add a collapsed, host-neutral Continuity task tree: logical/origin task first, selected active generation highlighted, prior and successor mains nested, and navigation/rollover controls only behind verified native host authority. Never rewrite an undocumented native chat list.

## P0 — live certification and release packaging

1. Run the focused live matrix on the user's Windows workstation and Ubuntu environment.
2. Record exact compatible versions of Node, Codex/ChatGPT Desktop, Cursor SDK, Grok Build, Hermes, and current APIs.
3. Verify Grok CLI account identity/entitlement, model list, effort values, JSON terminal shape, permission matching, and process-tree cancellation.
4. Canary Grok capacity rather than assuming the bundled report's six-active/18-turn calibration is stable.
5. Verify direct xAI API team model availability, function-call continuity, exact cost ticks, and rate-limit policy.
6. Add an opt-in redacted live-smoke harness with explicit cost ceilings and no default paid calls.
7. Decide repository/package naming before public publication; internals are provider-neutral even though the current name references Cursor/Codex.

## P1 — durable state, worker recovery, and accounting

1. SQLite or append-only journal for response/thread continuity.
2. Versioned schema, bounded migrations, retention, and OS-protected/encrypted sensitive state.
3. Restart-safe Consult threads and Cursor Delegate resume where the SDK supports reliable local handles.
4. Durable worker reservations with PID plus creation identity and restart reconciliation to `abandoned`/verified-dead state.
5. Explicit job/thread list, inspect, cancel, and delete commands that expose metadata without prompt bodies by default.
6. Persistent provider budget policy by day/week/month, including exact API spend ceilings.
7. Optional operator-entered/browser-assisted Grok weekly-usage snapshots and reconciliation against the local ledger.

## P1 — stronger execution boundaries

1. Git-object/archive snapshot creation for consistent point-in-time Consult copies.
2. Optional snapshot manifest/hash and post-run mutation proof.
3. Automatic branch/worktree creation, unique job state directory, rollback on partial setup, and bounded cleanup.
4. Post-run diff/status/commit-ancestry report generated independently of the worker.
5. OS/container/VM runner for command providers and managed workers.
6. Windows Job Object helper for stronger descendant control than `taskkill` where needed.
7. Structured command/permission policy instead of opaque string-pattern rules; reject shell metacharacters and validate path arguments.

## P1 — provider completeness

1. Grok ACP adapter only where resumable steering materially improves the Desktop experience; keep one-shot headless mode as the default.
2. Reconsider Hermes full-agent forward support only after upstream provides verifiable source-bound/narrowable ACP tools and exact configured-MCP exclusion; then rebuild adversarial offline coverage and native-certify independently on Linux and Windows, including exact process-restoration semantics.
3. Cursor cloud runtime adapter with lifecycle, reconnect, archive/delete, branch/PR reporting, and cancellation.
4. Generic upstream OpenAI Responses adapter, distinct from Chat Completions.
5. Anthropic Messages and other raw-provider adapters when a reviewed auth/billing path is intentionally supported.
6. Cached capability/model/effort canaries with explicit source, timestamp, and confidence.
7. Per-mode model aliases and task profiles, e.g. cheap mechanical worker, strong adjudicator, fast raw Integrated model.

## P2 — Desktop and client integration

1. Validate and refine current ChatGPT/Codex Desktop provider/profile/model-picker behavior.
2. Implement a Codex++-style Desktop augmentation that consumes the bridge's provider/model/capability surface without rewriting bridge semantics.
3. Surface provider, model, mode, task profile, effort, finite turn cap, admission/usage state, and worker status in the Desktop UI.
4. Add per-turn mode override while retaining thread defaults.
5. Add visible managed-worker queue, cancellation, evidence, and independent-acceptance status.
6. Small local status/config UI or tray process only where Desktop augmentation cannot cover lifecycle control.
7. Windows service/task installer and systemd user unit.
8. Streamable HTTP MCP in addition to stdio.
9. Package Cursor, Codex, and other host skills/plugins rather than only copyable examples.

## P2 — orchestration

1. Multi-consult fan-out with blind independence and primary synthesis.
2. Structured adjudication: claims, evidence, disagreements, confidence, and proposed discriminating tests.
3. Provider-neutral authoritative task packets that can be reassigned without changing acceptance truth.
4. Conditional Consult triggers based on uncertainty, failure, risk, or review stage.
5. Explicit Delegate acceptance gate that independently checks diff/status/tests before a result is marked accepted.
6. Work decomposition across non-overlapping worktrees with one global provider admission controller.
7. Effort/profile optimization based on accepted-output cost, correction rate, and coordinator review time—not token count alone.
8. Provider fallback only through an explicit semantic/privacy/cost policy.

## P2 — protocol breadth and observability

1. Native image/file forwarding per provider.
2. More Responses item types and structured-output support.
3. Resumable SSE/event IDs for long runs.
4. OpenTelemetry/metrics for queue delay, active jobs, provider turns, acceptance rate, corrections, and spend.
5. Signed/hashed evidence bundles and configurable retention/redaction.
6. Better usage/cost normalization while retaining provider-specific raw accounting.

## P3 — multi-user service

Only after the local personal tool is stable:

- identity and tenant separation;
- per-user provider authorization and quotas;
- TLS/secret management;
- distributed state/locks;
- audit and incident-response policy;
- hardened worker isolation;
- deployment/upgrade/rollback tooling.

That is a different product boundary and should not emerge accidentally from the loopback personal daemon.


## Provider-runtime extensions kept out of 0.2.1

- **Grok ACP resident-worker pool:** add only after a strict ACP client, restart reconciliation, nested-call accounting, and native Windows process tests exist. Current Grok outer jobs remain finite one-shot runs.
- **Official Cursor Cloud Agent adapter:** distinguish cloud-run lifecycle/retention from the existing local SDK-agent pool before claiming persistent cloud workers.
- **Durable shared thread state:** persist convenience threads, Responses lineage, retained-agent handles, and job recovery across daemon restarts.
