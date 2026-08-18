# Installation

The deterministic installer is wired into the CLI and source-run setup window.

Use `threadspan install gui` for the guided flow. Use `threadspan install plan` and `threadspan install apply` for automation. Both use the same component registry, digest, backups, atomic writes, and rollback manifest.

The GUI is loopback-only and uses a short-lived installer session created through the authenticated daemon. It never receives provider credentials.

Host-specific MCP/plugin writes are generated from neutral descriptors and merged with existing configuration. Do not replace unrelated MCP servers. Back up the exact host file before mutation and keep credentials in environment/provider-native state.

## Explicit provider discovery

`agentrouter-free`, `mistral-api-free`, `groqcloud-free`, `cloudflare-workers-ai-free`, and `gemini-api-free` are explicit-only. Defaults and `selection: "all"` exclude them. Without recent ready evidence they stay collapsed under **Add providers**. Selecting one adds only a disabled, digest-bound component document and prerequisites; it does not sign up, create credentials, install an app, open a browser, change billing, enable a route, or send a live probe.

Every candidate has `paidUpgradeAllowed: false`, no assumed end date, seven-day visibility freshness, an official URL, and an environment-variable name without a value. AgentRouter additionally requires a separate hard-capped token per host and a fresh live probe. Cloudflare remains a setup candidate using the generic OpenAI-compatible surface; no custom adapter is installed. Threadspan is not partnered with, sponsored by, or endorsed by any listed provider and does not promise permanent free access.

## Optional Codex full access

`codex-full-access` is an explicit-only component. It is never selected by installer defaults or by `selection: "all"`; in the setup window its checkbox starts unchecked with a full-access warning. Selecting it updates only the selected host's user-level `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`). It does not touch a project's `.codex/config.toml`.

The reviewed plan contains the target path, transform identifier, hashes, modes, setting names, effects, and bounded per-tool conflict descriptors—never raw TOML, tokens, headers, or credential values. Apply resolves the current user config path again, rejects a symlinked config or parent, requires the exact reviewed preimage, recomputes the transform and next hash, backs up the exact prior bytes under the installer backup root, and writes atomically. A matching config is a visible no-op.

The component sets `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, and user-reviewed/preapproved app and MCP defaults. This removes command approval pauses and command sandboxing and preapproves app/MCP tools. It does **not** enable destructive/open-world capability, tools, apps, plugins, or servers. Existing per-tool overrides remain untouched and are reported as residual conflicts. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The Compatibility Watch configuration also includes a bounded early code-work self-heal profile. Deterministic code/test/build failures, CLI drift, quoting or command-length failures, locks, subagent interruptions, and cross-platform divergence trigger direct repair first, focused regression evidence, one recognizer/helper/process update, and one meta-meta detection/coordination check. Depth stops at 2; agent output is evidence rather than completion authority, project policy is not silently overridden, and reusable defects may only become sanitized reviewed issue/PR proposals.

See [INSTALLER-GUI.md](INSTALLER-GUI.md) and [HOST-SURFACES.md](HOST-SURFACES.md).
