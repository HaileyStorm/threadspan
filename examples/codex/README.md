# Codex example

From the bridge package root:

```bash
node src/cli.mjs codex install
node src/cli.mjs skill install --skill all
```

Then merge `AGENTS.fragment.md` into the host project's `AGENTS.md`.

The installer generates the model-provider profiles and MCP command using absolute paths. Prefer it over copying a static TOML fragment, which would be wrong as soon as Node, the package, or the config lives somewhere else.

The default generated MCP entry proxies to the same HTTP daemon as the model-provider profiles, so start one daemon before using either MCP tools or bridge profiles:

```bash
node src/cli.mjs serve
```

The installed skills keep advisory Consult separate from bounded managed-worker Delegate. Multiple Desktop coordinators may each launch a tiny stdio shim, but all should target the same daemon. Use stable coordinator/worker-group IDs, one clean linked worktree per writable outer worker, and independently reproduce acceptance commands.
