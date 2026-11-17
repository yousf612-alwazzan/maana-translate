# Builds dist/Maana-Setup-<version>.exe: a small guided installer with the
# extension ZIP embedded. Uses the C# compiler that ships with Windows
# (.NET Framework 4), so nothing has to be installed to build it.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$src         = Join-Path $projectRoot 'installer'
$dist        = Join-Path $projectRoot 'dist'
$obj         = Join-Path $src 'obj'
$fw          = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc         = Join-Path $fw 'csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw "csc.exe not found at '$csc'." }

# 1. Fresh extension ZIP (this is what the installer unpacks).
& (Join-Path $PSScriptRoot 'make-zip.ps1') | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'extension\manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version  = [string]$manifest.version
$zip      = Join-Path $dist ("maana-translate-{0}.zip" -f $version)
if (-not (Test-Path -LiteralPath $zip)) { throw "ZIP not found: $zip" }

# 2. Icon file from the extension's PNG icons (PNG-compressed entries).
New-Item -ItemType Directory -Force -Path $obj | Out-Null
$ico   = Join-Path $obj 'icon.ico'
$sizes = 16, 32, 48, 128
$pngs  = foreach ($s in $sizes) { , [System.IO.File]::ReadAllBytes((Join-Path $projectRoot "extension\icons\icon-$s.png")) }
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $bw.Write([byte]$sizes[$i]); $bw.Write([byte]$sizes[$i]); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($ico, $ms.ToArray())
$bw.Dispose()

# 3. Compile.
$out  = Join-Path $dist ("Maana-Setup-{0}.exe" -f $version)
$args = @(
    '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/codepage:65001',
    "/out:$out",
    "/win32icon:$ico",
    "/win32manifest:$(Join-Path $src 'app.manifest')",
    "/lib:$(Join-Path $fw 'WPF')",
    '/r:PresentationFramework.dll', '/r:PresentationCore.dll', '/r:WindowsBase.dll', '/r:System.Xaml.dll',
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    "/resource:$zip,payload.zip",
    "/resource:$(Join-Path $src 'ui.xaml'),ui.xaml",
    "/resource:$(Join-Path $projectRoot 'extension\icons\icon-128.png'),icon.png",
    (Join-Path $src 'Installer.cs')
)
& $csc @args
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE." }

Write-Output ("Created {0} ({1:N0} KB)" -f $out, ((Get-Item -LiteralPath $out).Length / 1KB))
