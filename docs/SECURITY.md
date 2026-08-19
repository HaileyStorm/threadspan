# Security model

## Intended deployment

The default design assumes:

- one trusted local user;
- one workstation;
- loopback-only HTTP;
- trusted bridge configuration;
- explicit provider credentials in environment variables;
- callers that understand the distinction between Consult, Integrated, and Delegate.

It is not a multi-tenant gateway, hardened sandbox service, or internet-facing API.

## Assets

Protect:

- provider API keys and OAuth refresh state;
- source code and artifacts included in prompts or snapshots;
- the user's paid subscription quota;
- live workspaces modified by Delegate;
- tool output and reasoning history retained in memory;
- the local machine from untrusted command/provider execution.

## HTTP listener

Default:

```jsonc
{
  "host": "127.0.0.1",
  "port": 8743,
  "authTokenEnv": "THREADSPAN_TOKEN",
  "allowUnauthenticatedLoopback": false,
  "allowedOrigins": []
}
```

Policy:

- A valid bearer token is accepted from any reachable client.
- A non-browser loopback request may omit the token only when `allowUnauthenticatedLoopback` is true.
- Requests with an `Origin` header must use an explicitly allowed origin or a valid bearer token.
- CORS response headers are emitted only for explicitly allowed origins.
- Preflight is answered before bearer auth because browsers cannot attach the application bearer to the preflight itself.

### Owner and MCP connector credentials

The owner main token and MCP connector token are separate authorization domains:

- owner HTTP routes use the main token and never fall back to the connector token;
- `/mcp` accepts only the connector token and always exposes the connector allowlist, without Delegate or filesystem workspace arguments;
- the owner main token is rejected at `/mcp` rather than treated as an unrestricted MCP credential;
- host and Codex connector installation reject the owner token file, canonical aliases of that file, hard-link identity, and token values equal to the resolved owner token;
- remote MCP accepts only an absolute `/mcp` endpoint. Legacy `/v1` or root remotes fail closed instead of wrapping owner HTTP tools as MCP;
- explicit `--embedded` / `--embedded-mcp` remains the local-process escape hatch and is rendered explicitly so ambient remote variables cannot override it.

Credential comparisons never log token values. Keep both files owner-readable only and rotate both if either boundary is suspected to have been crossed.

