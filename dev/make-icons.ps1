# Generates the app icon with System.Drawing (works in Windows PowerShell 5.1):
#   extension\icons\icon-16/32/48/128.png   used by the extension and the pages
#   installer\icon-256.png                  large size for the installer's .ico
#   dev\out\icon-preview.png                every size on a light and a dark background
#
# The icon is a comic speech bubble holding the letter ع: white fill and an ink
# outline, so it reads on light and dark toolbars alike, with a hard red shadow
# like printed comics.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$outDir      = Join-Path $projectRoot 'extension\icons'
$previewDir  = Join-Path $PSScriptRoot 'out'
foreach ($d in @($outDir, $previewDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d | Out-Null }
}

$ink    = [System.Drawing.ColorTranslator]::FromHtml('#141414')
$paper  = [System.Drawing.Color]::White
$red    = [System.Drawing.ColorTranslator]::FromHtml('#E23A2B')
$letter = [string][char]0x0639   # Arabic letter ع
$fontName  = 'Segoe UI'
$fontStyle = [System.Drawing.FontStyle]::Bold
$refEm  = 200.0
$typo   = [System.Drawing.StringFormat]::GenericTypographic

# Ink bounding box of the letter at the reference size, so it can be centred by
# what is actually drawn rather than by the font's line box.
function Get-InkBox {
    $refSize = 400; $origin = 100
    $bmp = New-Object System.Drawing.Bitmap $refSize, $refSize
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Black)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $font = New-Object System.Drawing.Font($fontName, [single]$refEm, $fontStyle, [System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString($letter, $font, [System.Drawing.Brushes]::White, [single]$origin, [single]$origin, $typo)
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
    return @{ Left = [double]($minX - $origin); Top = [double]($minY - $origin); Width = [double]($maxX - $minX + 1); Height = [double]($maxY - $minY + 1) }
}
$inkBox = Get-InkBox

# The bubble outline (body + tail) in a 128-unit design space.
function New-BubblePath {
    param([double]$k, [double]$dx, [double]$dy, [hashtable]$shape)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath ([System.Drawing.Drawing2D.FillMode]::Winding)
    $path.AddEllipse([single](($shape.cx - $shape.rx + $dx) * $k), [single](($shape.cy - $shape.ry + $dy) * $k), [single](2 * $shape.rx * $k), [single](2 * $shape.ry * $k))
    $pts = New-Object 'System.Drawing.PointF[]' 3
    for ($i = 0; $i -lt 3; $i++) {
        $pts[$i] = New-Object System.Drawing.PointF([single](($shape.tail[$i][0] + $dx) * $k), [single](($shape.tail[$i][1] + $dy) * $k))
    }
    $path.AddPolygon($pts)
    return $path
}

# One bubble: a thick stroke, then the fill on top, which leaves a clean outer outline.
function Add-Bubble {
    param($g, [double]$k, [double]$dx, [double]$dy, [hashtable]$shape, $fill, $edge, [double]$outline)
    $path = New-BubblePath -k $k -dx $dx -dy $dy -shape $shape
    $pen = New-Object System.Drawing.Pen $edge, ([single](2 * $outline))
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Miter
    $pen.MiterLimit = 6
    $brush = New-Object System.Drawing.SolidBrush $fill
    $g.DrawPath($pen, $path)
    # Fill the body and the tail one by one: filled together, the part where they
    # overlap can be left empty depending on the direction each outline was drawn.
    $g.FillEllipse($brush, [single](($shape.cx - $shape.rx + $dx) * $k), [single](($shape.cy - $shape.ry + $dy) * $k), [single](2 * $shape.rx * $k), [single](2 * $shape.ry * $k))
    $tail = New-Object 'System.Drawing.PointF[]' 3
    for ($i = 0; $i -lt 3; $i++) {
        $tail[$i] = New-Object System.Drawing.PointF([single](($shape.tail[$i][0] + $dx) * $k), [single](($shape.tail[$i][1] + $dy) * $k))
    }
    $g.FillPolygon($brush, $tail)
    $brush.Dispose(); $pen.Dispose(); $path.Dispose()
}

function New-Icon {
    param([int]$size, [switch]$Tiny)
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $k = $size / 128.0

    if (-not $Tiny) {
        # Bubble with a hard shadow down and to the left.
        $shape   = @{ cx = 70.0; cy = 50.0; rx = 49.0; ry = 39.0; tail = @(@(46.0, 78.0), @(31.0, 111.0), @(80.0, 84.0)) }
        $outline = [Math]::Max(1.4, 5.0 * $k)
        $shadow  = 8.0
        Add-Bubble -g $g -k $k -dx (-$shadow) -dy $shadow -shape $shape -fill $red -edge $red -outline $outline
        $letterRatio = 0.37
    } else {
        # Tiny sizes: no shadow, the bubble fills the square so the letter stays readable.
        $shape   = @{ cx = 64.0; cy = 52.0; rx = 56.0; ry = 46.0; tail = @(@(30.0, 80.0), @(18.0, 124.0), @(70.0, 94.0)) }
        $outline = 12.0 * $k
        $letterRatio = 0.52
    }
    Add-Bubble -g $g -k $k -dx 0 -dy 0 -shape $shape -fill $paper -edge $ink -outline $outline

    # The letter, centred on the bubble body by its ink box.
    $scale  = ($size * $letterRatio) / $inkBox.Height
    $font   = New-Object System.Drawing.Font($fontName, [single]($refEm * $scale), $fontStyle, [System.Drawing.GraphicsUnit]::Pixel)
    $drawX  = $shape.cx * $k - ($inkBox.Width * $scale) / 2.0 - $inkBox.Left * $scale
    $drawY  = ($shape.cy - 1.0) * $k - ($inkBox.Height * $scale) / 2.0 - $inkBox.Top * $scale
    $brush  = New-Object System.Drawing.SolidBrush $ink
    $g.DrawString($letter, $font, $brush, [single]$drawX, [single]$drawY, $typo)
    $brush.Dispose(); $font.Dispose(); $g.Dispose()
    return $bmp
}

$made = @{}
foreach ($size in @(16, 32, 48, 128, 256)) {
    if ($size -eq 16) {
        # Drawn four times larger and scaled down: small text keeps its weight this
        # way, where drawing it directly at 8 px comes out thin and grey.
        $big = New-Icon -size 64 -Tiny
        $bmp = New-Object System.Drawing.Bitmap 16, 16, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $dg  = [System.Drawing.Graphics]::FromImage($bmp)
        $dg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $dg.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $dg.DrawImage($big, 0, 0, 16, 16)
        $dg.Dispose(); $big.Dispose()
    } else {
        $bmp = New-Icon -size $size
    }
    $path = if ($size -eq 256) { Join-Path $projectRoot 'installer\icon-256.png' } else { Join-Path $outDir ("icon-{0}.png" -f $size) }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $made[$size] = $bmp
    Write-Output ("Wrote {0}" -f $path)
}

# Preview sheet: every size on a light and on a dark strip.
$sheet = New-Object System.Drawing.Bitmap 560, 330
$sg = [System.Drawing.Graphics]::FromImage($sheet)
$sg.Clear([System.Drawing.ColorTranslator]::FromHtml('#F1F3F4'))
$darkBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#202124'))
$sg.FillRectangle($darkBrush, 0, 165, 560, 165)
$darkBrush.Dispose()
foreach ($row in @(0, 165)) {
    $x = 20
    foreach ($size in @(128, 48, 32, 16)) {
        $sg.DrawImageUnscaled($made[$size], $x, $row + [int]((165 - $size) / 2))
        $x += $size + 30
    }
    # the 16 px icon enlarged four times, to judge its pixels
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $sg.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $sg.DrawImage($made[16], $x + 20, $row + 50, 64, 64)
    $sg.DrawImage($made[32], $x + 110, $row + 50, 64, 64)
}
$sg.Dispose()
$sheet.Save((Join-Path $previewDir 'icon-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$sheet.Dispose()
foreach ($b in $made.Values) { $b.Dispose() }
Write-Output 'Wrote dev\out\icon-preview.png'
