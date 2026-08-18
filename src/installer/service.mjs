import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const WINDOWS_RUNTIME_ENVIRONMENT = [
  "APPDATA", "ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
  "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
];
const REVISION_PATTERN = /^[0-9a-f]{7,64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const DAEMON_SERVICE_LIFECYCLE_API_VERSION = 1;
export const DAEMON_SERVICE_PLAN_SCHEMA_VERSION = 2;

/** Render a per-user daemon/Desktop-host lifecycle plan without writing files or starting processes. */
export function createDaemonServicePlan(options) {
  if (!options?.nodePath || !options?.cliPath || !options?.configPath) throw new TypeError("nodePath, cliPath, and configPath are required");
  const sourceRevision = normalizeSourceRevision(options.sourceRevision);
  const ownerFingerprint = lifecycleOwnerFingerprint(options.lifecycleOwner);
  const platform = options.platform ?? process.platform;
  const nodePath = resolve(options.nodePath);
  const cliPath = resolve(options.cliPath);
  const configPath = resolve(options.configPath);
  const cliSha256 = resolveCliSha256(cliPath, options.cliSha256);
  const home = resolve(options.home ?? homedir());
  const stateRoot = resolve(options.stateRoot ?? resolve(home, ".threadspan", "service"));
  const environmentVariables = resolveServiceEnvironment(options);
  const shared = { ...options, nodePath, cliPath, configPath, sourceRevision, ownerFingerprint, home, stateRoot };
  const payload = platform === "linux"
    ? linuxPlan(shared, environmentVariables)
    : platform === "win32"
      ? windowsPlan(shared, environmentVariables)
      : unsupportedPlan(platform);
  const planId = normalizePlanId(options.planId ?? `service-${sourceRevision.slice(0, 12)}`);
  const basePlan = {
    apiVersion: DAEMON_SERVICE_LIFECYCLE_API_VERSION,
    schemaVersion: DAEMON_SERVICE_PLAN_SCHEMA_VERSION,
    kind: "threadspan-service-lifecycle",
    planId,
    platform,
    source: { revision: sourceRevision, cliPath, cliSha256 },
    ownerFingerprint,
    stateRoot,
    configPath,
    ...payload,
  };
  return deepFreeze({ ...basePlan, digest: computeServicePlanDigest(basePlan) });
}

function linuxPlan(options, environmentVariables) {
  const serviceDirectory = resolve(options.serviceDirectory ?? resolve(options.home, ".config", "systemd", "user"));
  const marker = lifecycleMarker(options);
  const descriptionBinding = `revision ${options.sourceRevision} owner ${options.ownerFingerprint.slice(0, 16)}`;
  const daemonUnit = `${marker}\n[Unit]\nDescription=Threadspan daemon (${descriptionBinding})\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.cliPath)} serve --config ${systemdQuote(options.configPath)}\nRestart=on-failure\nRestartSec=3\nKillMode=control-group\nTimeoutStopSec=10s\nNoNewPrivileges=true\nPassEnvironment=${environmentVariables.join(" ")}\n\n[Install]\nWantedBy=default.target\n`;
  const desktopUnit = `${marker}\n[Unit]\nDescription=Threadspan Desktop host (${descriptionBinding})\nRequires=threadspan.service\nAfter=threadspan.service\n\n[Service]\nType=simple\nExecStart=${systemdQuote(options.nodePath)} ${systemdQuote(options.cliPath)} desktop attach --config ${systemdQuote(options.configPath)}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=10s\nNoNewPrivileges=true\nPassEnvironment=${environmentVariables.join(" ")}\n\n[Install]\nWantedBy=default.target\n`;
  return {
    supported: true,
    lifecycleKind: "systemd-user",
    environmentVariables,
    allowedWriteRoots: [serviceDirectory, options.stateRoot],
    workloads: [
      { id: "daemon", serviceName: "threadspan.service", sourceRevision: options.sourceRevision, ownerFingerprint: options.ownerFingerprint },
      { id: "desktop-host", serviceName: "threadspan-desktop-host.service", sourceRevision: options.sourceRevision, ownerFingerprint: options.ownerFingerprint, attachmentMode: "authenticated-supervisor-reconnect-only", appLifecycleAuthority: "none" },
    ],
    files: inspectPlannedFiles([
      { role: "daemon", path: resolve(serviceDirectory, "threadspan.service"), content: daemonUnit, mode: 0o600 },
      { role: "desktop-host", path: resolve(serviceDirectory, "threadspan-desktop-host.service"), content: desktopUnit, mode: 0o600 },
    ]),
    commands: {
      inspect: [
        lifecycleCommand("inspect-daemon", ["systemctl", "--user", "cat", "threadspan.service"], { status: "ownership", absentExitCodes: [1] }),
        lifecycleCommand("inspect-desktop-host", ["systemctl", "--user", "cat", "threadspan-desktop-host.service"], { status: "ownership", absentExitCodes: [1] }),
      ],
      activate: [
        lifecycleCommand("daemon-reload", ["systemctl", "--user", "daemon-reload"]),
        lifecycleCommand("enable-start", ["systemctl", "--user", "enable", "--now", "threadspan.service", "threadspan-desktop-host.service"]),
      ],
      verify: [
        lifecycleCommand("daemon-enabled", ["systemctl", "--user", "is-enabled", "threadspan.service"], stableExpectation(["enabled"])),
        lifecycleCommand("daemon-active", ["systemctl", "--user", "is-active", "threadspan.service"], stableExpectation(["active"])),
        lifecycleCommand("desktop-host-enabled", ["systemctl", "--user", "is-enabled", "threadspan-desktop-host.service"], stableExpectation(["enabled"])),
        lifecycleCommand("desktop-host-active", ["systemctl", "--user", "is-active", "threadspan-desktop-host.service"], stableExpectation(["active"])),
        lifecycleCommand("daemon-health", daemonHealthCommand(options), stableExpectation(["ok"])),
      ],
      recover: [
        lifecycleCommand("re-enable-start", ["systemctl", "--user", "enable", "--now", "threadspan.service", "threadspan-desktop-host.service"]),
      ],
      deactivate: [
        lifecycleCommand("disable-stop", ["systemctl", "--user", "disable", "--now", "threadspan-desktop-host.service", "threadspan.service"]),
        lifecycleCommand("rollback-daemon-reload", ["systemctl", "--user", "daemon-reload"]),
      ],
      verifyAbsent: [
        lifecycleCommand("daemon-inactive", ["systemctl", "--user", "is-active", "threadspan.service"], { exitCodes: [3, 4], stdout: ["inactive", "unknown"] }),
        lifecycleCommand("desktop-host-inactive", ["systemctl", "--user", "is-active", "threadspan-desktop-host.service"], { exitCodes: [3, 4], stdout: ["inactive", "unknown"] }),
      ],
      finalize: [lifecycleCommand("final-daemon-reload", ["systemctl", "--user", "daemon-reload"])],
    },
    note: "Import required environment variables into the user manager before activation; values are never written into the units. Desktop attach reconnects only to an existing authenticated supervisor and never launches or restarts the app.",
  };
}

function windowsPlan(options, environmentVariables) {
  const legacyStartupPath = resolveLegacyStartupPath(options);
  const legacyStats = safeLstatSync(legacyStartupPath);
  if (legacyStats) throw new Error("Published Windows Startup predecessor detected; reviewed manual removal is required before Task Scheduler planning");
  const marker = lifecycleMarker(options);
  const daemonScriptPath = resolve(options.stateRoot, "threadspan-daemon.ps1");
  const desktopScriptPath = resolve(options.stateRoot, "threadspan-desktop-host.ps1");
  const registerScriptPath = resolve(options.stateRoot, "threadspan-register-tasks.ps1");
  const cleanupScriptPath = resolve(options.stateRoot, "threadspan-remove-tasks.ps1");
  const allowedEnvironment = [...new Set([...WINDOWS_RUNTIME_ENVIRONMENT, ...environmentVariables])]
    .map((name) => `'${psLiteral(name)}'`).join(", ");
  const daemonScript = renderWindowsRuntimeScript(marker, allowedEnvironment, options, ["serve", "--config", options.configPath]);
  const desktopScript = renderWindowsRuntimeScript(marker, allowedEnvironment, options, ["desktop", "attach", "--config", options.configPath]);
  const descriptions = {
    daemon: `Threadspan lifecycle ${marker.slice(2)} role=daemon`,
    desktop: `Threadspan lifecycle ${marker.slice(2)} role=desktop-host`,
  };
  const registerScript = renderTaskRegistrationScript(marker, daemonScriptPath, desktopScriptPath, descriptions);
  const cleanupScript = renderTaskCleanupScript(marker, descriptions);
  const inspect = [
    windowsTaskDescriptionCommand("inspect-daemon", "Threadspan Daemon"),
    windowsTaskDescriptionCommand("inspect-desktop-host", "Threadspan Desktop Host"),
  ];
  return {
    supported: true,
    lifecycleKind: "windows-task-scheduler",
    legacyStartup: { path: legacyStartupPath, state: "absent", policy: "fail-closed-no-delete-no-migrate" },
    environmentVariables,
    allowedWriteRoots: [options.stateRoot],
    workloads: [
      { id: "daemon", taskName: "Threadspan Daemon", sourceRevision: options.sourceRevision, ownerFingerprint: options.ownerFingerprint },
      { id: "desktop-host", taskName: "Threadspan Desktop Host", sourceRevision: options.sourceRevision, ownerFingerprint: options.ownerFingerprint, attachmentMode: "authenticated-supervisor-reconnect-only", appLifecycleAuthority: "none" },
    ],
    files: inspectPlannedFiles([
      { role: "daemon", path: daemonScriptPath, content: daemonScript, mode: 0o600 },
      { role: "desktop-host", path: desktopScriptPath, content: desktopScript, mode: 0o600 },
      { role: "task-registration", path: registerScriptPath, content: registerScript, mode: 0o600 },
      { role: "task-cleanup", path: cleanupScriptPath, content: cleanupScript, mode: 0o600 },
    ]),
    commands: {
      inspect,
      activate: [lifecycleCommand("register-start-tasks", powershellFileCommand(registerScriptPath))],
      recover: [lifecycleCommand("repair-start-tasks", [...powershellFileCommand(registerScriptPath), "-Repair"])],
      verify: [
        windowsTaskStateCommand("daemon-task-state", "Threadspan Daemon"),
        windowsTaskStateCommand("desktop-host-task-state", "Threadspan Desktop Host"),
        lifecycleCommand("daemon-health", daemonHealthCommand(options), stableExpectation(["ok"])),
      ],
      deactivate: [lifecycleCommand("stop-remove-tasks", powershellFileCommand(cleanupScriptPath))],
      verifyAbsent: inspect.map((command) => ({ ...command, id: command.id.replace("inspect", "absent"), expectation: { absent: true } })),
      finalize: [],
    },
    note: "The per-user scheduled tasks use the current interactive identity, keep only reviewed environment names, and never write provider credential values. Desktop attach reconnects only to an existing authenticated supervisor and never launches or restarts the app.",
  };
}

function renderWindowsRuntimeScript(marker, allowedEnvironment, options, argumentsList) {
  const argumentsText = argumentsList.map((value) => `'${psLiteral(value)}'`).join(" ");
  return `${marker}\r\n$ErrorActionPreference = 'Stop'\r\n$allowedEnvironment = @(${allowedEnvironment})\r\n$currentEnvironment = [Environment]::GetEnvironmentVariables('Process')\r\nforeach ($name in @($currentEnvironment.Keys)) {\r\n  if ($allowedEnvironment -notcontains [string]$name) { [Environment]::SetEnvironmentVariable([string]$name, $null, 'Process') }\r\n}\r\n& '${psLiteral(options.nodePath)}' '${psLiteral(options.cliPath)}' ${argumentsText}\r\nexit $LASTEXITCODE\r\n`;
}

function renderTaskRegistrationScript(marker, daemonScriptPath, desktopScriptPath, descriptions) {
  const daemonArguments = windowsCommandLineQuoteList(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", daemonScriptPath]);
  const desktopArguments = windowsCommandLineQuoteList(["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", desktopScriptPath]);
  return `${marker}\r\nparam([switch]$Repair)\r\n$ErrorActionPreference = 'Stop'\r\n$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name\r\n$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited\r\n$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity\r\n$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)\r\n$definitions = @(\r\n  @{ Name = 'Threadspan Daemon'; Description = '${psLiteral(descriptions.daemon)}'; Arguments = '${psLiteral(daemonArguments)}' },\r\n  @{ Name = 'Threadspan Desktop Host'; Description = '${psLiteral(descriptions.desktop)}'; Arguments = '${psLiteral(desktopArguments)}' }\r\n)\r\nforeach ($definition in $definitions) {\r\n  $existing = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue\r\n  if ($existing -and (-not $Repair -or $existing.Description -ne $definition.Description)) { throw \"Scheduled task already exists with incompatible ownership: $($definition.Name)\" }\r\n}\r\nforeach ($definition in $definitions) {\r\n  if (-not (Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue)) {\r\n    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $definition.Arguments\r\n    $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $definition.Description\r\n    Register-ScheduledTask -TaskName $definition.Name -InputObject $task | Out-Null\r\n  }\r\n}\r\nStart-ScheduledTask -TaskName 'Threadspan Daemon'\r\nStart-ScheduledTask -TaskName 'Threadspan Desktop Host'\r\n`;
}

function renderTaskCleanupScript(marker, descriptions) {
  return `${marker}\r\n$ErrorActionPreference = 'Stop'\r\n$expected = @{ 'Threadspan Daemon' = '${psLiteral(descriptions.daemon)}'; 'Threadspan Desktop Host' = '${psLiteral(descriptions.desktop)}' }\r\nforeach ($name in $expected.Keys) {\r\n  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue\r\n  if ($task -and $task.Description -ne $expected[$name]) { throw \"Refusing to remove task with different lifecycle ownership: $name\" }\r\n}\r\nforeach ($name in $expected.Keys) {\r\n  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue\r\n  if ($task) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName $name -Confirm:$false }\r\n}\r\n`;
}

function windowsTaskDescriptionCommand(id, taskName) {
  const command = `$task = Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -ErrorAction SilentlyContinue; if (-not $task) { exit 3 }; [Console]::Out.Write($task.Description)`;
  return lifecycleCommand(id, ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { status: "ownership", absentExitCodes: [3] });
}

function windowsTaskStateCommand(id, taskName) {
  const command = `$state = ''; for ($attempt = 0; $attempt -lt 20; $attempt++) { $task = Get-ScheduledTask -TaskName '${psLiteral(taskName)}' -ErrorAction Stop; $state = $task.State.ToString(); if ($state -eq 'Running') { [Console]::Out.Write($state); exit 0 }; Start-Sleep -Milliseconds 250 }; [Console]::Out.Write($state); exit 4`;
  return lifecycleCommand(id, ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], stableExpectation(["Running"]));
}

function stableExpectation(stdout) { return { stdout, stableSamples: 2, stableIntervalMs: 250 }; }

function daemonHealthCommand(options) {
  const host = options.config?.server?.host ?? "127.0.0.1";
  const port = options.config?.server?.port ?? 8743;
  if (!["127.0.0.1", "::1", "localhost"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Managed lifecycle health verification requires a loopback server host and valid port");
  }
  const url = `http://${host === "::1" ? "[::1]" : host}:${port}/health`;
  const script = `fetch(${JSON.stringify(url)}).then((response)=>{if(!response.ok)process.exit(2);process.stdout.write('ok')}).catch(()=>process.exit(2))`;
  return [options.nodePath, "-e", script];
}

function resolveLegacyStartupPath(options) {
  if (process.platform === "win32") {
    const appData = options.environment?.APPDATA ?? process.env.APPDATA;
    if (typeof appData !== "string" || !appData) throw new TypeError("APPDATA is required for native Windows legacy Startup inspection");
    const canonical = resolve(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Threadspan.cmd");
    const override = typeof options.legacyStartupPath === "string" && options.legacyStartupPath
      ? resolve(options.legacyStartupPath)
      : typeof options.startupDirectory === "string" && options.startupDirectory
        ? resolve(options.startupDirectory, "Threadspan.cmd")
        : canonical;
    if (override.toLowerCase() !== canonical.toLowerCase()) throw new Error("Native Windows legacy Startup path override must equal the canonical APPDATA predecessor path");
    return canonical;
  }
  if (typeof options.legacyStartupPath === "string" && options.legacyStartupPath) return resolve(options.legacyStartupPath);
  if (typeof options.startupDirectory === "string" && options.startupDirectory) return resolve(options.startupDirectory, "Threadspan.cmd");
  throw new TypeError("startupDirectory or legacyStartupPath is required for non-native Windows lifecycle planning");
}

function powershellFileCommand(path) {
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path];
}

function lifecycleCommand(id, argv, expectation = {}) {
  return { id, argv, expectation: { exitCodes: [0], ...expectation } };
}

function lifecycleMarker(options) {
  return `# Threadspan-Service owner-sha256=${options.ownerFingerprint} revision=${options.sourceRevision}`;
}

function inspectPlannedFiles(files) {
  return files.map((file) => {
    const stats = safeLstatSync(file.path);
    if (!stats) return { ...file, expectedPreimageSha256: null, expectedPreimageMode: null };
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Refusing non-regular lifecycle target: ${file.path}`);
    const bytes = readFileSync(file.path);
    return { ...file, expectedPreimageSha256: sha256(bytes), expectedPreimageMode: stats.mode & 0o777 };
  });
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
    for (const key of ["apiKeyEnv", "authTokenEnv", "executableEnv"]) if (provider[key]) names.push(provider[key]);
    if (provider.gateway?.apiKeyEnv) names.push(provider.gateway.apiKeyEnv);
    if (Array.isArray(provider.envAllowlist)) names.push(...provider.envAllowlist);
  }
  const normalized = [...new Set(names.map((name) => String(name)))];
  const invalid = normalized.find((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (invalid) throw new TypeError(`Service environment variable name '${invalid}' is invalid`);
  return normalized;
}

function unsupportedPlan(platform) {
  return {
    supported: false,
    lifecycleKind: "unsupported",
    allowedWriteRoots: [],
    workloads: [],
    files: [],
    commands: { inspect: [], activate: [], verify: [], recover: [], deactivate: [], verifyAbsent: [], finalize: [] },
    environmentVariables: [],
    note: `No managed daemon template is supplied for ${platform}.`,
  };
}

/** Recompute the stable integrity digest of a daemon lifecycle plan. */
export function computeServicePlanDigest(plan) {
  const { digest: _digest, ...payload } = plan;
  return sha256(stableStringify(payload));
}

/** Validate a daemon lifecycle plan before preview or mutation. */
export function validateDaemonServicePlan(plan) {
  if (!plan || plan.apiVersion !== DAEMON_SERVICE_LIFECYCLE_API_VERSION || plan.schemaVersion !== DAEMON_SERVICE_PLAN_SCHEMA_VERSION || plan.kind !== "threadspan-service-lifecycle") throw new TypeError("Invalid daemon lifecycle plan");
  if (!plan.supported) throw new Error(`Daemon lifecycle is unsupported on ${plan.platform}`);
  if (!REVISION_PATTERN.test(plan.source?.revision ?? "") || !SHA256_PATTERN.test(plan.source?.cliSha256 ?? "")) throw new TypeError("Invalid source binding");
  if (!SHA256_PATTERN.test(plan.ownerFingerprint ?? "") || !SHA256_PATTERN.test(plan.digest ?? "")) throw new TypeError("Invalid lifecycle ownership binding");
  if (computeServicePlanDigest(plan) !== plan.digest) throw new Error("Daemon lifecycle plan integrity check failed");
  if (!Array.isArray(plan.files) || !Array.isArray(plan.allowedWriteRoots) || !plan.commands || !Array.isArray(plan.workloads)) throw new TypeError("Invalid daemon lifecycle plan shape");
  if (plan.platform === "win32" && (plan.legacyStartup?.state !== "absent" || typeof plan.legacyStartup.path !== "string")) throw new TypeError("Invalid Windows legacy-startup inspection binding");
  const paths = plan.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw new Error("Daemon lifecycle plan contains duplicate file targets");
  for (const file of plan.files) {
    if (typeof file.path !== "string" || typeof file.content !== "string" || !Number.isInteger(file.mode)) throw new TypeError("Invalid daemon lifecycle file");
    if (!(file.expectedPreimageSha256 === null || SHA256_PATTERN.test(file.expectedPreimageSha256))) throw new TypeError("Invalid daemon lifecycle preimage");
  }
  validateDaemonLifecycleCommands(plan.platform, plan.commands, { files: plan.files });
  return plan;
}

/** Validate the exact executable/status semantics shared by plans and durable manifests. */
export function validateDaemonLifecycleCommands(platform, commands, binding = {}) {
  for (const phase of ["inspect", "activate", "verify", "recover", "deactivate", "verifyAbsent", "finalize"]) {
    if (!Array.isArray(commands[phase])) throw new TypeError(`Invalid daemon lifecycle command phase: ${phase}`);
    for (const command of commands[phase]) {
      if (typeof command.id !== "string" || !Array.isArray(command.argv) || command.argv.length === 0 || command.argv.some((value) => typeof value !== "string")) {
        throw new TypeError("Invalid daemon lifecycle command");
      }
      validateLifecycleCommandExpectation(command, phase);
    }
  }
  validateCanonicalVerification(platform, commands, binding);
  return commands;
}

function validateLifecycleCommandExpectation(command, phase) {
  const expectation = command.expectation;
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) throw new TypeError("Invalid daemon lifecycle command expectation");
  for (const key of ["exitCodes", "absentExitCodes"]) {
    if (expectation[key] !== undefined && (!Array.isArray(expectation[key]) || expectation[key].length === 0
      || expectation[key].some((value) => !Number.isInteger(value) || value < 0 || value > 255))) {
      throw new TypeError(`Invalid daemon lifecycle ${key}`);
    }
  }
  if (expectation.stdout !== undefined && (!Array.isArray(expectation.stdout) || expectation.stdout.length === 0
    || expectation.stdout.some((value) => typeof value !== "string" || value.length > 128))) {
    throw new TypeError("Invalid daemon lifecycle stdout expectation");
  }
  if (expectation.stableSamples !== undefined && (!Number.isInteger(expectation.stableSamples) || expectation.stableSamples < 2 || expectation.stableSamples > 5)) {
    throw new TypeError("Daemon lifecycle stableSamples must be between 2 and 5");
  }
  if (expectation.stableIntervalMs !== undefined && (!Number.isInteger(expectation.stableIntervalMs) || expectation.stableIntervalMs < 0 || expectation.stableIntervalMs > 2_000)) {
    throw new TypeError("Daemon lifecycle stableIntervalMs must be between 0 and 2000");
  }
  if (phase === "verify" && (!Number.isInteger(expectation.stableSamples) || expectation.stableSamples < 2)) throw new TypeError("Every lifecycle verify command requires stable samples");
}

function validateCanonicalVerification(platform, commands, binding) {
  const required = platform === "linux"
    ? new Map([
      ["daemon-enabled", ["enabled"]], ["daemon-active", ["active"]],
      ["desktop-host-enabled", ["enabled"]], ["desktop-host-active", ["active"]], ["daemon-health", ["ok"]],
    ])
    : platform === "win32"
      ? new Map([["daemon-task-state", ["Running"]], ["desktop-host-task-state", ["Running"]], ["daemon-health", ["ok"]]])
      : new Map();
  if (commands.verify.length !== required.size) throw new TypeError("Lifecycle verify command set is not canonical for the platform");
  assertExactPhaseIds(commands, "verify", [...required.keys()]);
  for (const command of commands.verify) {
    const stdout = required.get(command.id);
    if (!stdout || stableStringify(command.expectation.stdout) !== stableStringify(stdout)
      || stableStringify(command.expectation.exitCodes) !== "[0]"
      || command.expectation.stableSamples !== 2 || command.expectation.stableIntervalMs !== 250) {
      throw new TypeError(`Lifecycle verification semantics are not canonical for ${command.id}`);
    }
  }
  if (platform === "linux") {
    assertExactPhaseIds(commands, "inspect", ["inspect-daemon", "inspect-desktop-host"]);
    assertExactPhaseIds(commands, "activate", ["daemon-reload", "enable-start"]);
    assertExactPhaseIds(commands, "recover", ["re-enable-start"]);
    assertExactPhaseIds(commands, "deactivate", ["disable-stop", "rollback-daemon-reload"]);
    assertExactPhaseIds(commands, "verifyAbsent", ["daemon-inactive", "desktop-host-inactive"]);
    assertExactPhaseIds(commands, "finalize", ["final-daemon-reload"]);
    assertExactArgv(commandById(commands.inspect, "inspect-daemon"), ["systemctl", "--user", "cat", "threadspan.service"]);
    assertExactArgv(commandById(commands.inspect, "inspect-desktop-host"), ["systemctl", "--user", "cat", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.activate, "daemon-reload"), ["systemctl", "--user", "daemon-reload"]);
    assertExactArgv(commandById(commands.activate, "enable-start"), ["systemctl", "--user", "enable", "--now", "threadspan.service", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.recover, "re-enable-start"), ["systemctl", "--user", "enable", "--now", "threadspan.service", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.deactivate, "disable-stop"), ["systemctl", "--user", "disable", "--now", "threadspan-desktop-host.service", "threadspan.service"]);
    assertExactArgv(commandById(commands.deactivate, "rollback-daemon-reload"), ["systemctl", "--user", "daemon-reload"]);
    assertExactArgv(commandById(commands.verify, "daemon-enabled"), ["systemctl", "--user", "is-enabled", "threadspan.service"]);
    assertExactArgv(commandById(commands.verify, "daemon-active"), ["systemctl", "--user", "is-active", "threadspan.service"]);
    assertExactArgv(commandById(commands.verify, "desktop-host-enabled"), ["systemctl", "--user", "is-enabled", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.verify, "desktop-host-active"), ["systemctl", "--user", "is-active", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.verifyAbsent, "daemon-inactive"), ["systemctl", "--user", "is-active", "threadspan.service"]);
    assertExactArgv(commandById(commands.verifyAbsent, "desktop-host-inactive"), ["systemctl", "--user", "is-active", "threadspan-desktop-host.service"]);
    assertExactArgv(commandById(commands.finalize, "final-daemon-reload"), ["systemctl", "--user", "daemon-reload"]);
    assertExactExpectation(commandById(commands.inspect, "inspect-daemon"), { exitCodes: [0], status: "ownership", absentExitCodes: [1] });
    assertExactExpectation(commandById(commands.inspect, "inspect-desktop-host"), { exitCodes: [0], status: "ownership", absentExitCodes: [1] });
    assertExactExpectation(commandById(commands.activate, "daemon-reload"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.activate, "enable-start"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.recover, "re-enable-start"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.deactivate, "disable-stop"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.deactivate, "rollback-daemon-reload"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.verify, "daemon-enabled"), { exitCodes: [0], ...stableExpectation(["enabled"]) });
    assertExactExpectation(commandById(commands.verify, "daemon-active"), { exitCodes: [0], ...stableExpectation(["active"]) });
    assertExactExpectation(commandById(commands.verify, "desktop-host-enabled"), { exitCodes: [0], ...stableExpectation(["enabled"]) });
    assertExactExpectation(commandById(commands.verify, "desktop-host-active"), { exitCodes: [0], ...stableExpectation(["active"]) });
    assertExactExpectation(commandById(commands.verify, "daemon-health"), { exitCodes: [0], ...stableExpectation(["ok"]) });
    assertExactExpectation(commandById(commands.verifyAbsent, "daemon-inactive"), { exitCodes: [3, 4], stdout: ["inactive", "unknown"] });
    assertExactExpectation(commandById(commands.verifyAbsent, "desktop-host-inactive"), { exitCodes: [3, 4], stdout: ["inactive", "unknown"] });
    assertExactExpectation(commandById(commands.finalize, "final-daemon-reload"), { exitCodes: [0] });
    for (const command of commands.verifyAbsent) {
      if (stableStringify(command.expectation.exitCodes) !== "[3,4]") throw new TypeError("Linux absence verification must accept exact systemctl exit codes 3 and 4");
    }
    assertHealthCommand(commandById(commands.verify, "daemon-health"));
  } else if (platform === "win32") {
    assertExactPhaseIds(commands, "inspect", ["inspect-daemon", "inspect-desktop-host"]);
    assertExactPhaseIds(commands, "activate", ["register-start-tasks"]);
    assertExactPhaseIds(commands, "recover", ["repair-start-tasks"]);
    assertExactPhaseIds(commands, "deactivate", ["stop-remove-tasks"]);
    assertExactPhaseIds(commands, "verifyAbsent", ["absent-daemon", "absent-desktop-host"]);
    assertExactPhaseIds(commands, "finalize", []);
    assertExactArgv(commandById(commands.inspect, "inspect-daemon"), windowsTaskDescriptionCommand("inspect-daemon", "Threadspan Daemon").argv);
    assertExactArgv(commandById(commands.inspect, "inspect-desktop-host"), windowsTaskDescriptionCommand("inspect-desktop-host", "Threadspan Desktop Host").argv);
    assertExactArgv(commandById(commands.verify, "daemon-task-state"), windowsTaskStateCommand("daemon-task-state", "Threadspan Daemon").argv);
    assertExactArgv(commandById(commands.verify, "desktop-host-task-state"), windowsTaskStateCommand("desktop-host-task-state", "Threadspan Desktop Host").argv);
    assertExactArgv(commandById(commands.verifyAbsent, "absent-daemon"), windowsTaskDescriptionCommand("absent-daemon", "Threadspan Daemon").argv);
    assertExactArgv(commandById(commands.verifyAbsent, "absent-desktop-host"), windowsTaskDescriptionCommand("absent-desktop-host", "Threadspan Desktop Host").argv);
    assertExactArgv(commandById(commands.activate, "register-start-tasks"), powershellFileCommand(boundLifecycleFile(binding.files, "task-registration")));
    assertExactArgv(commandById(commands.recover, "repair-start-tasks"), [...powershellFileCommand(boundLifecycleFile(binding.files, "task-registration")), "-Repair"]);
    assertExactArgv(commandById(commands.deactivate, "stop-remove-tasks"), powershellFileCommand(boundLifecycleFile(binding.files, "task-cleanup")));
    assertHealthCommand(commandById(commands.verify, "daemon-health"));
    assertExactExpectation(commandById(commands.inspect, "inspect-daemon"), windowsTaskDescriptionCommand("inspect-daemon", "Threadspan Daemon").expectation);
    assertExactExpectation(commandById(commands.inspect, "inspect-desktop-host"), windowsTaskDescriptionCommand("inspect-desktop-host", "Threadspan Desktop Host").expectation);
    assertExactExpectation(commandById(commands.activate, "register-start-tasks"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.recover, "repair-start-tasks"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.verify, "daemon-task-state"), windowsTaskStateCommand("daemon-task-state", "Threadspan Daemon").expectation);
    assertExactExpectation(commandById(commands.verify, "desktop-host-task-state"), windowsTaskStateCommand("desktop-host-task-state", "Threadspan Desktop Host").expectation);
    assertExactExpectation(commandById(commands.verify, "daemon-health"), { exitCodes: [0], ...stableExpectation(["ok"]) });
    assertExactExpectation(commandById(commands.deactivate, "stop-remove-tasks"), { exitCodes: [0] });
    assertExactExpectation(commandById(commands.verifyAbsent, "absent-daemon"), { absent: true });
    assertExactExpectation(commandById(commands.verifyAbsent, "absent-desktop-host"), { absent: true });
  }
}

function assertExactPhaseIds(commands, phase, expected) {
  const observed = commands[phase].map((command) => command.id);
  if (new Set(observed).size !== observed.length || stableStringify([...observed].sort()) !== stableStringify([...expected].sort())) {
    throw new TypeError(`Lifecycle ${phase} command IDs are not the exact canonical set`);
  }
}

function commandById(commands, id) { return commands.find((command) => command.id === id); }

function assertExactArgv(command, expected) {
  if (!command || stableStringify(command.argv) !== stableStringify(expected)) throw new TypeError(`Lifecycle command argv is not canonical for ${command?.id ?? "missing-command"}`);
}

function assertExactExpectation(command, expected) {
  if (!command || stableStringify(command.expectation) !== stableStringify(expected)) {
    throw new TypeError(`Lifecycle command expectation is not canonical for ${command?.id ?? "missing-command"}`);
  }
}

function assertHealthCommand(command) {
  if (!command || command.argv.length !== 3 || !isAbsolute(command.argv[0]) || command.argv[1] !== "-e"
    || !/^fetch\("http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}\/health"\)\.then\(\(response\)=>\{if\(!response\.ok\)process\.exit\(2\);process\.stdout\.write\('ok'\)\}\)\.catch\(\(\)=>process\.exit\(2\)\)$/.test(command.argv[2])) {
    throw new TypeError("Lifecycle health command is not canonical loopback verification");
  }
}

function boundLifecycleFile(files, role) {
  const file = files?.find((candidate) => candidate.role === role);
  const path = file?.path ?? file?.target;
  if (typeof path !== "string") throw new TypeError(`Missing lifecycle file binding for ${role}`);
  return path;
}

function normalizeSourceRevision(value) {
  const revision = String(value ?? "").toLowerCase();
  if (!REVISION_PATTERN.test(revision)) throw new TypeError("sourceRevision must be an exact 7-64 character hexadecimal revision");
  return revision;
}

function lifecycleOwnerFingerprint(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 256 || value.includes("\0")) {
    throw new TypeError("lifecycleOwner must be an opaque identifier between 8 and 256 characters");
  }
  return sha256(`threadspan-lifecycle-owner\0${value}`);
}

function resolveCliSha256(path, supplied) {
  if (supplied !== undefined) {
    const normalized = String(supplied).toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) throw new TypeError("cliSha256 must be a SHA-256 digest");
    return normalized;
  }
  return sha256(readFileSync(path));
}

function normalizePlanId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) throw new TypeError("planId contains unsupported characters");
  return value;
}

function safeLstatSync(path) {
  try { return lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

function systemdQuote(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new TypeError("systemd command arguments cannot contain line breaks or NUL");
  return `"${text.replace(/%/g, "%%").replace(/\$/g, () => "$$").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function psLiteral(value) { return String(value).replace(/'/g, "''"); }

function windowsCommandLineQuoteList(values) { return values.map(windowsCommandLineQuote).join(" "); }

function windowsCommandLineQuote(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
