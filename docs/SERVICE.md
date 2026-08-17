# Daemon lifecycle

Threadspan is one shared daemon per user account. Cursor, Grok Build, Codex, and ChatGPT may open and close independently; they do not own the daemon.

`createDaemonServicePlan()` renders a reviewable, hashed lifecycle plan:

- Linux: a `systemd --user` unit with restart-on-failure.
- Windows: a hidden per-user PowerShell launcher in the user's Startup folder.

Both plans bind the normal Threadspan configuration to the installed Node and CLI paths. They pass only named environment variables. Provider key values are not written into units, launchers, logs, or tracked configuration.

The Linux unit deliberately does not use `PrivateTmp`: Delegate workspace paths must identify the same files for the coordinator, daemon, worker, and independent acceptance process.

An installing agent should preview the exact files and commands, preserve any existing file as a rollback artifact, write atomically, activate the service, and verify `/health`, `/v1/models`, `/threadspan/state`, and restart durability. Do not claim one host from evidence gathered on the other.

The user can stop or remove Threadspan without uninstalling or signing out of any provider app.
