# External copy check

External copy check is a separate top-level Threadspan policy. It is not part of Copy review / Copy Naturalizer.

Permission modes:

- `off` — default. No adapter runs.
- `ask-every-time` — a user-started manual check or user-started release may run only after an explicit confirmation.
- `allow-manual-or-release` — a user-started manual check or user-started release may run without a second prompt.

`selection: "all"` does not enable this component. Environment keys existing do not enable it. Typing, startup, focus, timers, polls, and background activity never start a check.

Results are advisory. Threadspan never averages them into a verdict, never treats them as proof of authorship, and never uses them to accept or reject a rewrite. Protected-span and Voice rules stay with Copy review. External timeout, failure, or skip cannot fail a release.

Stored and reported fields are only normalized status, score, adapter, timestamp, and short safe display text. Source text, keys, raw provider bodies, and sensitive URLs are not persisted.

Threadspan has no partnership with these vendors. Documented endpoints and trial language can drift.

## Pangram — manual handoff only

The official checker is `https://www.pangram.com/`.

A user click may copy selected text to the clipboard and open that URL. The user pastes a short result or score back. Threadspan never submits, scrapes, reads, or automates Pangram's page. Network, clipboard, and browser effects stay at zero until that button is clicked.

## Sapling — documented API, environment key

- Destination: `POST https://api.sapling.ai/api/v1/aidetect`
- Payload: JSON `{ text }` plus the environment-only `SAPLING_API_KEY` (or the configured name). Default payload cap is 12,000 characters.
- Retention: Sapling stores submitted text and uses it to improve its service. An explicit acknowledgement is required before any submit.
- Trial/free drift: developer keys are rate-limited. That is not a permanent free API.

## Winston — documented API, environment key

- Destination: `POST https://api.gowinston.ai/v1/ai-content-detection`
- Payload: JSON `{ text }` with a Bearer token from `WINSTON_API_KEY`. Winston documents 300–150,000 characters; shorter texts are skipped.
- Trial: Winston documents a limited 2,000-credit developer trial with no card required. Availability can change; it is not permanently free.

## GPTZero and Copyleaks

These are documented as conditional/later only. They are not advertised or shipped as working free APIs. Copyleaks sandbox or sample numbers must never appear as real results.

## Surfaces

- Owner-only `POST /v1/copy/check` with `trigger: "manual"` or `"release"`.
- Owner-only `POST /v1/copy/release-review` for a user-started release companion.
- Collapsed HUD panel with explicit buttons only.
- Optional installer component `copy-check`, unchecked and excluded from `selection: "all"`.

Ordinary packaging and the default test suite do not make outbound detector calls. Live provider acceptance is not claimed.
