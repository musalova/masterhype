Write-Output "=== Win32_Process: Path vs ExecutablePath ==="
$p = Get-CimInstance -ClassName Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1
Write-Output ("explorer.exe -> Path=[" + $p.Path + "] ExecutablePath=[" + $p.ExecutablePath + "]")
Write-Output "=== crashpad_handler.exe sotto INSTDIR? ==="
$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
Get-ChildItem $instdir -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue | Select-Object FullName | Format-List
Write-Output "=== crashpad attivi ORA ==="
Get-CimInstance -ClassName Win32_Process -Filter "Name='crashpad_handler.exe'" | Select-Object ProcessId, Path, ExecutablePath, CommandLine | Format-List
Write-Output "=== Vecchi pluginsdir con old-install ==="
Get-ChildItem (Join-Path $env:TEMP '') -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue | ForEach-Object {
  $oi = Join-Path $_.FullName 'old-install'
  Write-Output ($_.FullName + '  old-install=' + (Test-Path $oi))
}
