# Grok Build as a Managed Software-Development Worker

**Research and probe report**  
**Date:** August 16, 2026  
**Scope:** Official Grok Build CLI, consumer subscription usage, direct API usage, local coding-agent orchestration, concurrency, safety, and operational recommendations.

## Executive summary

Grok Build can be useful as a coordinator-managed coding worker. It supports per-job model selection, reasoning-effort selection, finite turn limits, isolated working directories, machine-readable output, strict permission and sandbox modes, MCP, skills, hooks, plugins, sessions, subagents, and Agent Client Protocol (ACP) operation. Its best role is bounded implementation, deterministic test expansion, mechanical refactoring, codebase characterization, and other assignments whose scope and acceptance criteria can be independently verified.

The installed CLI exposes both `--model` and `--reasoning-effort` (`--effort`) controls. The authenticated installation currently lists only `grok-4.6`, so the model flag is real but the consumer account presently offers one first-party model. Grok also supports custom OpenAI-compatible model definitions and direct xAI API models, which makes broader model routing possible when an API key and billing policy are used.

Effort can be tuned to the assignment. Official xAI API documentation defines `low`, `medium`, and `high` for the current reasoning model family, with `high` as the default in the documented `grok-4.5` API. The installed `grok-4.6` CLI accepts an effort argument, but the public documentation does not yet publish an exact `grok-4.6` effort matrix. Accordingly, a production controller should use `low`, `medium`, and `high` only after a small account-specific canary confirms that the installed model accepts them.

Usage visibility depends on the billing path:

- Paid consumer plans now use a shared weekly pool across Build, Chat, Imagine, Voice, and other Grok products. Settings → Usage shows percentage consumed, product breakdown, weekly reset time, and extra-credit balance.
- The published consumer documentation does not provide a machine-readable endpoint for that weekly meter. It also does not define a separate monthly included-token allowance or a paid-plan daily allowance.
- The CLI's JSON terminal output does provide per-job input, cache-read, output, reasoning, total tokens, turns, model calls, and estimated cost. This is sufficient for a local dispatch ledger and relative throttling, but it cannot by itself reproduce the weighted weekly subscription percentage.
- Direct xAI API responses provide exact token usage and `cost_in_usd_ticks` for each request. API teams also have explicit RPS and TPM limits in the xAI Console. This is the more observable and controllable route for sustained automation.
- Extra Usage Credits and Auto Top Up are available for consumer plans. Auto Top Up supports a monthly cap, but this is a spending cap, not a monthly included-usage meter.

Bounded probes on the installed client established at least six useful overlapping workers, an observed cold-start/request burst limit of two requests per second, and an observed limit of 21 requests per rolling minute. These are empirical properties of one account, client version, model, and time window—not universal service guarantees. A safe initial controller profile is six active workers, no more than one cold start every 1.4 seconds, and no more than 18 total model turns per rolling 60 seconds. Seven to nine resident processes can be useful when some are doing local tool work, but they should all share the same admission queue; resident processes are not equivalent to concurrent model turns.

The largest operational risks are not model quality alone. They are ambiguous subscription entitlement, quota exhaustion, unsafe shell permissions, multiple agents editing the same checkout, weak terminal-state evidence, unbounded retries, ACP protocol mismatches, child-process leaks, and accepting an agent's self-reported success without independent review. A safe deployment must isolate every job, deny unneeded tools and network access, use exact command allowlists, disable subagents and memory by default, cap turns and wall time, record durable logs and usage, and reserve integration authority for an independent coordinator.

## Research basis

This report separates three evidence classes:

1. **Official documentation** from xAI covering Build, CLI controls, permissions, subscription usage, API rate limits, and cost tracking.
2. **Non-consuming local inspection** of the installed CLI's help, model list, version, executable identity, and configuration surface.
3. **Bounded authenticated probes** covering successful requests, overlap, request-rate behavior, machine-readable usage, quota failure, and local orchestration behavior.

The local installation inspected for this report was:

