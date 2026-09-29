import { Capacitor, registerPlugin } from '@capacitor/core';
import { create } from 'zustand';
import { hasRemoteConf, isOnline, remoteBase, remoteToken, watchPcs, discoveryAvailable, FEED_KEY } from './remote';
import { api } from './api';
import { mhFetch } from './direct';
import { DEFAULT_UPDATE_FEED, feedApkManifest } from '../../shared/updateFeed';
import type { AppUpdateState } from '../../shared/types';

// Aggiornamento automatico dell'APK.
// Sorgente primaria: il PC pairato — serve /update/manifest.json + l'APK via
// LAN dalla sua cartella apk (release/ in dev, <userData>/apk installato).
// Sorgente pubblica: DEFAULT_UPDATE_FEED (GitHub Releases, cablato a build) —
// o il feed annunciato dal PC (FEED_KEY) / 'mh-update-url' in localStorage
// per test. Serve i dispositivi "senza PC" e quelli lontani da casa.
// Il download e l'installazione passano dal plugin app-locale AppUpdate
// (HTTP nativo + FileProvider + intent di sistema): niente dipendenze npm.

export interface UpdateManifest {
  versionCode: number;
  versionName?: string;
  url?: string;      // URL assoluto o relativo al manifest
  file?: string;     // nome file alternativo (default app.apk)
  size?: number;
  sha256?: string;
  notes?: string;
  minSupportedCode?: number; // se > installato: update OBBLIGATORIO (non ignorabile)
}

// Feed pubblico: quello annunciato dal PC (memorizzato in FEED_KEY), oppure
// 'mh-update-url' (override manuale/test), oppure il default di build.
function publicManifestUrl(): string {
  try {
    const manual = localStorage.getItem('mh-update-url');
    if (manual) return manual;
    return feedApkManifest(localStorage.getItem(FEED_KEY) || DEFAULT_UPDATE_FEED);
  } catch { return feedApkManifest(DEFAULT_UPDATE_FEED); }
}

// PC MasterHype sulla stessa Wi-Fi (discovery UDP), anche MAI pairato: le
// route /update sono pubbliche → i telefoni "senza PC" si aggiornano lo stesso.
function discoverLanPc(ms = 5000): Promise<string | null> {
  if (!discoveryAvailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stop = () => {};
    const t = setTimeout(() => { stop(); resolve(null); }, ms);
    stop = watchPcs((pc) => { clearTimeout(t); stop(); resolve(pc.base); });
  });
}

interface UpdatePlugin {
  info(): Promise<{ versionCode: number; versionName: string }>;
  download(o: { url: string; token?: string; sha256?: string }): Promise<{ path: string; size: number }>;
  install(o: { path: string }): Promise<{ needsPermission?: boolean }>;
  addListener(ev: 'progress', cb: (e: { received: number; total: number }) => void): Promise<{ remove: () => void }>;
}

const plugin = Capacitor.isNativePlatform() ? registerPlugin<UpdatePlugin>('AppUpdate') : null;
// L'update UI esiste solo dove può installare (l'APK); in browser il plugin è null.
export const updateSupported = (): boolean => !!plugin;

// Versione dell'app CHE STA GIRANDO: sull'APK quella nativa del pacchetto
// (app:info risponderebbe col PC, non col telefono); su desktop e client
// remoto/browser quella del server che serve il renderer. '' se ignota.
export async function appVersion(): Promise<string> {
  try {
    if (plugin) return (await plugin.info()).versionName || '';
    return (await api().app.info()).version || '';
  } catch { return ''; }
}

export interface UpdateInfo extends UpdateManifest {
  url: string;                 // URL apk risolto (assoluto)
  source: 'pc' | 'public' | 'lan'; // da dove è arrivato il manifest (token solo per 'pc')
  required?: boolean;          // minSupportedCode > installato → non ignorabile
}

export type UpdatePhase =
  | 'idle'        // mai controllato / nessuna sorgente
  | 'checking'
  | 'available'   // nuova versione trovata → proposta all'utente
  | 'downloading'
  | 'ready'       // apk scaricato e verificato → pronto all'installazione
  | 'uptodate'    // check fatto: già all'ultima versione
  | 'error';

interface UpdateState {
  phase: UpdatePhase;
  current?: { versionCode: number; versionName: string };
  info?: UpdateInfo;
  path?: string;   // file apk scaricato (cache dir nativa)
  pct: number;     // progresso download 0..1 (NaN = indeterminato)
  msg?: string;    // dettaglio errore per phase 'error'
}

