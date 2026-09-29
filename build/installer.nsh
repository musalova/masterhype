; MasterHype — NSIS custom macros
;
; Problemi risolti (diagnosticati live, riprodotti deterministicamente):
;
;  1) APP TRAY-RESIDENT: la X nasconde la finestra invece di chiudere, quindi
;     WM_CLOSE (kill "graceful" del check di default) non la chiude mai.
;     Serve taskkill /F o Stop-Process -Force.
;
;  2) PATH LUNGHI -> "MasterHype non può essere chiuso" in loop infinito:
;     in update, uninstallOldVersion lancia il VECCHIO uninstaller che fa
;     atomicRMDir spostando ogni file in $PLUGINSDIR\old-install. I file di
;     resources\app.asar.unpacked\node_modules (build intermediates di
;     @capacitor/android, fino a ~255 char) producono destinazioni >260 char
;     (MAX_PATH) -> Rename fallisce -> Abort -> exit 2 -> l'installer riprova
;     5 volte -> dialog appCannotBeClosed -> Riprova -> stesso fallimento.
;     Il messaggio e' fuorviante: non c'entra l'app in esecuzione.
;     Fix: eliminare PRIMA app.asar.unpacked (robocopy /MIR regge i path
;     lunghi, rd/Remove-Item no).
;
;  3) PAZIENZA TROPPO CORTA del check di default (~4s, 2 giri): l'albero di
;     processi Electron (4x MasterHype.exe + yt-dlp/ffmpeg orfani in
;     resources\bin) impiega ~5-6s a morire dopo il force-kill -> falso
;     "cannot be closed" anche quando tutto e' killabile.
;     Fix: kill per-path (tutto cio' che sta sotto INSTDIR) + attesa ~15s.

; --- helpers ---

!macro _mhPid
  System::Call 'kernel32::GetCurrentProcessId() i .R8'
!macroend

; termina ogni processo il cui exe sta sotto ${DIR} (escluso il nostro PID —
; quando il nuovo uninstaller gira in-place da $INSTDIR non deve suicidarsi)
!macro _mhKillDir DIR
  !insertmacro _mhPid
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -C "Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('${DIR}', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $R8 } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $R9
!macroend

; attende fino a ~15s che non resti nessun processo sotto ${DIR}
!macro _mhWaitClear DIR
  !insertmacro _mhPid
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -C "$$t = Get-Date; while (@(Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('${DIR}', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $R8 }).Count -gt 0 -and ((Get-Date) - $$t).TotalSeconds -lt 15) { Start-Sleep -Milliseconds 400 }"`
  Pop $R9
!macroend

; elimina i path >260 sotto ${DIR} che farebbero abortire atomicRMDir
; (robocopy /MIR con dir vuota = wipe affidabile dei path lunghi)
!macro _mhPreClean DIR
  IfFileExists "${DIR}\resources\app.asar.unpacked\*.*" 0 +3
    nsExec::Exec `"$SYSDIR\cmd.exe" /c "md "$TEMP\mh-e" 2>nul & robocopy "$TEMP\mh-e" "${DIR}\resources\app.asar.unpacked" /MIR /NFL /NDL /NJH /NJS /NP >nul & rd /s /q "${DIR}\resources\app.asar.unpacked" >nul 2>&1 & rd /s /q "$TEMP\mh-e" >nul 2>&1"`
    Pop $R9
!macroend

; preparazione completa: kill app + processi sotto DIR + attesa + path lunghi
!macro _mhPrepare DIR
  ; l'app e' tray-resident: WM_CLOSE non basta, kill duro per image name
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $R9
  !insertmacro _mhKillDir "${DIR}"
  !insertmacro _mhWaitClear "${DIR}"
  !insertmacro _mhPreClean "${DIR}"
!macroend

; --- hooks electron-builder ---

; .onInit dell'installer — PRIMA delle pagine: kill app + pre-clean, cosi'
; il vecchio uninstaller (lanciato da uninstallOldVersion nella section)
; trova solo path corti e completa con exit 0.
!macro customInit
  !insertmacro _mhPrepare "$INSTDIR"
  ; pre-pulisci anche il percorso standard di installazione per-utente:
  ; e' li' che il vecchio uninstaller guarda (da UninstallString) anche se
  ; $INSTDIR dovesse puntare altrove nel wizard.
  ${If} "$INSTDIR" != "$LocalAppData\Programs\${APP_FILENAME}"
    !insertmacro _mhKillDir "$LocalAppData\Programs\${APP_FILENAME}"
    !insertmacro _mhWaitClear "$LocalAppData\Programs\${APP_FILENAME}"
    !insertmacro _mhPreClean "$LocalAppData\Programs\${APP_FILENAME}"
  ${EndIf}
!macroend

; sostituisce il check "app in esecuzione" di electron-builder (troppo fragile):
; kill per-path + attesa lunga, poi si procede — niente dialog in loop.
; Usato sia nella sezione install sia nel silent-check del nuovo uninstaller.
!macro customCheckAppRunning
  !insertmacro _mhPrepare "$INSTDIR"
!macroend

; .onInit del NUOVO uninstaller (dopo initMultiUser)
!macro customUnInit
  !insertmacro _mhPreClean "$INSTDIR"
!macroend

; sezione del NUOVO uninstaller — prima di atomicRMDir
!macro customUnInstall
  !insertmacro _mhPrepare "$INSTDIR"
!macroend

; chiamata dopo ExecWait del vecchio uninstaller (uninstallOldVersion):
; se il vecchio esce non-zero non blocchiamo l'update — i file nuovi vengono
; comunque copiati sopra (Return salta il check d'errore di handleUninstallResult)
!macro customUnInstallCheck
  !insertmacro _mhKillDir "$INSTDIR"
  !insertmacro _mhWaitClear "$INSTDIR"
  Return
!macroend
