param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$BitmapPath,
    [int]$MaxDimension = 2400
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile($ImagePath)
try {
    $ratio = [Math]::Min(1, $MaxDimension / [Math]::Max($source.Width, $source.Height))
    $width = [Math]::Max(1, [int]($source.Width * $ratio))
    $height = [Math]::Max(1, [int]($source.Height * $ratio))
    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::White)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.DrawImage($source, 0, 0, $width, $height)
        } finally {
            $graphics.Dispose()
        }
        $bitmap.Save($BitmapPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $bitmap.Dispose()
    }
} finally {
    $source.Dispose()
}
