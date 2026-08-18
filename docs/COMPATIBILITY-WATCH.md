# Desktop Compatibility Watch

Threadspan includes an optional, local-only observer for Codex CLI/Desktop and ChatGPT Desktop changes. It is wired into configuration, daemon state, CLI doctor/intake commands, and the companion HUD. Repair remains a separately approved operation.

The safe defaults are deliberate:

- `enabled: false`;
- `readOnly: true`;
- `applyEnabled: false`;
- `pollingEnabled: false`;
- no network access, package-manager calls, self-update, app shutdown, app restart, or authentication inspection.

Enabling observation permits only bounded product probes and private product-local Threadspan state writes. It does not permit a repair.

## Evidence collected

The default Linux and Windows probe set contains three independent products:

| Product | Evidence |
|---|---|
| Codex CLI | PATH/PATHEXT resolution, bounded `codex --version` for directly executable artifacts, and a streaming bounded SHA-256 fingerprint. Windows `.CMD`/`.BAT` wrappers are fingerprinted without shell execution; their version remains unknown. |
| Codex Desktop | First matching exact allowlisted artifact path, optional bounded `package.json` version metadata, size, and SHA-256. The app is not launched. |
| ChatGPT Desktop | First matching exact allowlisted artifact path, optional bounded `package.json` version metadata, size, and SHA-256. The app is not launched. |

Desktop packaging varies. The built-in paths cover conventional per-user, Program Files, `/opt`, and `.desktop` locations; operators can supply exact product definitions for other reviewed installations. The watcher does not recursively search application directories or inspect WindowsApps, browser profiles, cookie databases, OAuth state, process command lines, or credential stores. Missing evidence is reported as `missing` or `error`, never inferred as compatible.

Version-process time, stdout, and stderr are bounded. Artifact hashes stream under an explicit byte ceiling; metadata and rollback reads are also bounded. State stores normalized versions, artifact names, sizes, hashes, path hashes, timestamps, and bounded error classifications—not raw command output, environment values, authorization material, or full artifact paths.

Threadspan itself makes no network request. The generic OS process boundary cannot prove that an installed CLI's `--version` implementation has no network capability, so reports say `threadspan-does-not-request-network` and `processNetworkIsolation: not-enforced`. Operators that require network denial must run the probe under a separately reviewed OS sandbox. Script wrappers are not launched through a shell.

The default state location is:

- Linux: `${XDG_STATE_HOME:-$HOME/.local/state}/threadspan/compatibility-watch`;
- Windows: `%LOCALAPPDATA%\Threadspan\compatibility-watch`.

Files are written with private modes where the platform honors POSIX modes. Windows ACL inheritance remains an OS-level residual risk; place the state root in an owner-private directory.

## Manual doctor after an update

Because there is no CLI/index integration yet, import the module by its direct file path:

```js
import { DesktopCompatibilityWatch } from "./src/maintenance/desktop-update.mjs";

const watch = new DesktopCompatibilityWatch({ enabled: true });
const report = await watch.doctorAfterUpdate();
```

The report labels the evidence as local read-only observation. On the first run, detected/missing products establish a baseline. Later runs report product additions, removals, or changed normalized evidence. A changed fingerprint is a prompt for compatibility review; it is not proof that an update is safe or unsafe.

Exact current Desktop behavior still needs native smoke testing on the installed Linux and Windows builds. Offline tests and hashes do not certify model-picker, Settings, Usage, app lifecycle, or authentication behavior.

## Optional polling

Polling requires separate `pollingEnabled: true` configuration. The interval is bounded (one minute to 24 hours by default), the timer is unreferenced, and ticks are single-flight: an overlapping tick is skipped. Polling only calls `doctor()` and never plans or applies repair work.

```js
const watch = new DesktopCompatibilityWatch({
  enabled: true,
  pollingEnabled: true,
  pollIntervalMs: 15 * 60_000,
});

const polling = watch.startPolling((report) => {
  // Send the already-sanitized report to an owner-private local status surface.
}, {
  onError(error) {
    // Record a bounded local polling failure without an unhandled rejection.
  },
});

// Later:
polling.stop();
```

## All-task capability reuse and bounded self-heal

The direct/meta/meta-meta self-heal contract applies to research, browser work, documents, media, operations, provider setup, and coding. It is a planning and repair policy, not an automatic capability installer or completion authority.

At every task-planning or direct-repair checkpoint, first perform bounded discovery of already installed tools, skills, plugins, and provider capabilities. Discovery and selection evidence is keyed by host, provider, model, mode, and capability. Prefer provider-native strengths and tools; never transfer a tool/plugin/skill assumption across providers, models, or modes. Unknown remains Unknown until a bounded check. Select the smallest sufficient non-overlapping capability by capability fit, live availability, privacy, quota/cost, and expected coordination overhead, then stop discovery when it is sufficient. Do not repeat broad inventory searches, poll for unchanged results, or spend tokens merely to exhaust the catalog.

The bounded phases remain:

1. **Direct:** plan or repair the task with an existing capability first, then collect focused task-appropriate evidence.
2. **Meta:** update the capability discovery/selection registry, selection rules, or instructions when the repair shows a reusable recognition gap.
3. **Meta-meta:** analyze why an available capability was missed or why overlapping capability work was duplicated, then stop at depth 2.

A new reusable helper, skill, or plugin is appropriate only for a recurring or generalizable need. It requires all of the following before creation or proposal:

