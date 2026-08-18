# Cursor Standard host surface

This source-only VS Code-compatible extension provides a small Threadspan provider pane and launches the companion setup window. A generated user-level `.cursor/mcp.json` gives Cursor Agent and the CLI the same Threadspan MCP tools.

The extension reads the owner-private local daemon token into extension memory only. It does not store the token in settings, webview state, logs, or source. It does not inject models into Cursor's undocumented picker; Cursor-native models remain in Cursor, while the Threadspan pane exposes cross-provider routes.
