Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$installer = Get-Process -Name 'MasterHype-Setup-0.1.0' -ErrorAction SilentlyContinue
if (-not $installer) { Write-Output 'installer non trovato'; exit 1 }
Write-Output ('Installer PID: ' + $installer.Id)
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $installer.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'finestra non trovata'; exit 1 }
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$found = $false
foreach ($el in $all) {
  $name = $el.Current.Name
  if ($name -match 'Riprova|Retry') {
    $ctype = $el.Current.ControlType.ProgrammaticName
    Write-Output "Trovato: $ctype = $name"
    try {
      $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $ip.Invoke()
      Write-Output 'CLICCATO via InvokePattern'
      $found = $true
    } catch { Write-Output ('Invoke fallita: ' + $_.Exception.Message) }
  }
}
if (-not $found) {
  Write-Output 'Riprova non cliccato - elenco elementi:'
  foreach ($el in $all) {
    $n = $el.Current.Name
    $t = $el.Current.ControlType.ProgrammaticName
    Write-Output "  $t = $n"
  }
}
