# Installation

The deterministic installer is wired into the CLI and source-run setup window.

Use `threadspan install gui` for the guided flow. Use `threadspan install plan` and `threadspan install apply` for automation. Both use the same component registry, digest, backups, atomic writes, and rollback manifest.

## Canonical fresh install

The shared fresh-install coordinator closes component files, initial config and
credentials, and the per-user service lifecycle under one versioned parent
plan. CLI and GUI hooks serialize the same plan object; child plans are embedded
byte-for-byte and their digests are bound into the parent digest.

```text
threadspan install fresh-plan --root PATH --config PATH --owner-token-file PATH --connector-token-file PATH --output fresh-plan.json [--component ID ...] [--provider ID ...] [--source-root PATH] [--service-directory PATH] [--state-root PATH]
threadspan install fresh-apply --plan fresh-plan.json --approve-digest SHA256 --approve-task-protection-digest SHA256
threadspan install fresh-uninstall-plan --install-plan fresh-plan.json --output fresh-uninstall.json
threadspan install fresh-uninstall --plan fresh-uninstall.json --approve-digest SHA256
```

`fresh-plan` never accepts `--source-revision`. It derives the service revision
from either an exact clean Git `HEAD` equal to the inspected official
`origin/main` tracking ref, or owner-local staged provenance written after
publisher-signature verification. Source-run Git evidence binds the full commit
tree but is explicitly not a publisher signature; published installs use the
signed-bundle path. Bundle provenance is accepted
only when the signed checksum-manifest bytes carried exactly one
`# threadspan-source-commit COMMIT` record; older staged bundles remain usable by
the existing installer but are not provenance-complete enough for fresh apply.
The staged updater retains the authenticated archive, checksum manifest, and
signature. Planning and apply verify the pinned publisher-key fingerprint,
archive digest, and every extracted regular-file path and hash before trusting
the source commit.

The owner API token and connector-only MCP token are independent 32-byte random
values generated only after apply owns the exclusive parent claim. Plans,
previews, journals, receipts, stdout, and logs contain paths and scopes but never
token values. The files are create-only, exact `0600` on POSIX, and referenced
separately from the initial config. Existing config or token targets fail closed;
there is no force flag, overwrite, implicit migration, or same-file reuse.
Windows plan rendering remains available for offline parity, but native fresh
apply currently fails closed before any write because Node cannot guarantee an
owner-only ACL atomically at secret-file creation. The reviewed ACL hardening and
read-back implementation is retained for the future native helper; it is not yet
Windows acceptance.

Fresh apply serializes through one canonical current-user claim and is resumable
through a bounded owner-local journal. A later failure
reverses service lifecycle, component files, config, connector token, and owner
token in that order. Component and service rollback each have a separately
digest-bound child plan and terminal replay. A completed parent receipt remains
`applied-pending-provider-and-host-activation`: offline setup does not prove
provider authentication, runtime reachability, live inference, or host-surface
activation. Provider evidence reports each dimension and a closed reason code;
a descriptor alone is never `ready`.

Production apply rejects a plan created for another native platform. Synthetic
Linux/Windows planning remains useful for offline tests, but it is not host
acceptance. Fresh apply does not close, restart, launch, or kill ChatGPT Desktop
or provider applications. Task protection is digest-bound and must be approved
before mutation.

Daemon/Desktop-host lifecycle is a separate approval boundary because it writes
user service definitions and executes activation commands. Use:

```text
threadspan install service-plan --root PATH --output service-plan.json --source-revision REVISION --lifecycle-owner OPAQUE_ID
threadspan install service-apply --plan service-plan.json --approve-digest SHA256
threadspan install service-uninstall-plan --manifest PATH --output uninstall-plan.json
threadspan install service-uninstall --plan uninstall-plan.json --approve-digest SHA256
threadspan install service-claim
```

`--lifecycle-owner` is an opaque local lifecycle identifier; only its SHA-256
fingerprint enters the plan or receipts. Planning hashes the exact CLI file and
requires an exact hexadecimal source revision. Service apply/uninstall recheck
their digests, source/preimage bindings, ownership, activation status, and exact
rollback material. Windows uses Task Scheduler; the older Startup-folder
launcher is manual-recovery provenance only and is not installed.

The current service lifecycle is clean-install-only. It rejects any existing
canonical task/unit, including matching ownership, rather than guessing at an
in-place migration. The revision is supplied from reviewed release provenance;
the installer independently binds the CLI bytes, while transitive artifact/source
attestation remains part of the release process.

Lifecycle API version `1` uses service-plan schema `2`. Apply/uninstall serialize
through one current-user canonical claim namespace regardless of plan/state root
and resume exact durable transitional states. A
claim collision is not automatically stale. After reviewing the sanitized
`service-claim` result, rerun apply/uninstall with
`--recover-claim-digest SHA256`; the previous claim remains in local history.
Synthetic or cross-host Windows planning must pass `--legacy-startup-path` so
the published Startup predecessor check is bound into the digest.