const DISMISS_KEY = 'mh-update-dismissed'; // versionCode ignorato dall'utente

export const useUpdate = create<UpdateState>(() => ({
  phase: 'idle',
  pct: 0,
}));

// Manifest da ogni sorgente disponibile, nell'ordine: PC di casa (token),
// poi URL pubblico configurato. null = nessuna sorgente raggiungibile.
// Vince il versionCode più alto tra le sorgenti raggiungibili: il PC di casa
// può essere rimasto indietro rispetto al feed pubblico (o viceversa).
async function fetchManifest(): Promise<UpdateInfo | null> {
  const sources: { url: string; source: UpdateInfo['source']; token?: string }[] = [];
  // PC marcato offline: inutile pagare il timeout sul socket morto — quando
  // torna, onReconnected fa comunque partire un check fresco.
  const pcUp = hasRemoteConf() && isOnline();
  if (pcUp) sources.push({ url: `${remoteBase()}/update/manifest.json`, source: 'pc', token: remoteToken() });
  const pub = publicManifestUrl();
  if (pub) sources.push({ url: pub, source: 'public' });
  // Nessun PC raggiungibile: un qualsiasi PC MasterHype in Wi-Fi fa da sorgente
  if (!pcUp) {
    const lan = await discoverLanPc();
    if (lan) sources.push({ url: `${lan}/update/manifest.json`, source: 'lan' });
  }

  let best: UpdateInfo | null = null;
  for (const s of sources) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 7000);
      const res = await mhFetch(s.url, {
        headers: s.token ? { 'X-MH-Token': s.token } : undefined,
        signal: ac.signal,
      }).finally(() => clearTimeout(t));
      if (!res.ok) continue;
      const m = (await res.json().catch(() => null)) as UpdateManifest | null;
      if (!m || !Number.isFinite(m.versionCode)) continue;
      const apkUrl = new URL(m.url ?? (m.file ? `./${m.file}` : './app.apk'), s.url);
      // Solo http(s): un manifest avvelenato non deve puntare a file:/content:
      if (apkUrl.protocol !== 'http:' && apkUrl.protocol !== 'https:') continue;
      if (!best || m.versionCode > best.versionCode) best = { ...m, url: apkUrl.href, source: s.source };
    } catch { /* sorgente giù: prova la prossima */ }
  }
  return best;
}

let checking = false;
// Check esplicito (manual=true: risponde sempre con uno stato visibile) o
// automatico (silenzioso: "uptodate" non disturba, "available" mostra la card).
export async function checkUpdate(manual = false): Promise<void> {
  if (!plugin || checking) return;
  // Download in corso o APK pronto: un check (timer 6h, riconnessione) NON
  // deve azzerare lo stato — si perderebbero progresso e file verificato.
  const ph = useUpdate.getState().phase;
  if (ph === 'downloading' || ph === 'ready' || (!manual && ph === 'available')) return;
  checking = true;
  useUpdate.setState({ phase: 'checking', msg: undefined });
  try {
    const [cur, man] = await Promise.all([plugin.info(), fetchManifest()]);
    useUpdate.setState({ current: cur });
    if (!man) {
      useUpdate.setState({ phase: manual ? 'error' : 'idle', msg: manual ? 'Nessuna sorgente aggiornamenti raggiungibile' : undefined });
      return;
    }
    if (man.versionCode <= cur.versionCode) {
      useUpdate.setState({ phase: 'uptodate', info: undefined });
      return;
    }
    // Update obbligatorio (minSupportedCode > installato): niente dismiss —
    // la card resta finché l'utente non aggiorna (sicurezza/compatibilità).
    const required = Number.isFinite(man.minSupportedCode) && (man.minSupportedCode ?? 0) > cur.versionCode;
    if (!required) {
      // Versione già "ignorata" dall'utente: la riproponiamo solo al check manuale
      const dismissed = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (!manual && man.versionCode === dismissed) {
        useUpdate.setState({ phase: 'idle', info: man });
        return;
      }
    }
    useUpdate.setState({ phase: 'available', info: { ...man, required }, pct: 0 });
  } catch (e) {
    useUpdate.setState({ phase: manual ? 'error' : 'idle', msg: e instanceof Error ? e.message : String(e) });
  } finally {
    checking = false;
  }
}

