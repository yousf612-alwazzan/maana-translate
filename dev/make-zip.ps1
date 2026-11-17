# Builds dist/maana-translate-<version>.zip from the contents of extension/.
# Uses bsdtar (tar.exe) so zip entries use forward-slash paths.
# Requires extension/manifest.json to exist.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot  = Split-Path -Parent $PSScriptRoot
$extDir       = Join-Path $projectRoot 'extension'
$manifestPath = Join-Path $extDir 'manifest.json'
$distDir      = Join-Path $projectRoot 'dist'
$tarExe       = 'C:\Windows\System32\tar.exe'

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "manifest.json not found at '$manifestPath'. Create the extension manifest before building the ZIP."
}

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "manifest.json is not valid JSON: $($_.Exception.Message)"
}

$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw "manifest.json has no 'version' field."
}

if (-not (Test-Path -LiteralPath $tarExe)) {
    throw "tar.exe not found at '$tarExe'."
}

if (-not (Test-Path -LiteralPath $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$zipPath = Join-Path $distDir ("maana-translate-{0}.zip" -f $version)
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

# Pass the top-level entries of extension/ so archive paths are relative to its root.
$entries = @(Get-ChildItem -LiteralPath $extDir -Force | ForEach-Object { $_.Name })
if ($entries.Count -eq 0) {
    throw "extension/ is empty; nothing to package."
}

# The install guide rides along at the top of the ZIP.
& $tarExe -a -c -f $zipPath -C $extDir @entries -C $projectRoot 'README.md'
if ($LASTEXITCODE -ne 0) {
    throw "tar.exe failed with exit code $LASTEXITCODE."
}

Write-Output ("Created {0}" -f $zipPath)
