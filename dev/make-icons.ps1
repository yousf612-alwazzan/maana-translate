# Generates the extension icons (16, 32, 48, 128 px) with System.Drawing.
# Works in Windows PowerShell 5.1. Output: <project>\extension\icons\icon-<size>.png

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$outDir      = Join-Path $projectRoot 'extension\icons'
if (-not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Path $outDir | Out-Null
}

$bgColor   = [System.Drawing.ColorTranslator]::FromHtml('#0E0E0F')
$goldColor = [System.Drawing.ColorTranslator]::FromHtml('#C8A55A')
$letter    = [string][char]0x0639   # Arabic letter ع
$fontName  = 'Segoe UI'
$fontStyle = [System.Drawing.FontStyle]::Bold
$targetInkRatio = 0.62              # letter ink height as a share of icon height
$refEm     = 200.0                  # reference font size used for measuring

$typo = [System.Drawing.StringFormat]::GenericTypographic

# Measure the ink bounding box of the letter at a reference size.
# Returns @{ Left; Top; Width; Height } relative to the drawing origin.
function Get-InkBox {
    $refSize = 400
    $origin  = 100
    $bmp = New-Object System.Drawing.Bitmap $refSize, $refSize
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Black)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $font = New-Object System.Drawing.Font($fontName, [single]$refEm, $fontStyle, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.Brushes]::White
    $g.DrawString($letter, $font, $brush, [single]$origin, [single]$origin, $typo)

    $minX = $refSize; $minY = $refSize; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt $refSize; $y++) {
        for ($x = 0; $x -lt $refSize; $x++) {
            if ($bmp.GetPixel($x, $y).R -gt 127) {
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    $font.Dispose(); $g.Dispose(); $bmp.Dispose()
    if ($maxX -lt 0) { throw "Glyph not rendered; font '$fontName' may lack Arabic support." }
    return @{
        Left   = [double]($minX - $origin)
        Top    = [double]($minY - $origin)
        Width  = [double]($maxX - $minX + 1)
        Height = [double]($maxY - $minY + 1)
    }
}

$ink = Get-InkBox

function New-Icon {
    param([int]$size, [bool]$withFrame)

    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($bgColor)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # Scale the letter so its ink height is 62% of the icon, centred on the ink box.
    $scale    = ($size * $targetInkRatio) / $ink.Height
    $emSize   = [single]($refEm * $scale)
    $font     = New-Object System.Drawing.Font($fontName, $emSize, $fontStyle, [System.Drawing.GraphicsUnit]::Pixel)
    $inkLeft  = $ink.Left * $scale
    $inkTop   = $ink.Top  * $scale
    $inkW     = $ink.Width  * $scale
    $inkH     = $ink.Height * $scale
    $drawX    = ($size - $inkW) / 2.0 - $inkLeft
    $drawY    = ($size - $inkH) / 2.0 - $inkTop
    $brush    = New-Object System.Drawing.SolidBrush $goldColor
    $g.DrawString($letter, $font, $brush, [single]$drawX, [single]$drawY, $typo)
    $brush.Dispose(); $font.Dispose()

    if ($withFrame) {
        $inset = [double]$size * 0.09
        $penW  = if ($size -ge 128) { 1.5 } else { 1.0 }
        $chamfer = [double]$size * 0.12
        $half  = $penW / 2.0
        $l = $inset + $half
        $t = $inset + $half
        $r = $size - $inset - $half
        $b = $size - $inset - $half
        # Outline with the top-left corner cut diagonally.
        $pts = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF([single]($l + $chamfer), [single]$t)),
            (New-Object System.Drawing.PointF([single]$r, [single]$t)),
            (New-Object System.Drawing.PointF([single]$r, [single]$b)),
            (New-Object System.Drawing.PointF([single]$l, [single]$b)),
            (New-Object System.Drawing.PointF([single]$l, [single]($t + $chamfer)))
        )
        $pen = New-Object System.Drawing.Pen $goldColor, ([single]$penW)
        $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
        $g.DrawPolygon($pen, $pts)
        $pen.Dispose()
    }

    $g.Dispose()
    return $bmp
}

foreach ($size in @(16, 32, 48, 128)) {
    $withFrame = ($size -ge 48)
    if ($size -eq 128) {
        # Chrome Web Store icon rule: 96x96 artwork centred on a 128x128 canvas,
        # leaving 16 px of transparent padding on every side.
        $art = New-Icon -size 96 -withFrame $true
        $bmp = New-Object System.Drawing.Bitmap 128, 128, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $pg  = [System.Drawing.Graphics]::FromImage($bmp)
        $pg.Clear([System.Drawing.Color]::Transparent)
        $pg.DrawImageUnscaled($art, 16, 16)
        $pg.Dispose()
        $art.Dispose()
    } else {
        $bmp = New-Icon -size $size -withFrame $withFrame
    }
    $path = Join-Path $outDir ("icon-{0}.png" -f $size)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ("Wrote {0} (frame: {1})" -f $path, $withFrame)
}