| Property | Observed value |
| --- | --- |
| Executable | `%USERPROFILE%\.grok\bin\grok.exe` |
| Version | `grok 1.0.4 (d846eb93d9)` |
| Executable bytes | 142,043,976 |
| Executable SHA-256 | `9c6ec0341e94b8225c6e7cd28eee1fc9f9de5f641437f23b3fff64e2fbd838b9` |
| Authentication | Cached grok.com login |
| Available first-party model | `grok-4.6` |
| ACP protocol observed | Version 1 over JSON-RPC stdio |

The executable was not available through the inspecting process's `PATH`; reliable automation therefore needs the absolute executable path plus a version and hash check before launch.

## Model and effort configurability

### Model selection

Grok Build exposes several model-selection mechanisms:

- CLI: `--model <MODEL>` or `-m <MODEL>`.
- TUI: `/model <name>`.
- User configuration: `[models] default = "..."` in `%USERPROFILE%\.grok\config.toml`.
- Custom model definitions: model ID, base URL, backend, environment-key name, context window, completion-token cap, and other provider settings can be registered in the same configuration.
- Direct xAI API: select any model available to the API team rather than only the consumer CLI's advertised model.

The installed consumer CLI currently reports only `grok-4.6`. Supplying another name is therefore not a reliable way to obtain a different first-party model unless `grok models` lists it or it is explicitly configured as a custom/API model.

### Reasoning effort

The CLI exposes `--reasoning-effort <EFFORT>` and the alias `--effort <EFFORT>`. The TUI exposes `/effort`. Official API documentation defines:

| Effort | Appropriate use |
| --- | --- |
| `low` | Simple edits, deterministic test additions, formatting, targeted searches, and latency-sensitive tool use. |
| `medium` | Moderate implementation, debugging with several interacting files, and bounded analysis. |
| `high` | Difficult algorithms, ambiguous failures, architecture-sensitive changes, and deep multi-step reasoning. |

For the documented `grok-4.5` API, reasoning cannot be fully disabled and defaults to `high`. Because the locally available model is `grok-4.6` and its exact accepted effort values are not yet documented, the controller should validate each intended level with a tiny finite canary after a CLI or model update. It should never silently fall back to a different effort or model.

### Other per-task tuning controls

The CLI offers more useful task tuning than model and effort alone:

- `--max-turns <N>` limits the agent loop.
- `--no-plan` avoids spending a turn on plan mode for fully specified mechanical tasks.
- `--no-subagents` prevents untracked nested concurrency.
- `--no-memory` prevents cross-session memory from influencing or retaining job context.
- `--disable-web-search` removes an unnecessary external-data path for local coding tasks.
- `--tools` and `--disallowed-tools` constrain the built-in tool set.
- `--json-schema` constrains the final response to a machine-validated shape.
- `--output-format json` or `streaming-json` provides machine-readable progress and terminal output.
- `--cwd` binds the working directory.
- `--session-id`, `--resume`, and `--continue` support persistent work, although fresh bounded sessions are safer for isolated jobs.
- `--rules` appends assignment-specific instructions; `--system-prompt-override` is more powerful and should be avoided unless a controlled harness owns the entire policy.
- `--agent` and `--agents` configure agent definitions. These are useful interactively, but coordinator-managed workers should normally disable subagents to keep concurrency and authority visible.

### Recommended task profiles

| Work class | Model/effort | Turn cap | Suggested controls |
| --- | --- | --- | --- |
| Mechanical test or one-file edit | Available coding model, `low` | 4–8 | No plan, no subagents, no memory, no web, exact test commands. |
| Bounded multi-file implementation | Available coding model, `medium` | 8–16 | No subagents, no memory, no web unless explicitly required, strict schema result. |
| Focused bug diagnosis | Available coding model, `medium` | 6–12 | Read/test tools, edits disabled unless repair is explicitly authorized. |
| Difficult algorithmic component | Available coding model, `high` | 12–24 | Narrow scope, stronger independent review, explicit timeout and checkpoints. |
| Broad architecture or high-consequence decision | Prefer a stronger coordinator/reviewer; use Grok for bounded evidence gathering | Task-specific | Separate research from write authority; require independent synthesis and approval. |

The most economical policy is not “always low.” Low effort can produce retries, rework, or subtly incorrect patches that cost more than one medium-effort pass. Effort should follow task ambiguity and consequence, while scope, turns, and tools control the upper bound.

## Usage limits, feedback, and throttling

