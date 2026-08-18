# Voice and request-local intent

Threadspan Voice controls presentation, not authority. The local default is **Technical partner**. A selected profile may shape only user-facing assistant prose and the cadence of optional progress updates.

It never changes machine protocols, tool calls or results, JSON schemas, exact evidence, mandated formats, permissions, routing, provider/native settings, factual claims, or factual confidence. Voice also never replaces system/developer authority. A safe raw-Consult adapter receives the bounded Voice instruction only when it explicitly advertises a user-facing prose-policy hook; Integrated/tool and unsupported adapters run unchanged. The instruction is transient and is not added to stored or replayed messages.

## Presets

`D/W/T/P/U/C` are directness, warmth, technical depth, progress cadence, uncertainty disclosure, and correction explicitness. Every value is an integer from 1 to 5.

| Profile | D | W | T | P | U | C |
|---|---:|---:|---:|---:|---:|---:|
| Technical partner (default) | 5 | 3 | 5 | 1 | 4 | 5 |
| Concise operator | 5 | 2 | 3 | 1 | 3 | 4 |
| Teaching explainer | 3 | 4 | 5 | 2 | 4 | 5 |
| Diagnostic reviewer | 4 | 3 | 5 | 2 | 5 | 5 |
| Calm guide | 3 | 5 | 3 | 3 | 4 | 4 |

The setup window presents these as preset cards. **Customize** clones the selected preset into a request-safe custom profile with advanced sliders, preferred/avoided terms, a live local preview, and **Reset to Technical partner**. The reviewed selection is written to `threadspan/components/voice-profiles.json` through the installer's normal exact preview, digest approval, preimage backup, and rollback manifest. Runtime loading treats that managed file as a lower-precedence layer beneath an explicit `config.jsonc` `voice` block, and reopening setup hydrates the existing managed selection.

## Custom schema

Runtime configuration uses `voice.selectedProfile` and optional custom `voice.profiles`:

```json
{
  "voice": {
    "selectedProfile": "my-reviewer",
    "profiles": [
      {
        "id": "my-reviewer",
        "name": "My reviewer",
        "userPromise": "Evidence-led review with direct corrections.",
        "parameters": {
          "directness": 4,
          "warmth": 3,
          "technicalDepth": 5,
          "progressCadence": 2,
          "uncertaintyDisclosure": 5,
          "correctionExplicitness": 5
        },
        "preferredTerms": ["evidence", "invariant"],
        "avoidedTerms": ["obviously"]
      }
    ]
  }
}
```

Custom profiles are composable from any preset or complete custom base. Unknown profile and parameter fields survive normalize/serialize round trips so newer extensions are not erased by an older Threadspan build. Built-in preset IDs cannot be shadowed. Free-form names, promises, and terminology remain display/configuration data; only the six validated numeric tendencies enter the elevated transient adapter instruction, preventing custom text from becoming prompt authority.

## Request-local intent brief

An optional structured intent brief can formalize an explicitly supplied `objective`, `deliverables`, `constraints`, `permissions`, `priorities`, `exclusions`, `acceptance`, and `deferred` list. Threadspan derives it only from those structured caller fields; it does not infer authority from raw prompt text, invent permissions, or drop unaffected authority.

Updates must identify themselves as an `override`, `addition`, or exact `correction`. Overrides replace only named fields, additions append without deleting existing items, and corrections must match the current authoritative value before replacement. The raw request remains authoritative.

Intent briefs are request-local. They are available through the exported derivation/update functions and an optional in-process `onIntentBrief` execution callback. They are not memory, are not added to replay messages, and are removed from returned/session and provider adapter metadata. This feature does not create a new route for raw prompts or private data; normal provider delivery remains governed by the existing route/privacy authority.

## Compatibility boundary

Voice and intent have no memory implementation. A future host-native style or intent API may replace an adapter hook only after capability and replay compatibility are verified. Until then, unsupported adapters remain unchanged rather than emulating support through machine protocols or execution prompts.

Project-bootstrap's installed reservation-recovery policy is also fail-closed: it is disabled by default and declares that any separately authorized implementation must require explicit owner authorization and visible evidence, use an exact `working_sentinel.py` tool release first, target only the exact claim, never interrupt active work, and have no silent fallback. Voice installation does not itself release reservations.
