# Implementation package delivery report

**Package:** `cursor-codex-bridge` 0.2.1  
**Snapshot:** 2026-08-16  
**State:** substantial alpha; complete for offline/local prototyping, with live-provider/Desktop certification pending.

## Retained without reduction

All 0.2.0 functionality remains: mode semantics; Responses HTTP/SSE; MCP; Cursor snapshot Consult and retained Delegate; Grok Build/direct xAI; DeepSeek; Nous/Hermes; generic/command adapters; continuity; Codex setup; skills/prompts/examples; worktree gates; admission; ledgers; Windows/Ubuntu architecture; and independent acceptance.

## Added or changed in 0.2.1

- Thin MCP-to-daemon proxy by default, centralizing all Desktop coordinator trees.
- Grok `allowSubagents` and `allowWebSearch` default true under the explicit operator policy; per-job and legacy negative opt-outs remain.
- Cross-session Grok memory stays off; nested agents inherit parent authority; web evidence is attributed/untrusted.
- `coordinator_id` and `worker_group` propagate through every relevant call and telemetry layer.
- Count-only daemon runtime diagnostics for Grok admission/ledger and retained Cursor agents.
- Fleet example for two or more coordinator trees, nine outer Grok slots, and retained Cursor agents behind one daemon; normal default remains six outer jobs.
- Codex config defaults to the shared daemon and retains `--embedded-mcp`.
- Source-preserving findings merge map and multi-coordinator guide.

## Verification evidence

`npm run verify` passes **86/86 offline tests** plus source syntax checks. The **39/39 changed-path checks** target Grok policy/opt-outs, fleet identity, remote MCP auth/forwarding/errors/status, runtime diagnostics, config conflicts, generated Codex routing, and convenience-HTTP normalization/route parsing. Packaging adds a clean install, CLI/import/mock smoke, ZIP integrity, extracted verification, and SHA-256 checks. No paid call is automated.

## Honest limits

Nine outer workers are an operator preset, not a universal provider limit; nested calls may not be perfectly exposed in terminal accounting. Grok weekly usage still needs provider-meter reconciliation. Cursor persistence means retained SDK agents, not certified Cursor Cloud Agent jobs. Desktop picker behavior, native Windows provider processes, live provider events, and restart-durable state remain uncertified/incomplete.

See `README.md`, `docs/GROK-REPORT-MERGE.md`, `docs/MULTI-COORDINATOR-FLEET.md`, `docs/TESTING.md`, and `STATUS.md`.