### Paid consumer subscription path

xAI's current consumer FAQ says paid Grok plans use one shared weekly usage pool across products. The Usage page displays:

- percentage of the current weekly pool consumed;
- percentage breakdown by product, including Build;
- weekly reset date and time; and
- extra-credit balance.

This answers the weekly question directly. It does **not** expose an officially documented automation API, exact token denomination for the weekly percentage, or a separate paid daily/monthly included allowance. Different products consume the pool at different compute-weighted rates, so raw CLI tokens cannot be assumed to map linearly to the visible percentage.

Daily and monthly controls must therefore be local policy:

- **Daily:** allocate a fraction of the remaining weekly percentage based on days until reset, task priority, and a reserve. For example, preserve 20% of the remaining pool for urgent work and permit ordinary work to consume at most `(remaining percentage - reserve) / days remaining` per day.
- **Weekly:** treat Settings → Usage as the source of truth. Record a manual or browser-assisted snapshot at the start of each dispatch cycle and after material batches.
- **Monthly:** use an Auto Top Up monthly spending cap if top-ups are enabled. This limits spend, not included subscription use.

The TUI also exposes `/usage`, which opens credit usage or billing management. This is useful to a human operator but is not a documented headless quota endpoint.

### Free-tier behavior observed

One authenticated CLI identity was classified by the service as free tier even though a paid entitlement was expected. The exact terminal response reported:

- error code `subscription:free-usage-exhausted`;
- rolling 24-hour usage of 511,500 tokens against a 500,000-token limit; and
- no further Build work until reset or subscription recognition.

This demonstrates two important facts:

1. The account actually recognized by Build is more important than which account is visible in an arbitrary browser window. The CLI uses its cached login after authentication.
2. Subscription entitlement must be verified with an actual bounded Build request or Usage page, not inferred from a purchase receipt or another Grok product.

The paid weekly-pool documentation and the observed free rolling-24-hour error are not contradictory: they describe two different entitlement states. A controller should identify which one the service is actually enforcing before dispatching a queue.

### Per-job CLI telemetry

The headless JSON terminal record observed during a four-turn job included:

| Metric | Observed example |
| --- | ---: |
| Input tokens | 23,559 |
| Cache-read input tokens | 51,328 |
| Output tokens | 1,349 |
| Reasoning tokens | 619 |
| Total tokens | 76,236 |
| Model calls / turns | 4 / 4 |
| Reported cost | $0.080876 |

This is enough to maintain a durable local ledger by job, worker, model, effort, task class, and date. Cache-read tokens materially contributed to total usage, so a throttle must count them rather than assuming cached context is free.

### Direct API path

The direct xAI API provides materially better accounting:

- every response reports input, output, and total token usage;
- reasoning tokens are exposed for reasoning models;
- `cost_in_usd_ticks` reports the exact charged cost after discounts;
- the xAI Console exposes the team's per-model RPS and TPM limits;
- API rate tiers scale with cumulative API spend; and
- HTTP 429 is the explicit rate-limit signal.

For sustained automation where deterministic budget enforcement matters more than consumer-plan convenience, the API path is preferable. It lets an orchestrator enforce exact per-day and per-month cost ceilings, independent of the opaque compute weighting of a consumer weekly pool.

### Recommended throttle

A practical consumer-plan controller should:

1. Capture the weekly Usage-page percentage and reset time before opening a new batch.
2. Record every headless terminal record, including failed and throttled calls.
3. Count cold starts, follow-up turns, retries, input, cache-read, output, and reasoning usage.
4. Use a single global admission controller across every worker process.
5. Stop automatic dispatch when the Usage page reaches a chosen reserve threshold.
6. Permit no automatic retry on quota errors; queue the job until an explicit reset time or operator decision.
7. Reconcile the local ledger with the Usage page after each meaningful batch because product weighting prevents exact local reconstruction.

Suggested percentage policy:

| Weekly usage | Dispatch behavior |
| --- | --- |
| 0–50% | Normal bounded work. |
| 50–70% | Prefer low/medium effort and mechanically verifiable tasks. |
| 70–85% | Reduce active workers and reserve high effort for critical work. |
| 85–95% | Run only urgent, short, high-confidence assignments. |
| 95–100% | Stop automatic dispatch; require operator approval or extra credits. |

