# Independent acceptance checklist

- Confirm provider, model, profile, effort, turn cap, and timeout used.
- Confirm the worker ran in the intended branch/worktree and started from the recorded base.
- Inspect `git status`, the full diff, and every changed path.
- Reject unrelated changes, hidden generated files, credentials, or external-path writes.
- Re-run each acceptance command yourself; do not rely on reported success.
- Add a discriminating/adversarial test when the bug or requirement has plausible edge cases.
- Confirm any package, lockfile, network, or configuration changes were explicitly authorized.
- Verify no push, merge, rebase, tag, release, or canonical-branch mutation occurred.
- Record accepted changes and remaining uncertainty before integration.
