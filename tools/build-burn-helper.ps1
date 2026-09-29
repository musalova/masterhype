# Compila BurnHelper.exe con il csc.exe di .NET Framework 4.0 (già in Windows)
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$src = Join-Path $PSScriptRoot "BurnHelper.cs"
$out = Join-Path $PSScriptRoot "..\resources\bin\BurnHelper.exe"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
& $csc /target:exe /platform:anycpu /optimize+ /out:"$out" "$src"
if ($LASTEXITCODE -eq 0) { Write-Host "OK -> $out" } else { Write-Host "COMPILAZIONE FALLITA" }
