# Grok Build profile guidance

The packaged adapter includes four starting profiles:

| Profile | Effort | Turn cap | Typical use |
| --- | --- | ---: | --- |
| `mechanical` | low | 8 | one-file edits, deterministic tests, formatting, targeted searches |
| `diagnose` | medium | 12 | focused bug isolation or read-heavy investigation |
| `balanced` | medium | 16 | bounded multi-file implementation |
| `deep` | high | 24 | difficult algorithmic component with narrow scope and stronger review |

Provider and request configuration may lower these limits. `expected_turns` is an admission reservation, not a promise of actual consumption. The adapter reconciles it to terminal `model_calls` or `turns` when the CLI reports them.

These defaults are operational starting points, not universal xAI service guarantees. Re-canary model, effort, version, entitlement, and capacity after relevant changes.