- a clear trigger and bounded scope;
- regression tests or equivalent focused verification;
- an owner;
- rollback or an explicit expiry/removal condition;
- portability expectations;
- a no-overlap check against installed and already-proposed capabilities.

One-off tasks never auto-create reusable capabilities. Third-party skill/plugin installation and any permission expansion still use the normal user approval flow. This policy does not add memory, carry prompts or credentials, copy cross-host state, silently override project policy, or turn agent output into completion authority. Generalizable defects may become reviewed sanitized Compatibility Watch issue/PR proposals; they are not auto-installed, auto-merged, or auto-applied.

## Repair planning and rollback

Repair is limited to exact secret-free text targets under an explicit existing repair root. It is intended for Threadspan-owned compatibility artifacts, not ChatGPT/Codex authentication state or undocumented Desktop internals.

`prepareRepairPlan()`:

1. validates a bounded operation list and target containment;
2. rejects traversal, symbolic links, junction-like paths exposed as links, special files, duplicate targets, common credential assignments/private keys, and oversized inputs;
3. copies only the exact existing target files into a bounded private rollback snapshot;
4. records preimage and desired SHA-256 hashes;
5. returns a deterministic plan ID and digest plus manual shutdown/restart prompts;
6. does not change a repair target.

Preview and apply are separate:

```js
const watch = new DesktopCompatibilityWatch({
  enabled: true,
  readOnly: false,
  applyEnabled: true,
});

const plan = await watch.prepareRepairPlan({
  planId: "reviewed-desktop-profile-1",
  repairRoot: "/absolute/threadspan-managed-root",
  operations: [{
    relativePath: "profiles/desktop.toml",
    content: "# reviewed secret-free content\n",
  }],
  shutdownProducts: ["codex-desktop"],
  restartProducts: ["codex-desktop"],
});

const preview = watch.previewRepairPlan(plan);

const result = await watch.applyRepairPlan(plan, {
  applyEnabled: true,
  approvedPlanId: preview.planId,
  approvedDigest: preview.digest,
  confirmedStoppedProducts: ["codex-desktop"],
});
```

Apply proceeds only when all of these are true:

- the watch is enabled;
- read-only mode was explicitly disabled;
- apply was enabled in both construction and the apply request;
- the supplied plan ID exactly matches the preview;
- the supplied digest exactly matches the preview and the freshly recomputed plan;
- an exclusive one-shot apply claim can be created for the plan;
- the rollback manifest is unused and belongs to the same plan;
- every required rollback backup exists and matches its recorded hash before the first target write;
- every target still matches its snapshotted preimage;
- every requested app shutdown was performed and explicitly confirmed by the operator.

The implementation never stops or restarts an app. It reports before/after prompts so the operator or a future documented integration can do so. After successful file replacement, manually restart the requested apps and run `doctorAfterUpdate()`.

If a target write fails, only targets written by that attempt are restored in reverse order from the verified snapshot. Rollback refuses to overwrite a target changed by another actor after Threadspan's write. An incomplete restoration is reported as `rollback-incomplete`; it is never reported as success. An exclusive claim prevents concurrent or replayed apply attempts.

The module repeatedly verifies directory and file identities around writes. Node does not expose a portable cross-platform `openat`/directory-relative rename primitive, so a hostile same-user process that can replace writable parent directories in the final pathname race remains outside this trusted-local-user boundary. Use an owner-private repair root and do not grant another process concurrent write access. Native Windows ACL/junction behavior remains a separate smoke-test gate.

Credential-pattern rejection is defense in depth, not a general secret scanner. Only target known Threadspan-owned, secret-free compatibility files. Never point repair planning at Codex/ChatGPT configuration, authentication, browser, or session stores.

## Native Settings and Usage migration candidates

Native Desktop Settings and Usage contribution points are migration candidates only. The compatibility module exposes `assessNativeDesktopMigration()` to record capability evidence without enabling, patching, or modifying a native surface.

Threadspan HUD controls remain authoritative during measured coexistence. A future sunset may only enter review after all of the following are independently demonstrated:

- native Settings is stable and at least as capable as the Threadspan control;
- native Usage is stable and at least as capable as the Threadspan HUD;
- equivalent behavior is verified on Linux;
- equivalent behavior is verified on Windows;
- a bounded rollback to the Threadspan HUD is verified.

Even when every gate passes, the result is only `eligible-for-measured-sunset-review`; automatic sunset is forbidden. If either native surface is weaker, missing, or unstable—or if platform parity or rollback is unproven—retain the Threadspan HUD indefinitely.

Do not patch undocumented Desktop internals to create, repair, or accelerate these contribution points. Capability discovery must use stable documented surfaces or owner-reviewed local evidence. A Desktop update that changes an undocumented artifact is a reason to stop and reassess, not to rewrite it automatically.

## Explicit non-goals

The Compatibility Watch does not:

- auto-create helpers, skills, or plugins for one-off tasks;
- install third-party skills/plugins or expand permissions without normal user approval;
- run unbounded or token-burning capability discovery loops;
- store memory, prompts, credentials, or cross-host state for self-heal discovery;
- download or install updates;
- invoke package managers or app installers;
- query online release feeds;
- scrape authentication, entitlement, browser, session, or Usage data;
- enumerate app processes or command lines;
- kill, close, launch, or restart Desktop applications;
- rewrite native model catalogs, Settings, Usage, profiles, or undocumented app files automatically;
- claim Linux acceptance from Windows evidence, or Windows acceptance from Linux evidence.

Use native, exact-build smoke tests as a separate acceptance gate.