These are operational recommendations, not provider limits.

## Concurrency probes and stable capacity

Authenticated probes were performed with Grok CLI 1.0.4 and `grok-4.6` over a short controlled interval. Sanitized results were:

| Probe | Result |
| --- | --- |
| Single smoke request | Completed successfully. |
| Cold-start burst | Exact observed ceiling: 2 requests per second. |
| Rolling request probe | Exact observed ceiling: 21 requests per rolling minute. |
| Four staggered workers | All four completed with sustained overlap. |
| Eight staggered workers | Six completed with overlap; workers seven and eight encountered rate limiting after the account reached 21/21 RPM. |

The evidence proves at least six overlapping useful workers. It does not prove that six is a provider concurrency cap: the eight-worker test hit the turn-rate budget before it could isolate a distinct worker-count ceiling.

### Recommended concurrency profile

- **Active model workers:** six maximum initially.
- **Resident worker processes:** up to nine when some are performing finite local tool work or waiting in a visible queue.
- **Cold-start spacing:** at least 1.4 seconds.
- **Global model-turn budget:** no more than 18 in any rolling 60 seconds, leaving a three-turn margin below the observed 21 RPM threshold.
- **Retries:** zero by default. A task may authorize one finite delayed retry, charged against the same global budget.
- **States:** every job should expose `queued`, `admitted`, `running`, `throttled`, `completed`, `failed`, `cancelled`, or `abandoned` with durable timestamps.

Useful concurrency depends on workload shape. Six model-heavy agents can saturate the turn budget quickly. Nine resident agents may be efficient when several spend most of their time compiling or testing locally. The admission controller, not process count, is the source of truth.

Capacity must be remeasured after any change in subscription, CLI version, model, authentication method, or rate-limit behavior.

## Strengths

### Good agentic coding surface

Grok Build can read, edit, search, run tools, test code, operate in a worktree, and return structured output. Headless `--single` mode is simple enough for bounded jobs, while ACP supports richer multi-turn orchestration.

### Strong task-level configurability

Model, effort, tools, turns, planning, memory, web access, output schema, working directory, permissions, and sandbox are configurable per invocation. This makes it possible to spend more reasoning only where it pays off.

### Machine-readable accounting

JSON output includes turns, model calls, token classes, and cost. Streaming formats expose incremental events. This is far better for orchestration than scraping a TUI.

### Existing repository conventions

Grok reads `AGENTS.md` and compatible instruction files, and can discover skills, hooks, plugins, MCP servers, and project configuration. Existing repositories can supply scoped instructions without rewriting the whole workflow for a new provider.

### Extensibility

MCP allows approved external tools; hooks can intercept lifecycle events; skills package repeatable workflows; plugins bundle several extensions. Custom model definitions permit provider-neutral routing.

### Independent throughput

At least six overlapping workers were usable in probes. For repositories with many genuinely independent, mechanically reviewable tasks, this can materially increase output without consuming the coordinator's highest-cost reasoning capacity.

## Weaknesses and difficulties encountered

### Entitlement ambiguity

A cached CLI login can be valid yet mapped to the wrong subscription state. Browser windows using other profiles do not change the cached CLI identity after authentication. A paid entitlement expected by the operator was not recognized by one Build request, which fell back to a free rolling-24-hour limit. Account identity and product entitlement need an explicit canary.

### Consumer quota is only partly automatable

The weekly subscription meter is documented in Settings → Usage, but no consumer quota API is documented. Local token records help forecast usage but cannot exactly reproduce compute-weighted weekly percentage consumption.

### CLI documentation can lag the installed model

Official pages described `grok-4.5` while the installed client exposed `grok-4.6`. The effort flag existed, but the exact model-specific effort matrix was not published. Version/model/feature canaries are necessary.

### Permission rules are easy to make too broad

String-pattern permission rules can be unsafe if a harness treats a command as an opaque shell string. Shell chaining, aliases, source/destination asymmetry, or an unexpected field can turn an apparently safe prefix into a wider operation. The orchestrator should use structured argv, reject shell metacharacters, validate every path argument, and deny by default.

