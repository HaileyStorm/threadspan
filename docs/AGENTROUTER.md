# AgentRouter through Claude Code

Threadspan supports an explicit AgentRouter route only through the official Claude Code CLI and the dedicated `claude-code` adapter. It does not use the generic `openai-chat` adapter or a Codex adapter for this route. Integrated mode is unsupported because Claude Code owns its tool loop; Consult remains a disposable plan-mode snapshot and Delegate remains a finite bounded run in an isolated linked worktree.

The example provider is `agentrouter-claude`, model `claude-opus-4-8`, with `consult` and `delegate` capabilities. Its gateway block names only:

```json
{
  "baseUrl": "https://agentrouter.org",
  "apiKeyEnv": "AGENTROUTER_API_KEY",
  "model": "claude-opus-4-8",
  "provider": "agentrouter"
}
```

At launch, Threadspan requires the named environment variable and creates a child-only Claude environment containing `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`. Ambient `ANTHROPIC_*` values are never forwarded when no gateway is configured and are replaced, not composed, when it is. Missing keys fail before process launch. Plans, config, service files, logs, and provider metadata contain environment names only, never token values.

## Availability and evidence

On 2026-08-18, Linux and Windows with Claude Code 2.1.234 each returned `THREADSPAN_AGENTROUTER_OK` through `https://agentrouter.org` using `claude-opus-4-8`. Each host used a distinct USD 1 hard-capped token and had no payment method. This is route-specific live evidence, not a permanent offer or a guarantee for another account, token, model, host, or date.

The public installer component is `agentrouter-free`. It is explicit-only, excluded from defaults and `selection: "all"`, and stays under **Add providers** without explicit ready evidence. `offerEndDate` is `null`, `visibilityFreshnessDays` is `7`, and `requiresLiveProbe` is `true`. After freshness expires, present **Check availability**. If a future end date is recorded, hide the route after that date unless a newer live probe proves availability. Disable the route whenever the offer, token, model, endpoint, or live probe is stale or unavailable.

The current [AgentRouter portal guide](https://co.agentrouter.org/portal/guide) and [AgentRouter documentation](https://docs.agentrouter.org/) must be checked before setup. The portal currently documents the `co.agentrouter.org` domain, while the bounded 2026-08-18 tests found the older-domain keys rejected there and accepted at `agentrouter.org`. Use the endpoint proved for the exact host token; do not treat the portal's generic OpenAI-compatible or Codex examples as fallbacks. Generic fetch/OpenAI Chat was rejected as an unauthorized client, Codex 0.147 rejected `wire_api = "chat"`, and the old-domain keys were rejected by `co.agentrouter.org`.

## No-spend and permission boundary

Threadspan is not partnered with, sponsored by, or endorsed by AgentRouter or any provider listed in its discovery candidates. It only surfaces public documentation and user-discovered evidence. AgentRouter receives the prompts and selected code context sent through Claude Code; review that third-party destination before enabling the route.

Use a separate hard-capped token per host. Threadspan does not create accounts or tokens, open a browser, install Claude Code, add a payment method, change billing, enable the route, or upgrade a plan. Each action requires explicit user permission and a reviewed plan. Install only the official Claude Code build after that approval, then run a fresh bounded probe before enablement. No permanent free access is promised.
