# Cursor host example

This example assumes the bridge package is installed globally or linked so the `cursor-bridge` executable is on `PATH`:

```bash
npm install -g /absolute/path/to/cursor-bridge
```

Copy the `.cursor` directory into the host project. The MCP shim uses the default bridge config path for authentication policy and forwards to the persistent daemon at `http://127.0.0.1:8743`. Start that daemon once for every Cursor/ChatGPT/Codex coordinator tree.

For a non-global installation, change `.cursor/mcp.json` to launch the current Node executable with absolute paths to `src/cli.mjs` and the desired config file.

The project-local skill mirrors the package Consult skill. The rule is always applied to keep mode semantics and verification requirements visible.

The example also includes `.cursor/skills/managed-worker/SKILL.md`. Use it only for bounded provider-owned execution in an isolated worktree; keep Consult advisory and independently accept Delegate output.

Use `--embedded` only when you deliberately want this Cursor process to own a separate provider registry, admission controller, and retained-agent pool.
