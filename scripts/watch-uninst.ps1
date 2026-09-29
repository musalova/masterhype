$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
$env:ELECTRON_RUN_AS_NODE = $null
Start-Process (Join-Path $instdir 'MasterHype.exe')
Start-Sleep 8
Write-Output '=== App avviata, processi sotto INSTDIR prima ==='
Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($instdir, 'CurrentCultureIgnoreCase') } | ForEach-Object { Write-Output ("  " + $_.ProcessId + " " + $_.Name + " " + $_.Path) }
Write-Output '=== Lancio old-uninstaller silent in background ==='
$un = Join-Path $env:TEMP 'nsbB61A.tmp\old-uninstaller.exe'
$args = '/S /KEEP_APP_DATA /currentuser --updated _?=' + $instdir
$p = Start-Process -FilePath $un -ArgumentList $args -PassThru
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 700
  $alive = -not $p.HasExited
  $procs = Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith($instdir, 'CurrentCultureIgnoreCase') } | ForEach-Object { $_.ProcessId.ToString() + ':' + $_.Name }
  Write-Output ("t=" + ($i * 0.7) + "s exited=" + (-not $alive) + " procsUnderINSTDIR=[" + ($procs -join ', ') + "]")
  if (-not $alive) { break }
}
Write-Output ("=== old-uninstaller exit code: " + $p.ExitCode + " ===")
