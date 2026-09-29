$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
Write-Output "=== Test lock esclusivo su tutti i file sotto $instdir ==="
$locked = @()
Get-ChildItem -Path $instdir -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  $f = $null
  try {
    $f = [System.IO.File]::Open($_.FullName, 'Open', 'ReadWrite', 'None')
  } catch {
    $locked += $_.FullName
  } finally {
    if ($f) { $f.Close() }
  }
}
if ($locked.Count -eq 0) { Write-Output "  NESSUN file bloccato" } else {
  Write-Output "  FILE BLOCCATI:"
  $locked | ForEach-Object { Write-Output "   - $_" }
}
Write-Output "=== Chi tiene aperto MasterHype.exe? (prova rinomina sicura) ==="
$exe = Join-Path $instdir 'MasterHype.exe'
try {
  Rename-Item $exe 'MasterHype.exe.tmp' -ErrorAction Stop
  Rename-Item (Join-Path $instdir 'MasterHype.exe.tmp') 'MasterHype.exe' -ErrorAction Stop
  Write-Output "  rinomina OK -> exe NON bloccato"
} catch {
  Write-Output ("  RINOMINA FALLITA -> exe BLOCCATO: " + $_.Exception.Message)
}
Write-Output "=== Processi con Path NULL (invisibili al check NSIS) ==="
Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Path -eq $null -and $_.Name -notmatch '^(System|Registry|Memory Compression|smss|csrss|wininit|winlogon|services|lsass|svchost|fontdrvhost|dwm|sihost|taskhostw|RuntimeBroker|dllhost|WmiPrvSE|SearchIndexer|spoolsv|dasHost|audiodg|conhost|MoUsoCoreWorker|SecurityHealthService|MsMpEng|NisSrv)' } | Select-Object ProcessId, Name, ExecutablePath, Path | Format-Table -AutoSize
