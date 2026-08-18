# Optional maximum-utilization mode

Threadspan includes an optional maximum-utilization controller. It is disabled by default. Selecting the installer component writes a safe component document with `enabled: false`; enabling the daemon policy remains a separate operator decision.

Automatic polling also defaults to off. Set both `enabled: true` and `automaticPollingEnabled: true` to poll at the bounded `pollIntervalMs` cadence (30 seconds to one hour). Polls are single-flight and resolve only the currently selected `openai-codex` account through `AccountStore` and its validated non-default isolated `codex-home`.

The daemon calls the official Codex App Server `account/rateLimits/read` method in the same bounded process as `account/read` and consumes `rateLimitsByLimitId` (or the backward-compatible single-bucket view). Each batch binds the selected opaque account and isolated profile, canonical `CODEX_HOME`, exact ordered methods, process and executable identity, argv, raw-result digest, normalized bucket/window results, adapter generation, and source digests. The controller recomputes the closed receipt projection and enforces a two-minute maximum age and five-second future-skew ceiling. Immediately before commit, the adapter acquires the AccountStore selection-generation lock, repeats a source-bound native `account/read`, proves the same native identity/executable/profile, and holds that selection binding through the journal commit. See the [official OpenAI App Server rate-limit contract](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt). Forecasts, local usage ledgers, reset timers, generic HTTP 429 responses, caller-supplied “authoritative” flags, stale batches, and syntactically receipt-shaped input cannot open or recover automatic mode.

## State and persistence

`reduce(state, event, policy)` is pure and performs no I/O. The daemon commits the resulting state and capability-tagged requested actions to an owner-private journal before dispatch. Every outbox key contains the epoch, action type, and a digest of its prerequisites. Restart restores reducer state and replays actions that lack execution evidence.

Before invoking a capability, the journal atomically claims its exact outbox key with a bounded lease under a process-shared file claim. Each capability registration names its expected host-adapter identity. The handler is synchronously entered while that claim lock is still held, so cancellation either wins before invocation or becomes explicit in-flight uncertainty. A successful host must return a self-digested receipt binding that registered host adapter, claim, capability, action digest, idempotency key, automatic/manual dispatch kind, applied status, and bounded start/completion times; only the verified receipt digest is retained. Unsupported host effects remain `unsupported` and are eligible for a later capable adapter. Once invocation might have occurred, an exception, expired lease, concurrent cancellation, malformed receipt, or crash becomes `indeterminate` and is never replayed automatically. Late success or failure cannot change a cancelled or indeterminate entry. A pre-invocation disabled/cancelled action remains `cancelled`; a legacy executed entry without the new receipt digest migrates to `indeterminate` instead of remaining proven.

The process-shared journal claim and expected-state digest prevent stale in-memory daemons from overwriting reducer state or invoking the same claim concurrently. A daemon that loses state CAS reloads the committed reducer state before returning the conflict, so a later operation need not restart the process. Threadspan does not auto-break an orphaned journal claim file; its owner, process, host, and creation metadata support exact host-local review, and automatic mutation fails closed until that review completes. The journal may contain private target identifiers and inbox bodies, while the HUD receives only phase, readiness, epoch, native ratio/time, counts (including claimed and indeterminate actions), and status totals.

## Launch and exhaustion

- The default launch threshold is 96% used.
- The target/monitor/manifest snapshot is canonical and frozen at launch. Each already-running target receives at most one deterministic notice. Dynamic additions are ignored for that epoch.
- At most one preauthorized manifest of idle `continuous` work is requested. The controller does not start milestone or user-driven work.
- A first observation at 100% suppresses notices, manifest work, and Fast. Reaching 100% during an existing epoch adds no new launch actions.
- A newer exact native read for the same provider/account/`limitId` exits either active or exhausted state when usage falls below 96%. Within an adapter generation, batch sequence must increase; across an adapter restart, both process-completion and observation time must be strictly newer. A changed primary/secondary window identity proves a new reset (including weekly resets); a timestamp by itself never does. Owner disable always exits and requests monitor restoration, and suppresses re-entry for the same observed window.

## Protected turns and inbox

During maximum utilization and exhaustion, supervisor messaging, steering, interruption, wake, promotion, rotation, acknowledgement, and check-in requests are denied for protected targets. Explicit user stop and safety authority pass through. Primary/final output observations are provisional and do not end protection.

Future monitor invocations are suspended without interrupting an occurrence already running. Recovery requests a compare-and-swap restore against the preserved baseline. Owner-private inbox messages are sequence-numbered and requested exactly once only at a target's natural checkpoint; the controller does not create a scheduled task, wake, or acknowledgement turn.

## Fast and rollover

At 99% used, one frozen, catalog-eligible Fast turn may be requested. It is a bounded canary, not a survival guarantee. The normal rollover consideration point is 0.78 and moves only to 0.75 while protection is active. A `consider-rollover` action is emitted only after predecessor-stop, single-successor, identity, reservation, quiet-boundary, and no-user-input gates all pass. The controller never promotes a successor.

## Manual full-push

Manual full-push is a separate owner action scoped by a visible provider, app, or account label. Its manifest, cancellation family, and host-receipt dispatch kind remain distinct from automatic generations. The manifest is frozen and capped by `manualManifestMaxEntries`. It has no approaching-limit or reset semantics, does not infer quota, does not launch a Fast canary, and does not use the 0.75 rollover bias. The HUD publishes only the scope kind/label, active state, and manifest count; opaque account IDs and native bucket IDs remain private.

## Host adapter boundary

Current Threadspan composition requests documented capabilities supplied by the host adapter. It does not emulate unavailable task messaging, monitor control, task launch, Fast launch, rollover, or output-phase control. A deployment without authoritative native quota remains observational; a deployment without a matching host capability leaves the corresponding action pending or unsupported.

## Automatic takeover interaction

Automatic takeover is not a maximum-utilization action and cannot consume its protected-task messaging path. A confirmed provider/account limit is journaled by the daemon-owned takeover monitor. It tries one certified same-provider account first; a cross-provider successor is eligible only when the takeover setting and task/smart-route authority allow it and the candidate preserves the required mode, workspace, privacy, context, and configured intelligence floor.

The successor lane never steers, wakes, interrupts, promotes, rotates, or cancels a protected incumbent. Subagents still running remain untouched; failed or not-running children are recovered only after the coordinator and in bounded staggered batches. Exact native reset evidence exits automatic mode, restores ordinary maximum-utilization behavior, and cancels stale queued recovery. Timestamp forecasts alone cannot do so.

There is no arbitrary automatic-event intake. Main-token, loopback-only controls are:

- `POST /v1/maximum-utilization/refresh-native`
- `POST /v1/maximum-utilization/disable`
- `POST /v1/maximum-utilization/manual/enter`
- `POST /v1/maximum-utilization/manual/leave`

The scoped connector token cannot call these controls or read `/threadspan/state`.
