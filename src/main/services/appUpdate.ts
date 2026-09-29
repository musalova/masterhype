// Auto-aggiornamento dell'app desktop (EXE) da un feed HTTP(S) generico:
// una cartella statica su un server qualsiasi (VPS, R2/S3 pubblico, Netlify…)
// con i file prodotti da `npm run release` → release/feed/:
//   latest.yml                 (manifest electron-builder: versione + sha512)
//   MasterHype-Setup-X.Y.Z.exe (+ .blockmap per il download differenziale)
//   app-update.json + MasterHype-Android.apk  (stesso feed per i telefoni)
// "Privato ma pubblico": il feed è raggiungibile da ovunque ma basta un path
// non indovinabile (es. https://server/mh-8f3k2…/) per non esporlo a caso.
//
// Flusso: check a boot (+ ogni 6h) → download in background → 'ready' →
// l'utente sceglie "Riavvia e aggiorna" oppure si installa in silenzio alla
// prossima uscita dal tray. Mai durante una masterizzazione.

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getSettings } from '../settings';
import { isBurning } from './burner';
import { report } from './telemetry';
import { DEFAULT_UPDATE_FEED, normalizeFeed } from '../../shared/updateFeed';
import { IPC } from '../../shared/types';
import type { AppUpdateState } from '../../shared/types';

type NotifyFn = (channel: string, payload: unknown) => void;
let notify: NotifyFn = () => {};
let beforeQuit: () => void = () => {};

let state: AppUpdateState = { phase: 'idle', current: '' };
let wired = false;
let checking = false;

function setState(p: Partial<AppUpdateState>): void {
  state = { ...state, ...p, current: app.getVersion() };
  notify(IPC.appUpdateEvent, state);
}

export function appUpdateState(): AppUpdateState {
  return { ...state, current: app.getVersion(), feed: feedUrl() || undefined };
}

export function feedUrl(): string {
  // updateUrl invalido/non fidato (es. http:// non-loopback) → default sicuro:
  // meglio aggiornare dal feed GitHub che restare senza security updates.
  return normalizeFeed(getSettings().updateUrl) || DEFAULT_UPDATE_FEED;
}

function wire(): void {
  if (wired) return;
  wired = true;
  autoUpdater.autoDownload = true;
  // Uscita dal tray con update pronto → installazione silenziosa
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', msg: undefined }));
  autoUpdater.on('update-available', (i) => setState({ phase: 'downloading', version: i.version, pct: 0, notes: typeof i.releaseNotes === 'string' ? i.releaseNotes : undefined }));
  autoUpdater.on('update-not-available', () => setState({ phase: 'uptodate', version: undefined, pct: undefined }));
  autoUpdater.on('download-progress', (p) => setState({ phase: 'downloading', pct: Math.max(0, Math.min(1, p.percent / 100)) }));
  autoUpdater.on('update-downloaded', (i) => {
    setState({ phase: 'ready', version: i.version, pct: 1 });
    report('generic', { message: `aggiornamento ${i.version} scaricato — si installa al riavvio` });
  });
  autoUpdater.on('error', (e) => {
    setState({ phase: 'error', msg: e?.message?.split('\n')[0]?.slice(0, 200) ?? String(e) });
  });
}

// manual=true: risponde sempre con uno stato esplicito (anche 'disabled').
export async function checkAppUpdate(manual = false): Promise<AppUpdateState> {
  if (!app.isPackaged) { setState({ phase: 'disabled', msg: 'versione di sviluppo: aggiornamenti solo sull\'app installata' }); return appUpdateState(); }
  const feed = feedUrl();
  if (!feed) { setState({ phase: 'disabled', msg: 'nessun server aggiornamenti configurato' }); return appUpdateState(); }
  if (!manual && getSettings().autoUpdateApp === false) { setState({ phase: 'idle' }); return appUpdateState(); }
  // Già scaricato/in download: un nuovo giro non deve azzerare lo stato
  if (state.phase === 'ready' || state.phase === 'downloading' || checking) return appUpdateState();
  checking = true;
  try {
    wire();
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setState({ phase: 'error', msg: (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200) });
  } finally {
    checking = false;
  }
  return appUpdateState();
}

// "Riavvia e aggiorna": installazione silenziosa + riavvio automatico.
export function installAppUpdate(): void {
  if (state.phase !== 'ready') throw new Error('nessun aggiornamento pronto');
  if (isBurning()) throw new Error('masterizzazione in corso — aggiorna quando ha finito');
  beforeQuit(); // tray-resident: senza il flag la X/quit verrebbe intercettata
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

export function initAppUpdate(n: NotifyFn, onBeforeQuit: () => void): void {
  notify = n;
  beforeQuit = onBeforeQuit;
  // Primo check a boot assestato, poi ogni 6h (il PC resta acceso settimane)
  setTimeout(() => { void checkAppUpdate(); }, 20_000);
  setInterval(() => { void checkAppUpdate(); }, 6 * 3600_000);
}
