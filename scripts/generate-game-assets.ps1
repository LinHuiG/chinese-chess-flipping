$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$res = Join-Path $root 'client/app/src/main/res'
$raw = Join-Path $res 'raw'
New-Item -ItemType Directory -Path $raw -Force | Out-Null

# Original short, softly enveloped PCM cues. Generated offline, never on the phone.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
public static class ChessSoundAssets {
    public static void Write(string path, double[] frequencies, double[] starts, double duration, double decay) {
        const int rate = 22050;
        int samples = (int)(duration * rate);
        using (var writer = new BinaryWriter(File.Create(path))) {
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + samples * 2);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(rate); writer.Write(rate * 2);
            writer.Write((short)2); writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(samples * 2);
            for (int i = 0; i < samples; i++) {
                double time = (double)i / rate, signal = 0;
                for (int n = 0; n < frequencies.Length; n++) {
                    double t = time - starts[n];
                    if (t < 0) continue;
                    double envelope = Math.Min(1, t / .006) * Math.Exp(-t / decay);
                    double phase = 2 * Math.PI * frequencies[n] * t;
                    signal += envelope * (Math.Sin(phase) + .12 * Math.Sin(phase * 2.01));
                }
                signal *= .24 * Math.Min(1, (duration - time) / .035);
                writer.Write((short)(Math.Max(-1, Math.Min(1, signal)) * 32767));
            }
        }
    }
}
'@
[ChessSoundAssets]::Write((Join-Path $raw 'capture.wav'), @(740,1110), @(0,.025), .18, .038)
[ChessSoundAssets]::Write((Join-Path $raw 'victory.wav'), @(523.25,659.25,783.99), @(0,.12,.24), .65, .13)
[ChessSoundAssets]::Write((Join-Path $raw 'defeat.wav'), @(440,349.23), @(0,.14), .50, .12)

Add-Type -AssemblyName System.Drawing
function Glyph-Path([string]$text, [float]$x, [float]$y, [float]$size) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $font = [System.Drawing.FontFamily]::new('Microsoft YaHei')
    $format = [System.Drawing.StringFormat]::GenericTypographic
    $matrix = [System.Drawing.Drawing2D.Matrix]::new()
    try {
        $path.AddString($text, $font, 1, $size, [System.Drawing.PointF]::new(0,0), $format)
        $bounds = $path.GetBounds()
        $matrix.Translate($x - $bounds.X - $bounds.Width / 2, $y - $bounds.Y - $bounds.Height / 2)
        $path.Transform($matrix)
        $points = $path.PathPoints; $types = $path.PathTypes
        $result = [System.Text.StringBuilder]::new()
        for ($i = 0; $i -lt $points.Length; $i++) {
            $type = $types[$i] -band 7
            $number = { param($n) $n.ToString('0.###', [Globalization.CultureInfo]::InvariantCulture) }
            if ($type -eq 3) {
                [void]$result.Append('C')
                for ($j = 0; $j -lt 3; $j++) {
                    [void]$result.Append((& $number $points[$i+$j].X) + ',' + (& $number $points[$i+$j].Y) + ' ')
                }
                $i += 2
            } else {
                $command = if ($type -eq 0) { 'M' } else { 'L' }
                [void]$result.Append($command + (& $number $points[$i].X) + ',' + (& $number $points[$i].Y))
            }
            if (($types[$i] -band 128) -ne 0) { [void]$result.Append('Z') }
        }
        return $result.ToString()
    } finally { $matrix.Dispose(); $path.Dispose(); $font.Dispose(); $format.Dispose() }
}
$blackGlyph = Glyph-Path '将' 63 43 27
$redGlyph = Glyph-Path '帅' 45 64 28
$foreground = @"
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="#14000000" android:pathData="M85,46a22,22 0,1 1,-44 0a22,22 0,1 1,44 0M69,67a24,24 0,1 1,-48 0a24,24 0,1 1,48 0" />
    <path android:fillColor="#292A30" android:pathData="M85,43a22,22 0,1 1,-44 0a22,22 0,1 1,44 0" />
    <path android:fillColor="#00000000" android:strokeColor="#777A83" android:strokeWidth="1" android:pathData="M82,43a19,19 0,1 1,-38 0a19,19 0,1 1,38 0" />
    <path android:fillColor="#FFFFFF" android:pathData="$blackGlyph" />
    <path android:fillColor="#FFFFFF" android:pathData="M69,64a24,24 0,1 1,-48 0a24,24 0,1 1,48 0" />
    <path android:fillColor="#00000000" android:strokeColor="#E3474C" android:strokeWidth="1.3" android:pathData="M65.5,64a20.5,20.5 0,1 1,-41 0a20.5,20.5 0,1 1,41 0" />
    <path android:fillColor="#D93640" android:pathData="$redGlyph" />
</vector>
"@
[IO.File]::WriteAllText((Join-Path $res 'drawable/ic_launcher_foreground.xml'), $foreground, [Text.UTF8Encoding]::new($false))
Get-ChildItem -LiteralPath $raw | Select-Object Name,Length
