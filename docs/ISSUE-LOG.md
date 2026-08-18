# Implementation issue log

## Both hosts

| Issue | Fix | Residual |
|---|---|---|
| Stale bridge processes exposed old provider/model state. | Restarted the daemon and rechecked endpoints. | Every host still needs revision-bound restart acceptance. |
| MCP shims launched by an old Desktop process did not inherit the new token and returned 401. | Added connector-private token-file support; environment remains first priority. | Desktop must reload managed MCP config. |
| Route prefixes survived when metadata supplied the same mode/provider. | Consume route segments independently from metadata. | Covered by normalization tests. |
| Provider processes outlived completed jobs. | Added process-group/tree reaping and bounded cleanup. | Old POSIX zombies remain until their parent exits. |
| A nested Codex worker lacked daemon owner authentication. | Added owner-only `main.env` provisioning for `THREADSPAN_TOKEN`; MCP keeps a distinct connector token and uses only `/mcp`. | Revalidate each generated host launch without exposing either value. |
| Nous rejected a valid multi-call assistant turn under an obsolete one-tool policy. | Buffer each complete Nous turn, preserve ordered calls/reasoning/results, allow bounded multi-call output, and retain a 16-call ceiling. | Provider-specific aggregate turn/job accounting remains authoritative. |
| `POST` Consult to `agentrouter-claude` without an explicit workspace failed with `config_error: Consult snapshot exceeds maxBytes (536870912)` because `BridgeService` synthesized the Threadspan process cwd before provider dispatch. | **Direct:** bridge routing no longer infers cwd for Consult or Integrated; explicit `bridge_workspace`/`cwd` is preserved, `bridge_no_default_workspace=true` remains accepted but is redundant, and Delegate now fails before dispatch without an explicit workspace. The Claude-side provenance guard remains defense in depth. **Meta:** service/convenience and HTTP Responses regressions prove no-source defaults, both explicit aliases, compatibility-marker behavior, and pre-provider Delegate rejection. | **Meta-meta:** Compatibility Watch should audit every request-normalization default for authority and provenance before it reaches an adapter; convenience must not silently expand filesystem visibility or resource use. Recheck the live AgentRouter POST after daemon restart. |
| Browser tab discovery exposed raw callback URLs that can contain authentication material. | Project only sanitized title/origin/path fields before browser-tab output; never retain query strings or fragments in logs, screenshots, or reports. | Existing callback tabs may remain in the user's browser until they close them; Threadspan does not inspect or copy browser auth state. |
| A private or not-yet-released GitHub repository returned HTTP 404 and setup called it a GitHub outage. | Classify 404/no stable tag as “No public release yet”; keep Retry and Continue current. | A green current-release check requires an actual public stable release. |
| An explicit provider plus the model name `openrouter/free` was normalized as if it were a full route prefix. | Strip route segments independently only when the incoming model actually contains those segments; preserve exact upstream model names when provider/mode were supplied separately. | Covered by the HTTP and CLI route-normalization regression. |
| A broad Grok implementation prompt spent its turn budget researching and planning instead of returning a bounded patch. | Preserved the thread and evidence, then resumed with a narrow completion-only packet and independently reviewed the resulting diff. | Compatibility Watch must detect repeated exploration without terminal artifacts and narrow the same session before spending another full budget. |
| The HUD initialized External copy-check state after the first synthetic/live render, causing a temporal-dead-zone exception that stopped Continuity and route-map rendering. | Moved the policy state before the first render, added an order regression, and exercised the repaired synthetic HUD in-browser. | Keep screenshot/browser acceptance for release UI; static asset presence alone did not catch this class of failure. |
| The daemon published Pangram's reviewed HTTPS URL but the HUD state adapter discarded it, leaving the manual handoff permanently unavailable. | Preserve only a credential-free, query-free HTTPS `officialUrl` through the adapter and reject unsafe URL forms. | Browser acceptance must prove the server-authorized handoff, clipboard step, and inert link reveal together. |
| Consult snapshots could copy common untracked secret and local-auth filenames. | Added mandatory case-insensitive secret/auth exclusions that callers cannot remove while keeping project-specific exclusions additive. | Ordinary-looking files can still contain secrets; Consult snapshots reduce mutation risk, not provider visibility. |
| Command, Grok, and Cursor children could inherit every daemon credential. | Default child environments now contain only a minimal cross-platform baseline plus explicit configured values and `envAllowlist` names; broad inheritance requires visible `inheritEnv: true`. | Native host acceptance remains required after CLI launcher changes. |
| Cross-provider takeover treated missing privacy metadata as compatible. | Require the source and candidate to publish the same explicit non-empty privacy class; same-provider account fallback remains independent. | Operators must classify approved routes before cross-provider takeover can run. |
| OpenAI-compatible routes allowed remote plaintext HTTP and automatic redirects carrying prompts or authorization. | Permit HTTP only for verified loopback hosts and use manual redirect handling so 3xx responses fail rather than crossing origins. | Other adapters retain their own transport contracts and require separate review. |
| The full-access description understated the authority of `danger-full-access` plus no approvals. | State plainly that existing tools may read/write, execute, and use the network without approval; keep selection explicit-only and application separately confirmed. | The component still does not install or enable new tools, apps, plugins, or servers. |
| Release signing could package dirty or release-eligible untracked source. | Require an exact clean Git commit before and after source reads, reject eligible untracked files, and publish the path-free source commit in bundle metadata. | Direct npm publication remains a separate future hardening surface; official releases use the signed bundle path. |
| Minimal child environments removed a Cursor CLI credential that this host intentionally supplied through `CURSOR_API_KEY`. | Added only `CURSOR_API_KEY` to the starter Cursor provider's explicit `envAllowlist`; native Cursor login remains supported and unrelated daemon credentials stay excluded. | Other providers must name their own required credential variables rather than inheriting the daemon environment. |

