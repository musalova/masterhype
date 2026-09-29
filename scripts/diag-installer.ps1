$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
Write-Output "INSTDIR: $instdir"
Write-Output "=== Processi sotto INSTDIR (quello che l'installer vede come 'app in esecuzione') ==="
$procs = Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($instdir, 'CurrentCultureIgnoreCase') }
if ($procs) { $procs | Select-Object ProcessId, Name, Path | Format-List } else { Write-Output '  nessuno' }
Write-Output "=== Tutti i processi MasterHype* / electron / crashpad ==="
Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -match 'masterhype|electron|crashpad' } | Select-Object ProcessId, Name, Path | Format-List
Write-Output "=== Tasklist MasterHype ==="
tasklist /FI "IMAGENAME eq MasterHype.exe" 2>$null
Write-Output "=== Contenuto dir installazione ==="
if (Test-Path $instdir) { Get-ChildItem $instdir | Select-Object Name, Length | Format-Table -AutoSize } else { Write-Output '  cartella ASSENTE' }
Write-Output "=== Processi con finestra Installazione ==="
Get-Process | Where-Object { $_.MainWindowTitle -match 'Installazione|MasterHype|Setup' } | Select-Object Id, ProcessName, MainWindowTitle, Responding | Format-List