### ACP integration is more complex than one-shot headless mode

ACP requires strict JSON-RPC request IDs, response shapes, authentication sequencing, client capabilities, session setup, filesystem callbacks, progress events, cancellation, and terminal handling. A client that omits a capability such as `fs/read_text_file` can fail after an otherwise successful handshake. Malformed or duplicate-key JSON must fail closed and still produce a durable terminal record.

### Process and state ownership require engineering

Safe orchestration needs durable reservations, exact PID plus creation identity, bounded cancellation, verified process-tree death, restart-safe job reconciliation, terminal/cancel exclusivity, log hashes, and rollback of partially created job directories. These are harness responsibilities, not guaranteed by the model.

### Agent self-report is not acceptance evidence

An agent can claim that tests passed, scope was respected, or a task completed. The coordinator still needs to inspect the diff, rerun appropriate tests, verify repository status and commit ancestry, check durable logs, and confirm there are no out-of-scope artifacts.

### Context and cache usage can be expensive

Repository instructions and cached context improve continuity, but cache-read tokens still count toward observed total usage. Large inherited contexts can consume quota even when visible output is small.

## Safe local-repository operating model

### Prefer one isolated worktree per worker

Never point multiple agents at the same writable checkout. Each job should receive:

- an immutable base commit;
- a dedicated branch;
- an isolated worktree;
- exact writable file scope;
- exact allowed read paths where confidentiality or corpus size matters;
- acceptance commands and deadline; and
- a unique state/log directory.

### Use one-shot headless mode by default

For a fully specified bounded task, `--single` with JSON output is simpler and safer than ACP. Use ACP only when the coordinator genuinely needs mid-job messages, streaming tool callbacks, or resumable interaction.

A generic safe invocation profile is:

```powershell
& $PinnedGrokExe `
  --no-auto-update `
  --cwd $ExactWorktree `
  --model $PinnedModel `
  --reasoning-effort $TaskEffort `
  --single $ExactPrompt `
  --output-format json `
  --permission-mode dontAsk `
  --sandbox strict `
  --no-subagents `
  --no-memory `
  --disable-web-search `
  --max-turns $FiniteTurnCap `
  --allow $ExactReadRule `
  --allow $ExactEditRule `
  --allow $ExactTestCommandRule `
  --deny $CanonicalBranchAndNetworkRules
```

The exact CLI version should be checked because some flags are version-dependent. Global flags must appear in the order accepted by the installed client, especially when using `agent stdio`.

### Deny by default

For headless jobs, `dontAsk` is preferable to always-approve: anything not explicitly allowed is denied rather than waiting for a prompt or executing implicitly. Always-approve should not be used for unattended repository work.

At minimum, deny:

- canonical-branch writes;
- push, merge, rebase, force-push, and tag creation unless a narrowly scoped workflow explicitly needs them;
- deletion and recursive move/copy operations;
- network, web, credential stores, browser profiles, and package installation unless required;
- paths outside the assigned worktree and exact evidence roots;
- nested subagents; and
- commands not copied exactly from the task's acceptance contract.

Permissions and sandboxing are separate. A tool call can be approved but still blocked by the sandbox; both layers should be configured.

### Independent acceptance

Before integration, a separate coordinator or reviewer should verify:

1. assignment, base, branch, worktree, and worker identity;
2. exact diff and file scope;
3. absence of secrets and unexpected generated artifacts;
4. targeted tests plus adversarial tests proportionate to risk;
5. terminal, stdout, stderr, usage, and process evidence;
6. commit ancestry and remote/local parity if remote delivery is used; and
7. clean worktree and safe rebase onto current canonical main.

The worker should have no integration or completion authority.

## Recommended orchestration architecture

```text
Authoritative task packet
        |
        v
Coordinator validates dependencies, scope, budget, and base
        |
        v
Global admission controller
  - six active maximum
  - 1.4-second start spacing
  - 18 turns / rolling 60 seconds
  - weekly-usage reserve
        |
        v
Isolated worker worktree + pinned CLI/model/effort
        |
        v
Finite headless run
  - strict sandbox and allowlist
  - no subagents/memory/web by default
  - durable stdout/stderr/usage/process identity
        |
        v
Terminal state + clean commit or exact failure evidence
        |
        v
Independent review and test reproduction
        |
        v
Coordinator-only integration or bounded correction
```

