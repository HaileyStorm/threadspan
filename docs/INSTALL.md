# Portable Threadspan installer

The installer module plans and applies product-local Threadspan configuration on Node 22. It is intentionally not wired into `src/cli.mjs` yet.

## Fresh Codex task prompt

> Install Threadspan from `<future-repository-url>` using the one-pass setup; show me the complete plan and prerequisites before applying it.

That is the single README-facing prompt intended for use after the repository has a durable public or private URL.

## Setup styles

Broad-permission one-pass setup selects every component in one noninteractive plan. It is useful when the operator already intends to install the daemon, Cursor, Grok Build, Nous, OpenRouter, native Codex integration, monitoring/fallback, sidecar UI, context profiles, product-local Continuity, and Compatibility Watch. The plan still surfaces filesystem, local-port, executable, and authentication prerequisites before approval. Broad permission does not allow Threadspan to collect or store credentials.

Prompted setup builds incremental plans from an explicit component list. Apply one reviewed plan, then create another when the operator chooses the next component. This keeps permission and authentication decisions close to the integration that needs them.

Both styles use the same safety contract:

- planning is read-only;
- the complete preview includes writes, backup root, rollback manifest, and prerequisite states;
- apply requires the exact digest returned by the preview;
- every existing target receives a product-local backup;
- replacements use a temporary file and same-directory atomic rename;
- targets, backups, and manifests are bounded to the explicit install root;
- a partial failure restores prior files and removes files created by the failed plan;
- environment-variable names and manual sign-in requirements may be recorded, but credential values are never collected or stored.

## Module API

One-pass planning:

```js
import {
  applyInstallerPlan,
  createInstallerPlan,
  previewInstallerPlan,
} from "./src/installer/index.mjs";

const plan = createInstallerPlan({
  installRoot: "/absolute/codex-home",
  selection: "all",
  longContextProfiles: "all", // optional; omit for standard profiles only
});
const preview = previewInstallerPlan(plan);
process.stdout.write(preview.text);

// Only after the operator has seen and approved the preview:
await applyInstallerPlan(plan, { approvedDigest: preview.digest });
```

Incremental planning:

```js
const plan = createInstallerPlan({
  installRoot: "/absolute/codex-home",
  selection: ["daemon", "codex-native", "context-profiles"],
});
```

The install root must already exist. Use `CODEX_HOME` as the root when the generated `*.config.toml` files should be immediately discoverable by Codex; Threadspan's own artifacts remain below that same bounded root. The planner never asks for a secret. Nous and OpenRouter prerequisite checks inspect only whether `NOUS_API_KEY` or `OPENROUTER_API_KEY` is present; their values are not copied into the plan. Cursor, Grok Build, and Codex use existing product sign-ins.

## Components

| Component | Planned product-local artifact | Early prerequisite |
|---|---|---|
| daemon | loopback daemon configuration | local port and state permission |
| Cursor | Consult/Delegate integration descriptor | existing Cursor sign-in |
| Grok Build | bounded-worker integration descriptor | installed, signed-in CLI |
| Nous | OpenAI-compatible provider descriptor | `NOUS_API_KEY` in runtime environment |
| OpenRouter | OpenAI-compatible provider descriptor | `OPENROUTER_API_KEY` in runtime environment |
| native Codex | native picker/catalog descriptor | existing Codex sign-in |
| monitoring/fallback | health and explicit fallback policy | local status read/write permission |
| sidecar UI | loopback, read-only-default UI descriptor | local UI port permission |
| context profiles | named Codex profile files | profile-directory write permission |
| Continuity | checkpoint/rollover descriptor | product-local state permission |
| Compatibility Watch | report-only compatibility policy | version reads; separate approval for live checks |

Continuity is optional because it appears only when selected (or as part of explicit `selection: "all"`). Its scope is product-local checkpoints and rollover metadata. It explicitly excludes memory, multi-host synchronization, and cross-host communications.

Compatibility Watch is report-only. It does not silently rewrite profiles, replace the native model catalog, install updates, or perform a live network check without a separate approval.

## Codex context profiles

The generated profiles use the official Codex keys `model_context_window` and `model_auto_compact_token_limit`. Codex documents profile files at `$CODEX_HOME/<name>.config.toml` and selection with `--profile`; see the [official configuration reference](https://developers.openai.com/codex/config-reference).

Standard profiles are always generated when `context-profiles` is selected:

| Profile | Model | Context | Auto-compact |
|---|---|---:|---:|
| `gpt-5.6-default` | `gpt-5.6-sol` | 271,500 | 192,000 |
| `spark` | `gpt-5.3-codex-spark` | 128,000 | 80,000 |

Optional long-context profiles:

| Profile | Model | Context | Auto-compact |
|---|---|---:|---:|
| `gpt-5.6-600k` | `gpt-5.6-sol` | 600,000 | 480,000 |
| `gpt-5.6-1m` | `gpt-5.6-sol` | 1,000,000 | 800,000 |

Every profile is rejected if its auto-compact threshold exceeds 90% of the context window. The installer preserves the native Codex picker/catalog rather than installing a replacement catalog.

## Rollback evidence

Each apply creates `.threadspan-installer/rollbacks/<plan-id>.json`. Every entry identifies the product-relative target, whether it existed, its original SHA-256 when applicable, and its product-relative backup path. The manifest transitions from `prepared` to `applied`; if an apply fails after preparation, the installer restores targets it actually wrote and records `rolled-back-after-error`. A failed restoration is reported as `rollback-incomplete` with the affected product-relative targets rather than being presented as a successful rollback.
