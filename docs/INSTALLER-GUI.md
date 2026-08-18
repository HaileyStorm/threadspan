# Setup window

The setup window is a loopback web UI launched in Chromium app mode. It is not an Electron bundle or compiled installer.

`threadspan install gui` authenticates to the daemon, creates a short-lived installer-only session, and puts its nonce in the URL fragment. The browser strips the fragment immediately. The nonce cannot call `/v1`, and no provider credential enters the browser.

The legacy component-only GUI path reuses `createInstallerPlan()`,
`previewInstallerPlan()`, and `applyInstallerPlan()`. When an authenticated
native helper supplies the reviewed fresh-install roots, the controller instead
calls `createFreshInstallPlan()` and `applyFreshInstallPlan()` directly. The
returned parent object is the same closed/versioned plan used by the CLI, with
the same parent and child digests; the browser does not reconstruct it. Neither
path can write an unpreviewed plan or mismatched digest. Planning inspects current
managed files: matching content and permissions are recorded as unchanged, not
as writes, and an all-no-op legacy plan skips task protection, Desktop closure,
and file-write approval.

Existing Threadspan-managed JSON is merged so unowned project/user keys survive reviewed updates. An existing Codex profile is replaced only when it carries Threadspan's ownership marker. Unmanaged, unreadable, linked, or wrong-type targets are preserved and shown as exclusions with a visible reason. Changes, unchanged targets, exclusions, content hashes, scopes, reversal metadata, and reasons are all bound into the plan digest; any real change requires a newly reviewed digest.

The **Codex full access** checkbox is a separate explicit-only exception and always starts unchecked. Its visible warning says that selection removes command approval pauses and command sandboxing and makes app/MCP approvals preapproved. It also states that the component does not enable destructive or open-world access. The plan names every affected setting and the user-level config target without exposing config contents. Existing per-tool overrides are left in place and appear as bounded residual conflicts in Review. `selection: "all"` cannot select this component.

This specialized operation uses the same digest, drift detection, backup, atomic-write, rollback-manifest, and no-op flow as other installer changes, but resolves `$CODEX_HOME/config.toml` on the selected host at both plan and apply time. It never writes project `.codex/config.toml`. The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents the user and project layers and the affected keys.

## Installer appearance

The setup window starts with a dark visual fallback and a compact **System / Dark / Light** control. The stored preference is the enum only; no account, host, provider, project, or other identity is persisted. System is the initial mode. In System mode, a valid dark/light hint already present in bootstrap or recovery metadata takes precedence, then `prefers-color-scheme`; environments without either retain the dark fallback. Explicit Dark or Light overrides those hints until the user chooses System again.

A tiny head script applies the stored enum or System result before the stylesheet to minimize a light/dark flash. The control is a labeled keyboard-focusable radio group with an assistive status announcement. Installer accent changes remain window-local and do not alter installed HUD accents.

## Add providers

Provider/app components are grouped only from explicit bootstrap-discovered readiness. Installed/ready providers stay in the main component list. Not-installed, unavailable, and unknown providers appear under the collapsed, keyboard-accessible **Add providers** disclosure with their readiness label; missing readiness is shown as Unknown rather than treated as installed.

Selecting an Add providers entry performs no external install or authentication. It adds the existing component ID to the ordinary plan request, so that component's existing app/CLI installation, sign-in, permission, preview, and live-untested prerequisites appear in the digest-bound Review step. External installers and authentication still require their separate explicit approval. Recovery remains limited to component IDs and bounded installer state and never gains credentials from this grouping.

## Writing tools

The collapsed **Writing tools** disclosure contains the optional Copy helper and the separate External copy check. Both checkboxes start unchecked for every user. Copy helper explains that local heuristics flag wording issues on the device and that an optional rewrite can use only an already configured provider the user explicitly chooses. Setup never enables a provider, stores credentials, runs a rewrite, or applies a suggestion, and it shows no story, build, detector, or cost metrics.

External copy check is excluded from `selection: "all"`. Selecting it installs **Ask every time** with the manual Pangram handoff available; API adapters remain disabled until the user separately configures and enables them. The card names destination, payload size, Sapling retention, Winston's limited expiring trial, and that Threadspan has no partnership. Apply still requires the reviewed digest and keeps the standard exact backup and rollback manifest. Threadspan never submits detector text in the background, and detector scores remain advisory rather than proof of authorship.

## Stable release check comes first

The first setup state checks only the official `HaileyStorm/threadspan` GitHub releases and selects the highest strict `major.minor.patch` stable tag. Drafts, prereleases, release channels, and lookalike repository or asset URLs are rejected. Release discovery, checksum-manifest download, signature download, and archive download each have their own bounded timeout and inherit installer-request cancellation. **Check again** repeats the same bounded check. If GitHub, the network, or a phase timeout makes the check unavailable, setup shows the failure and offers Retry or Continue current; the installed version remains usable.

An official Git checkout can fast-forward to the stable tag only when `origin` is one of the exact approved official URLs, the checkout root is exact, and tracked plus untracked state is clean. The updater rechecks remote identity and cleanliness after fetch, requires the current commit to be an ancestor of the release tag, and uses `git merge --ff-only`. Dirty or unexpected-remote checkouts are never fetched or changed.

