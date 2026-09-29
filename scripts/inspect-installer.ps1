Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$proc = Get-Process -Name 'MasterHype-Setup-0.1.0' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Output 'installer not running'; exit }
Write-Output "PID: $($proc.Id) | Title: $($proc.MainWindowTitle)"
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Dump($e, $d) {
  if ($d -gt 5) { return }
  $name = $e.Current.Name
  $type = $e.Current.ControlType.ProgrammaticName
  if ($name) { Write-Output ((' ' * $d) + $type + ': ' + $name) }
  $c = $walker.GetFirstChild($e)
  while ($c) { Dump $c ($d + 1); $c = $walker.GetNextSibling($c) }
}
$top = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
$n = 0
while ($top) {
  $n++
  Write-Output "--- window $n ---"
  Dump $top 0
  $top = $walker.GetNextSibling($top)
}
