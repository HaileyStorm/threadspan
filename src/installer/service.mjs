import { createHash } from "node:crypto";
import { resolve } from "node:path";

const PASSED_ENVIRONMENT = ["THREADSPAN_TOKEN", "NOUS_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY", "DEEPSEEK_API_KEY"];

/** Render a per-user daemon lifecycle plan without writing files or starting processes. */
export function createDaemonServicePlan(options) {
  if (!options?.nodePath || !options?.cliPath || !options?.configPath) throw new TypeError("nodePath, cliPath, and configPath are required");
  const platform = options.platform ?? process.platform;
  const payload = platform === "linux" ? linuxPlan(options) : platform === "win32" ? windowsPlan(options) : unsupportedPlan(platform);
  const plan = { schemaVersion: 1, kind: "threadspan-daemon-service", platform, ...payload };
  return { ...plan, digest: digest(plan) };
}

function linuxPlan(options) {
  const node = resolve(options.nodePath);
  const cli = resolve(options.cliPath);
  const config = resolve(options.configPath);
  const unit = `[Unit]\nDescription=Threadspan shared model-routing daemon\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(node)} ${systemdQuote(cli)} serve --config ${systemdQuote(config)}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPassEnvironment=${PASSED_ENVIRONMENT.join(" ")}\n\n[Install]\nWantedBy=default.target\n`;
  return {
    supported: true,
    files: [{ path: "~/.config/systemd/user/threadspan.service", content: unit, mode: 0o600 }],
    activate: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "threadspan.service"]],
    status: [["systemctl", "--user", "status", "threadspan.service", "--no-pager"]],
    rollback: [["systemctl", "--user", "disable", "--now", "threadspan.service"], ["systemctl", "--user", "daemon-reload"]],
    note: "Import required environment variables into the user manager before activation; values are never written into the unit.",
  };
}

function windowsPlan(options) {
  const node = resolve(options.nodePath);
  const cli = resolve(options.cliPath);
  const config = resolve(options.configPath);
  const startupDirectory = options.startupDirectory;
  if (typeof startupDirectory !== "string" || !startupDirectory) throw new TypeError("startupDirectory is required for win32 service plans");
  const scriptPath = resolve(options.scriptPath ?? `${options.home ?? "~"}/.threadspan/service/threadspan-start.ps1`);
  const script = `$ErrorActionPreference = 'Stop'\r\n& '${psLiteral(node)}' '${psLiteral(cli)}' serve --config '${psLiteral(config)}'\r\nexit $LASTEXITCODE\r\n`;
  const launcher = `@echo off\r\nstart "Threadspan" /min powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${cmdLiteral(scriptPath)}"\r\n`;
  return {
    supported: true,
    files: [{ path: scriptPath, content: script, mode: 0o600 }, { path: resolve(startupDirectory, "Threadspan.cmd"), content: launcher, mode: 0o600 }],
    activate: [["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-File", scriptPath]],
    status: [["powershell.exe", "-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 8743 -State Listen"]],
    rollback: [["powershell.exe", "-NoProfile", "-Command", `Remove-Item -LiteralPath '${psLiteral(resolve(startupDirectory, "Threadspan.cmd"))}' -Force`]],
    note: "The launcher runs at user logon and inherits user-scoped environment variables; no provider credential value is written to disk.",
  };
}

function unsupportedPlan(platform) {
  return { supported: false, files: [], activate: [], status: [], rollback: [], note: `No managed daemon template is supplied for ${platform}.` };
}

function systemdQuote(value) { return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
function psLiteral(value) { return String(value).replace(/'/g, "''"); }
function cmdLiteral(value) { return String(value).replace(/%/g, "%%").replace(/"/g, '""'); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
