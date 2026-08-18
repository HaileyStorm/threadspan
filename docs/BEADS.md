# Optional Beads integration

Threadspan can stage a disabled-by-default Beads component for repositories that want durable issue lifecycle and explicit continuous-work scheduling. Selecting it writes only `threadspan/components/beads.json` under the chosen install root. It does not install Beads, run `bd init`, migrate a tracker, invoke hooks, or mutate an issue.

The installer agent should prefer the official Beads Codex plugin, keep the canonical tracker at the repository root, and use explicit issue IDs for lifecycle commands. Before the first lifecycle mutation after a Desktop or CLI start, it performs a read-only activation audit of the exact project root, composed policy hashes, installed `bd` version, and static tracker routing. Discovery must not invoke `bd where` when the tracker is absent, ambiguous, historical, or read-only.

`bd ready` is scheduling evidence, not completion authority. Automatic next-work selection is allowed only when the repository explicitly declares `continuation_mode=continuous`; milestone and user-driven work remain stopped at their terminal milestone. A missing or empty ready queue falls back to explicit project actions, then to a versioned backlog, and never silently completes an active objective.

Writable work uses the shared `.working` reservation contract before edits. Existing `AGENTS.md`, tracker state, project workflow, and stronger safeguards always win. The component excludes credentials, memory, and cross-host coordination.

To adopt it, select **Beads** in the setup window, review the generated component document and prerequisite, then let the installer agent propose the repo-local policy separately. Every proposed file remains visible before approval and keeps the normal rollback record.
