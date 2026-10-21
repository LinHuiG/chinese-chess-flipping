param([switch]$Windows)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$server = Join-Path $root 'cyber-room-server.exe'
if (!(Test-Path -LiteralPath $server)) { throw '请从完整本地交付目录运行 Start-Local.ps1。' }
$listener = Get-NetTCPConnection -LocalPort 19880 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-Process -Id $listener[0].OwningProcess
    if ($owner.Path -ne $server) { throw '19880 端口已被其他程序占用，请先处理端口冲突。' }
} else {
    $env:CHESS_RESOURCE_DIR = $root
    $env:HTTP_PORT = '19880'; $env:TCP_PORT = '19888'; $env:UDP_PORT = '19888'
    Start-Process -FilePath $server -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'server-output.log') -RedirectStandardError (Join-Path $root 'server-error.log')
}
Write-Host '网页：http://127.0.0.1:19880'
Write-Host '本地插件市场：http://127.0.0.1:19880/plugins/'
if ($Windows) {
    $env:CYBER_ROOM_CONFIG_DIR = Join-Path $root 'review-profile'
    New-Item -ItemType Directory -Path $env:CYBER_ROOM_CONFIG_DIR -Force | Out-Null
    $settings = Join-Path $env:CYBER_ROOM_CONFIG_DIR 'settings.json'
    if (!(Test-Path -LiteralPath $settings)) { [IO.File]::WriteAllText($settings, '{"host":"127.0.0.1","port":19888,"transport":"TCP"}', [Text.UTF8Encoding]::new($false)) }
    Start-Process -FilePath (Join-Path $root 'CyberRoom-0.9.2-windows-x64.exe') -WorkingDirectory $root -WindowStyle Hidden
    Write-Host 'Windows 已使用独立配置启动；首次请在设置中将插件市场改为上面的本地地址。'
}
