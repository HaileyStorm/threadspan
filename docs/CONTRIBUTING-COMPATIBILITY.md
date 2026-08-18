# Compatibility contributions

File a **Compatibility report** for a changed app, CLI, provider, or platform. A focused pull request is welcome when the fix is already understood. Agents may submit either, but must use sanitized public evidence and identify exact versions, platform, rollback, tests, and remaining gaps.

Threadspan's local intake monitor reads only public issue and pull-request metadata. It does not download diffs, check out branches, run contributor code, comment, approve, merge, release, update a host, or expose account state. Untrusted pull-request code must never run on a self-hosted runner.

For Desktop update reports, bind evidence to one exact `{platform, product, N, N+1}` transition. Report `attach`, `protocol`, `routing`, `provider`, and `settings` separately; do not summarize partial success as compatibility. Label simulated Linux/Windows plans `synthetic`, record the actual execution host, and never use cross-platform simulation as native acceptance. Keep repair proposals bound to the exact failed probe digest and unchanged target preimages.

Promotion is separate:

1. Triage the report as compatibility, security, provider, UI, or documentation work.
2. Reproduce it in a disposable sandbox without credentials or private source.
3. Review the proposed diff and run bounded focused tests.
4. Merge through normal maintainer authority and publish a signed/tagged source release.
5. Roll out independently on Linux and Windows with preserved rollback artifacts.

Release integration remains manual and passive. Do not invoke an updater, relaunch Desktop, call provider inference, switch accounts/routes, change Settings/authentication, patch Desktop internals, or disturb running tasks as part of a compatibility contribution.

Reports may inform native Settings/Usage migration and HUD sunset review. They never decide it alone. Sunset still requires verified feature parity, both-host acceptance, rollback, and a measured coexistence period; keeping the Threadspan HUD indefinitely is valid.
