param(
    [Parameter(Mandatory=$true)][string]$Serial,
    [ValidateSet('Inspect','Tap','Input','Capture')][string]$Action = 'Inspect',
    [string]$Text,
    [string]$Value,
    [string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if ($Action -eq 'Capture') {
    if (-not $OutputPath) { throw 'OutputPath is required' }
    & $adb -s $Serial shell screencap -p /sdcard/chess-check.png
    & $adb -s $Serial pull /sdcard/chess-check.png $OutputPath
    exit $LASTEXITCODE
}
& $adb -s $Serial shell uiautomator dump /sdcard/chess-check.xml | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect device' }
[xml]$ui = (& $adb -s $Serial shell cat /sdcard/chess-check.xml)
$nodes = $ui.SelectNodes('//node')
if ($Action -eq 'Inspect') {
    $nodes | Where-Object { $_.text -or $_.'content-desc' } |
        Select-Object text,content-desc,bounds,enabled,checked | ConvertTo-Json -Compress
    exit 0
}
$node = $nodes | Where-Object { $_.text -eq $Text -or $_.'content-desc' -eq $Text } | Select-Object -First 1
if (-not $node) { throw "Visible target not found: $Text" }
$box = [regex]::Matches($node.bounds, '\d+') | ForEach-Object { [int]$_.Value }
& $adb -s $Serial shell input tap ([int](($box[0]+$box[2])/2)) ([int](($box[1]+$box[3])/2))
if ($Action -eq 'Input') {
    & $adb -s $Serial shell input keycombination 113 29
    & $adb -s $Serial shell input text $Value
    & $adb -s $Serial shell input keyevent 4
}
if ($LASTEXITCODE -ne 0) { throw 'Device input failed' }