Other source installs require the canonical `threadspan-VERSION.tar.gz`, `SHA256SUMS`, and `SHA256SUMS.sig` assets from that official release. Before the archive is downloaded or executed, the installer verifies the exact checksum-manifest bytes with the pinned Ed25519 public key shipped at `src/installer/release-signing-public-key.pem`; a same-origin checksum alone is not publisher authentication. Missing, wrong-signer, malformed, or tampered signatures fail closed and leave **Continue current** available. The archive SHA-256 must then match the authenticated manifest exactly.

Extraction applies the producer's portable-path contract before writing: no absolute or drive paths, traversal, backslashes, colons/alternate data streams, trailing spaces or dots, Windows-reserved names, or Unicode-normalized case-insensitive collisions. Links and special filesystem entries are also rejected. The extracted `package.json`, version, official repository identity in `README.md`, and GUI files are checked before the source is staged side-by-side under the owner's `.threadspan/staging/releases` directory. Existing staging destinations and the current source tree are never overwritten.

After verification, a detached loopback helper serves only the staged GUI files, re-hashing each one before use, and proxies only installer API paths back to the exact configured loopback daemon. The proxy requires a separate random helper capability and never derives an upstream origin from the request target. A digest-bound resume capsule contains installer/session identity and version metadata only—no credentials, prompts, provider output, or task state. The controller then treats the verified staged root as the current source for later manual checks in that session.

The helper reports ready only after it has bound its loopback port and launched the updated app window. The old setup window exits after that readiness receipt. A failed check, download, checksum, extraction, identity check, helper startup, asset recheck, or browser launch leaves the current installer window usable and never executes an unverified candidate asset.

Active Codex tasks are read through App Server and grouped by working directory. Every group defaults to waiting for completion. A pause action must call the originating host's documented interrupt/cancel surface and preserve a native resume identifier; it must not kill arbitrary processes. Fresh-install task selection and inventory evidence are hashed into a closed task-protection binding in the parent plan.

Desktop closure and file-write approval remain separate controls only on the
legacy component path. The shared fresh path asks for task protection and the
parent digest, does not show a Desktop close/restart approval, and never launches,
restarts, closes, or force-kills Desktop or provider apps. Its proof labels
provider and host activation pending unless closed server-issued evidence proves
every configured/descriptor/auth/runtime/live dimension. Installer recovery
records contain IDs, host kind, project path, component IDs, digests, state,
timestamps, and bounded results, but no prompts, credential values, browser
state, provider response text, or owner-local telemetry.

The shipped setup command still obtains its loopback session from an existing
authenticated daemon. A native zero-state launcher capable of creating that
first authenticated helper is not yet shipped. The GUI advertises the canonical
fresh hooks as unavailable with reason `authenticated-native-bootstrap-required`
unless such a helper is explicitly present; this residual is not reported as a
successful fresh installation.

The installed host-surface manifest records the same provider-neutral policy shown by the daemon: raw APIs are host-owned; managed workers inherit provider-native user/project settings unless an explicit, visible override is requested; brainstorming branches are bounded and convergence-stopped under one caller-owned synthesis; and host tools/plugins such as ImageGen are invoked only when they materially improve a decision.

The same manifest installs portable connection-recovery scaffolding without claiming live repair. Provider, account, and transport health remain distinct; pre-output auth/transport failures are not conflated with mid-turn provider failure; reconnect/rebind and handle-audit counts are bounded; stale process/config bindings are detected; native re-auth instructions never collect credentials; resumable state is preserved; and parent interruption requires a handle audit. Reroute remains subject to the existing privacy, account, side-effect, mode, and authority gates, while exact resume or rollback stays adapter-specific.

**Compatibility Watch — Recover, learn, harden.** Compatibility Watch is the subsystem, UI, and history owner. Its bounded self-heal behavior detects app/provider drift, restores compatibility first, runs one direct/meta/meta-meta hardening sequence, and then stops. Setup records the required owner, evidence, regression, host rollout, and relevant rollback/expiry contract without performing recursive analysis, exposing private incident content, or creating token churn.

Its early code-work profile applies the same bound to deterministic code/test/build failures, tool or CLI drift, quoting/command-length errors, file locks, subagent timeout/capacity/context interruption, and cross-platform divergence. Direct repair comes first, followed by focused regression evidence, a recognizer/helper/process improvement, and a meta-meta check of missed detection or coordination. The profile stops at depth 2, carries no memory, prompts, credentials, or cross-host state, does not silently override project policy, and treats agent output as evidence rather than completion authority.

Compatibility Watch may stage portable outcomes as reviewed sanitized GitHub issue/PR proposals with affected versions/hosts, evidence, rollback, and residual gaps. Its local persistent monitor—not the submitting agent—triages, tests, tweaks, accepts or rejects, and may apply locally only after acceptance. Machine-local credentials/state, prompts, and private provider output never enter the proposal, and submission never enables auto-merge.

The optional donation card is claimed once in server-owned recovery state for each installer session. Reloading the page or relaunching the verified staged installer cannot show it again, and donation content is not part of the installed runtime.

Unexpected heartbeat loss asks the originating host, through its native resume path, whether to relaunch or cancel. Explicit Cancel suppresses that notification.
