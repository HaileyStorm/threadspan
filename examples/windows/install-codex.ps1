[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $HOME '.cursor-codex-bridge\config.jsonc'),
    [string]$CodexConfigPath = (Join-Path $HOME '.codex\config.toml'),
    [switch]$ForceConfig
)

$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$CliPath = Join-Path $PackageRoot 'src\cli.mjs'

if (-not (Test-Path -LiteralPath $ConfigPath) -or $ForceConfig) {
    $initArguments = @($CliPath, 'config', 'init', '--config', $ConfigPath)
    if ($ForceConfig) { $initArguments += '--force' }
    & node @initArguments
    if ($LASTEXITCODE -ne 0) { throw "Bridge config initialization failed with exit code $LASTEXITCODE." }
}

& node $CliPath codex install --config $ConfigPath --codex-config $CodexConfigPath
if ($LASTEXITCODE -ne 0) { throw "Codex configuration install failed with exit code $LASTEXITCODE." }

& node $CliPath skill install --skill all
if ($LASTEXITCODE -ne 0) { throw "Bridge skill install failed with exit code $LASTEXITCODE." }

Write-Host "Installed bridge configuration, Codex managed block, and Consult/managed-worker skills."
Write-Host "Review provider settings in: $ConfigPath"
