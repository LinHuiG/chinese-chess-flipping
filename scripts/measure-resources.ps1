param([Parameter(Mandatory=$true)][string]$Java, [int]$Seconds=15)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskOutput=Join-Path $taskRoot 'server/target/resource-v05'
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null
$taskProcesses=[System.Collections.Generic.List[System.Diagnostics.Process]]::new()
try {
    Copy-Item -LiteralPath (Join-Path $taskRoot 'server/target/chess-server.jar') -Destination (Join-Path $taskOutput 'reference.jar')
    $env:TCP_WORKER_THREADS='2'
    $env:TCP_PORT='28888'; $env:HTTP_PORT='28880'; $env:UDP_PORT='28888'
    $taskRust=Start-Process -FilePath (Join-Path $taskRoot 'server/target/release/chess-server.exe') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskOutput/rust.out.log" -RedirectStandardError "$taskOutput/rust.err.log"
    $taskProcesses.Add($taskRust)
    $env:TCP_PORT='29888'; $env:HTTP_PORT='29880'
    $taskJava=Start-Process -FilePath $Java -ArgumentList '-Xms16m','-Xmx128m','-XX:+UseSerialGC','-XX:MaxDirectMemorySize=16m','-Xss512k','-jar',"$taskOutput/reference.jar" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskOutput/java.out.log" -RedirectStandardError "$taskOutput/java.err.log"
    $taskProcesses.Add($taskJava)
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(20)
    do { if($taskRust.HasExited -or $taskJava.HasExited){throw 'Server startup failed'}; $taskReady=(Get-Content "$taskOutput/java.out.log" -Raw -ErrorAction SilentlyContinue) -match 'HTTP and WebSocket server listening'; if(-not $taskReady){Start-Sleep -Milliseconds 100} } while(-not $taskReady -and [DateTime]::UtcNow -lt $taskDeadline)
    if(-not $taskReady){throw 'Reference startup timeout'}
    $taskClasspath=(Join-Path $taskRoot 'server/target/test-classes')+';'+(Join-Path $taskRoot 'server/target/classes')
    foreach($taskPort in @(28888,29888)) {
        $taskProbe=Start-Process -FilePath $Java -ArgumentList '-cp',$taskClasspath,'com.chessflipping.server.ResourceProbe',"$taskPort",'102' -WindowStyle Hidden -PassThru -RedirectStandardOutput "$taskOutput/probe-$taskPort.out.log" -RedirectStandardError "$taskOutput/probe-$taskPort.err.log"
        $taskProcesses.Add($taskProbe)
    }
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(20)
    do { $taskReady=(@(28888,29888)|Where-Object{(Get-Content "$taskOutput/probe-$_.out.log" -Raw -ErrorAction SilentlyContinue) -match 'READY connections=102'}).Count -eq 2; if(-not $taskReady){Start-Sleep -Milliseconds 100} } while(-not $taskReady -and [DateTime]::UtcNow -lt $taskDeadline)
    if(-not $taskReady){throw 'Probe handshake timeout'}
    $taskBefore=@{}; foreach($taskProcess in @($taskRust,$taskJava)){$taskProcess.Refresh();$taskBefore[$taskProcess.Id]=$taskProcess.TotalProcessorTime.TotalMilliseconds}
    $taskClock=[System.Diagnostics.Stopwatch]::StartNew();Start-Sleep -Seconds $Seconds;$taskClock.Stop()
    $taskResults=foreach($taskEntry in @(@('Rust',$taskRust),@('Java',$taskJava))){$taskProcess=$taskEntry[1];$taskProcess.Refresh();[pscustomobject]@{Runtime=$taskEntry[0];Connections=102;DurationSeconds=[math]::Round($taskClock.Elapsed.TotalSeconds,2);WorkingSetMiB=[math]::Round($taskProcess.WorkingSet64/1MB,2);PrivateMiB=[math]::Round($taskProcess.PrivateMemorySize64/1MB,2);SingleCoreCpuPercent=[math]::Round(($taskProcess.TotalProcessorTime.TotalMilliseconds-$taskBefore[$taskProcess.Id])/$taskClock.Elapsed.TotalMilliseconds*100,3)}}
    $taskResults|ConvertTo-Json|Set-Content "$taskOutput/results.json" -Encoding utf8
    $taskResults|ConvertTo-Json
} finally {foreach($taskProcess in $taskProcesses){if(-not $taskProcess.HasExited){Stop-Process -InputObject $taskProcess -Force}}}
