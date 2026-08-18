# Windows setup

Windows is a first-class target. Version 0.4.1 passed focused native tests and live provider, Continuity, and restart acceptance on Windows; use this guide with the live smoke checklist because account, CLI, and app behavior can still drift.

## Install

From PowerShell in the extracted package:

```powershell
npm install
node .\src\cli.mjs config init
```

Default config:

```text
%USERPROFILE%\.cursor-codex-bridge\config.jsonc
```

Set credentials for the current shell:

```powershell
$env:CURSOR_API_KEY = '...'
$env:DEEPSEEK_API_KEY = '...'
$env:XAI_API_KEY = '...'
$env:CURSOR_BRIDGE_TOKEN = 'long-random-value'
```

Persist them only through a credential-management approach appropriate for the machine. Avoid checking secrets into PowerShell profiles or project files.

## Diagnose

```powershell
node .\src\cli.mjs doctor
node .\src\cli.mjs providers
node .\src\cli.mjs models
```

The doctor command searches `PATH` and `PATHEXT` for command providers rather than assuming a bare name exists. For Grok Build it also checks the configured/default `%USERPROFILE%\.grok\bin\grok.exe`, prints the resolved version and optional SHA-256, and reports missing pin/entitlement-policy warnings without making an inference request.

## Start

```powershell
.\examples\windows\start-bridge.ps1
```

Or:

```powershell
node .\src\cli.mjs serve
```

## Install Codex integration

```powershell
node .\src\cli.mjs codex install
node .\src\cli.mjs skill install --skill all
```

The generated MCP entry records absolute paths to the current Node executable, CLI, and bridge config, which avoids dependence on the client's working directory.

## Windows-specific cautions

- PowerShell environment variables apply to the process tree launched from that shell.
- Windows file ACLs do not map exactly to POSIX mode `0600`. Preserve the required sandbox identity while ensuring the owner, Administrators, and SYSTEM retain inheritable access to `.codex`; verify the resulting ACL before resuming Codex rather than replacing the tree blindly.
- Managed command/Grok processes use a graceful then forced `taskkill /PID <pid> /T` sequence. This is stronger than direct `child.kill()`, but native canaries must still prove descendant cleanup for the installed CLI; a Windows Job Object helper remains roadmap work.
- Antivirus/Defender may inspect temporary Consult snapshots and spawned SDK/CLI processes.
- Test paths containing spaces and non-ASCII characters.
- Long repository paths can still trigger third-party tool limitations even when Node itself supports them.
- Cursor SDK local transport/process behavior must be tested natively; WSL results are not equivalent.


## Grok Build on Windows

The starter provider uses the portable path:

```jsonc
"command": "~/.grok/bin/grok"
```

At runtime `~` expands through `USERPROFILE`, and executable discovery applies `PATHEXT`, so a normal `%USERPROFILE%\.grok\bin\grok.exe` installation is found. For unattended work, replace it with the reviewed absolute `.exe` path or set `GROK_BUILD_PATH`, then run:

```powershell
node .\src\cli.mjs doctor
node .\src\cli.mjs models
```

Review the reported version/hash and optionally set `pin.version` and `pin.sha256`. Never reuse another machine's hash.

Before Delegate, create a dedicated linked worktree:

```powershell
git -C C:\src\repo worktree add C:\src\repo-worktrees\task-123 -b bridge/task-123 HEAD
node .\src\cli.mjs delegate `
  "Implement the exact bounded task packet; do not integrate" `
  --provider grok-build `
  --model grok-4.6 `
  --workspace C:\src\repo-worktrees\task-123 `
  --profile mechanical `
  --max-turns 8 `
  --expected-turns 2 `
  --no-plan `
  --acceptance-command "npm test"
```

The provider can enforce a linked worktree, clean start, and denied `main`/`master`/`trunk` branch. It does not create or integrate the worktree. Check the CLI account's Build entitlement and Settings → Usage before automatic batches; the local ledger cannot reconstruct the weighted weekly percentage.

## Recommended per-user scheduled startup

The source package does not install a machine-wide Windows service. For a personal workstation, the reviewed installer plan creates a per-user scheduled task that launches:

```text
Program: <absolute path to node.exe>
Arguments: <absolute path to src\cli.mjs> serve --config <absolute path to config.jsonc>
Start in: <package directory>
```

Make sure the task receives required environment variables through a secure mechanism. Do not put provider keys directly in the task arguments. Confirm the task survives the installing shell or SSH session ending, and reject a restart that leaves the previous detached `serve` process on the listener.