API v1 explicitly rejects the earlier unversioned prototype instead of adapting
its unsafe lock namespace or runtime-success semantics. Successful deterministic
activation returns `applied-pending-runtime-ownership`, not `applied`: stable
service/task state and loopback health do not prove that the listener belongs to
the reviewed source/owner. Uninstall receipts bind the separately approved
uninstall plan ID/digest and list verified deactivation, absence, and finalization
command IDs.
An `uninstalled` manifest retains that sanitized terminal receipt, so retrying
the same approved uninstall plan is an exact read-only replay rather than a
second uninstall.

The GUI is loopback-only and uses a short-lived installer session created through the authenticated daemon. It never receives provider credentials.

The GUI controller exposes the shared fresh plan/apply hooks only when its
authenticated native helper supplies reviewed source, config, token, state, and
service paths. The current `threadspan install gui` command still requires an
already authenticated daemon configuration, so native zero-state GUI bootstrap
remains an explicit residual rather than a simulated success. The legacy
component-only path retains its older Desktop-closure approval; the shared fresh
path removes that obsolete approval and never closes or restarts Desktop/provider
apps.

Host-specific MCP/plugin writes are generated from neutral descriptors and merged with existing configuration. Do not replace unrelated MCP servers. Back up the exact host file before mutation and keep credentials in environment/provider-native state.

## Explicit provider discovery

`agentrouter-free`, `mistral-api-free`, `groqcloud-free`, `cloudflare-workers-ai-free`, and `gemini-api-free` are explicit-only. Defaults and `selection: "all"` exclude them. Without recent ready evidence they stay collapsed under **Add providers**. Selecting one adds only a disabled, digest-bound component document and prerequisites; it does not sign up, create credentials, install an app, open a browser, change billing, enable a route, or send a live probe.

Every candidate has `paidUpgradeAllowed: false`, no assumed end date, seven-day visibility freshness, an official URL, and an environment-variable name without a value. AgentRouter additionally requires a separate hard-capped token per host and a fresh live probe. Cloudflare remains a setup candidate using the generic OpenAI-compatible surface; no custom adapter is installed. Threadspan is not partnered with, sponsored by, or endorsed by any listed provider and does not promise permanent free access.

## Optional Copy helper

`copy-naturalizer` is available to every user as an explicit opt-in component. It stays collapsed and unchecked in the setup window, and `selection: "all"` does not select it. Selecting it adds only a disabled, digest-bound local descriptor; apply still requires review of the exact digest and retains the usual preimage backup and rollback manifest.

Local heuristics can flag filler, stock phrases, and hard-to-read sentences. A rewrite is optional and can use only a provider the user has already configured and explicitly chosen. Setup does not select or enable a provider, collect or store credentials, run the helper, apply a suggestion, or show story, build, detector, or cost metrics.

## Optional External copy check

`copy-check` is a separate explicit-only component. Defaults and `selection: "all"` do not select it. Selecting it adds only a disabled descriptor with permission mode `off`. Environment keys existing do not enable adapters.

The setup card names destinations (Pangram official page; Sapling `https://api.sapling.ai/api/v1/aidetect`; Winston `https://api.gowinston.ai/v1/ai-content-detection`), the default 12,000-character payload cap, Sapling's stored-text/improvement retention warning, Winston's limited 2,000-credit developer trial, and that Threadspan has no vendor partnership. GPTZero and Copyleaks are not advertised as working free APIs.

## Optional Codex full access

`codex-full-access` is an explicit-only component. It is never selected by installer defaults or by `selection: "all"`; in the setup window its checkbox starts unchecked with a full-access warning. Selecting it is not sufficient to apply it: the reviewed full-access plan must be separately confirmed. Apply updates only the selected host's user-level `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`). It does not touch a project's `.codex/config.toml`.

The reviewed plan contains the target path, transform identifier, hashes, modes, setting names, effects, and bounded per-tool conflict descriptors—never raw TOML, tokens, headers, or credential values. Apply resolves the current user config path again, rejects a symlinked config or parent, requires the exact reviewed preimage, recomputes the transform and next hash, backs up the exact prior bytes under the installer backup root, and writes atomically. A matching config is a visible no-op.

The component sets `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, and user-reviewed/preapproved app and MCP defaults. Existing tools may read and write files, execute commands, and use the network without approvals, including through already configured app and MCP surfaces. The component does not install or enable new tools, apps, plugins, or servers. Existing per-tool overrides remain untouched and are reported as residual conflicts. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The Compatibility Watch configuration also includes a bounded early code-work self-heal profile. Deterministic code/test/build failures, CLI drift, quoting or command-length failures, locks, subagent interruptions, and cross-platform divergence trigger direct repair first, focused regression evidence, one recognizer/helper/process update, and one meta-meta detection/coordination check. Depth stops at 2; agent output is evidence rather than completion authority, project policy is not silently overridden, and reusable defects may only become sanitized reviewed issue/PR proposals.

See [INSTALLER-GUI.md](INSTALLER-GUI.md) and [HOST-SURFACES.md](HOST-SURFACES.md).
