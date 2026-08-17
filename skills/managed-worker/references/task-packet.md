# Managed-worker task packet

```text
OUTCOME
<one concrete deliverable>

BASE / WORKSPACE
- Repository/worktree: <exact isolated workspace supplied separately>
- Base commit: <sha>
- Branch: <non-canonical branch>

SCOPE
- May change: <files/components>
- Must not change: <files/components>
- Non-goals: <explicit exclusions>

CONSTRAINTS
- <compatibility, dependency, security, performance, style>

ACCEPTANCE
1. <exact command>
2. <exact command>

EVIDENCE REQUIRED
- changed files and concise rationale;
- exact commands run and terminal results;
- unresolved risks or unverified assumptions;
- no claim of integration, push, merge, or release.
```

Keep the packet self-contained, but include only context needed for the bounded task. The workspace remains the source of truth for code; the packet remains the source of truth for scope and acceptance.
