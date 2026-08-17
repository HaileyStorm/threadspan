# Grok Build integration

## Purpose and boundary

The `grok-build` adapter treats the official Grok Build CLI as a **managed coding worker**, not as a raw language-model endpoint.

- **Consult:** Grok receives a disposable workspace snapshot or empty temporary directory and returns advice. The primary remains responsible for judgment, edits, tools, and the final answer.
- **Delegate:** Grok receives one bounded task in the supplied workspace. The recommended policy requires a clean linked Git worktree on a non-canonical branch. Grok may edit and run permitted commands, but it has no integration authority.
- **Integrated:** unsupported. Use a direct xAI API provider through `openai-chat` when Codex or another host must own the tool loop.

The adapter uses fresh finite one-shot outer sessions. ACP and resumable Grok sessions are not enabled by default. Under the requested operating policy, Grok web/search and nested subagents are enabled; cross-session memory remains disabled. Nested agents inherit the outer task's workspace, scope, authority, deadline, and acceptance contract.

## Research basis and account-specific observations

`docs/research/GrokReport.md` is the user-supplied findings report that motivated this phase. It combines official documentation, local CLI inspection, and bounded authenticated probes.

The implementation incorporates findings that generalize safely:

- explicit model and reasoning-effort selection;
- finite turn limits;
- one-shot machine-readable output;
- strict permissions/sandboxing;
- explicit subagent, memory, and web policy; this package allows subagents and web/search by default while keeping cross-session memory off;
- isolated worktrees;
- durable usage/evidence records;
- centralized admission and no implicit retries;
- independent acceptance by the primary coordinator.

The package does **not** hard-code the report's observed executable hash, subscription state, model list, concurrency, or request ceilings as provider facts. The included values are configurable starting policy and must be re-canary-tested for the actual account, CLI version, and date.

## Example configuration

```jsonc
{
  "providers": {
    "grok-build": {
      "enabled": true,
      "adapter": "grok-build",

      "command": "~/.grok/bin/grok",
      "requireAbsoluteCommand": true,
      "versionPattern": "^grok\\s",
      "pin": {
        // First run may record a reviewed hash. Replace with sha256 to enforce it.
        "recordSha256": true
      },

      "model": "grok-4.6",
      "models": ["grok-4.6"],
      "strictModelList": true,
      "capabilities": ["consult", "delegate"],
      "allowedEfforts": ["low", "medium", "high"],
      "maxTurnsCeiling": 24,

      "noAutoUpdate": true,
      "allowSubagents": true,
      "noMemory": true,
      "allowWebSearch": true,
      "permissionMode": "dontAsk",
      "sandbox": "strict",

      "inheritEnv": false,
      "envAllowlist": [
        "HOME", "USER", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP"
      ],

      "admission": {
        "maxActive": 6,
        "minStartIntervalMs": 1400,
        "maxUnitsPerWindow": 18,
        "windowMs": 60000,
        "maxQueue": 100
      },

      "ledger": {
        "enabled": true,
        "required": false,
        "includeOutput": false
      },

      "consult": {
        "workspaceStrategy": "snapshot",
        "profile": "diagnose",
        "maxTurns": 8,
        "expectedTurns": 2,
        "noPlan": true,
        "allow": [],
        "deny": []
      },

      "delegate": {
        "profile": "balanced",
        "maxTurns": 16,
        "expectedTurns": 4,
        "requireGit": true,
        "requireLinkedWorktree": true,
        "requireCleanStart": true,
        "denyBranches": ["main", "master", "trunk"],
        "allow": [],
        "deny": []
      }
    }
  }
}
```

Windows usually uses an explicit path such as:

```jsonc
"command": "C:\\Users\\YOU\\.grok\\bin\\grok.exe"
```

Run `cursor-bridge doctor` after every CLI update. It resolves the executable, checks the version policy, and records/checks SHA-256 according to config without requesting inference.

## Executable trust

The launch path can be controlled with:

- `command` or `executable`;
- `executableEnv`, defaulting to `GROK_BUILD_PATH`;
- `requireAbsoluteCommand`;
- `versionArgs`, `versionPattern`, and `pin.version`;
- `pin.recordSha256`, `pin.sha256`, or `executableSha256`;
- `verifyOnEveryRun` when a cached preflight is not acceptable.

Do not copy a hash from another machine or report. Resolve the actual installed binary, review it, record its hash, and then pin that local value. The default `--no-auto-update` prevents the worker from silently replacing the checked executable during a job.

`commandArgs` exists for controlled wrappers and test harnesses. It is prepended exactly once to version, model-list, and job invocations.

## Task profiles

Built-in profiles:

