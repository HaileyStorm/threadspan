# Installation

The deterministic installer is wired into the CLI and source-run setup window.

Use `threadspan install gui` for the guided flow. Use `threadspan install plan` and `threadspan install apply` for automation. Both use the same component registry, digest, backups, atomic writes, and rollback manifest.

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

The source-run GUI currently covers component-file installation only. Service
lifecycle plan/apply/uninstall remains CLI-only until the GUI can compose both
transactions under one atomic approval and recovery contract; the GUI does not
silently activate services or restart Desktop/provider apps.

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
