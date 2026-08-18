# Grok Enhanced host surface

Install the plugin from this directory, then register the generated `threadspan` MCP shim at user scope. Grok Build keeps its own account, sessions, dashboard, tasks, and usage display. Threadspan adds cross-provider status plus Consult, Integrated, and Delegate.

Grok Bot and grok.com use the optional authenticated HTTPS `/mcp` connector. They do not accept a localhost connector. Give that connector a dedicated `THREADSPAN_CONNECTOR_TOKEN`; never reuse a provider API key.

No Threadspan code patches Grok's TUI or Grok Bot binaries.