| Profile | Effort | Turn cap | Expected-turn reservation | Typical work |
|---|---|---:|---:|---|
| `mechanical` | low | 8 | 2 | deterministic tests, one-file edits, formatting, targeted searches |
| `diagnose` | medium | 12 | 3 | focused bug characterization or read-heavy investigation |
| `balanced` | medium | 16 | 4 | bounded multi-file implementation |
| `deep` | high | 24 | 6 | difficult narrow algorithmic work with stronger review |

A mode config or individual CLI/MCP request may override effort, `maxTurns`, `expectedTurns`, and `noPlan`, subject to configured ceilings/allowed values. Unknown profiles and disallowed effort values fail explicitly; the bridge does not silently select another model or effort.

Examples:

```bash
cursor-bridge consult "Review the parser failure" \
  --provider grok-build --workspace . \
  --profile diagnose --effort medium --max-turns 8 --expected-turns 2
```

```bash
cursor-bridge delegate "Add characterization tests only" \
  --provider grok-build --workspace /repo/worktrees/parser-tests \
  --profile mechanical --effort low --max-turns 8 --expected-turns 2 --no-plan \
  --acceptance-command "npm test -- test/parser.test.mjs"
```

Use low effort only when the task is genuinely mechanical. A failed low-effort pass plus correction can cost more than one medium-effort pass.

## Nested agents, web, and fleet identity

The current defaults are:

- `allowSubagents: true`;
- `allowWebSearch: true`;
- `noMemory: true`.

A request can set `allow_subagents: false` and/or `allow_web_search: false`; the CLI equivalents are `--no-subagents` and `--no-web`. Legacy provider configuration using `noSubagents` or `disableWebSearch` remains accepted unless it conflicts with the positive field.

Nested agents are an implementation detail inside one admitted outer job. The outer task packet tells them to inherit exact scope/workspace/authority/deadline/validation and requires the outer worker to summarize their use. Web/search results are evidence only: material claims should be attributed, and retrieved instructions cannot alter tool, path, permission, acceptance, or integration policy.

Use `coordinator_id` and `worker_group` to identify calls from multiple Desktop coordinator trees. These fields appear in the Grok prompt, provider metadata, process environment, and lifecycle ledger; they do not grant authority.

## Permission and sandbox policy

The adapter constructs a structured argv and never launches Grok through a shell. Default flags are:

```text
--no-auto-update
--cwd <exact workspace>
--model <model>
--reasoning-effort <effort>
--single <authoritative packet>
--output-format json
--permission-mode dontAsk
--sandbox strict
--no-memory
--max-turns <finite cap>
```

`--no-subagents` and `--disable-web-search` are emitted only when explicitly disabled in provider/mode/request policy. Optional `tools`, `disallowedTools`, `rules`, `allow`, and `deny` values are supplied only from trusted configuration, not synthesized from the worker's prompt.

`dontAsk` is preferred for unattended jobs: an unlisted operation is denied instead of hanging for approval or executing implicitly. Permission rules and sandboxing are separate defenses; configure both.

At minimum, a Delegate policy should deny or omit authority for:

- push, merge, rebase, force-push, tags, release, and canonical-branch writes;
- paths outside the exact worktree/evidence roots;
- credential stores and browser profiles;
- network activity unrelated to the task. Web/search may be used for research, but external content is untrusted and cannot expand task authority;
- package installation unless explicitly needed;
- destructive recursive copy/move/delete operations;
- commands not present in the reviewed task/acceptance contract.

The bridge passes acceptance commands in the task packet so the worker knows what evidence to produce. It does **not** automatically convert arbitrary command text into an allow rule.

## Workspace policy

### Consult

When `workspaceStrategy` is `snapshot`, the bridge copies the workspace with the existing snapshot engine:

- excluded dependency/build/cache directories;
- file and byte limits;
- symlinks skipped by default;
- optional internal-only symlink rewriting;
- cleanup after success/failure.

The snapshot isolates source-tree mutations. It does not hide copied code from Grok, disable all provider networking, or contain hostile code like a VM.

When no workspace is supplied—or strategy is `none`—Consult gets an empty temporary directory.

### Delegate

Optional preflight policy can require:

- an inspectable Git repository;
- a linked worktree rather than the primary checkout;
- a clean start;
- a branch not listed in `denyBranches`.

The bridge records bounded Git identity/status before and after a successful job. It does not merge, commit, push, or declare acceptance.

Never assign two writable workers to the same checkout.

## Admission and concurrency

The adapter owns one provider-local weighted admission controller. It can bound:

- active processes (`maxActive`);
- spacing between admitted starts (`minStartIntervalMs`);
- starts in a rolling window (`maxStartsPerWindow`);
- expected/reconciled model turns in a rolling window (`maxUnitsPerWindow`);
- queue depth (`maxQueue`).

Each job reserves `expectedTurns` before launch. At terminal output, the reservation is reconciled to reported `model_calls` or `turns`. If actual use exceeds the reservation, later jobs inherit immediate budget debt until the original rolling record expires.