export async function downloadUpdate(): Promise<void> {
  const info = useUpdate.getState().info;
  if (!plugin || !info) return;
  useUpdate.setState({ phase: 'downloading', pct: info.size ? 0 : NaN, msg: undefined });
  autoRetryUsed = false;
  const sub = await plugin.addListener('progress', (e) => {
    if (e.total > 0) useUpdate.setState({ pct: Math.min(1, e.received / e.total) });
  });
  try {
    const r = await plugin.download({
      url: info.url,
      token: info.source === 'pc' ? remoteToken() : undefined,
      sha256: info.sha256,
    });
    useUpdate.setState({ phase: 'ready', path: r.path, pct: 1 });
  } catch (e) {
    useUpdate.setState({ phase: 'error', msg: e instanceof Error ? e.message : String(e) });
  } finally {
    sub.remove();
  }
}

// Lancia l'installer di sistema sul file scaricato.
// 'permission': Android ha aperto la pagina "installa app sconosciute" —
// l'utente abilita e riprova. 'gone': il file non c'è più (pulizia cache di
// sistema) → la card torna a 'available' e riscarica al prossimo tap.
export async function installUpdate(): Promise<'ok' | 'permission' | 'gone'> {
  const path = useUpdate.getState().path;
  if (!plugin) return 'gone';
  if (!path) {
    useUpdate.setState({ phase: 'available', pct: 0 });
    return 'gone';
  }
  try {
    const r = await plugin.install({ path });
    if (r.needsPermission) armRetryOnReturn();
    return r.needsPermission ? 'permission' : 'ok';
  } catch (e) {
    if (String(e instanceof Error ? e.message : e).includes('non trovato')) {
      useUpdate.setState({ phase: 'available', path: undefined, pct: 0 });
      return 'gone';
    }
    throw e;
  }
}

// Android ha aperto "Installa app sconosciute": quando l'utente torna
// nell'app (permesso concesso) si riparte da soli — senza dover ritrovare
// la card e ritoccare "Installa". Un solo tentativo per consenso.
let retryArmed = false;
let autoRetryUsed = false; // max un tentativo automatico: permesso negato → niente loop
function armRetryOnReturn(): void {
  if (retryArmed || autoRetryUsed || typeof document === 'undefined') return;
  retryArmed = true;
  const onVis = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', onVis);
    retryArmed = false;
    autoRetryUsed = true;
    if (useUpdate.getState().phase === 'ready') setTimeout(() => { void installUpdate().catch(() => {}); }, 600);
  };
  document.addEventListener('visibilitychange', onVis);
}

// "Ignora": non riproporre QUESTA versione al boot (il check manuale la trova comunque)
export function dismissUpdate(): void {
  const vc = useUpdate.getState().info?.versionCode;
  if (vc) { try { localStorage.setItem(DISMISS_KEY, String(vc)); } catch { /* */ } }
  useUpdate.setState({ phase: 'idle' });
}

export function resetUpdateError(): void {
  useUpdate.setState({ phase: 'idle', msg: undefined });
}

// ---- Aggiornamento dell'app DESKTOP (EXE via feed, electron-updater nel main) ----
// Lo stato arriva dal main (evento app:updEvent); il renderer mostra card e
// riga Impostazioni. "Più tardi" = si installa da solo all'uscita dal tray.
export const useDesktopUpdate = create<AppUpdateState & { dismissed?: string }>(() => ({ phase: 'idle', current: '' }));
let desktopInit = false;
export function initDesktopUpdate(): () => void {
  if (desktopInit || !window.masterhype) return () => {};
  desktopInit = true;
  const a = window.masterhype.app;
  void a.updateStatus().then((s) => useDesktopUpdate.setState(s)).catch(() => {});
  const off = a.onUpdateEvent((s) => useDesktopUpdate.setState(s));
  return () => { off(); desktopInit = false; };
}
export async function checkDesktopUpdate(): Promise<void> {
  if (!window.masterhype) return;
  useDesktopUpdate.setState({ phase: 'checking', msg: undefined });
  const s = await window.masterhype.app.updateCheck().catch((e: unknown) => ({ phase: 'error' as const, current: useDesktopUpdate.getState().current, msg: e instanceof Error ? e.message : String(e) }));
  useDesktopUpdate.setState(s);
}
export function dismissDesktopUpdate(): void {
  useDesktopUpdate.setState((s) => ({ dismissed: s.version }));
}