The controller should queue work rather than launch opportunistically. It should distinguish resident, admitted, active, throttled, and terminal workers, and it should recover dead workers through durable state rather than by guessing from missing processes.

## Best uses

Grok workers are well suited to:

- deterministic unit-test expansion;
- characterization tests for existing behavior;
- small scoped feature implementation with exact contracts;
- mechanical API migrations;
- source-only compilers, validators, and adapters;
- bounded documentation updates;
- reproducible bug isolation;
- fixture generation that does not require subjective judgment;
- static audits with no write authority; and
- parallel work across genuinely non-overlapping packages.

They are less suitable as the sole authority for:

- broad architecture;
- security-critical design;
- ambiguous product requirements;
- irreversible operations;
- final visual or subjective review;
- integration across heavily contended branches;
- tasks requiring protected data discovery; or
- decisions where a plausible but subtly wrong answer is costly.

For these cases, Grok can still gather bounded evidence or implement an already-approved component while a stronger coordinator retains synthesis and acceptance.

## Adoption plan

### Phase 1: controlled pilot

1. Confirm the CLI account's paid Build entitlement in Settings → Usage.
2. Run one low-effort, one-file, deterministic test task.
3. Enforce a single isolated worktree, no web, no memory, no subagents, exact test argv, and no push/integration authority.
4. Verify terminal usage and reproduce the test independently.

### Phase 2: measured parallelism

1. Admit up to three workers, then six.
2. Use the shared 1.4-second/18-RPM controller.
3. Measure successful first-pass delivery rate, correction rate, tokens, wall time, and coordinator review time by task class and effort.
4. Adjust effort based on total accepted-output cost, not raw token price alone.

### Phase 3: sustained mixed workforce

1. Keep six as the default active ceiling until remeasurement proves otherwise.
2. Allow seven to nine resident workers only when local-tool phases dominate and every model turn remains admitted globally.
3. Maintain provider-neutral task packets so work can be reassigned without changing acceptance truth.
4. Consider the direct API path if consumer usage opacity or weekly interruptions materially reduce productivity.

## Final assessment

Grok Build can supplement a reasoning-focused coordinator effectively, especially for narrow coding tasks that can be specified and tested mechanically. Its configurability is sufficient to tune effort, turns, tools, memory, web access, permissions, and output per assignment. The installed consumer path currently offers one first-party model but still permits effort tuning and custom/API model routing.

The practical safe capacity demonstrated is six overlapping workers behind a global turn-rate controller, with up to nine resident processes only when model turns are queued. The limiting resource is model-turn and subscription usage, not merely process count.

Usage control is workable but split across two systems. Consumer plans provide a human-visible weekly percentage pool; CLI terminal records provide detailed per-job tokens and cost; direct API use provides the strongest exact accounting and rate-limit controls. A mature deployment should combine the weekly meter with a durable local ledger, explicit reserves, no implicit retries, and a stop-before-exhaustion policy.

The technology is usable now, but only with an engineered safety envelope. The simplest reliable path is isolated worktrees plus finite one-shot headless jobs, strict deny-by-default permissions, disabled nested autonomy, a shared quota/concurrency controller, durable evidence, and independent integration review.

## Official sources

- [Grok Build overview](https://docs.x.ai/build/overview)
- [CLI reference](https://docs.x.ai/build/cli/reference)
- [Headless and scripting](https://docs.x.ai/build/cli/headless-scripting)
- [Modes and commands](https://docs.x.ai/build/modes-and-commands)
- [Permissions](https://docs.x.ai/build/features/permissions)
- [Settings and configuration](https://docs.x.ai/build/settings)
- [Skills, plugins, hooks, and subagents](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- [MCP servers](https://docs.x.ai/build/features/mcp-servers)
- [Enterprise deployment and security controls](https://docs.x.ai/build/enterprise)
- [Consumer subscription FAQ: usage and limits](https://docs.x.ai/grok/faq)
- [Reasoning effort](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [API rate limits](https://docs.x.ai/developers/rate-limits)
- [API cost tracking](https://docs.x.ai/developers/cost-tracking)
