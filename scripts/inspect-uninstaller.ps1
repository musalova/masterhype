Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$proc = Get-Process -Name 'old-uninstaller' -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output 'old-uninstaller non trovato'; exit 1 }
Write-Output ('PID: ' + $proc.Id + ' | Title: ' + $proc.MainWindowTitle)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
$i = 0
foreach ($w in $wins) {
  $i++
  Write-Output "--- finestra $i : $($w.Current.Name) ---"
  $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    $t = $el.Current.ControlType.ProgrammaticName
    $n = $el.Current.Name
    Write-Output "  $t : $n"
  }
}
Write-Output '=== processi figli/figlie e powershell/cmd appesi ==='
Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ParentProcessId -eq $proc.Id -or $_.Name -match 'powershell|cmd|conhost|taskkill|tasklist|findstr' } | Select-Object ProcessId, ParentProcessId, Name, CommandLine | Format-List