## Linux

| Issue | Fix | Residual |
|---|---|---|
| Wrong working directory made Node miss `src/cli.mjs`. | Lifecycle files use absolute installed paths. | Moving a source install requires regeneration. |
| Cursor SDK sandbox startup failed under AppArmor. | Disabled only the SDK local sandbox for the reviewed adapter; Delegate still requires a linked worktree. | Recheck after upstream sandbox changes. |
| Grok `dontAsk` denied Delegate writes. | Use documented bypass mode only for Delegate in a linked worktree. | Independent acceptance remains mandatory. |
| Two pre-fix Grok descendant zombies remain under the user manager. | New jobs are reaped; avoided disrupting unrelated services. | Clear at logout/reboot. |
| The systemd user service did not carry an explicit `CODEX_HOME`, so native Continuity discovery depended on launcher state. | Added a reviewed service drop-in with the resolved Linux Codex home and restarted the user service. | Regenerate the drop-in if the account's Codex home moves. |
| A Linux host overlay selected stale Grok model `grok-4.6-build`. | Live CLI validation selected `grok-4.6`; the overlay was corrected. | Recheck the live catalog after CLI or entitlement changes. |
| Cursor Agent `2026.08.11-e8db854` rejected Threadspan's disposable Consult snapshot with `Workspace Trust Required`. | Direct self-heal: Cursor CLI argv now adds the least-authority `--trust` flag dynamically for Consult only; the disposable snapshot and plan mode remain unchanged, and Delegate does not gain `--yolo`, force, or implicit trust. | Meta self-heal: keep a bounded compatibility probe that verifies Consult trust on a disposable workspace without source mutation. Meta-meta self-heal: watch the Cursor CLI version/fingerprint and rerun that probe after a version change before certifying the new build. |

## Windows

| Issue | Fix | Residual |
|---|---|---|
| Background path/quoting errors made startup exit immediately. | Use explicit installed paths and generated PowerShell flow. | Keep native path-with-spaces acceptance. |
| SSH-owned background processes died with the SSH job. | Use per-user scheduled task/Startup lifecycle. | Recheck after install changes. |
| Node could not spawn `codex.cmd` with `shell: false` (`EINVAL`). | Route only `.cmd`/`.bat` through `ComSpec /d /s /c` with Windows-command-line escaping; these scripts are interpreted command text, not direct argv executables. | Native Windows smoke required. |
| Cursor SDK Delegate returned `[resource_exhausted]`. | Preserve structured availability state; do not relabel it as a path bug. | Retry one explicit model after cooldown; Consult passed. |
| A PowerShell probe serialized rich `Get-Content` objects into huge CLIXML. | Use `[IO.File]::ReadAllLines()` and project scalar fields before JSON. | Keep this in host scripts/reviews. |
| Nested SSH PowerShell quoting failed before mutation. | Encode the complete script as UTF-16LE and invoke PowerShell with `-EncodedCommand`, avoiding nested quoting and command-length ceilings. | Native path/encoding acceptance remains required for each generated script. |
| A large encoded PowerShell acceptance script exceeded the Windows command-line ceiling. | Use `-EncodedCommand` only for bounded snippets; transfer larger hashable scripts and invoke them with `-File`. | Generated remote-control tooling should select the transport before launch and record the script hash. |
| PowerShell treated ordinary native stderr logging as a terminating error under strict error handling. | Capture native output with a bounded local `ErrorActionPreference=Continue`, then decide from the exact exit code and independently checked artifact. | Keep strict handling for PowerShell errors; never treat warning text alone as command failure or success. |
| Claude Code through a Windows `.cmd` wrapper treated inline empty MCP JSON as a file path. | Create a unique file-backed empty MCP config outside the workspace, require its absolute path, and clean it with bounded retries. | Native Windows AgentRouter Consult passed on the repaired adapter; recheck after Claude Code launcher changes. |
| A global worker `CODEX_HOME` environment override collided with the same path registered as an isolated account profile, so config validation exited. | Removed the launcher-wide override and bound `nous-worker` through its account/profile source only. | Installer must compose auth isolation separately from execution settings. |
| Stopping the scheduled task left its detached Node daemon alive, so source/config changes appeared ineffective. | Identify and replace only the exact Threadspan `serve` process tree, then verify the new listener before acceptance. | Lifecycle repair should make this revision-bound restart behavior automatic. |
| Native Windows Codex `workspace-write` allowed reads but denied every worker write. | Used the owner's existing `danger-full-access` Codex default for this account-bound linked-worktree Delegate and retained independent diff/file acceptance. | Portable setup must inherit native settings and ask before any required divergence; do not make this a hidden global default. |
| The first Windows Delegate smoke trusted process success and could continue after a missing file. | Replaced it with a terminating script that independently verifies exact file bytes and Git status. | Worker prose is never acceptance evidence. |
| Inherited `.codex` permissions denied the owner while leaving only the sandbox identity effective. | Preserved a byte-for-byte backup and restored inheritable owner, Administrators, and SYSTEM access without removing the sandbox entry. | Recheck ACL inheritance after app or account migration; never copy this host's ACL blob to another machine. |
| A focused takeover test raced the production disconnect timer. | Bound the test to the deterministic injected timing surface and kept production disconnect recovery unchanged. | Keep timing tests isolated from wall-clock scheduling. |
| A daemon launched under SSH disappeared when the SSH job ended. | Replaced it with a per-user scheduled task and proved the listener survived the initiating session. | Recheck task ownership after installer updates. |
| A startup-script regex/quoting change failed before activation. | Restored the exact backup, moved nontrivial deployment logic into a transferred `.ps1`, and re-applied only after local parse checks. | Keep rollback-first deployment and avoid nested shell quoting for script bodies. |
| Remote `Get-CimInstance` inspection hung and rich-object projection produced noisy output. | Replaced it with bounded scalar process inspection and exact PID/command-line projection. | Prefer process-specific native queries over broad WMI inventory. |
| The first Windows 0.4.2 deployment reached the new daemon but a ten-second Continuity acceptance timeout expired while enumerating the native task tree. | The deployment automatically restored the prior app/config/task, preserved the active Codex PID, then repeated with a 60-second bounded Continuity timeout and passed with 100 tasks. | Keep rollback automatic and set endpoint-specific timeouts from measured native behavior rather than generic HTTP defaults. |

