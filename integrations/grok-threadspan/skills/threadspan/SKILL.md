---
name: threadspan
description: Use Threadspan to inspect provider availability or to Consult, call an Integrated raw model, or Delegate a bounded task to another configured provider.
---

# Threadspan from Grok

Threadspan is a secondary routing and execution surface. Grok remains the active host and owns the conversation unless a bounded `delegate` call explicitly transfers one task.

1. Call `bridge_status` before routing when availability or quota may have changed.
2. Use `bridge_models` only when the desired provider/model is not already known.
3. Use `consult` for advice; treat the result as evidence.
4. Use `integrated` for one tool-free raw-model response while Grok retains tools.
5. Use `delegate` only with an isolated linked worktree, exact allowed/denied paths, non-goals, and acceptance commands.
6. Never send credentials or private source to a provider that has not passed the active privacy gate.
7. On interruption, resume this Grok session with Grok/ACP. Do not route Grok session recovery through Codex.

The companion HUD is authoritative for Threadspan provider state. Grok's `/dashboard`, `/usage`, `/context`, and `/tasks` remain authoritative for Grok-native state.
