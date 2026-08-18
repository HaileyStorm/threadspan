# Optional Tips

Threadspan Tips provide one compact piece of guidance when local capability/state heuristics decide it is relevant. They are disabled by default and are separate from financial tipping or donations.

## Enable or disable

Set the daemon configuration explicitly:

```json
{
  "tips": {
    "enabled": true,
    "cooldownMs": 86400000,
    "modelRefinement": {
      "enabled": false,
      "provider": null,
      "model": null,
      "privacy": "deny",
      "maxCallsPerSession": 1,
      "maxOutputTokens": 96,
      "maxLatencyMs": 4000,
      "cooldownMs": 86400000
    },
    "ask": {
      "enabled": false,
      "maxTurnsPerSession": 3,
      "maxOutputTokens": 192,
      "maxLatencyMs": 8000
    }
  }
}
```

Set `enabled` back to `false` to disable publication for every sidecar. A user can also choose **Disable tips** in the sidecar; that preference stays only in that browser's local storage. Selecting the optional installer component records the capability with every model feature off; it does not silently opt the runtime in.

`cooldownMs` accepts one minute through 30 days. The default is 24 hours.

## Selection and spam limits

The daemon projects only four bounded signals into the selector: mode, route verification, qualified-fallback count, and whether Compatibility Watch reported change. A fixed priority list returns at most one static catalog entry. There is no randomness, telemetry, rotation service, ambient model call, or background network lookup.

The sidecar shows no tip unless the daemon publishes one. When it does:

- at most one tip is shown in a browser session;
- the last-show timestamp enforces the configured cooldown across sessions;
- **Dismiss** hides the current tip;
- **Disable tips** prevents future display in that browser;
- the tip stays compact and links to a local, collapsed glossary entry.

The browser stores only a disabled flag, last-show/refinement timestamps, and a one-bit session marker. It stores no prompt, thread/account/task identifier, provider credential, route body, transcript, or model output.

## Optional cheap-model refinement

Refinement is heuristic-first and foreground-only. Set `modelRefinement.enabled` to `true`, choose an explicit cheap Consult-capable `provider` and exact live model, and set `privacy` to `sanitized-tip-context-only`. The daemon publishes the refinement capability only when that provider/model is currently available and supports Consult. A missing provider, unavailable model, unsupported mode, or denied privacy gate means no model controls and no call.

The user must press **Refine**. No call happens merely because the sidecar opens or a tip appears. The request contains only the static tip key/current copy and fixed rewrite instructions—never the host prompt, thread/account/task IDs, credentials, files, memory, or arbitrary runtime text. It inherits the selected provider account plus provider/host settings, and explicitly disables web and subagents. The one-call session cap, output-token ceiling, latency abort, and refinement cooldown are conjunctive; a failed call still consumes the attempt and cooldown so retries cannot burn silently.

## Session-only "Ask about this"

Set `ask.enabled` to `true` only after model refinement is configured. The **Ask about this** dialog exists but makes no call until the user opens it and submits a question. It uses the same gated provider/model/account/privacy/settings route, with its own maximum of one to four turns, output-token ceiling, and latency abort.

The conversation handle remains in page memory, while the visible transcript stays in the page DOM and a bounded 30-minute continuation copy stays only in daemon RAM. Tip turns bypass Threadspan's normal response/thread session store, are capped at four turns and 16 simultaneous mini conversations, and are cleared on daemon close. They are never written to local storage, durable memory, the host prompt, or a durable thread list. Only text typed into this mini conversation is sent. The UI never imports the main assistant's raw prompt or identifiers.

Every foreground call rechecks the configured provider/model, exact Consult capability, current live availability, and privacy policy on the daemon. The daemon replaces refinement copy/instructions with the static catalog version, rejects account IDs and host context/artifacts/workspaces, reapplies the configured token/latency ceilings, and resolves the provider's currently selected account internally. Stale or modified browser state cannot weaken those gates.

**Escalate to main assistant** is a separate explicit action. It emits/copies a safe topic handoff without attaching the mini-conversation transcript; host integrations may consume that event. There is no automatic escalation or ambient chatter.

## Current catalog

Tips may explain changed compatibility evidence, an unverified route, a qualified fallback, or the current Consult/Integrated/Delegate boundary. The full vocabulary and practical "Try" ideas are in the [Threadspan glossary](GLOSSARY.md).
