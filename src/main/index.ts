import { app, BrowserWindow, protocol, shell, dialog, globalShortcut, net, Tray, Menu, nativeImage, ipcMain, powerMonitor } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { initDb } from './db';
import { initSettings, getSettings, setSettingsChangedHook } from './settings';
import { registerIpc } from './ipc';
import { setNotifier } from './services/downloader';
import { setBurnNotifier, isBurning } from './services/burner';
import { maybeUpdateYtDlp } from './services/updater';
import { getTrack } from './services/library';
import { startRemoteServer, restartRemoteServer, remoteBroadcast, registerRemoteInfoHandler, updateDirs, applyKeepAwake } from './remote';
import { setPairNotifier } from './pairing';
import { setPlayerStateListener, setHandlersNotifier, setApkInfoProvider } from './handlers';
import { restoreQueue } from './services/downloader';
import { initAppUpdate, checkAppUpdate, appUpdateState, installAppUpdate } from './services/appUpdate';
import { findUpdateSource } from './update';
import { statSync } from 'fs';
import { IPC } from '../shared/types';

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

// Player musicale: play() deve poter partire anche dopo l'attesa di streamUrl()
// (l'autoplay policy standard scade ~5s dopo il click -> anteprime mute)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false; // vero solo da "Esci" nel tray: la X chiude in tray (il server del telefono deve restare vivo)
let nowPlaying = { title: '', artist: '', playing: false, remote: false };

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  remoteBroadcast(channel, payload); // anche i client remoti (telefono) ricevono gli eventi
}

