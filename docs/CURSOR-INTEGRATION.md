# Cursor integration

Cursor appears in two roles:

- **as a provider**, through `@cursor/sdk`;
- **as a host client**, through an MCP server and a Cursor skill/rule copied into a project.

These roles are independent. The bridge can be called from Cursor while consulting DeepSeek/Nous, or called from Codex while consulting/delegating to Cursor.

## Cursor as a provider

Install dependencies normally:

```bash
npm install
```

`@cursor/sdk` is optional and dynamically imported. A bridge configuration can run DeepSeek/Nous/command providers without successfully importing Cursor.

Set:

```bash
export CURSOR_API_KEY='...'
```

PowerShell:

```powershell
$env:CURSOR_API_KEY = '...'
```

Run:

```bash
node src/cli.mjs doctor
node src/cli.mjs models
```

### Cursor Consult

Cursor does not expose the raw-model semantics needed for Integrated mode, and the inspected SDK surface does not provide a hard read-only Ask mode. The implementation therefore uses:

1. a disposable snapshot of the requested workspace;
2. a fresh local Cursor agent;
3. `plan` mode by default;
4. a policy prompt requiring advisory output;
5. disposal of the agent and snapshot after the turn.

Any accidental file edits occur in the copy. The source tree is not changed by that agent instance.

This boundary does **not** guarantee:

- that no copied content is transmitted to Cursor/model providers;
- that the provider cannot use network tools;
- that hostile files cannot affect the agent runtime;
- that the plan-mode agent will never attempt a write in the copy.

### Cursor Delegate

Delegate uses the live workspace and `agent` mode by default. The provider retains a local SDK agent for continuity and amortized startup cost.

Pool key:

```text
bridge thread ID + model ID + resolved workspace path
```

Safety/lifecycle behavior:

- one concurrent send per retained agent;
- duplicate first-call creation is deduplicated;
- queued cancellation does not execute later;
- unrelated agents can run concurrently;
- dead agents are removed and disposed;
- idle/count limits evict old agents;
- closing the bridge disposes retained agents.

Delegate should be given a bounded task and reviewed like any autonomous code change.

### Cursor Integrated

Unsupported by design. A capability error explains that the SDK exposes Cursor's agent harness rather than a raw model endpoint controlled by the caller's tool loop.

## Cursor as an MCP host

Copy the example `.cursor` directory from:

```text
examples/cursor/.cursor/
```

It includes:

- `mcp.json` — launches the bridge's stdio MCP server;
- `skills/consult/SKILL.md` — project-local Consult skill;
- `skills/managed-worker/SKILL.md` — bounded Delegate and independent-acceptance skill;
- `rules/consult.mdc` — mode-selection and evidence rules.

The example uses paths relative to the installed package only where Cursor can resolve them. Review and change the absolute package/config paths for the target machine rather than relying on a shell working directory.

A minimal MCP configuration is:

```json
{
  "mcpServers": {
    "consult": {
      "command": "node",
      "args": [
        "/absolute/path/to/cursor-bridge/src/cli.mjs",
        "mcp",
        "--config",
        "/absolute/path/to/config.jsonc"
      ]
    }
  }
}
```

## Cursor-side Consult workflow

The host Cursor agent should:

1. identify a question where independent judgment is useful;
2. summarize current state and evidence;
3. call MCP `consult`;
4. retain `threadId` for follow-up;
5. evaluate and verify the response;
6. continue its own implementation rather than handing conversational control to the consultant.

The skill must not call Delegate merely because the consultant has access to an agentic provider. Consult is advice.

## Using DeepSeek or Nous from Cursor

Cursor can call the bridge's MCP Consult tool regardless of which provider is configured:

- `provider: "deepseek"` for V4;
- `provider: "nous"` for the Hermes subscription proxy;
- omit `provider` for the bridge default.

For an Integrated raw-model workflow inside Cursor itself, use Cursor's native custom-model/provider features when available, or another client that can target the bridge's Responses endpoint. The shipped Cursor integration focuses on MCP Consult/Delegate because it is the stable compositional boundary.

## Settings and prompts

The bridge can pass configured `settingSources`, sandbox options, MCP servers, and mode/model selections into Cursor SDK agent creation. Keep these minimal for Consult. Giving the snapshot agent broad external MCP tools can undermine the expectation that it is merely reviewing local evidence.

## Live smoke checklist

1. `doctor` imports `@cursor/sdk` and sees `CURSOR_API_KEY`.
2. `models` returns at least the configured fallback.
3. Consult a tiny test repository and verify the source tree hash is unchanged.
4. Verify the temporary snapshot is removed after success and failure.
5. Delegate a trivial tracked change in a disposable repository.
6. Send two same-thread Delegate calls and verify ordering/continuity.
7. Cancel a queued and an active call.
8. Close the bridge and check for orphaned Cursor processes.
9. Repeat on Windows native, not only WSL/Linux.


## Cursor-side managed-worker workflow

The host Cursor agent can use MCP `delegate` to route a bounded task to Cursor, Grok Build, or another configured agent provider. It should build the authoritative task packet, create/select an isolated worktree, set finite profile/turn/time controls, and independently inspect/retest the result.

Do not confuse this with Cursor acting as the provider: the host agent may delegate to any provider ID. Grok Build remains Consult/Delegate only; direct xAI API remains the raw Integrated route.
