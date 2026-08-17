[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $HOME '.cursor-codex-bridge\config.jsonc'),
    [switch]$RunDoctor
)

$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$CliPath = Join-Path $PackageRoot 'src\cli.mjs'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Bridge configuration does not exist: $ConfigPath. Run install-codex.ps1 or 'node src\cli.mjs config init'."
}

if ($RunDoctor) {
    & node $CliPath doctor --config $ConfigPath
    if ($LASTEXITCODE -ne 0) {
        throw "Bridge doctor failed with exit code $LASTEXITCODE."
    }
}

& node $CliPath serve --config $ConfigPath
exit $LASTEXITCODE
