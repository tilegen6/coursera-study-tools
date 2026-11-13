param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    $sharedNode = Join-Path $env:USERPROFILE '.codex/skill-runtime/tools/node/node-v24.22.0-win-x64/node.exe'
    if (Test-Path -LiteralPath $sharedNode) { $nodeExecutable = $sharedNode }
    else { throw 'Node.js 20+ is required. Install Node.js, then run this script again.' }
} else { $nodeExecutable = $nodeCommand.Source }
if ($Stop) { & $nodeExecutable (Join-Path $PSScriptRoot 'bridge/start.cjs') stop }
else {
    $codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
    if (-not $codexCommand) { throw 'Codex CLI was not found. Open the Codex app, or install the CLI and run codex login.' }
    $env:CODEX_BINARY = $codexCommand.Source
    & $nodeExecutable (Join-Path $PSScriptRoot 'bridge/start.cjs')
}
exit $LASTEXITCODE
