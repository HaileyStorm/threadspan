import { createHash } from "node:crypto";
import { resolve } from "node:path";

const WINDOWS_RUNTIME_ENVIRONMENT = [
  "APPDATA", "ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
  "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
];

/** Render a per-user daemon lifecycle plan without writing files or starting processes. */
export function createDaemonServicePlan(options) {
  if (!options?.nodePath || !options?.cliPath || !options?.configPath) throw new TypeError("nodePath, cliPath, and configPath are required");
  const platform = options.platform ?? process.platform;
  const environmentVariables = resolveServiceEnvironment(options);
  const payload = platform === "linux" ? linuxPlan(options, environmentVariables) : platform === "win32" ? windowsPlan(options, environmentVariables) : unsupportedPlan(platform);
  const plan = { schemaVersion: 1, kind: "threadspan-daemon-service", platform, ...payload };
  return { ...plan, digest: digest(plan) };
}

function linuxPlan(options, environmentVariables) {
  const node = resolve(options.nodePath);
  const cli = resolve(options.cliPath);
  const config = resolve(options.configPath);
  const unit = `[Unit]\nDescription=Threadspan shared model-routing daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(node)} ${systemdQuote(cli)} serve --config ${systemdQuote(config)}\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=10s\nNoNewPrivileges=true\nPassEnvironment=${environmentVariables.join(" ")}\n\n[Install]\nWantedBy=default.target\n`;
  return {
    supported: true,
    environmentVariables,
    files: [{ path: "~/.config/systemd/user/threadspan.service", content: unit, mode: 0o600 }],
    activate: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "threadspan.service"]],
    status: [["systemctl", "--user", "status", "threadspan.service", "--no-pager"]],
    rollback: [["systemctl", "--user", "disable", "--now", "threadspan.service"], ["systemctl", "--user", "daemon-reload"]],
    note: "Import required environment variables into the user manager before activation; values are never written into the unit.",
  };
}

function windowsPlan(options, environmentVariables) {
  const node = resolve(options.nodePath);
  const cli = resolve(options.cliPath);
  const config = resolve(options.configPath);
  const startupDirectory = options.startupDirectory;
  if (typeof startupDirectory !== "string" || !startupDirectory) throw new TypeError("startupDirectory is required for win32 service plans");
  const scriptPath = resolve(options.scriptPath ?? `${options.home ?? "~"}/.threadspan/service/threadspan-start.ps1`);
  const allowedEnvironment = [...new Set([...WINDOWS_RUNTIME_ENVIRONMENT, ...environmentVariables])]
    .map((name) => `'${psLiteral(name)}'`).join(", ");
  const script = `$ErrorActionPreference = 'Stop'\r\n$allowedEnvironment = @(${allowedEnvironment})\r\n$currentEnvironment = [Environment]::GetEnvironmentVariables('Process')\r\nforeach ($name in @($currentEnvironment.Keys)) {\r\n  if ($allowedEnvironment -notcontains [string]$name) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }\r\n}\r\n& '${psLiteral(node)}' '${psLiteral(cli)}' serve --config '${psLiteral(config)}'\r\nexit $LASTEXITCODE\r\n`;
  const launcher = `@echo off\r\nstart "Threadspan" /min powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cmdLiteral(scriptPath)}"\r\n`;
  return {
    supported: true,
    environmentVariables,
    files: [{ path: scriptPath, content: script, mode: 0o600 }, { path: resolve(startupDirectory, "Threadspan.cmd"), content: launcher, mode: 0o600 }],
    activate: [["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", scriptPath]],
    status: [["powershell.exe", "-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 8743 -State Listen"]],
    rollback: [["powershell.exe", "-NoProfile", "-Command", `Remove-Item -LiteralPath '${psLiteral(resolve(startupDirectory, "Threadspan.cmd"))}' -Force`]],
    note: "The launcher keeps only runtime essentials plus selected server/provider environment names; no provider credential value is written to disk.",
  };
}

/** Select only server auth and provider environment names present in the reviewed configuration. */
function resolveServiceEnvironment(options) {
  const hasConfig = options.config && typeof options.config === "object";
  if (!hasConfig && !Array.isArray(options.providerEnvironmentVariables)) {
    throw new TypeError("config or an explicit providerEnvironmentVariables array is required for service environment selection");
  }
  const config = hasConfig ? options.config : {};
  const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
  const selectedProviderIds = options.providerIds ?? Object.entries(providers)
    .filter(([, provider]) => provider && typeof provider === "object" && provider.enabled !== false)
    .map(([providerId]) => providerId);
  if (!Array.isArray(selectedProviderIds)) throw new TypeError("providerIds must be an array when configured");

  const names = [options.authTokenEnv ?? config.server?.authTokenEnv ?? "THREADSPAN_TOKEN", ...(options.providerEnvironmentVariables ?? [])];
  if (config.server?.connectorTokenEnv) names.push(config.server.connectorTokenEnv);
  for (const providerId of selectedProviderIds) {
    const provider = providers[providerId];
    if (!provider || typeof provider !== "object") throw new TypeError(`Selected service provider '${providerId}' is not configured`);
    for (const key of ["apiKeyEnv", "authTokenEnv", "executableEnv"]) {
      if (provider[key]) names.push(provider[key]);
    }
    if (provider.gateway?.apiKeyEnv) names.push(provider.gateway.apiKeyEnv);
    if (Array.isArray(provider.envAllowlist)) names.push(...provider.envAllowlist);
  }
  const normalized = [...new Set(names.map((name) => String(name)))];
  const invalid = normalized.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (invalid) throw new TypeError(`Service environment variable name '${invalid}' is invalid`);
  return normalized;
}

function unsupportedPlan(platform) {
  return { supported: false, files: [], activate: [], status: [], rollback: [], note: `No managed daemon template is supplied for ${platform}.` };
}

function systemdQuote(value) { return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function psLiteral(value) { return String(value).replace(/'/g, "''"); }
function cmdLiteral(value) { return String(value).replace(/%/g, "%%").replace(/"/g, '""'); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