## Design corrections

| Issue | Fix |
|---|---|
| Codex model catalog entries cannot encode `modelProvider`. | Preserve native catalog; routed starts pair model/provider and profiles carry routes. |
| Generic OpenAI routing could not represent Grok Build workers. | Dedicated Grok adapter, fleet admission, accounting, and cancellation. |
| Raw Nous inference was mistaken for Hermes Agent. | Keep Nous first-class; label Hermes as a separate Preview runtime. |
| Reverse recovery risked defaulting to Codex. | Native-host recovery forbids cross-host executable fallback. |
| A Nous worker `integratedRoute` was emitted as an object/raw model. | Corrected it to the exact string `integrated/nous/deepseek/deepseek-v4-flash-0731`. |

## 2026-08-17 continuation wave

### Grok Build turn-cap completion loss and entitlement transition

- **Observed:** A live `grok-4.6` Consult completed nine model calls and useful research, but the bridge reported `finishReason: cancelled` and Grok exited at `max turns reached` before emitting the requested terminal packet. A synthesis-only resume on the same thread then failed with `authentication or product entitlement was rejected` after earlier calls had succeeded.
- **Preserved:** The original Threadspan thread ID, run-ledger evidence, usage accounting, and task state. No automatic quota retry, credential substitution, provider substitution, or cross-account fallback was attempted.
- **Fix direction:** Treat turn-cap-without-terminal-output as a recoverable incomplete result with an explicit synthesis continuation budget; classify later authentication/entitlement failure as an account-scoped availability transition. Surface both in account state and preserve the continuation for a provider-authorized retry.
- **Recheck:** Linux and Windows Grok live acceptance after account-aware routing lands. Verify one bounded-turn job that reaches a terminal response and one simulated turn-cap recovery without duplicate work.

### Role-specific subagent launch contract

- **Observed:** Launching a role-specific agent with `fork_context: true` failed because full-history forks inherit the parent agent type.
- **Fix:** Retry with an explicit self-contained packet and no history fork. This avoids both the incompatible launch shape and accidental inheritance of unrelated private context.
- **Recheck:** Keep delegated packets bounded and confirm each launched role reports the expected role and scope.

### Canonical tracker routing

- **Observed:** A lifecycle lookup from the Threadspan source checkout failed because the public repository intentionally has no private operator tracker.
- **Fix:** Do not initialize a competing tracker. Route operator lifecycle updates through the existing private coordination tracker.
- **Recheck:** Installer/release documentation must distinguish source checkout from operator coordination state; the public distribution must not include the private tracker or its identifiers.

### Browser-assisted donation setup

- **Observed:** A donation-service profile-image step required an explicit browser file upload, while a separate provider OAuth flow completed only after navigating the parent tab to its authenticated account page.
- **Preserved:** Provider-native OAuth, no copied cookies or tokens, no automatic payment setup, no API keys, and no automatic credit transfer.
- **Fix:** Leave explicit upload/payout steps to the user instead of weakening browser permissions. Treat provider-native account pages as the authority and verify successful OAuth at an authenticated destination rather than from popup closure alone.
