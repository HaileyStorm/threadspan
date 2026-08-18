# Daemon lifecycle

Threadspan is one shared daemon per user account. Cursor, Grok Build, Codex, and ChatGPT may open and close independently; they do not own the daemon.

`createDaemonServicePlan()` renders a reviewable, hashed lifecycle plan for two
workloads owned as one unit: `threadspan serve` and `threadspan desktop attach`.
Both carry the same opaque owner fingerprint, exact source revision, CLI file
SHA-256, configuration path, and plan digest:

The public lifecycle API is version `1`; service plans use schema version `2`,
while manifests, uninstall plans, claims, and receipts carry their own schema
version plus the same API version. Consumers must validate both fields.
API v1 is a deliberate breaking migration from the earlier unversioned
prototype: no safe compatibility wrapper exists for its caller-selected lock
root or over-broad runtime-success claim, so old plans must be replanned.

- Linux: a `systemd --user` unit with restart-on-failure.
- Windows: two hidden per-user Task Scheduler entries that launch generated
  PowerShell wrappers independently of an SSH or Desktop process. The obsolete
  Startup-folder `.cmd` launcher is not generated or accepted as canonical state.

Both plans bind the normal Threadspan configuration to the installed Node and CLI paths. Planning requires an exact hexadecimal source revision and hashes the CLI preimage; apply rejects a changed CLI. They pass only named environment variables. Provider key values are not written into units, launchers, receipts, logs, or tracked configuration.

Systemd command arguments escape both `%` specifier expansion and `$` environment
expansion before entering `ExecStart`. Windows planning resolves or requires the
published Startup `Threadspan.cmd` predecessor path and fails closed if it exists;
it never deletes or migrates that file.

For an explicitly selected Claude gateway, service planning also imports `providers.<id>.gateway.apiKeyEnv` by name (for example, `AGENTROUTER_API_KEY`). It never writes the value or persists derived `ANTHROPIC_*` variables; those are constructed only in the Claude child at launch. Discovery candidates likewise contribute only their reviewed environment name when their provider is explicitly configured and selected.

The Linux unit deliberately does not use `PrivateTmp`: Delegate workspace paths must identify the same files for the coordinator, daemon, worker, and independent acceptance process.

Managed provider jobs reap residual POSIX process groups after their parent exits. The Linux unit also bounds final control-group cleanup to ten seconds so an imperfect third-party CLI cannot stall an update or restart for systemd's much longer default.

The daemon removes both signal listeners on the first SIGINT or SIGTERM. Leaving the unused listener registered would keep Node alive after an otherwise clean shutdown.

`previewDaemonServicePlan()`, `applyDaemonServicePlan()`, and the separately
digest-bound uninstall plan use the same transaction seam. Apply rechecks the
source and every file preimage, rejects stale, partial, or duplicate lifecycle
ownership, writes atomically, and runs only structured argv through the bounded
killable production runner. Runner injection is restricted to the offline Node
test harness. Apply verifies registered/active state and restores exact preimages when
activation fails. Uninstall removes only matching ownership and restores the
recorded preimages. Receipts contain hashes and command IDs, not environment
values, account identity, command output, absolute paths, PIDs, or owner-local
telemetry.
Terminal uninstall persists the complete sanitized receipt before returning.
Retrying the same approved uninstall plan after a return-path interruption reads
that exact receipt without acquiring a claim or rerunning commands/file changes.

Production apply and uninstall share one exclusive current-user claim under
`~/.threadspan/state/service-lifecycle-claims`, independent of caller-selected
plan/state roots. Synthetic tests can override it only through an injected
runner's visibly test-only claim root. Contenders fail before ownership
inspection or commands. An abandoned
claim is never cleared by PID or age: inspect it with `install service-claim` and
pass its exact digest through `--recover-claim-digest` only after owner review;
the displaced claim is retained as recovery evidence. Matching durable
`prepared`, `activating`, `uninstalling`, and `uninstall-incomplete` states resume
idempotently from exact installed/preimage hashes. Verification requires two
stable service/task samples, two loopback `/health` samples, and repeated
registration-marker reads—not a single transient `active` or `Running`
observation. These checks do not source/owner-bind the listener process. The
durable and receipt status is therefore `applied-pending-runtime-ownership`, with
`evidenceClass=service-registration-and-loopback-health-only` and
`runtimeOwnershipVerified=false`, until separate native proof exists.

This first lifecycle transaction is intentionally clean-install-only: an
existing canonical unit/task or an owner-mismatched artifact is a visible
blocker, not an implicit migration. Existing published installations require a
separately reviewed migration/uninstall path before this plan can replace them.
The source revision is reviewed release provenance and the CLI hash prevents an
in-place entrypoint swap; transitive source/package provenance remains a release
gate rather than something inferred by the service installer.

This repository's default tests inject the runner and are offline evidence only.
An installing agent must still preview the exact local files and commands, then
separately verify `/health`, `/v1/models`, `/v1/continuity`, `/threadspan/state`,
and restart durability on each host. On Windows, stop/restart acceptance must
prove that Task Scheduler owns the replacement daemon rather than leaving an
SSH-owned or detached stale process behind. Do not claim one host from evidence
gathered on the other.

The lifecycle starts or stops Threadspan's daemon and Desktop host process. It
does not close, launch, restart, sign out of, or uninstall Desktop/provider apps.
