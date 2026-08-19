import { resolve } from "node:path";
import { requireHostSurface } from "../core/host-surfaces.mjs";

export function createMcpShimDefinition(options) {
  for (const key of ["nodePath", "cliPath", "bridgeConfigPath", "connectorTokenFile"]) {
    if (typeof options?.[key] !== "string" || !options[key]) throw new TypeError(`${key} is required`);
  }
  if (options.ownerTokenFile && resolve(options.ownerTokenFile) === resolve(options.connectorTokenFile)) {
    throw new TypeError("Generated host MCP connector token file must differ from the owner main-token file");
  }
  const remoteUrl = options.remoteUrl ?? "http://127.0.0.1:8743/mcp";
  const endpoint = new URL(remoteUrl);
  if (endpoint.pathname.replace(/\/+$/, "") !== "/mcp") throw new TypeError("Generated host MCP endpoint must end in /mcp");
  return Object.freeze({
    command: resolve(options.nodePath),
    args: [
      resolve(options.cliPath), "mcp",
      "--config", resolve(options.bridgeConfigPath),
      "--remote", endpoint.toString(),
      "--token-file", resolve(options.connectorTokenFile),
    ],
  });
}

export function renderCursorMcpConfig(existing, options) {
  requireHostSurface("cursor");
  const document = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  document.mcpServers = document.mcpServers && typeof document.mcpServers === "object" && !Array.isArray(document.mcpServers)
    ? document.mcpServers : {};
  document.mcpServers.threadspan = createMcpShimDefinition(options);
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function renderGrokMcpToml(options) {
  requireHostSurface("grok");
  const shim = createMcpShimDefinition(options);
  return `[mcp_servers.threadspan]\ncommand = ${tomlString(shim.command)}\nargs = [${shim.args.map(tomlString).join(", ")}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 7200\n`;
}

export function renderHermesMcpYaml(options) {
  requireHostSurface("hermes");
  const shim = createMcpShimDefinition(options);
  return `# Merge this server into the reviewed Hermes MCP configuration.\n# The connector token is read-only. Reverse Delegate and owner-only controls are intentionally unavailable.\n# Hermes remains responsible for its native account and model picker.\nmcp_servers:\n  threadspan:\n    transport: stdio\n    command: ${yamlString(shim.command)}\n    args:\n${shim.args.map((arg) => `      - ${yamlString(arg)}`).join("\n")}\n    tools:\n      include:\n        - bridge_status\n        - bridge_models\n        - bridge_accounts\n        - consult\n        - integrated\n`;
}

/** Render a staged Claude Code stdio MCP document without credential values. */
export function renderClaudeCodeMcpConfig(existing, options) {
  requireHostSurface("claude-code");
  const document = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  document.mcpServers = document.mcpServers && typeof document.mcpServers === "object" && !Array.isArray(document.mcpServers)
    ? document.mcpServers : {};
  document.mcpServers.threadspan = { type: "stdio", ...createMcpShimDefinition(options) };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Render a reviewable Claude Code settings fragment for the compact Threadspan status line. */
export function renderClaudeCodeSettings(existing, options) {
  requireHostSurface("claude-code");
  if (typeof options?.statusLinePath !== "string" || !options.statusLinePath) throw new TypeError("statusLinePath is required");
  const document = existing && typeof existing === "object" && !Array.isArray(existing) ? structuredClone(existing) : {};
  document.statusLine = {
    type: "command",
    command: `${shellQuote(resolve(options.nodePath))} ${shellQuote(resolve(options.statusLinePath))}`,
    padding: 0,
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function createHostSurfaceInstallPacket(host, options) {
  const surface = requireHostSurface(host);
  const content = host === "grok" ? renderGrokMcpToml(options)
    : host === "cursor" ? renderCursorMcpConfig(options.existing, options)
      : host === "claude-code" ? renderClaudeCodeMcpConfig(options.existing, options)
      : host === "hermes" ? renderHermesMcpYaml(options)
        : null;
  return Object.freeze({
    surface,
    content,
    ...(["claude-code", "hermes"].includes(host) ? {
      status: "preview",
      liveTested: false,
      nativePickerReplaceable: false,
      nativePickerPreserved: true,
    } : {}),
    ...(host === "claude-code" ? {
      settingsContent: renderClaudeCodeSettings(options.existingSettings, options),
      pluginSource: options.pluginSource ?? null,
    } : {}),
    storesCredentialValues: false,
    recovery: host === "hermes" ? "unavailable" : `native-${host}`,
  });
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function shellQuote(value) {
  return JSON.stringify(String(value));
}