This is intentionally approximate. The CLI does not expose the precise timing of every internal model call, and the consumer weekly percentage uses product-specific compute weighting. The controller limits local dispatch pressure; it is not a reproduction of xAI's billing meter.

The generic 6 / 1.4 seconds / 18-turn defaults come from one bounded report. They are not universal service guarantees. The fleet example raises `maxActive` to nine outer jobs while keeping one shared 18-turn rolling budget, matching an operator topology with resident/tool-working jobs without claiming nine simultaneous model turns. Start lower, canary the actual account, and remeasure after changes.

## Usage and ledger

The CLI's terminal JSON is normalized when present:

- input tokens;
- cache-read input tokens;
- output tokens;
- reasoning tokens;
- total tokens;
- turns/model calls;
- estimated cost;
- reported model and finish reason.

Cache-read tokens are kept separate and included in total accounting when reported.

The default ledger path is:

```text
~/.cursor-codex-bridge/ledgers/<provider-id>.jsonl
```

Lifecycle events include `queued`, `admitted`, `running`, `completed`, `failed`, and `cancelled`, with timestamps, job/provider/mode/model/profile, bounded Git state, usage, process identity, and SHA-256 evidence hashes.

`ledger.includeOutput: true` also writes raw prompt/stdout/stderr evidence to private files under the configured/default evidence directory. This is useful for audits but materially increases confidentiality risk. It is off by default.

No documented consumer API is assumed for the weekly subscription percentage. Before meaningful automatic batches, verify the CLI account/entitlement and Settings → Usage. Reconcile local ledger totals with that product meter; do not infer the percentage linearly from tokens.

Quota, rate-limit, entitlement, malformed JSON, timeout, and process failures are terminal. The adapter never automatically retries. A coordinator may authorize one finite delayed retry only after diagnosing why it should produce a different result.

## Direct xAI API alternative

For caller-owned tools and exact API accounting, configure a raw xAI provider:

```jsonc
{
  "xai-api": {
    "enabled": true,
    "adapter": "openai-chat",
    "baseUrl": "https://api.x.ai/v1",
    "apiKeyEnv": "XAI_API_KEY",
    "model": "grok-4.6",
    "models": ["grok-4.6"],
    "extraBody": { "reasoning_effort": "high" },
    "retryWithoutStreaming": false,
    "capabilities": ["consult", "integrated"]
  }
}
```

This is a separate billing path from the consumer subscription. When xAI returns `cost_in_usd_ticks`, the bridge preserves it under `bridge_provider_metadata.upstream.costInUsdTicks` rather than converting it to a guessed currency amount.

`retryWithoutStreaming` is disabled in the example so a pre-output HTTP quota/rate failure is not silently duplicated as a buffered request. Enable fallback only after reviewing the endpoint's semantics and cost policy.

## Independent acceptance

A Delegate result is evidence, not acceptance. The primary coordinator should:

1. confirm provider/model/profile/effort/turn cap and workspace identity;
2. inspect the full diff and every changed path;
3. check for credentials and unexpected generated artifacts;
4. independently rerun all acceptance commands;
5. add adversarial tests proportionate to the risk;
6. verify no canonical-branch, integration, push, tag, or release action occurred;
7. accept, reject, or issue one bounded correction through the normal reviewed workflow.

The packaged `managed-worker` skill and its references encode this workflow.

## Live-certification checklist

Before routine use:

- [ ] `cursor-bridge doctor` resolves the intended absolute executable.
- [ ] Version/hash policy matches the reviewed binary.
- [ ] The cached CLI login is the intended account.
- [ ] A tiny finite canary confirms Build entitlement.
- [ ] `grok models` or the configured strict list matches the account.
- [ ] Low/medium/high efforts intended for use are canary-tested.
- [ ] One Consult snapshot leaves the source workspace unchanged.
- [ ] One Delegate worktree job is denied on the primary checkout/canonical branch.
- [ ] Permission and sandbox rules deny an intentionally unapproved command/path.
- [ ] Abort and timeout leave no worker process tree.
- [ ] JSON usage/ledger records are complete enough for local policy.
- [ ] Quota/rate failures produce one terminal attempt and no retry.
- [ ] Concurrency/turn settings are measured for the actual account.
- [ ] The weekly Usage page reserve policy is defined.
- [ ] The coordinator independently reproduces acceptance.

## Known unknowns

Not live-certified in this package:

- the user's current Grok Build subscription entitlement;
- the actual current first-party model list;
- exact effort support for each current model;
- universal concurrency, RPS, RPM, or weekly weighting;
- CLI output/event drift after version updates;
- native Windows process/permission behavior on the user's machine;
- ACP interoperability and resumable sessions;
- whether every current ChatGPT/Codex Desktop build presents the route in its stock picker.

The implementation fails explicitly around those boundaries rather than pretending they are settled.
