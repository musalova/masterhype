$un = Join-Path $env:TEMP 'nsbB61A.tmp\old-uninstaller.exe'
$instdir = Join-Path $env:LOCALAPPDATA 'Programs\MasterHype'
$args = '/KEEP_APP_DATA /currentuser --updated _?=' + $instdir
# interattivo (niente /S): mostrera la pagina di errore reale
$p = Start-Process -FilePath $un -ArgumentList $args -PassThru
Start-Sleep 3
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, System.IntPtr e); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' -Name U32 -Namespace W
$root = [System.Windows.Automation.AutomationElement]::RootElement
function DumpWin($proc, $label) {
  Write-Output "=== $label (PID $($proc.Id)) ==="
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $wins) {
    Write-Output ("WIN: " + $w.Current.Name)
    $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($el in $all) {
      $t = $el.Current.ControlType.ProgrammaticName
      $n = $el.Current.Name
      if ($n -ne '') { Write-Output "  $t : $n" }
    }
  }
}
function ClickEl($proc, $name) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $w) { Write-Output 'win assente'; return $false }
  [W.U32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 300
  $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    if ($el.Current.Name -eq $name) {
      $r = $el.Current.BoundingRectangle
      [W.U32]::SetCursorPos([int]($r.X + $r.Width/2), [int]($r.Y + $r.Height/2)) | Out-Null
      Start-Sleep -Milliseconds 120
      [W.U32]::mouse_event(0x0002,0,0,0,[System.IntPtr]::Zero)
      Start-Sleep -Milliseconds 50
      [W.U32]::mouse_event(0x0004,0,0,0,[System.IntPtr]::Zero)
      Write-Output "click: $name"
      return $true
    }
  }
  Write-Output "non trovato: $name"
  return $false
}
DumpWin $p 'PRIMA'
ClickEl $p 'Avanti >'
Start-Sleep 4
DumpWin $p 'DOPO AVANTI'
Start-Sleep 6
DumpWin $p 'FINALE'
