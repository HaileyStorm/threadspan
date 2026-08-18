# Optional project bootstrap

Project bootstrap is an agent-guided, preview-first setup for a repository that lacks a complete local operating contract. It is not a template dump and never overwrites an existing project convention merely because Threadspan has a default.

The agent first scouts architecture, entry points, protocols, tests, automation, current policy, tracker state, and remote configuration. It then proposes only the useful repo-local pieces, typically:

- `AGENTS.md` with project-specific safety, workflow, and acceptance rules
- `.codex/config.toml` composed with existing native settings
- one canonical test entry point such as `scripts/test_all.sh`
- repo-root tracker policy when Beads is selected
- CI and runner policy appropriate to the actual platforms
- a private GitHub remote only when the owner authorizes it and no remote or collision exists

Every path and content change appears in the installer preview. Existing files are preserved unless the owner explicitly accepts a merge; writes are rollback-backed and followed by proportional checks. The bootstrap never copies memory, host credentials, machine-local state, multi-host sync, or cross-host communications.

Selecting **Project bootstrap** installs only its disabled component document. Repository mutation is a later, explicit agent step so the same release can adapt to a new project without pretending every project is interchangeable.
