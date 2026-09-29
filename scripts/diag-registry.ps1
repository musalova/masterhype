Write-Output "=== Uninstall registry (MasterHype) ==="
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'MasterHype' } | ForEach-Object {
  Write-Output ("PSChildName: " + $_.PSChildName)
  Write-Output ("DisplayName: " + $_.DisplayName)
  Write-Output ("Version: " + $_.DisplayVersion)
  Write-Output ("InstallLocation: " + $_.InstallLocation)
  Write-Output ("UninstallString: " + $_.UninstallString)
}
Write-Output "=== Chiave app (InstallLocation/KeepShortcuts) ==="
Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'masterhype|com\.masterhype' } | ForEach-Object {
  Write-Output ("Key: " + $_.Name)
  Get-ItemProperty $_.PSPath | Format-List
}
Get-ChildItem 'HKLM:\Software' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'masterhype|com\.masterhype' } | ForEach-Object {
  Write-Output ("Key HKLM: " + $_.Name)
  Get-ItemProperty $_.PSPath | Format-List
}
Write-Output "=== File usati/bloccati sotto INSTDIR (handle.exe non disponibile -> check rinomina) ==="
$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
Write-Output ("INSTDIR esiste: " + (Test-Path $instdir))
