# Grok findings-report merge map

This file records how the supplied `docs/research/GrokReport.md` changed versions 0.2.0–0.2.1. The original report is retained unchanged. The bridge's existing Consult / Integrated / Delegate semantics remain authoritative.

## Applied directly

| Finding | Package change |
|---|---|
| Grok Build is a provider-owned coding harness with model, effort, finite-turn, headless JSON, permission, sandbox, memory, web, subagent, session, MCP, and ACP controls. | Added a dedicated `grok-build` adapter for Consult and Delegate. It invokes structured argv in finite one-shot mode and rejects Integrated explicitly. |
| Mechanical, bounded multi-file, diagnosis, and difficult work benefit from different effort/turn policies. | Added `mechanical`, `balanced`, `diagnose`, and `deep` profiles plus request-level `profile`, `reasoningEffort`, `maxTurns`, `expectedTurns`, and `noPlan`. |
| CLI identity, installed model, effort support, version, and binary identity can drift. | Added non-consuming executable resolution, version/SHA-256 inspection, optional pin enforcement, optional model discovery, strict-model-list policy, and doctor output. No account-specific hash is bundled as a universal pin. |
| Safe automation needs one global admission point rather than uncoordinated worker processes. | Added reusable weighted FIFO admission covering active jobs, launch spacing, rolling starts, expected model-turn reservations, terminal reconciliation, queue bounds, cancellation, and diagnostics. |
| Per-job terminal JSON is useful even though it cannot reconstruct the consumer weekly percentage. | Added a private append-only lifecycle/usage ledger, cache-read/reasoning/model-call/cost normalization, evidence hashes, and opt-in raw evidence. |
| Quota, entitlement, and rate failures should not be retried implicitly. | Grok failures are classified and terminal; the adapter performs no automatic retry. JSON written on stderr is parsed. |
| Multiple writable agents must not share a checkout, and worker self-report is not acceptance. | Delegate can require Git, a linked worktree, a clean start, and a non-canonical branch. Added the provider-neutral `managed-worker` skill and independent-acceptance checklist. |
| Child-process leaks and overbroad inherited environments are harness risks. | Added managed descendant termination and optional environment allowlists, shared by Grok and generic command adapters. |
| Direct xAI API usage has a different authority/accounting boundary from Grok Build. | Added a separate disabled `xai-api` raw-model example for Consult/Integrated and preserved exact `cost_in_usd_ticks` when returned. |

## Applied as configurable canary guidance

The report's observed `grok-4.6` availability, six useful overlapping workers, 1.4-second launch spacing, and 18-turn rolling safety budget are represented as starter values and documented canaries. They are not labeled service guarantees. Model IDs, effort values, entitlement, rate behavior, and safe capacity must be rechecked after account, client, model, or subscription changes.

## Deliberately not automated

- **Consumer weekly-usage percentage:** the report found no supported machine-readable endpoint. The package records local telemetry and requires an operator/provider-meter reconciliation rather than scraping or inventing a conversion.
- **Automatic retries:** retries can consume opaque quota and duplicate side effects. A coordinator must explicitly authorize any bounded retry.
- **Automatic worktree creation or integration:** the bridge validates the supplied workspace but does not merge, push, rebase, tag, or declare acceptance.
- **Acceptance-command permission generation:** exact commands are carried in the task/evidence contract, but opaque command strings are not transformed into broad CLI allow rules.
- **ACP as the default:** one-shot headless mode is simpler and safer for bounded tasks. ACP remains future work for cases that genuinely need steering or resume.
- **Cross-session memory:** remains disabled by default.
- **Subagents and web/search:** the operator explicitly overrode the report's conservative defaults. Version 0.2.1 enables both, keeps per-job opt-outs, requires inherited nested-agent boundaries, and treats web content as untrusted attributed evidence.
- **Another machine's executable hash or account limits:** preserved only in the original report for provenance, never silently enforced.

## Retained functionality

No existing provider or mode was removed. Cursor snapshot Consult and retained-agent Delegate, DeepSeek V4, Nous Portal raw inference, generic OpenAI-compatible endpoints, command providers, Responses HTTP/SSE, MCP, Codex configuration, the in-thread Consult skill, and Windows/Ubuntu architecture remain available.


## 0.2.1 fleet follow-up

The operator reported a working topology with nine Grok workers (each able to use subagents), two ChatGPT coordinators (each with several subagents), and persistent Cursor agents for long-running research/retrieval. The package applies the generalizable parts without treating that one environment as a universal provider limit:

- default MCP integrations now proxy to one persistent daemon;
- Grok web/search and subagents are allowed by default, with explicit opt-outs;
- coordinator/worker-group identity is durable in prompts and local telemetry;
- provider runtime counters expose whether admission and retained-agent pools are actually centralized;
- an example fleet profile permits nine outer Grok slots but preserves one 18-turn rolling controller;
- Cursor Delegate agents remain retained per thread/model/workspace in that daemon;
- true Grok ACP resident pools and official Cursor Cloud Agent pooling remain separately documented future adapters rather than implied claims.
