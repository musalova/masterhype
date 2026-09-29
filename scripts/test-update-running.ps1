$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process (Join-Path $instdir 'MasterHype.exe')
Start-Sleep 10
$procs = Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($instdir, 'CurrentCultureIgnoreCase') }
Write-Output ("App in esecuzione: " + $procs.Count + " processi sotto INSTDIR")
$procs | ForEach-Object { Write-Output ("  " + $_.ProcessId + " " + $_.Name) }
Write-Output "=== Lancio Setup /S con app RUNNING ==="
$setup = 'C:\Users\musalova\Documents\masterhype\release\MasterHype-Setup-0.1.0.exe'
$p = Start-Process -FilePath $setup -ArgumentList '/S' -PassThru -Wait
Write-Output ("SETUP EXIT: " + $p.ExitCode)
Start-Sleep 2
$procs2 = Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($instdir, 'CurrentCultureIgnoreCase') }
Write-Output ("Dopo: " + $procs2.Count + " processi sotto INSTDIR")
$exe = Join-Path $instdir 'MasterHype.exe'
Write-Output ("MasterHype.exe presente: " + (Test-Path $exe))
Write-Output ("app.asar.unpacked: " + (Test-Path (Join-Path $instdir 'resources\app.asar.unpacked')))
