# How Threadspan was built

This report covers the build phase beginning with the GPT-5.6 Sol handoff at `2026-08-17T18:11:00Z`. It uses local Codex task events and Threadspan's own provider ledger rather than account dashboards. The cutoff for this snapshot is `2026-08-18T10:41:05Z`.

![Threadspan build usage](media/build-usage.svg)

## Activity

| Measure | Observed |
|---|---:|
| Wall-clock interval | 16.5 hours |
| Active item intervals | 11.1 hours |
| User steering messages | 420 |
| Assistant messages | 583 |
| Tool calls | 4,187 |
| Continuation/compaction contexts | 17 |

"Active item intervals" is the union of native item start/completion intervals, not a timesheet. It excludes idle gaps and can still include overlapping provider work.

## Codex tokens

| Token class | Tokens |
|---|---:|
| Input | 559,576,468 |
| Cached input | 553,382,272 |
| Uncached input (derived) | 6,194,196 |
| Output | 1,058,097 |
| Reasoning output (subset) | 405,642 |
| Total | 560,634,565 |

Cached input is shown separately because it dominates the total. Reasoning output is already included in output and must not be added again.

## Threadspan-routed work

| Route | Events | Completed | Failed | Input | Cached | Output | Reasoning subset |
|---|---:|---:|---:|---:|---:|---:|---:|
| Nous | 23 | 23 | 0 | 439,743 | 328,064 | 21,528 | 16,724 |
| Grok Build | 13 | 9 | 4 | 184,386 | 500,992 | 7,090 | 4,631 |
| Nous worker | 7 | 4 | 3 | 409,426 | 327,296 | 3,875 | 0 |
| Cursor | 7 | 4 | 3 | 95,757 | 716,928 | 7,493 | 0 |
| OpenRouter | 5 | 3 | 2 | 718 | 0 | 117 | 94 |
| Claude Code gateway | 5 | 3 | 2 | 6 | 0 | 205 | 0 |
| Cursor SDK | 2 | 1 | 1 | 13,441 | 0 | 114 | 0 |

Provider-reported token fields are not directly comparable. Some CLIs report cache reads separately from input, some omit categories, and some report only terminal usage. The event counts are more reliable than cross-provider token totals.

## What the numbers mean

- This was an intensive productization session, not a from-scratch origin story. The design foundation came from earlier local orchestration work and the owner's organized provider, Continuity, recovery, parallel-work, and UI ideas.
- Threadspan was used while Threadspan was being built: live routing, account isolation, provider acceptance, compatibility repair, and source-grounded review all exercised the same daemon and adapters being prepared for release.
- The long task history explains the very large cached-input number. Continuity reduces the need to carry that history forever; it does not make context free.
- Failed events are retained because they found real integration defects. They are not presented as successful provider work.
- No account tier, account count, email, prompt, private task content, credential, or provider cookie appears in this report.

This snapshot is reproducible from owner-local ledgers, but those ledgers are not part of the public release.
