$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
$dest = Join-Path $env:TEMP 'mh-rename-test'
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest | Out-Null
Write-Output '=== Simulo atomicRMDir: rinomino ogni file e lo rimetto a posto ==='
$fails = @()
Get-ChildItem -Path $instdir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = $_.FullName.Substring($instdir.Length)
  if ($_.PSIsContainer) { return }
  $tmp = Join-Path $dest ($_.Name + '.mhtest')
  try {
    [System.IO.File]::Move($_.FullName, $tmp)
    [System.IO.File]::Move($tmp, $_.FullName)
  } catch {
    $fails += ($rel + ' -> ' + $_.Exception.Message)
  }
}
if ($fails.Count -eq 0) { Write-Output '  tutti i file rinominabili' } else {
  $fails | ForEach-Object { Write-Output ("  FAIL: " + $_) }
}
Write-Output '=== Attributi/Junction/FileStream alternativi ==='
Get-ChildItem -Path $instdir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -match 'ReparsePoint|System|Device' -or $_.LinkType } | Select-Object FullName, Attributes, LinkType, Target | Format-List
Write-Output '=== File nascosti/sistema root ==='
Get-ChildItem -Path $instdir -Force | Select-Object Name, Attributes | Format-Table -AutoSize