### Recommended hardened local config

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "authTokenEnv": "THREADSPAN_TOKEN",
    "allowUnauthenticatedLoopback": false,
    "allowedOrigins": []
  }
}
```

Set `THREADSPAN_TOKEN` to a long random token and launch Codex/clients with access to that environment variable.

### Do not expose directly to a LAN/internet

Before non-loopback exposure, add at least:

- TLS;
- real identity/authentication;
- per-user authorization and quotas;
- rate limiting;
- request/audit IDs;
- provider ACLs;
- network firewall rules;
- persistent audit storage with a redaction policy;
- separate OS identity/container/VM;
- a decision about whether source snapshots may leave the host.

## Electron HUD bootstrap and successor channel

The Electron inspector is an unauthenticated bootstrap mechanism and therefore
must never remain the HUD transport. Only explicit `threadspan desktop launch`
may create it. Bootstrap accepts one exact Node target on the exact loopback
port, binds the launched PID/executable/start identity and reviewed package
digests, receives a source-bound supervisor acknowledgement, and then proves
both inspector discovery and the WebSocket closed. Port squatting, target
multiplicity/spoofing, premature closure, and later reappearance fail closed.
If target/source validation fails before a trusted supervisor exists, Threadspan
does not evaluate or signal the untrusted target; it tells the owner to close the
explicitly launched app so the bootstrap inspector is removed before recovery.

The successor protocol has a distinct random capability for each Electron
generation. It uses timing-safe per-frame HMAC authentication plus exact generation,
per-connection sequence, and globally bounded action IDs. Frames, results,
timeouts, route catalogs, and retained replay sets are bounded. Its operation
set is closed to health/identity, sanitized HUD synchronization, bounded renderer
action read, and authenticated teardown; it provides no shell or arbitrary
evaluation surface. The capability never enters argv, environment, renderer,
public receipts, logs, or successor frames. Owner-private state retains the capability and only
sanitized hashes/endpoint metadata needed for exact reconnect/recovery.

Each accepted socket receives a fresh authenticated session challenge. Requests
and responses bind that challenge; reconnect resets sequence state only after a
valid hello. Per-socket frames, queued work, results, output backpressure, pending
client requests, connections, and pre-authentication idle time are bounded.

The renderer is not an authentication boundary. Renderer action IDs provide
bounded duplicate/stale rejection, not trusted-gesture provenance; any script in
that renderer can propose a fresh schema-valid route action. The supervisor
catalog/schema checks and owner-authenticated daemon route validation remain the
authority boundary.

Loopback does not prove peer ownership. Capability authentication is mandatory
on every platform. Current Linux and Windows coverage is offline/synthetic;
native Windows ACL/packaged-path acceptance remains explicitly unverified.

Bootstrap and rollback may write only Threadspan-owned private state. Exact
digest-or-absence evidence covers reviewed executable, `app.asar`, and package
metadata paths before and after. Threadspan never modifies Desktop packages,
and rollback never restores a persistent inspector. Uncertain injection or
teardown becomes owner-visible recovery state rather than automatic replay.
The original bootstrap port is part of durable generation identity. Closure
requires two explicit TCP refusals plus matching `/json/list` refusal; timeout,
reset, or another listener is ambiguous/reoccupied state, never proof of closure.
A process-shared host claim spans the complete launch/attach lifetime, and a
dead generation is retired only by explicit recovery after process-absence,
port-closure, and current package-disposition checks.
Rollback uses an authenticated two-step teardown/finalize protocol. The teardown
tombstone stays reachable after renderer/listener removal so a crash or transient
renderer failure can resume the same exact capability/generation; final channel
closure happens only after durable rolled-back evidence. Transaction and host
claim mutations use narrow guards, and abandoned claims/guards are preserved and
released only by exact reviewed digest.
Guard-file recovery itself is not a concurrent CAS operation. It is exposed only
as an explicit stop-the-world owner procedure after every Desktop host/service
is stopped, with a separate `--confirm-hosts-stopped` assertion; using it while
another owner is active violates the recovery contract and is refused by default.

## Consult snapshot

The Cursor snapshot boundary is designed to protect the **source tree from mutation**. It is not a comprehensive sandbox.

Implemented protections:

- recursive copy into a temporary directory;
- default exclusion of `.git`, dependency, build, cache, and virtual-environment directories;
- byte and file count limits;
- symlinks skipped by default;
- optional internal-only symlink copy with canonical target checks and rewrite to snapshot-local targets;
- cleanup after success and error;
- failed partial snapshot cleanup.

Residual risks:

- copied secrets or proprietary code are visible to the provider;
- files can contain instructions/exploits targeting tools/parsers;
- TOCTOU changes can occur while a live source is copied;
- device files/special filesystem behavior may vary by platform;
- provider network/tool access is outside the copy boundary;
- a huge number of tiny paths can still impose traversal cost before limits trip;
- a local SDK/runtime compromise can escape ordinary application boundaries.

For higher assurance, create the snapshot from a clean Git object database/export, run the provider in a VM/container with no credentials except those required, and disable unnecessary network/MCP tools.

## Delegate

Delegate is intentionally destructive-capable.

- MCP marks it with `destructiveHint: true`.
- Cursor Delegate receives the live workspace.
- The provider's own harness may run shell commands, edit files, and use configured MCP servers.
- Retained agent context can influence later calls on the same bridge thread.

Use disposable branches/worktrees, backups, or a clean clone. Review `git diff`, untracked files, generated artifacts, and test output before accepting work.

Never point Delegate at a directory that contains broader secrets or unrelated writable projects merely for convenience.

## Hermes ACP forward blocker

Hermes ACP is a provider-owned execution surface whose built-in `hermes-acp` toolset includes filesystem, terminal, web, browser, memory, skill, execution, and delegation capabilities. Current official source also adds every enabled Hermes-native MCP server when it constructs a session. The documented `HERMES_ACP_SKIP_CONFIGURED_MCP=1` marker skips background discovery only; it does not exclude those servers from the session.

Those tools are not source-bound or narrowable through the documented ACP host configuration. A disposable Consult copy protects the original tree from ordinary path-local writes but cannot prove that external tools have no side effects. Rejecting permission requests does not disable tools that run without an ACP permission round trip. A clean Delegate worktree likewise cannot constrain opaque MCP authority to the task.

Threadspan therefore ships no full-agent Hermes forward adapter, provider configuration, or native recovery route. The staged reverse connector remains read-only and contains no credential values; it references the connector-token file instead. Reconsideration requires verifiable source-bound tool selection, exact configured-MCP exclusion, reconciled process-restoration behavior, adversarial offline coverage, and separate native Linux/Windows acceptance.

## Grok Build managed worker

The dedicated adapter adds a safety envelope around the official CLI, but the CLI remains a powerful local coding agent.

Implemented controls:

- optional absolute executable requirement;
- non-consuming version/SHA-256 inspection and optional strict pinning;
- structured argv with `shell: false`;
- finite one-shot jobs and turn/time/output ceilings;
- `dontAsk` and strict sandbox defaults;
- no cross-session memory or auto-update by default; Grok subagents and web/search are enabled by the current operator policy, with explicit opt-outs and inherited authority boundaries;
- optional environment allowlist;
- provider-local admission and no implicit retries;
- private lifecycle/usage ledger with raw content disabled by default;
- disposable Consult snapshot;
- optional Git, linked-worktree, clean-start, and denied-branch checks for Delegate;
- descendant process-tree termination on cancellation/timeout/output failure.

Residual risks:

- provider permission rules can be too broad, too narrow, or interpreted differently after a CLI update;
- an allowed opaque shell string may contain chaining, aliases, or path ambiguity;
- sandbox and permission rules are distinct and must both be reviewed;
- copied Consult content is visible to the provider and runtime;
- Delegate can still damage the assigned worktree or consume credentials/network access that its environment/tool policy permits;
- a worker can falsely report success;
- the local ledger does not reproduce the provider's compute-weighted weekly subscription percentage;
- a bridge crash does not yet reconcile a running job to an `abandoned` state or prove descendant death after restart.

Do not automatically derive Grok `--allow` patterns from user/model-provided command text. Acceptance commands are carried in the task packet and independently rerun by the coordinator; permission policy is configured separately.

The worker must not receive push, merge, rebase, force-push, tag, release, credential-store, browser-profile, or canonical-branch authority unless a narrowly reviewed workflow explicitly requires it.


## Managed worker / Grok Build boundary

Grok Build and similar provider-owned coding CLIs are execution surfaces. The dedicated adapter reduces risk but does not make arbitrary model-driven shell work safe.

Implemented controls:

- structured argv with `shell: false`;
- optional absolute executable requirement, version constraint, and SHA-256 pin;
- no auto-update during jobs;
- finite one-shot sessions and turn/wall/output limits;
- default `dontAsk`, strict sandbox, no cross-session memory, and explicit web/subagent policy (currently allowed by default, never authority-expanding);
- optional reduced environment allowlist;
- process-tree termination;
- snapshot Consult and optional linked-worktree/clean-start/denied-branch Delegate gates;
- provider-local admission and no automatic retries;
- bounded private lifecycle/usage/evidence records.

Residual risks:

- permission string patterns may still be broader than intended;
- an allowed shell/tool can interpret arguments in unsafe ways;
- the provider may read every file inside its assigned boundary;
- sandbox implementation and CLI behavior may drift after updates;
- package/test commands can execute repository-controlled code;
- a worker can produce a plausible but wrong patch or false success report;
- the consumer subscription meter cannot be reproduced exactly from local telemetry.

Use one clean isolated worktree per worker, exact allow/deny policy, and independent acceptance. The worker must not receive push, merge, rebase, tag, release, canonical-branch, or completion authority.

Raw prompt/stdout/stderr ledger evidence is opt-in because it may contain proprietary code or secrets. Default hashes prove evidence identity without storing its content in the ledger. Ledger directories/files are created with private modes where supported, but OS backups and administrator access remain outside the application's control.


## Nested agents and web-derived content

The current Grok policy enables nested subagents and web/search because the intended workload uses both. This changes the exposure surface, not the authority model:

- every nested agent inherits the outer job's exact workspace, allowed scope, deadline, tools, permissions, and acceptance contract;
- nested agents do not receive integration, push, release, or canonical-branch authority;
- the outer worker must summarize nested assignments and material findings;
- websites, retrieved documents, issues, and snippets are untrusted data and may contain prompt injection;
- externally supplied instructions never override the bridge task packet, repository instructions, allow/deny policy, or coordinator acceptance;
- material external claims should be attributed in the worker result;
- use per-job `allow_web_search: false` or `allow_subagents: false` when the task is local, sensitive, or too small to justify the added surface.

One persistent daemon is also a security boundary: it prevents each Desktop coordinator from unknowingly creating an independent Grok rate controller and retained-agent pool. It is still a single-user local service, not multi-tenant isolation.

## Integrated

The calling client owns tools. Security therefore depends on the client's:

- tool allowlist;
- sandbox and filesystem scope;
- shell approval policy;
- network policy;
- call budget and loop termination;
- treatment of provider-generated function arguments.

The bridge does not execute Integrated function calls. It also does not sanitize arguments beyond structural translation.

## Command provider

The command adapter is a code-execution boundary controlled by configuration.

Risks:

- arbitrary binary execution;
- inherited environment variables;
- provider prompt on stdin;
- live workspace as working directory;
- shell injection if `shell: true`;
- descendant processes and platform-specific termination races;
- executable substitution through PATH.

Mitigations:

- configuration file mode is restricted where supported;
- `doctor` resolves the actual executable path;
- `shell` defaults false;
- output/stderr/time are bounded;
- abort sends graceful then forced descendant-aware termination;
- arguments are passed as an array;
- only four documented placeholders are expanded.

For untrusted command adapters, run under a separate OS account/container and keep the default `inheritEnv: false` with an explicit `envAllowlist`. Broad inheritance requires the visible `inheritEnv: true` opt-in and is usually too permissive for provider CLIs on a credential-rich workstation. Abort/timeout uses managed descendant-tree termination; native verification is still required for each Windows/POSIX CLI.

## Credentials

Prefer `apiKeyEnv` over `apiKey`.

- Config expansion supports `${ENV_VAR}`, but unresolved variables become empty strings; `doctor` should be used to catch missing credentials.
- No credentials are bundled.
- Authorization headers and API keys are not logged.
- OpenAI-compatible upstream error bodies are used only transiently for narrow classification such as streaming unsupported. Default error messages, details, and retry logs retain only safe status/classification fields, never the upstream body.
- Hermes stores its own Portal OAuth state outside this package.

## Explicit Codex full-access component

`codex-full-access` is intentionally excluded from defaults and `selection: "all"`. Its GUI control starts unchecked, and selecting it is not sufficient to apply it: the reviewed full-access plan must be separately confirmed. Existing tools may read and write files, execute commands, and use the network without approvals, including through already configured app and MCP surfaces. The component does not install or enable new tools, apps, plugins, or servers; existing per-tool overrides can remain more restrictive.

The component mutates only the selected host's user-level `$CODEX_HOME/config.toml`, never project `.codex/config.toml`. A dedicated line-preserving TOML transform changes only the named execution/approval keys, preserves comments/order/unrelated settings, leaves per-tool overrides untouched, reports those overrides as bounded residual conflicts, and fails closed on duplicate or ambiguous target tables/keys.

Raw config bytes, tokens, headers, and credential values are excluded from the plan, preview, manifest, recovery record, and logs. Apply resolves the host path again, rejects a symlink config or parent, compares the exact preimage hash and mode, recomputes the transform and next hash, stores an exact-byte backup under the installer backup root, atomically replaces the config, and restores exact bytes plus the original mode after a partial failure. Configuration that already matches is recorded as unchanged. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for current precedence and key semantics; project, profile, CLI, managed-requirement, and per-tool layers can remain more specific residual controls.

The early code-work self-heal profile is configuration, not acceptance authority. It bounds direct repair, focused regression evidence, one recognizer/helper/process update, and one missed-detection/coordination check to depth 2. It excludes memory, prompts, credentials, and cross-host state; cannot silently override project policy; and treats all agent output as evidence. Reusable defects may be proposed to Compatibility Watch only as sanitized reviewed issues or PRs.

## Nous subscription proxy

Hermes' subscription proxy is intentionally a credential-attaching passthrough and accepts any bearer. Keep it bound to `127.0.0.1`. If started with `0.0.0.0`, protect it externally; otherwise any reachable client may spend the subscription quota.

The bridge's bearer does not automatically secure the proxy if another process can reach port 8645 directly.

## Public release and intake hygiene

The release-bundle preflight scans each selected file before archive creation. It rejects private-key encodings, known high-confidence credential token formats, unintended non-synthetic email addresses, and SSN-shaped personal data. It deliberately does not apply generic entropy scoring or match arbitrary prose about credentials. Intentional public donation/contact data is allowlisted only as an exact value in its exact published files; reserved synthetic email domains remain available to offline tests.

Normalized replay state does not retain computer-output bodies, browser metadata, screenshot metadata, attachment IDs, filenames, local references, or non-public media URLs. Computer output and unsafe attachments become opaque omission markers. A media reference may retain only a syntactically public HTTP(S) origin and path; userinfo, query strings, and fragments are removed or cause omission.

Public issues and pull requests must omit signed URLs and their query strings, callback URLs, screenshots, images or generated media, audio, transcripts, and raw logs unless the material has been separately sanitized and reduced to the minimum evidence needed.

## Logging and retained state

Defaults:

```jsonc
{
  "logging": { "level": "info", "logBodies": false },
  "responses": { "exposeReasoning": false }
}
```

- Logs contain IDs, provider/mode/model, status, and usage, not message bodies by default.
- `logBodies: true` explicitly adds credential-redacted request/result JSON capped at 32,768 characters per body. Redaction is best-effort; prompt/source content is intentionally still present.
- Session state contains normalized messages in process memory.
- Exposed reasoning may reveal sensitive internal model content and is off by default.
- A process/core dump can still contain prompt and credential material.

## Browser clients

Add exact origins, including scheme and port:

```jsonc
{
  "allowedOrigins": [
    "http://127.0.0.1:3000",
    "http://localhost:3000"
  ]
}
```

An allowlisted origin can make bearerless browser calls only if the server's broader authentication policy also permits them; CORS is not authentication. Prefer sending a bearer and disabling unauthenticated loopback when a browser UI is used.

## Security review checklist

- [ ] Listener remains loopback unless a reviewed gateway exists.
- [ ] Long random bridge bearer set.
- [ ] Unauthenticated loopback disabled where local malware/other users matter.
- [ ] Browser origins exact and minimal.
- [ ] Config file permissions reviewed.
- [ ] Provider keys only in environment/credential manager.
- [ ] Consult exclusions cover project-specific secrets and large directories.
- [ ] Delegate uses one disposable branch/worktree/clone per writable worker.
- [ ] Grok executable path/version/hash reviewed; no foreign-machine hash copied as a pin.
- [ ] Grok model/effort canary and authenticated account entitlement verified.
- [ ] Managed worker has finite turns/time, no implicit retry, no integration authority, and independently reproduced acceptance.
- [ ] Provider CLI environment reduced to an allowlist where practical.
- [ ] Consumer weekly usage reserve checked outside the local token ledger.
- [ ] Command providers avoid shell and run under constrained identity.
- [ ] Hermes proxy remains loopback.
- [ ] Reasoning/body logging disabled unless a reviewed diagnostic session explicitly requires it.
- [ ] Public release preflight passes, and issue/PR evidence excludes signed or callback URLs, screenshots, media, audio, and transcripts.
- [ ] Grok/managed workers use an explicit reviewed executable path/version/hash policy.
- [ ] Every Delegate worker has a unique clean linked worktree and non-canonical branch.
- [ ] Worker permissions, sandbox, tools, memory, web, subagents, turn cap, and timeout are explicit.
- [ ] Raw worker evidence is disabled unless its confidentiality impact is accepted.
- [ ] Worker output is independently reviewed and acceptance commands are rerun.
- [ ] Live provider budgets/rate limits established.
- [ ] Process restart/state-loss behavior acceptable.
