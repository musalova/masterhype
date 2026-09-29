Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' -Name U32 -Namespace W
$root = [System.Windows.Automation.AutomationElement]::RootElement
$installer = Get-Process -Name 'MasterHype-Setup-0.1.0' -ErrorAction SilentlyContinue
if (-not $installer) { Write-Output 'installer non trovato'; exit 1 }
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $installer.Id)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) { Write-Output 'finestra non trovata'; exit 1 }
[W.U32]::SetForegroundWindow($installer.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400
$all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  if ($el.Current.Name -eq 'Riprova') {
    $r = $el.Current.BoundingRectangle
    $x = [int]($r.X + $r.Width / 2)
    $y = [int]($r.Y + $r.Height / 2)
    Write-Output "click su Riprova a ($x,$y)"
    [W.U32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 150
    [W.U32]::mouse_event(0x0002, 0, 0, 0, [System.IntPtr]::Zero)  # LEFTDOWN
    Start-Sleep -Milliseconds 60
    [W.U32]::mouse_event(0x0004, 0, 0, 0, [System.IntPtr]::Zero)  # LEFTUP
    Write-Output 'click inviato'
    exit 0
  }
}
Write-Output 'Riprova non trovato'
