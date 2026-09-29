$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
$pluginLen = (Join-Path $env:TEMP 'nsXXXXXX.tmp\old-install').Length
Write-Output ("plugindest base len: " + $pluginLen)
Write-Output '=== I 20 path piu lunghi sotto INSTDIR ==='
Get-ChildItem -Path $instdir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
  [PSCustomObject]@{ Len = $_.FullName.Length; Rel = $_.FullName.Substring($instdir.Length) }
} | Sort-Object Len -Descending | Select-Object -First 20 | ForEach-Object {
  $destLen = $pluginLen + $_.Rel.Length
  $mark = ''
  if ($destLen -ge 260) { $mark = ' *** OLTRE 260 ***' }
  Write-Output ("  len=" + $_.Len + " destLen=" + $destLen + $mark + "  " + $_.Rel)
}
Write-Output '=== app.asar.unpacked esiste? ==='
$u = Join-Path $instdir 'resources\app.asar.unpacked'
Write-Output (Test-Path $u)
