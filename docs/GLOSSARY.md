# Threadspan glossary

This is the compact vocabulary for Threadspan's current behavior and named roadmap. Use your browser's page search (`Ctrl+F` or `Cmd+F`) or the linked term index below. It is a reference, not a first-run checklist.

[Account routing](#account-routing) · [Availability](#availability-and-verification) · [Beads](#beads) · [Branching](#branching) · [Compatibility Watch](#compatibility-watch-and-self-heal) · [Consult](#consult) · [Context profiles](#context-profiles) · [Continuity](#continuity) · [Core host](#core-host) · [Delegate](#delegate) · [Fallback](#fallback) · [Integrated](#integrated) · [Local models](#local-models-roadmap) · [Maximum utilization](#maximum-utilization) · [Provider](#provider) · [Tips](#tips)

## Account routing

Selecting among separately described accounts for one provider. Health, quota, privacy, and authority gates remain account-specific; Threadspan never treats one login as interchangeable with another.

## Availability and verification

Availability is observed provider/account/transport health. Verified means current evidence supports a route; it is not a promise of future capacity, entitlement, or successful completion.

## Beads

An optional repo-root issue lifecycle and dependency tracker. Readiness is scheduling evidence, not completion authority. Threadspan does not initialize, migrate, or mutate a tracker merely to discover it.

## Branching

Bounded independent work used when separate evidence, genuine design divergence, or disjoint writes justify the coordination cost. Branches stop when findings converge; the caller owns synthesis.

## Compatibility Watch and self-heal

Compatibility Watch detects bounded app/provider drift and records source-backed evidence. Self-heal restores useful operation first, then performs at most direct, meta, and meta-meta hardening under review, rollback, and host-specific verification gates.

## Consult

Advisory secondary output. The current host keeps judgment, tools, edits, and acceptance.

**Try:** ask a second model to challenge a design, diagnose a failure from compact evidence, or review a proposed patch before you execute it.

## Context profiles

Named context-window and auto-compaction settings. Longer profiles are explicit capability choices, not automatic fixes for poor thread hygiene, and unsupported model/profile combinations must fail closed.

## Continuity

Product-local checkpoints, handoff descriptors, and rollover metadata that preserve a task across a safe boundary. It is not memory, cross-host synchronization, or permission to resume through a different host.

## Core host

The app or CLI that owns the current conversation, tools, approvals, and native recovery. Current core host surfaces are Codex, Grok Build/Bot, Cursor, and preview Hermes integration; their capabilities are not assumed equivalent.

## Delegate

A provider-owned agent executes one bounded task in an authorized workspace. The coordinator still reviews the diff, reruns acceptance, and owns integration.

**Try:** delegate a narrow implementation or test task with exact scope, non-goals, workspace, and verification commands.

## Fallback

A compatible alternative route that passed the current qualification checks. It is never automatic failover by itself and cannot bypass account, privacy, cost, capability, or authority gates.

## Integrated

A raw secondary model is active while the current host owns tools, approvals, and the tool loop. A full provider-owned agent harness cannot be relabeled Integrated.

**Try:** compare a raw model under the same host tool policy, or use a different reasoning provider without changing the host's execution boundary.

## Local models roadmap

Major future support for routing to owner-run models across multiple local backends. It is not implemented today. A central target is Qwen 3.8 27B, with backend-neutral capability, context, tool-use, performance, and privacy checks rather than one hard-coded runtime.

## Maximum utilization

An optional controller for bounded full-push behavior near an authoritative native quota limit. It is disabled by default; estimates, generic errors, and local usage projections cannot activate it.

## Provider

The model or agent service behind a route, such as OpenAI/Codex, Grok, Cursor, Nous, or OpenRouter. Provider identity does not determine mode: the actual adapter capability and authority boundary do.

## Tips

Optional compact product guidance selected first by local capability/state heuristics. Tips are disabled by default, limited to one per browser session, cooldown-bound, dismissible, and user-disableable. An explicitly configured cheap model may refine warranted copy only after user action and strict provider/privacy/live-availability and budget gates. A session-only "Ask about this" chat is also user-opened and never receives the host prompt, memory, identifiers, or credentials.