// Tray: icona nell'area notifiche con controlli rapidi e brano corrente nel tooltip
function createTray(): void {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../resources/icon.png');
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('MasterHype');
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const np = nowPlaying.title ? `${nowPlaying.title} — ${nowPlaying.artist}${nowPlaying.remote ? ' (telefono)' : ''}` : 'Nessuna traccia';
  tray.setToolTip(nowPlaying.title ? `MasterHype · ${np}` : 'MasterHype');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: np, enabled: false },
    { type: 'separator' },
    { label: nowPlaying.playing ? 'Pausa' : 'Riproduci', click: () => send(IPC.mediaKey, 'toggle') },
    { label: 'Successivo', click: () => send(IPC.mediaKey, 'next') },
    { label: 'Precedente', click: () => send(IPC.mediaKey, 'prev') },
    { type: 'separator' },
    { label: 'Mostra MasterHype', click: () => { if (win) { win.show(); win.focus(); } } },
    ...(appUpdateState().phase === 'ready'
      ? [{ label: `Riavvia e aggiorna a ${appUpdateState().version ?? 'nuova versione'}`, click: () => { try { installAppUpdate(); } catch (e) { dialog.showErrorBox('Aggiornamento', e instanceof Error ? e.message : String(e)); } } }]
      : []),
    { label: 'Esci', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0b0f',
    title: 'MasterHype',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // La X non esce: riduce in tray. Il server remoto resta vivo — il telefono
  // continua a funzionare anche con la finestra chiusa (stesso modello di
  // Spotify/Discord). Uscita vera solo da tray → "Esci" o da masterizzazione.
  win.on('close', (e) => {
    if (!win || quitting) return;
    if (isBurning()) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Annulla', 'Chiudi comunque'],
        defaultId: 0, cancelId: 0,
        title: 'Masterizzazione in corso',
        message: 'Una masterizzazione è in corso.',
        detail: 'Chiudendo ora il disco potrebbe risultare incompleto o inutilizzabile.',
      });
      if (r === 0) { e.preventDefault(); return; }
      quitting = true; app.quit(); return;
    }
    e.preventDefault();
    win.hide(); // resta in tray: il server del telefono non muore mai per una X
  });

  win.on('closed', () => { win = null; });

  if (process.env.MASTERHYPE_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

// Evita doppie istanze: la seconda porta in primo piano la prima
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
app.on('second-instance', () => {
  if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.masterhype.app'); // notifiche Windows con nome corretto
  initDb();
  initSettings();
  setNotifier(send);
  setBurnNotifier(send);
  setHandlersNotifier(send); // broadcast prefs → PC + telefoni vedono i cambi live

  // Tasti multimediali della tastiera funzionano anche con l'app in background
  globalShortcut.register('MediaPlayPause', () => send(IPC.mediaKey, 'toggle'));
  globalShortcut.register('MediaNextTrack', () => send(IPC.mediaKey, 'next'));
  globalShortcut.register('MediaPreviousTrack', () => send(IPC.mediaKey, 'prev'));

  // Il renderer notifica il brano corrente → tooltip e menu del tray.
  // Stesso canale anche dai client remoti (telefono): chi suona aggiorna il tray.
  const onNowPlaying = (s: { title?: string; artist?: string; playing: boolean; remote?: boolean }) => {
    nowPlaying = { title: s.title ?? '', artist: s.artist ?? '', playing: s.playing, remote: !!s.remote };
    rebuildTrayMenu();
  };
  ipcMain.on(IPC.playerState, (_e, s) => onNowPlaying(s));
  setPlayerStateListener(onNowPlaying);

  // media://audio/<id> -> file mp3 (con Range) ; media://cover/<id> -> copertina
  protocol.handle('media', (req) => {
    const u = new URL(req.url);
    const id = parseInt(u.pathname.replace(/^\//, ''), 10);
    const t = Number.isFinite(id) ? getTrack(id) : undefined;
    if (u.hostname === 'audio' && t?.filePath) return net.fetch(pathToFileURL(t.filePath).toString(), { headers: req.headers });
    if (u.hostname === 'cover' && t?.coverPath) return net.fetch(pathToFileURL(t.coverPath).toString());
    return new Response('not found', { status: 404 });
  });

  setPairNotifier((info) => send(IPC.pairingUsed, info)); // "telefono collegato" → toast sulla card Impostazioni
  registerRemoteInfoHandler(); // prima di registerIpc: entra nella mappa condivisa
  registerIpc();
  startRemoteServer(); // telefono/tablet sulla stessa rete Wi-Fi
  // Avvio automatico con Windows: il telefono dipende dal server del PC —
  // senza autostart ogni reboot spegne il "cloud" domestico.
  const applyAutostart = () => {
    // Build di sviluppo (electron.exe nudo): mai registrarla all'avvio di Windows
    if (!app.isPackaged) return;
    try { app.setLoginItemSettings({ openAtLogin: getSettings().autostart !== false }); } catch { /* */ }
  };
  applyAutostart();
  // Sospensione del PC: socket HTTP e discovery UDP non sopravvivono al sonno
  // (e l'IP può essere cambiato) → riavvio completo del server remoto; i client
  // SSE morti si chiudono alla prossima write/qui con close(). Con keepAwake
  // attivo (default) questa strada è quasi mai percorsa: è la rete di
  // sicurezza per batteria scarica, sospensione forzata, keepAwake spento.
  powerMonitor.on('resume', () => {
    if (getSettings().remoteEnabled) restartRemoteServer();
  });
  setSettingsChangedHook((p) => {
    if ('remoteEnabled' in p || 'remotePort' in p || 'remoteToken' in p) restartRemoteServer();
    if ('keepAwake' in p) applyKeepAwake(); // toggle keep-awake senza restart del server
    if ('autostart' in p) applyAutostart();
    if ('updateUrl' in p || ('autoUpdateApp' in p && p.autoUpdateApp)) void checkAppUpdate();
    // Scritture interne (cambio profilo, fallback dopo deleteUser, ecc.) non
    // passano dall'handler settings:set → broadcast anche da qui; gli echi
    // dell'handler riapplicano lo stesso stato — idempotente.
    send(IPC.settingsEvent, getSettings());
  });
  createWindow();
  createTray();
  // Download rimasti in coda all'ultima chiusura/aggiornamento: ripartono
  restoreQueue();
  // Versione APK che il PC serve ai telefoni (card Aggiornamenti)
  setApkInfoProvider(() => {
    const src = findUpdateSource(updateDirs());
    if (!src) return undefined;
    const m = src.manifest as { versionCode: number; versionName?: unknown };
    let size: number | undefined;
    try { size = statSync(src.apkPath).size; } catch { /* */ }
    return { versionCode: m.versionCode, versionName: typeof m.versionName === 'string' ? m.versionName : undefined, size };
  });
  // Auto-aggiornamento dell'EXE dal feed configurato. Il flag quitting va
  // alzato prima di quitAndInstall: la X/close è intercettata dal tray.
  let updPhase = '';
  initAppUpdate((ch, p) => {
    send(ch, p);
    const ph = (p as { phase?: string })?.phase ?? '';
    if (ph !== updPhase) { updPhase = ph; rebuildTrayMenu(); } // voce "Riavvia e aggiorna"
  }, () => { quitting = true; });
  // yt-dlp si auto-aggiorna in background (YouTube cambia spesso; max 1 check/giorno)
  setTimeout(() => { void maybeUpdateYtDlp(); }, 8000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// Tray-resident: chiudere le finestre NON esce (il server del telefono resta
// su). L'uscita vera passa da tray → "Esci" o dall'installazione di un update.
app.on('window-all-closed', () => { /* resta nel tray */ });
}
