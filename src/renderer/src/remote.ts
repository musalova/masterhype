import { IPC } from '../../shared/types';
import type { MhUser, MhDevice, Playlist, TrackRef, AppStats, AppInfo, AppUpdateState } from '../../shared/types';
import type { MasterHypeApi } from '../../preload/index';
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  directSearch, directStream, directPlayStream, directVideoUrl, directSuggestions,
  directLyrics, directUpNext, directCharts, directAlbumTracks, directArtistTop,
  directArtistPage, directPlaylistTracks,
} from './direct';

// Client remoto: su telefono/tablet (browser o app Android) non esiste
// window.masterhype — la stessa identica UI parla col PC via HTTP.
// Config: {base: 'http://192.168.x.x:48484', token: '…'} in localStorage,
// oppure auto-derivato da ?token= quando si apre la pagina servita dal PC.

interface RemoteConf { base: string; token: string; alts?: string[]; user?: number; devBound?: boolean }
const CONF_KEY = 'mh-remote-conf';

declare global {
  interface Window { masterhype?: MasterHypeApi }
}

export const isRemote = (): boolean => typeof window === 'undefined' || !window.masterhype;

function loadConf(): RemoteConf | null {
  if (typeof location === 'undefined') return null; // ambiente non-DOM (test)
  // 1) token nell'URL: la pagina è servita dal PC stesso → stesso origin.
  // Preserva `user`/`alts` della conf salvata: un reload dopo il cambio profilo
  // non deve far ripartire il dispositivo dal profilo 1.
  const q = new URLSearchParams(location.search).get('token');
  if (q && location.protocol.startsWith('http')) {
    let prev: RemoteConf | null = null;
    try { const s = localStorage.getItem(CONF_KEY); if (s) prev = JSON.parse(s) as RemoteConf; } catch { /* */ }
    const c: RemoteConf = { base: location.origin, token: q, alts: prev?.alts, user: prev?.user };
    try { localStorage.setItem(CONF_KEY, JSON.stringify(c)); } catch { /* */ }
    history.replaceState(null, '', location.pathname); // pulisce il token dalla barra
    return c;
  }
  // 2) configurazione salvata (app Android / accessi successivi)
  try {
    const s = localStorage.getItem(CONF_KEY);
    if (s) return JSON.parse(s) as RemoteConf;
  } catch { /* */ }
  return null;
}

let conf = loadConf();
export const hasRemoteConf = (): boolean => !!conf;
export const remoteBase = (): string => conf?.base ?? '';
export const remoteToken = (): string => conf?.token ?? '';

// ---- Modalità "senza PC" (standalone) ----
// Al primo avvio dell'APK l'utente può scegliere di usare l'app da sola:
// niente pairing, niente PC. Il flag rende permanente la modalità autonoma
// (YouTube diretto, download sul telefono, code offline) che altrimenti
// scatterebbe solo a PC morto. I dati accumulati stanno sotto il profilo
// virtuale u1 — al primo pairing reale migrano sul profilo scelto.
const STANDALONE_KEY = 'mh-standalone';
// Marcatore DUREVOLE "i dati di questo dispositivo possono stare sotto :u1":
// il flag di sessione viene tolto da "Collega un PC" PRIMA del pairing —
// senza questo la migrazione standalone→profilo salterebbe proprio sul
// percorso per cui esiste (standalone → Impostazioni → Collega → pair ≠1).
// Si consuma al primo saveRemoteConf che la applica.
const STANDALONE_ERA = 'mh-standalone-era';
export function isStandalone(): boolean {
  if (conf) return false; // pairato → non è mai standalone (flag orfano ignorato)
  try { return localStorage.getItem(STANDALONE_KEY) === '1'; } catch { return false; }
}
export function enterStandalone(): void {
  // L'utente può arrivare al bottone anche da uno stato "sporco": conf
  // esistente (es. scelta profilo dopo eliminazione — il pairing restava e
  // isStandalone() sarebbe sempre false) o flag mh-pick-profile settato
  // (gate di nuovo al reload, loop infinito). "Senza PC" = scelta netta:
  // si dimentica QUALUNQUE pairing salvato.
  clearRemoteConf();
  try { localStorage.removeItem(PICK_PROFILE_KEY); } catch { /* */ }
  try {
    localStorage.setItem(STANDALONE_KEY, '1');
    localStorage.setItem(STANDALONE_ERA, '1');
  } catch { /* */ }
  location.reload();
}
// "Collega un PC" dalle Impostazioni: toglie il flag di sessione → torna il
// gate di pairing. L'era RESTA: è lei a guidare la migrazione :u1→profilo.
export function exitStandalone(): void {
  try { localStorage.removeItem(STANDALONE_KEY); } catch { /* */ }
  location.reload();
}

// Le chiavi namespacizzate ':u1' prodotte in standalone (profilo virtuale)
// passano al profilo reale scelto al pairing: indice download sul telefono,
// code pendingSync, dirty prefs, cache. Mai sovrascrivere una chiave ':u<id>'
// già esistente (profilo già usato su questo dispositivo): la copia u1 resta,
// niente si perde.
function migrateStandaloneData(uid: number): void {
  try {
    const renames: [string, string][] = [];
    for (const k of Object.keys(localStorage)) {
      // ':u1' seguito da fine chiave o ':' — ':u10' NON deve matchare ':u1'
      const nk = k.replace(/:u1(?=:|$)/, `:u${uid}`);
      if (nk !== k && localStorage.getItem(nk) == null) renames.push([k, nk]);
    }
    for (const [k, nk] of renames) {
      localStorage.setItem(nk, localStorage.getItem(k)!);
      localStorage.removeItem(k);
    }
    // I record IndexedDB portano il proprietario nel campo `u` (non nel key):
    // li riassegniamo lazy — import dinamico, phoneLocal importa già remote.
    void import('./phoneLocal').then((m) => m.phoneReassignUser(1, uid)).catch(() => {});
  } catch { /* */ }
}

const persistConf = () => { try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch { /* */ } swAnnounce(); };

// ---- Proxy service worker /__pc/* ----
// Con un SW che controlla la pagina (APK/PWA — su http://LAN in browser il SW
// non si registra, contesto non sicuro) media ed EventSource usano URL
// same-origin /__pc/…: è il SW a inoltrare al PC aggiungendo X-MH-Token in
// header. Il token non compare MAI in una URL di subresource (cronologia,
// log proxy, Referer). Dove il SW manca resta il fallback ?token= — che dopo
// l'upgrade a device token espone comunque solo il profilo del device.
const swControlled = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
function swAnnounce(): void {
  if (!conf || typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  const msg = { t: 'mh-pc-auth', base: conf.base, token: conf.token };
  try { navigator.serviceWorker.controller?.postMessage(msg); } catch { /* */ }
  // Primo avvio: controller è null finché il SW non claima — lo raggiungiamo
  // comunque via registration.active (il messaggio sopravvive al claim).
  void navigator.serviceWorker.ready
    .then((r) => r.active?.postMessage(msg)).catch(() => {});
}
// Il SW riattivato (controllerchange) deve ricevere subito le credenziali.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => swAnnounce());
}
if (conf) swAnnounce();

export function saveRemoteConf(base: string, token: string, user = 1, devBound = false): void {
  const base2 = base.replace(/\/+$/, '');
  // Indirizzi imparati (Tailscale, LAN secondaria): si conservano solo se il
  // pairing è verso lo STESSO PC. Il token cambia a ogni pairing (device
  // token freschi) → il confronto è su base/alts, non sul token. Verso un PC
  // nuovo il failover punterebbe a una macchina che non accetta il token.
  const samePc = !!conf && (conf.token === token || conf.base === base2 || (conf.alts ?? []).includes(base2));
  const alts = samePc ? [...(conf?.alts ?? []), conf?.base].filter((a): a is string => !!a && a !== base2) : [];
  let eraStandalone = false;
  try { eraStandalone = localStorage.getItem(STANDALONE_ERA) === '1'; } catch { /* */ }
  try { localStorage.removeItem(STANDALONE_KEY); } catch { /* */ }
  try { localStorage.removeItem(STANDALONE_ERA); } catch { /* */ }
  // Un pairing riuscito chiude anche un'eventuale attesa di scelta profilo:
  // il flag residuo rimanderebbe al gate al prossimo boot con conf valida.
  try { localStorage.removeItem(PICK_PROFILE_KEY); } catch { /* */ }
  if (eraStandalone && user !== 1) migrateStandaloneData(user);
  if (eraStandalone) {
    // Il primo SSE connect deve valere come "riconnessione": le code migrate
    // (like, ascolti, playlist, download) si drenano subito, non al primo
    // blackout fortuito. online=false finché il probe non conferma il PC.
    try { localStorage.setItem('mh-was-online', '0'); } catch { /* */ }
  }
  conf = { base: base2, token, user, alts: alts.length ? alts : undefined, devBound };
  persistConf();
}
export function clearRemoteConf(): void {
  conf = null;
  // Scollegare il dispositivo riporta al gate (pairing o scelta senza PC):
  // il flag va via — un flag residuo rientrerebbe muto in standalone.
  try { localStorage.removeItem(STANDALONE_KEY); } catch { /* */ }
}

// Coda offline: quando tornerà utile? Nei toast — "alla riconnessione" è la
// verità col PC pairato spento, "quando colleghi un PC" in modalità senza PC
// (le azioni restano comunque accodate e si consegnano al primo pairing).
export function resyncWhen(): string {
  return isStandalone() ? 'quando colleghi un PC' : 'alla riconnessione';
}
// Suffisso dei toast per azioni local-first (playlist, gusti…): vuoto se il PC
// ha già ricevuto la modifica o se non esiste un PC (senza PC il telefono È
// la verità); col PC pairato ma giù dice quando arriverà.
export function syncNote(): string {
  if (!isRemote() || isOnline() || isStandalone()) return '';
  return ` — sul PC ${resyncWhen()}`;
}
// Nei messaggi di errore: "PC offline" ha senso solo se un PC esiste —
// in modalità senza PC il motivo vero è che manca la rete/il fallback diretto.
export function pcGone(): string {
  return isStandalone() ? 'senza PC' : 'PC offline';
}

// Profilo di QUESTO dispositivo: su remoto è conf.user, su desktop lo
// specchia 'mh-user' (scritto all'avvio da api().users.current()).
// Il primo argomento iniettato dal server nelle chiamate è questo id —
// gusti, preferiti, playlist e preferenze visibili sono solo suoi.
export function myUserId(): number {
  if (isRemote()) return conf?.user ?? 1;
  try { return parseInt(localStorage.getItem('mh-user') ?? '1', 10) || 1; } catch { return 1; }
}
export function setLocalUserId(id: number): void {
  try { localStorage.setItem('mh-user', String(id)); } catch { /* */ }
}
// Cambio profilo su un dispositivo remoto: il profilo vive nella conf locale
// (il PC non cambia il proprio). Le preferenze locali dell'altro profilo
// vengono pulite dal chiamante prima del reload.
export function setRemoteUser(id: number): void {
  if (conf) {
    conf = { ...conf, user: id };
    try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch { /* */ }
  }
  setLocalUserId(id);
}

// Token scaduto/rigenerato: si torna alla schermata di pairing.
// Debounce: più chiamate concorrenti non devono sparare reload multipli.
let resetting = false;
// Race guard: una 401 tardiva di una probe/call in volo col VECCHIO token non
// deve cancellare un pairing più recente scritto nel frattempo (es. l'utente
// si è ri-pairizzato mentre la vecchia fetch era in viaggio).
function confRewritten(): boolean {
  try {
    const s = localStorage.getItem(CONF_KEY);
    return !!(s && conf && (JSON.parse(s) as RemoteConf)?.token !== conf.token);
  } catch { return false; }
}
export function resetToPairing(): void {
  if (resetting) return;
  resetting = true;
  if (confRewritten()) { location.reload(); return; }
  clearRemoteConf();
  location.reload();
}

// Profilo eliminato/sconosciuto sul PC: NON buttare il pairing — si perde il
// token e l'utente dovrebbe re-inserirlo a mano. Conserva base+token, chiede
// solo la scelta del profilo (ConnectGate con flag 'mh-pick-profile').
const PICK_PROFILE_KEY = 'mh-pick-profile';
export function needsProfilePick(): boolean {
  try { return localStorage.getItem(PICK_PROFILE_KEY) === '1'; } catch { return false; }
}
export function resetToProfilePick(): void {
  if (resetting) return;
  resetting = true;
  if (confRewritten()) { location.reload(); return; }
  try { localStorage.setItem(PICK_PROFILE_KEY, '1'); } catch { /* */ }
  location.reload(); // la conf resta: main.tsx mostra solo la scelta profilo
}
export function clearProfilePick(): void {
  try { localStorage.removeItem(PICK_PROFILE_KEY); } catch { /* */ }
}
// Accesso alla conf per il gate di scelta profilo (senza esportare l'oggetto)
export function confBase(): string { return conf?.base ?? ''; }
export function confToken(): string { return conf?.token ?? ''; }

// Handshake di pairing: distingue "codice errato" da "PC irraggiungibile" —
// due problemi diversi che meritano messaggi diversi all'utente
export async function testConnection(base: string, token: string): Promise<'ok' | 'auth' | 'down'> {
  // AbortController manuale: AbortSignal.timeout non esiste su WebView < 103
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/info`, {
      headers: { 'X-MH-Token': token }, signal: ac.signal,
    });
    if (res.status === 401) return 'auth';
    if (!res.ok) return 'down';
    // 200 OK non basta: su reti mobili un captive portal risponde 200 HTML a
    // QUALUNQUE indirizzo — il pairing si salverebbe su un host fantasma.
    const j = (await res.json().catch(() => null)) as { name?: unknown } | null;
    return j?.name === 'MasterHype' ? 'ok' : 'down';
  } catch { return 'down'; } finally { clearTimeout(t); }
}

// ---- Auto-discovery LAN + pairing guidato (zero digitazione) ----
// Il PC annuncia "MH1|porta|nome" via broadcast UDP :48485 (src/main/discovery.ts);
// il plugin nativo Discovery (APK) lo riceve → il gate mostra il PC trovato.
// Il token arriva da /pair SOLO dentro la finestra "Accoppia telefono" aperta
// sul PC, oppure dal QR (contiene già base+token). Fuori dall'APK: no-op —
// resta il flusso QR+manuale.

interface DiscoveryPlugin {
  listen(): Promise<void>;
  stop(): Promise<void>;
  addListener(ev: 'found', cb: (e: { host: string; port: number; name: string }) => void): Promise<PluginListenerHandle>;
}
const discPlugin = Capacitor.isNativePlatform() ? registerPlugin<DiscoveryPlugin>('Discovery') : null;

export interface FoundPc { base: string; name: string }

// Ascolta gli annunci UDP del PC. Ritorna la funzione di stop. Ogni base
// nuova arriva UNA volta (il PC annuncia ogni ~2.5s — dedup nel callback).
export function watchPcs(onFound: (pc: FoundPc) => void): () => void {
  if (!discPlugin) return () => {};
  const seen = new Set<string>();
  const sub = discPlugin.addListener('found', (e) => {
    if (!e?.host || !e.port) return;
    const base = `http://${e.host}:${e.port}`;
    if (seen.has(base)) return;
    seen.add(base);
    onFound({ base, name: e.name?.trim() || 'PC MasterHype' });
  });
  void discPlugin.listen().catch(() => {});
  return () => {
    void sub.then((s) => s.remove()).catch(() => {});
    void discPlugin.stop().catch(() => {});
  };
}

export const discoveryAvailable = !!discPlugin;

// Consegna del token durante la finestra "Accoppia telefono" (POST /pair è
// l'unica route senza token: fuori finestra → 'closed', così il gate può
// dire "sul PC premi Accoppia" e riprovare da solo finché si apre).
// Nome leggibile del dispositivo per la conferma sul PC ("Pixel 8"…)
export function deviceLabel(): string {
  const m = /Android[^;)]*;\s*([^;)]+)/.exec(navigator.userAgent);
  return m?.[1]?.trim().slice(0, 40) || 'Dispositivo Android';
}

// QR aperto nel browser del telefono: la pagina arriva come
// http://ip:porta/?pair=<codice monouso>. Il codice si riscatta subito via
// POST /pair → device token → conf salvata + scelta profilo (il token
// riscattato non è ancora legato: serve il "chi sei?"). Il codice esce dalla
// barra PRIMA di qualsiasi fetch esterna (monouso ma comunque una credenziale).
export async function redeemPairParam(): Promise<void> {
  if (typeof location === 'undefined') return;
  const code = new URLSearchParams(location.search).get('pair');
  if (!code || !location.protocol.startsWith('http')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const res = await fetch(`${location.origin}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: deviceLabel(), code }),
    });
    const j = (await res.json().catch(() => null)) as { t?: unknown } | null;
    if (res.ok && typeof j?.t === 'string' && j.t) {
      saveRemoteConf(location.origin, j.t, 1, true);
      // DOPO saveRemoteConf: è lui a togliere il flag — il token riscattato
      // non è legato a un profilo, il gate deve mostrare "chi sei?".
      try { localStorage.setItem(PICK_PROFILE_KEY, '1'); } catch { /* */ }
    }
  } catch { /* PC perso: il gate mostra il pairing manuale */ }
}

// Converte il codice condiviso del PC (letto dal QR o digitato) in un token
// per QUESTO dispositivo: la credenziale admin non resta memorizzata sul
// telefono. Server pre-device (device:register → 404) → si tiene il codice,
// vale ancora il vecchio modello a profilo-dichiarato.
export async function upgradeToDeviceToken(base: string, token: string, name: string): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MH-Token': token },
      body: JSON.stringify({ c: IPC.deviceRegister, a: [name] }),
      signal: ac.signal,
    });
    const j = (await res.json().catch(() => null)) as { r?: { token?: unknown } } | null;
    return typeof j?.r?.token === 'string' && j.r.token ? j.r.token : token;
  } catch { return token; } finally { clearTimeout(t); }
}

// Lega il token del dispositivo al profilo scelto (device:claim), chiamata
// diretta: nei gate la conf non è ancora salvata.
// 'ok' = legato · 'legacy' = server pre-device (vale ancora X-MH-User) ·
// 'window' = serve la finestra «Accoppia telefono» aperta sul PC ·
// 'err' = PC perso / errore.
export async function claimOnBase(base: string, token: string, user: number): Promise<'ok' | 'legacy' | 'window' | 'err'> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MH-Token': token },
      body: JSON.stringify({ c: IPC.deviceClaim, a: [user] }),
      signal: ac.signal,
    });
    if (res.status === 404) return 'legacy';
    if (res.status === 403) return 'window';
    return res.ok ? 'ok' : 'err';
  } catch { return 'err'; } finally { clearTimeout(t); }
}

// Claim sulla conf salvata (cambio profilo a device già pairato).
export async function claimProfile(id: number): Promise<'ok' | 'legacy' | 'window' | 'err'> {
  if (!conf) return 'ok';
  try {
    await call(IPC.deviceClaim, id);
    return 'ok';
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'metodo sconosciuto') return 'legacy';
    if (/accoppia/i.test(m)) return 'window';
    return 'err';
  }
}

// Cambio profilo in attesa della finestra: riprova il claim ogni 3s finché
// chi è al PC preme «Accoppia telefono» — poi onOk completa lo switch.
let claimIv: ReturnType<typeof setInterval> | null = null;
export function watchClaimWindow(id: number, onOk: () => void): void {
  if (claimIv) clearInterval(claimIv);
  const deadline = Date.now() + 100_000; // un po' oltre i 90s della finestra
  claimIv = setInterval(() => {
    void claimProfile(id).then((r) => {
      if (r === 'ok' || r === 'legacy' || r === 'err' || Date.now() > deadline) {
        clearInterval(claimIv!); claimIv = null;
        if (r === 'ok' || r === 'legacy') onOk();
      }
    });
  }, 3000);
}

// Upgrade silenzioso a token per-dispositivo: le conf salvate col codice
// condiviso (QR aperto nel browser, pairing precedente ai device token) lo
// convertono al boot — la credenziale admin non deve restare sul telefono.
let upgrading = false;
export async function ensureDeviceToken(): Promise<void> {
  if (!conf || conf.devBound || upgrading) return;
  upgrading = true;
  try {
    const w = await call<{ admin?: boolean; user?: number | null }>(IPC.deviceWhoami);
    if (w.admin !== true) {
      // Server nuovo ma già device token (o server vecchio: whoami → errore
      // 'metodo sconosciuto' → catch, niente flag: si riprova al prossimo boot)
      if (w.admin === false) { conf = { ...conf, devBound: true }; persistConf(); }
      return;
    }
    const t = await upgradeToDeviceToken(conf.base, conf.token, deviceLabel());
    if (t !== conf.token) { conf = { ...conf, token: t, devBound: true }; persistConf(); }
  } catch { /* PC giù o server vecchio: si riprova al prossimo avvio */ }
  finally { upgrading = false; }
}

// Il token di QUESTO dispositivo è admin (codice condiviso) o device-bound?
// Pilota la UI: le azioni admin-only (rinomina/elimina profili, gestione
// dispositivi) si mostrano solo ad admin. Server vecchio → admin (com'era).
let adminCache: boolean | null = null;
export async function remoteIsAdmin(): Promise<boolean> {
  if (!isRemote() || !conf) return true; // desktop = sempre admin
  if (conf.devBound) return (adminCache = false);
  if (adminCache != null) return adminCache;
  try {
    const w = await call<{ admin?: boolean }>(IPC.deviceWhoami);
    adminCache = w?.admin !== false;
  } catch { adminCache = true; }
  return adminCache;
}

export async function requestPair(base: string, name: string, code?: string): Promise<{ token: string } | 'closed' | 'down'> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code }),
      signal: ac.signal,
    });
    if (res.status === 403 || res.status === 429) return 'closed';
    if (!res.ok) return 'down';
    const j = (await res.json().catch(() => null)) as { t?: unknown } | null;
    // Captive portal/altro server: 200 senza {t} non è nostro
    return typeof j?.t === 'string' && j.t ? { token: j.t } : 'down';
  } catch { return 'down'; } finally { clearTimeout(t); }
}

// Lista profili DURANTE il pairing: la conf non è ancora salvata — chiamata
// diretta con il token appena verificato. Serve alla scelta "chi sei?".
// null = irraggiungibile/risposta non nostra: il chiamante NON deve
// confonderlo con "server legacy senza profili" ([]) e azzerare il profilo.
export async function fetchProfiles(base: string, token: string): Promise<MhUser[] | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MH-Token': token },
      body: JSON.stringify({ c: IPC.usersList, a: [] }),
      signal: ac.signal,
    });
    const j = (await res.json().catch(() => ({}))) as { r?: MhUser[]; e?: string };
    // Anche gli errori del nostro server portano {e} — senza quella chiave
    // (portal, proxy, body non-JSON) la risposta non è nostra: fallimento.
    if (!('r' in j) && !('e' in j)) return null;
    if (!res.ok) return [];
    return Array.isArray(j.r) ? j.r : [];
  } catch { return null; } finally { clearTimeout(t); }
}

// media://audio/5 (Electron) ↔ remoto: /__pc/media/... se il SW proxy è
// attivo (token mai in URL), altrimenti ?token= (browser su http://LAN).
export function mediaUrl(kind: 'audio' | 'cover', id: number): string {
  if (!isRemote()) return `media://${kind}/${id}`;
  return swControlled()
    ? `/__pc/media/${kind}/${id}`
    : `${remoteBase()}/media/${kind}/${id}?token=${encodeURIComponent(remoteToken())}`;
}

// Il server risponde con URL media:// — li riscriviamo verso l'host remoto
// (copertine libreria ecc. arrivano già dentro i JSON)
function rewriteMedia(v: unknown): unknown {
  if (typeof v === 'string' && v.startsWith('media://') && conf) {
    return swControlled()
      ? `/__pc/${v.replace('media://', 'media/')}`
      : `${conf.base}/${v.replace('media://', 'media/')}?token=${encodeURIComponent(conf.token)}`;
  }
  if (Array.isArray(v)) return v.map(rewriteMedia);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = rewriteMedia(o[k]);
    return out;
  }
  return v;
}

// Timeout per-canale: il default di 10s decide "PC morto" (fail-fast + probe),
// ma i canali che sul PC fan-out verso YouTube/Deezer/Last.fm possono
// impiegare MOLTO di più su PC lento o rete congestionata — un timeout
// applicativo NON deve marcare offline (vedi catch: probe di verità prima).
const CALL_TIMEOUTS = new Map<string, number>([
  [IPC.assistant, 60_000],
  [IPC.recommend, 45_000], [IPC.station, 45_000], [IPC.stationNext, 45_000],
  [IPC.radio, 45_000], [IPC.autoplaylist, 45_000], [IPC.recOnboard, 45_000],
  [IPC.trends, 45_000], [IPC.trendsRefresh, 45_000], [IPC.spotifyImport, 45_000],
  [IPC.search, 40_000], // expand=true: sequenze di chiamate YT sul PC
  [IPC.searchPick, 30_000], [IPC.streamUrl, 30_000], [IPC.playStream, 30_000],
  [IPC.videoUrl, 30_000], [IPC.upNext, 30_000], [IPC.lyrics, 30_000],
  [IPC.charts, 30_000], [IPC.albumTracks, 30_000], [IPC.artistTop, 30_000],
  [IPC.artistPage, 30_000], [IPC.playlistTracks, 30_000], [IPC.loudness, 30_000],
  [IPC.testLastfm, 30_000],
]);
const CALL_TIMEOUT_DEFAULT = 10_000;

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!conf) throw new Error('non configurato');
  // Fail-fast quando il PC è già marcato offline: le operazioni non devono
  // attendere un TCP timeout per una chiamata destinata a fallire. La
  // riconnessione avviene via probe SSE (non passa da qui) + onReconnected.
  if (!isOnline()) throw new Error('offline');
  // Timeout deciso: un PC spento/irraggiungibile non deve tenere la fetch appesa
  // ~20-60s (TCP connect su mobile) — l'app si avviava lenta e la musica non
  // partiva. 10s di default coprono reti reali lente (Tailscale/4G); i canali
  // pesanti (search/rec/yt:*) hanno budget proprio in CALL_TIMEOUTS.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CALL_TIMEOUTS.get(channel) ?? CALL_TIMEOUT_DEFAULT);
  let res: Response;
  try {
    res = await fetch(`${conf.base}/api/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MH-Token': conf.token,
        // Profilo dichiarato: col codice condiviso (admin/legacy) il server
        // lo usa; con un device token è ignorato — vale il binding del token.
        'X-MH-User': String(conf.user ?? 1),
      },
      body: JSON.stringify({ c: channel, a: args }),
      signal: ac.signal,
    });
    // Il server risponde con il profilo REALMENTE legato al token. Se non
    // coincide con conf.user (binding riassegnato dal PC, o claim abortito)
    // allineiamo la conf e ricarichiamo: i dati serviti sono del bound user.
    const bound = Number(res.headers.get('x-mh-bound-user'));
    if (conf && bound > 0 && (conf.user ?? 1) !== bound) {
      setRemoteUser(bound);
      location.reload();
    }
  } catch (e) {
    clearTimeout(timer);
    // Timeout applicativo ≠ PC morto: è scattato il NOSTRO timer mentre la
    // richiesta era in volo, ma il server può essere solo lento. Prima di
    // marcare offline (fail-fast globale, ytCall→diretto, banner) un probe
    // /api/info decide: PC vivo → errore della singola chiamata, niente offline.
    if (ac.signal.aborted && conf && (await fetchInfo(conf.base)) !== null) {
      throw new Error('timeout: il PC non ha risposto in tempo');
    }
    // Rete assente (Wi-Fi spento, PC giù): segnala offline e calcia subito il
    // probe — altrimenti il fail-fast terrebbe l'app "offline" fino al prossimo
    // retry del SSE, che può arrivare dopo decine di secondi.
    setOnline(false);
    retryNow();
    throw e instanceof Error ? e : new Error(String(e));
  } finally { clearTimeout(timer); }
  const j = (await res.json().catch(() => ({}))) as { r?: T; e?: string };
  // Protocollo /api/call: il server risponde SEMPRE {r:…} o {e:…} — anche un
  // risultato undefined arriva come {r:null}, e ogni errore ha {e}. Una
  // risposta senza nessuna delle due chiavi NON è nostra (captive portal,
  // proxy, body vuoto/non-JSON): trattarla come successo o come auth-error
  // era distruttivo — risolveva `undefined` fingendo successo (cache
  // avvelenate con la stringa "undefined" → playlist/like "persi" offline;
  // prefs.set risolveva → dirty non marcato → il reconnect sovrascriveva la
  // modifica col valore vecchio del PC → preferenze "perse"; yt.search →
  // `undefined.songs` → toast di errore), e un 401 fasullo poteva perfino
  // azzerare il pairing. Va trattata come errore di RETE: offline + probe.
  if (!('r' in j) && !('e' in j)) {
    setOnline(false);
    retryNow();
    throw new Error('risposta non valida dal PC');
  }
  if (res.status === 401) {
    // Distingue "token non valido" (→ re-pairing completo) da "profilo non
    // valido" (→ scelta profilo: il pairing resta, non si butta il token).
    if (j.e === 'profilo non valido') { resetToProfilePick(); throw new Error('profilo non valido'); }
    resetToPairing();
    throw new Error('unauthorized');
  }
  setOnline(true); // risposta protocollo-valida: il PC c'è (anche se {e} errore)
  if (!res.ok) throw new Error(j.e || `HTTP ${res.status}`);
  return rewriteMedia(j.r) as T;
}

// Chiamata diretta al PC SENZA fallback local-first: la usa il drain delle
// code (un'op che fallisce per rete deve restare in coda, non ri-accodarsi
// sotto un nuovo id temporaneo fingendo successo).
export const callRemote = <T>(channel: string, ...args: unknown[]): Promise<T> => call<T>(channel, ...args);

// ---- Eventi main→renderer via SSE (stesso canale degli ipcRenderer.on) ----
let es: EventSource | null = null;
let esRetry = 0;
let esTimer: ReturnType<typeof setTimeout> | null = null;
const chanCbs = new Map<string, Set<(p: unknown) => void>>();

// Callback di riconnessione: scattano quando il telefono ritrova il PC
// (rientro in Wi-Fi, PC riacceso) — persist.ts ci aggancia il re-sync
const reconCbs = new Set<() => void>();
export function onReconnected(fn: () => void): () => void {
  reconCbs.add(fn);
  return () => reconCbs.delete(fn);
}

// ---- Stato connessione: banner "PC non raggiungibile" nel renderer ----
// Persistito tra sessioni: chi usa l'app lontano dal PC riparte direttamente
// in modalità autonoma invece di pagare la prima chiamata morta. Il probe
// all'avvio corregge subito se il PC è tornato raggiungibile.
let online = (() => {
  try { return localStorage.getItem('mh-was-online') !== '0'; } catch { return true; }
})();
const connCbs = new Set<(on: boolean) => void>();
// Su remoto senza pairing (standalone o conf mancante) il PC è irraggiungibile
// PER DEFINIZIONE: false → call() fail-fast, ytCall va diretto, cached() serve
// le copie locali. È lo stesso contratto di "PC spento", reso strutturale.
// Su DESKTOP (api in-process) il "backend" è il processo stesso → sempre true:
// un false qui spezzerebbe downloadToPhone (useremmo YouTube invece del file
// locale) e le cover media:// (righe store non gated da isRemote).
export const isOnline = (): boolean => (isRemote() ? online && !!conf : true);
export function onConnectivity(fn: (on: boolean) => void): () => void {
  connCbs.add(fn);
  return () => connCbs.delete(fn);
}
function setOnline(v: boolean): void {
  if (online === v) return;
  online = v;
  if (!v) sawOffline = true; // marca la caduta: il prossimo connect è una riconnessione
  try { localStorage.setItem('mh-was-online', v ? '1' : '0'); } catch { /* */ }
  for (const fn of connCbs) { try { fn(v); } catch { /* */ } }
}

// ---- Fallback autonomo + cache read-only ----
// ytCall: PC giù (rete o fetch fallita → online=false) → il telefono risolve
// da solo via YouTube diretto. Un errore APPLICATIVO del server (es. 500 su un
// videoId) NON scatta il fallback: verrebbe nascosto dal doppio tentativo.
async function ytCall<T>(remote: () => Promise<T>, direct: () => Promise<T>): Promise<T> {
  if (!isOnline()) return direct();
  try { return await remote(); }
  catch (e) { return isOnline() ? Promise.reject(e) : direct(); }
}

// cached: dati di sola lettura (playlist, like remoti) — offline serve l'ultima
// copia vista invece di fallire. Scritture e dati volatili non passano di qui.
function cacheGet<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) as T : null; }
  catch { return null; }
}
// Ogni dato fresco dal PC segna "quando": offline il banner mostra quanto è
// vecchia ciò che si vede ("dati di 3 ore fa") invece di un finto stato attuale.
const FRESH_KEY = () => `mh-cache-fresh:u${myUserId()}`;
export function markPcFresh(): void {
  try { localStorage.setItem(FRESH_KEY(), String(Date.now())); } catch { /* */ }
}
export function pcFreshAt(): number | null {
  try { const v = Number(localStorage.getItem(FRESH_KEY())); return Number.isFinite(v) && v > 0 ? v : null; }
  catch { return null; }
}
function cacheSet(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); markPcFresh(); } catch { /* */ }
}
async function cached<T>(key: string, remote: () => Promise<T>): Promise<T> {
  if (!isOnline()) {
    const c = cacheGet<T>(key);
    if (c != null) return c;
    throw new Error('offline — nessuna copia locale');
  }
  try {
    const r = await remote();
    // null/undefined non sono dati validi da conservare: sovrascriverebbero
    // (o avvelenerebbero, via JSON.stringify(undefined)→"undefined") la
    // copia buona — in quel caso si serve la copia precedente.
    if (r != null) { cacheSet(key, r); return r; }
    const stale = cacheGet<T>(key);
    if (stale != null) return stale;
    return r;
  } catch (e) {
    if (!isOnline()) {
      const c = cacheGet<T>(key);
      if (c != null) return c;
    }
    throw e;
  }
}

// Scrittura local-first: PC giù (o giù a metà chiamata) → azione locale in
// coda. Un errore APPLICATIVO a PC vivo resta un errore (mai nasconderlo).
async function localFirst<T>(remote: () => Promise<T>, local: () => Promise<T> | T): Promise<T> {
  if (!isOnline()) return local();
  try { return await remote(); }
  catch (e) { if (isOnline()) throw e; return local(); }
}
// Playlist con id temporaneo (creata offline, non ancora sul PC): ogni op resta
// locale anche a PC vivo — il drain la rimappa sull'id vero nell'ordine giusto.
function plOp<T>(plId: number, remote: () => Promise<T>, local: () => Promise<T> | T): Promise<T> {
  return plId < 0 ? Promise.resolve(local()) : localFirst(remote, local);
}
let plDrainT: ReturnType<typeof setTimeout> | undefined;
async function queuePl(op: import('./pendingSync').PendingPlOp['op'], args: unknown[]): Promise<void> {
  const ps = await import('./pendingSync');
  ps.queuePlOp(op, args);
  // PC vivo (op su playlist temporanea): consegna a breve, non al prossimo blackout
  if (isOnline()) { clearTimeout(plDrainT); plDrainT = setTimeout(() => { void ps.drainPending().catch(() => {}); }, 1500); }
}
// TrackRef "pulito" per la coda: niente url media del PC (scadono) né campi enormi
function stripRef(t: TrackRef): TrackRef {
  return {
    id: t.id != null && t.id > 0 ? t.id : undefined, videoId: t.videoId, title: t.title, artist: t.artist,
    album: t.album, durationS: t.durationS, source: t.source,
    thumbnail: t.thumbnail && !/\/media\/cover\//.test(t.thumbnail) ? t.thumbnail : (t.videoId && !t.videoId.includes(':') ? `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg` : undefined),
  };
}
// add per id di una riga "solo telefono": ricostruisce il TrackRef dall'indice
async function addRefLocal(plId: number, trackId: number): Promise<void> {
  const { phoneIndex } = await import('./phoneLocal');
  const meta = phoneIndex()[trackId];
  if (!meta?.videoId) throw new Error('brano non disponibile');
  await remoteApi.playlists.addRef(plId, meta);
}

function attachChannel(channel: string): void {
  if (!es) return;
  es.addEventListener(channel, (e) => {
    for (const fn of chanCbs.get(channel) ?? []) {
      try { fn(JSON.parse((e as MessageEvent).data)); } catch { /* */ }
    }
  });
}

// App in background/schermo spento: il probe continuo a PC morto brucia
// traffico e batteria su rete mobile per nulla — si sospende finché la pagina
// non torna visibile, poi riprova subito.
let waitVis = false;
function scheduleReconnect(): void {
  if (esTimer) return;
  const delay = Math.min(60_000, 2000 * 2 ** esRetry++);
  esTimer = setTimeout(() => {
    esTimer = null;
    if (typeof document !== 'undefined' && document.hidden) {
      if (!waitVis) {
        waitVis = true;
        const onVis = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVis);
          waitVis = false;
          ensureEvents();
        };
        document.addEventListener('visibilitychange', onVis);
      }
      return;
    }
    ensureEvents();
  }, delay);
}

// Su risposta HTTP d'errore EventSource va in CLOSED e NON riprova da solo:
// controlliamo se è il token (401 → pairing) o il server che torna (retry).
// Impara gli indirizzi alternativi del PC (LAN secondaria, Tailscale) dalla
// risposta di /api/info — così il telefono può raggiungerlo anche fuori casa.
function learnAlts(alts: unknown): void {
  if (!conf || !Array.isArray(alts)) return;
  const list = alts.filter((a): a is string => typeof a === 'string' && a.startsWith('http') && a !== conf!.base);
  if (!list.length) return;
  const same = conf.alts && list.length === conf.alts.length && list.every((a, i) => a === conf!.alts![i]);
  if (!same) {
    conf = { ...conf, alts: list };
    try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch { /* */ }
  }
}

// Feed pubblico degli aggiornamenti annunciato dal PC: memorizzato sul
// telefono → fuori casa (o dopo "senza PC") gli update arrivano lo stesso.
export const FEED_KEY = 'mh-update-feed';
function learnFeed(feed: unknown): void {
  try {
    if (typeof feed === 'string' && /^https?:\/\//.test(feed)) localStorage.setItem(FEED_KEY, feed);
    else if (feed === undefined || feed === null || feed === '') localStorage.removeItem(FEED_KEY);
  } catch { /* */ }
}

// {alts} = il PC vero; 'auth' = token rifiutato (401); null = irraggiungibile
// o risposta non nostra (captive portal, proxy: un 200 HTML non è il PC).
async function fetchInfo(base: string): Promise<{ alts?: unknown; updateFeed?: unknown } | 'auth' | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 5000);
  try {
    const res = await fetch(`${base}/api/info`, { headers: { 'X-MH-Token': conf!.token }, signal: ac.signal });
    if (res.status === 401) return 'auth';
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as { name?: unknown; alts?: unknown; updateFeed?: unknown } | null;
    return j?.name === 'MasterHype' ? j : null;
  } catch { return null; } finally { clearTimeout(t); }
}

// Riordino candidati: se il base è un indirizzo CGNAT (Tailscale 100.64/10 —
// lo si usa fuori casa) e un alternativo è LAN privata (rientro a casa), la
// LAN viene riprovata PRIMA del Tailscale → rielezione naturale della rotta
// migliore al prossimo probe, invece di restare "appiccicati" al Tailscale
// finché non cade.
const isLanAddr = (u: string) => /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u);
const isCgnatAddr = (u: string) => /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u);
function probeOrder(conf: RemoteConf): string[] {
  const alts = conf.alts ?? [];
  const raw = isCgnatAddr(conf.base)
    ? [...alts.filter(isLanAddr), conf.base, ...alts.filter((a) => !isLanAddr(a))]
    : [conf.base, ...alts];
  return [...new Set(raw)];
}

async function probeRemoteHealth(): Promise<void> {
  if (!conf) return;
  // NIENTE setOnline(false) durante i tentativi: nel giro (qualche secondo) il
  // banner offline lampeggerebbe — si marca offline solo se falliscono TUTTI.
  for (const addr of probeOrder(conf)) {
    const info = await fetchInfo(addr);
    if (info === 'auth') { resetToPairing(); return; }
    if (!info) continue;
    // Il primo che risponde diventa base; gli altri restano candidati (il
    // vecchio base incluso: se torna raggiungibile il failover lo riusa).
    if (addr !== conf.base) {
      const alts: string[] = [...new Set<string>([conf.base, ...(conf.alts ?? [])])].filter((a) => a !== addr);
      conf = { ...conf, base: addr, alts };
      try { localStorage.setItem(CONF_KEY, JSON.stringify(conf)); } catch { /* */ }
      if (es) { es.close(); es = null; } // es poteva restare CONNECTING sul base morto
    }
    setOnline(true);
    learnAlts(info.alts);
    learnFeed(info.updateFeed);
    openEvents();
    return;
  }
  // Nessun indirizzo raggiungibile: SOLO ORA siamo offline certi → backoff
  setOnline(false);
  scheduleReconnect();
}

// Retry immediato: bottone "Riprova" del banner e evento 'online' del browser
// (Android lo emette appena il Wi-Fi torna — niente attesa del backoff SSE)
export function retryNow(): void {
  if (!conf) return;
  if (esTimer) { clearTimeout(esTimer); esTimer = null; }
  // Un EventSource mezzo-morto in CONNECTING non deve bloccare il retry
  if (es && es.readyState !== EventSource.OPEN) { es.close(); es = null; }
  ensureEvents(); // probe-first: riprova base + alternativi con timeout
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', retryNow);
  window.addEventListener('offline', () => setOnline(false));
  // Handle diagnostico per gli audit CDP (come __app/__mhApi): stato
  // standalone/pairing leggibile e saveRemoteConf chiamabile dai test.
  (window as unknown as { __mhRemote: unknown }).__mhRemote = {
    isStandalone, isOnline, hasRemoteConf, resyncWhen, myUserId,
    saveRemoteConf, enterStandalone, exitStandalone, remoteBase,
  };
}

// Connessione SSE in due fasi: PRIMA il probe /api/info (timeout 5s), POI
// l'EventSource. Su host morto l'EventSource resterebbe in CONNECTING decine
// di secondi senza errori utili — il probe delimita il rilevamento offline.
let connecting = false;
function ensureEvents(): void {
  if (es || !conf || connecting) return;
  connecting = true;
  void probeRemoteHealth().finally(() => { connecting = false; });
}

// true se in questa sessione siamo stati offline almeno una volta (o abbiamo
// avviato offline): solo allora il connect SSE è una "riconnessione" che merita
// il reload — altrimenti al boot normale ricaricheremmo due volte per nulla.
let sawOffline = !online;
let esWatchdog: ReturnType<typeof setTimeout> | null = null;
function clearEsWatchdog(): void {
  if (esWatchdog) { clearTimeout(esWatchdog); esWatchdog = null; }
}
function openEvents(): void {
  if (es || !conf) return;
  // SW proxy → URL same-origin, il token va in header dal SW. Senza SW
  // (browser http://LAN) resta ?token= — comunque solo un device token.
  es = new EventSource(swControlled()
    ? '/__pc/api/events'
    : `${conf.base}/api/events?token=${encodeURIComponent(conf.token)}`);
  // Watchdog CONNECTING: un server che accetta il TCP ma non manda mai la
  // risposta (proxy, captive portal, VPN) lascia l'ES appeso SENZA errori —
  // l'app resterebbe "connessa a metà" per sempre. Dopo 8s → probe onesto.
  clearEsWatchdog();
  esWatchdog = setTimeout(() => {
    if (es && es.readyState !== EventSource.OPEN) {
      es.close(); es = null;
      scheduleReconnect(); // il probe decide online/offline e riprova gli alternativi
    }
  }, 8000);
  es.onopen = () => {
    clearEsWatchdog();
    const wasOffline = sawOffline;
    sawOffline = false;
    esRetry = 0;
    setOnline(true);
    void probeRemoteHealth(); // impara/aggiorna gli indirizzi alternativi
    // Reconnect vero (o boot partito offline → dati solo da cache): risincronizza
    if (wasOffline) for (const fn of reconCbs) { try { fn(); } catch { /* */ } }
  };
  // Riattacca TUTTI i canali sul nuovo EventSource: se es viene ricreato
  // dopo un errore, i listener non devono restare sul vecchio oggetto.
  for (const ch of chanCbs.keys()) attachChannel(ch);
  es.onerror = () => {
    // SSE morto ≠ API morta: reti mobili/proxy tagliano le connessioni lunghe
    // mentre /api/call funziona benissimo. Prima marcare offline faceva
    // "lampeggiare" lo stato e scattava il fail-fast sulle chiamate — ora si
    // riprova col backoff e il probe decide davvero online/offline (fetch
    // /api/info + alternativi), non il destino dell'EventSource.
    es?.close(); es = null;
    clearEsWatchdog();
    scheduleReconnect();
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- boundary: payload tipizzato lato api
const on = (channel: string) => (cb: (p: any) => void) => {
  let set = chanCbs.get(channel);
  if (!set) {
    set = new Set();
    chanCbs.set(channel, set);
    ensureEvents();
    if (es) attachChannel(channel);
  }
  set.add(cb);
  return () => { set.delete(cb); };
};

// ---- Preferenze condivise PC↔telefono ----
// La tabella prefs del DB è lo store unico: desktop e remoti scrivono lì
// (via api().prefs) e idratano le mh-pref-* da lì all'avvio. Vive in persist.ts.

// ---- Specchio di MasterHypeApi via HTTP ----
export const remoteApi: MasterHypeApi = {
  settings: {
    get: () => call(IPC.settingsGet),
    set: (p) => call(IPC.settingsSet, p),
    onEvent: on(IPC.settingsEvent),
  },
  yt: {
    // Modalità autonoma: PC giù + telefono online → YouTube diretto dal telefono.
    // isOnline()=false è marcato da call() su errore di RETE; un errore applicativo
    // del server (4xx/5xx) NON deve attivare il fallback.
    search: (q, expand) => ytCall(() => call(IPC.search, q, expand), () => directSearch(q, expand)),
    // Il PC vecchio può non avere il canale → 404 applicativo → []; il
    // diretto copre PC spento e server datati.
    suggest: (q) => ytCall(() => call<string[]>(IPC.searchSuggest, q), () => directSuggestions(q)).catch(() => []),
    streamUrl: (v) => ytCall(() => call(IPC.streamUrl, v), () => directStream(v)),
    playStream: (v, a, t) => ytCall(() => call(IPC.playStream, v, a, t), () => directPlayStream(v, a, t)),
    searchPick: (q, t) => call(IPC.searchPick, q, t), // logica del PC: serve il PC
    videoUrl: (v, maxH) => ytCall(() => call(IPC.videoUrl, v, maxH), () => directVideoUrl(v, maxH)),
    loudness: (v) => ytCall(() => call(IPC.loudness, v), () => Promise.resolve(null)),
    lyrics: (a, t, d) => ytCall(() => call(IPC.lyrics, a, t, d), () => directLyrics(a, t, d)),
    upNext: (v) => ytCall(() => call(IPC.upNext, v), () => directUpNext(v)),
    charts: (c) => ytCall(() => call(IPC.charts, c), () => directCharts()),
    albumTracks: (id) => ytCall(() => call(IPC.albumTracks, id), () => directAlbumTracks(id)),
    artistTop: (id) => ytCall(() => call(IPC.artistTop, id), () => directArtistTop(id)),
    artistPage: (id) => ytCall(() => call(IPC.artistPage, id), () => directArtistPage(id)),
    playlistTracks: (id) => ytCall(() => call(IPC.playlistTracks, id), () => directPlaylistTracks(id)),
  },
  downloads: {
    enqueue: (t) => call(IPC.downloadEnqueue, t),
    list: () => call(IPC.downloadList),
    retry: (id) => call(IPC.downloadRetry, id),
    dismiss: (id) => call(IPC.downloadDismiss, id),
    clearFinished: () => call(IPC.downloadClear),
    onEvent: on(IPC.downloadEvent),
  },
  library: {
    list: () => call(IPC.libraryList),
    remove: (id) => call(IPC.libraryRemove, id),
    restore: (id) => call(IPC.libraryRestore, id),
    // Letture "di profilo": ultima copia del PC, poi ricostruzione locale dai
    // segnali accodati (modalità senza PC: gusti e recenti evolvono lo stesso)
    stats: () => cached<AppStats>(`mh-stats-cache:u${myUserId()}`, () => call(IPC.libraryStats))
      .then(async (s) => (isOnline() ? s : (await import('./localData')).localStats(s)))
      .catch(async (e) => { if (isOnline()) throw e; return (await import('./localData')).localStats(null); }),
    like: (id, liked) => call(IPC.libraryLike, id, liked),
    play: (id) => call(IPC.libraryPlay, id),
    skip: (id) => call(IPC.librarySkip, id),
    importFiles: () => Promise.resolve(0), // niente file system del PC dal telefono
    recent: (l) => cached<TrackRef[]>(`mh-recent-cache:u${myUserId()}`, () => call(IPC.libraryRecent, l))
      .then(async (r) => {
        if (isOnline()) return r;
        // Offline: i play accodati sono i più recenti di tutti → in testa
        const local = (await import('./localData')).localRecent(l ?? 10);
        const seen = new Set(local.map((t) => t.videoId));
        return [...local, ...r.filter((t) => !seen.has(t.videoId))].slice(0, l ?? 10);
      })
      .catch(async (e) => { if (isOnline()) throw e; return (await import('./localData')).localRecent(l ?? 10); }),
    likeRemote: (t, liked) => call(IPC.libraryLikeRemote, t, liked),
    remoteLikes: () => cached(`mh-likes-cache:u${myUserId()}`, () => call(IPC.libraryRemoteLikes)),
    remoteEvent: (e) => call(IPC.libraryRemoteEvent, e),
    taste: async (k) => {
      try {
        const base = await cached<{ kind: string; value: string; weight: number }[]>(`mh-taste-cache:u${myUserId()}:${k ?? 'all'}`, () => call(IPC.libraryTaste, k));
        // Offline: ultima copia del PC + i segnali raccolti nel frattempo
        return isOnline() ? base : (await import('./localData')).mergeTaste(base, k);
      } catch (e) {
        if (isOnline()) throw e;
        const t = (await import('./localData')).localTaste(k);
        if (!t.length) throw e; // niente segnali: il chiamante usa il suo fallback
        return t;
      }
    },
    tasteReset: () => call(IPC.libraryTasteReset),
    listen: (r) => call(IPC.libraryListen, r),
    tasteSeed: (names) => call(IPC.libraryTasteSeed, names),
    onChanged: on(IPC.libraryChanged),
  },
  // Playlist LOCAL-FIRST: col PC giù (o senza PC) ogni modifica entra nella
  // coda pendingSync e la lista si materializza da cache + coda
  // (localData.overlayPlaylists) — la playlist esiste subito sul telefono,
  // come sul desktop, e il PC la riceve al primo drain. Online: il PC.
  playlists: {
    list: async () => {
      const key = `mh-pl-cache:u${myUserId()}`;
      try {
        // Overlay SEMPRE: le op ancora in coda non sono sul PC per definizione
        // (quelle drenate escono dalla coda) — anche a PC vivo, finché il
        // drain non le consegna, la lista deve mostrarle.
        const base = await cached<Playlist[]>(key, () => call(IPC.playlistList));
        return (await import('./localData')).overlayPlaylists(base);
      } catch (e) {
        if (isOnline()) throw e;
        return (await import('./localData')).overlayPlaylists(cacheGet<Playlist[]>(key));
      }
    },
    create: (n, k) => localFirst(() => call<Playlist>(IPC.playlistCreate, n, k), async () => {
      const { queuePlOp, newTempPlaylistId } = await import('./pendingSync');
      const id = newTempPlaylistId();
      queuePlOp('create', [n, k, id]);
      return { id, name: n, kind: k, createdAt: Date.now(), tracks: [] };
    }),
    remove: (id) => plOp(id, () => call<void>(IPC.playlistDelete, id), () => queuePl('remove', [id])),
    rename: (id, n) => plOp(id, () => call<void>(IPC.playlistRename, id, n), () => queuePl('rename', [id, n])),
    // Riga "solo telefono" (id ≤ 0): per id il PC non la conosce → addRef col videoId
    add: (p, t) => (t > 0
      ? plOp(p, () => call<void>(IPC.playlistAdd, p, t), () => queuePl('add', [p, t]))
      : addRefLocal(p, t)),
    addRef: (p, t) => plOp(p,
      () => call<{ added: boolean; queued: boolean }>(IPC.playlistAddRef, p, stripRef(t)),
      () => queuePl('addRef', [p, stripRef(t)]).then(() => ({ added: true, queued: false }))),
    // Riga con id ≤ 0 = aggiunta ancora in coda (non esiste sul PC): la si
    // toglie/sposta in coda — la compattazione annulla l'addRef.
    removeTrack: (p, t) => (t > 0
      ? plOp(p, () => call<void>(IPC.playlistRemove, p, t), () => queuePl('removeTrack', [p, t]))
      : queuePl('removeTrack', [p, t])),
    move: (p, t, d) => (t > 0
      ? plOp(p, () => call<void>(IPC.playlistMove, p, t, d), () => queuePl('move', [p, t, d]))
      : queuePl('move', [p, t, d])),
    // M3U sul TELEFONO (non nei Documenti del PC): link YouTube Music al posto
    // dei path Windows → la playlist è portabile in qualsiasi player/app.
    export: async (id) => {
      const pls = await remoteApi.playlists.list();
      const pl = pls.find((p) => p.id === id);
      if (!pl?.tracks?.length) return null;
      const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`];
      for (const t of pl.tracks) {
        if (!t.videoId || t.videoId.includes(':')) continue;
        lines.push(`#EXTINF:${Math.round(t.durationS ?? 0)},${t.artist} - ${t.title}`);
        lines.push(`https://music.youtube.com/watch?v=${t.videoId}`);
      }
      const { saveTextFile } = await import('./files');
      return saveTextFile(`${pl.name.replace(/[^\wàèéìòù -]/gi, '').trim() || 'playlist'}.m3u8`, lines.join('\r\n'), 'audio/x-mpegurl');
    },
  },
  rec: {
    suggest: () => call(IPC.recommend),
    assistant: (r) => call(IPC.assistant, r),
    station: (id) => call(IPC.station, id),
    radio: (k, v) => call(IPC.radio, k, v),
    // Continuazione radio taste-aware: col PC vivo la calcola il motore;
    // a PC spento il telefono replica il filtro gusti sui dati locali.
    next: (v, a, ctx) => ytCall(() => call(IPC.stationNext, v, a, ctx),
      async () => (await import('./offlineRec')).offlineContinue(v, a, ctx)),
    autoplaylist: (id) => call(IPC.autoplaylist, id),
    onboard: () => cached(`mh-onboard-cache`, () => call(IPC.recOnboard)),
    trends: () => call(IPC.trends),
    trendsRefresh: () => call(IPC.trendsRefresh),
  },
  burn: {
    // Il telefono pilota il masterizzatore attaccato al PC
    drives: () => call(IPC.burnDrives),
    start: (k, d, t, n) => call(IPC.burnStart, k, d, t, n),
    erase: (d, f) => call(IPC.burnErase, d, f),
    eject: (d) => call(IPC.burnEject, d),
    onEvent: on(IPC.burnEvent),
  },
  spotify: {
    auth: () => Promise.resolve(false), // OAuth apre il browser sul PC: solo desktop
    status: () => cached(`mh-spotify-cache`, () => call(IPC.spotifyStatus)),
    importTaste: () => call(IPC.spotifyImport),
  },
  lastfm: {
    test: (k) => call(IPC.testLastfm, k),
  },
  player: {
    onMediaKey: () => () => {}, // i tasti hardware del telefono sono gestiti dal sistema
    updateState: (s) => { void call(IPC.playerState, s).catch(() => {}); },
  },
  diag: {
    stats: () => cached(`mh-diag-cache`, () => call(IPC.issuesStats)),
    clear: () => call(IPC.issuesClear),
    // Report salvato sul TELEFONO (nei Documenti del PC non serviva a chi lo chiedeva)
    exportReport: async () => {
      const { saveTextFile } = await import('./files');
      const pc = await call<string>(IPC.issuesReportText).catch(() => '');
      const { runSelfTest } = await import('./selftest');
      const st = await runSelfTest().catch(() => null);
      const dev = st ? ['', '=== Dispositivo ===', ...st.rows.map((r) => `${r.ok === true ? 'OK ' : r.ok === false ? 'KO ' : '-- '}${r.name}: ${r.detail}`)].join('\n') : '';
      return saveTextFile('masterhype-report.txt', `${pc || `PC non raggiungibile (${pcGone()})`}\n${dev}`, 'text/plain');
    },
    reportText: () => call(IPC.issuesReportText),
    report: (k, d) => call(IPC.issuesReport, k, d),
    track: (n) => (isOnline() ? call<void>(IPC.uxTrack, n).catch(() => {}) : Promise.resolve()),
  },
  backup: {
    // File sul TELEFONO: profilo dal PC (se raggiungibile) + stato locale del
    // dispositivo — un solo file che ripristina tutto, anche senza PC.
    export: async () => {
      const { exportDeviceBackup } = await import('./localData');
      const profile = isOnline() ? await call<unknown>(IPC.backupData).catch(() => null) : null;
      const { saveTextFile } = await import('./files');
      const day = new Date().toISOString().slice(0, 10);
      return saveTextFile(`masterhype-backup-${day}.json`, JSON.stringify({ app: 'masterhype-bundle', version: 1, profile, device: exportDeviceBackup() }, null, 2), 'application/json');
    },
    import: async (data) => {
      if (data == null) return null;
      const b = data as { app?: string; profile?: unknown; device?: unknown };
      const profile = b.app === 'masterhype' ? data : b.app === 'masterhype-bundle' ? b.profile : null;
      const device = b.app === 'masterhype-device' ? data : b.app === 'masterhype-bundle' ? b.device : null;
      if (!profile && !device) throw new Error('File di backup non valido');
      const { importDeviceBackup } = await import('./localData');
      const nDev = device ? importDeviceBackup(device) : 0;
      if (profile) {
        if (!isOnline()) {
          if (!nDev) throw new Error(`il profilo si importa sul PC — ${pcGone()}`);
        } else {
          const r = await call<{ taste: number; likes: number; playlists: number }>(IPC.backupImport, profile);
          return { ...r, device: nDev };
        }
      }
      return { taste: 0, likes: 0, playlists: 0, device: nDev };
    },
    data: () => call(IPC.backupData),
  },
  sys: {
    openFolder: (p) => call(IPC.openFolder, p),
    pickFolder: () => Promise.resolve(null),
    pathForFile: () => '',
  },
  remote: {
    info: () => call(IPC.remoteInfo),
  },
  // Versione del PC e del suo auto-aggiornamento (sola lettura dal telefono:
  // l'installazione riavvia il PC-server → solo dal desktop, 403 da remoto)
  app: {
    info: () => cached<AppInfo>('mh-pcinfo-cache', () => call(IPC.appInfo)),
    updateStatus: () => call<AppUpdateState>(IPC.appUpdateStatus),
    updateCheck: () => call<AppUpdateState>(IPC.appUpdateCheck),
    updateInstall: () => Promise.reject(new Error('si installa dal PC')),
    onUpdateEvent: on(IPC.appUpdateEvent),
  },
  pairing: {
    // Admin-only da remoto: un device token non può aprire la finestra né
    // mintare codici QR (altrimenti il rebind non richiederebbe il PC).
    open: () => call(IPC.pairingOpen),
    status: () => call(IPC.pairingStatus),
    code: () => call<{ code: string; leftMs: number }>(IPC.pairingCode),
    onUsed: on(IPC.pairingUsed),
  },
  prefs: {
    getAll: () => call(IPC.prefsGet),
    set: (k, v) => call(IPC.prefsSet, k, v),
    onEvent: on(IPC.prefsEvent),
  },
  users: {
    // Il profilo del dispositivo remoto è il binding del suo token:
    // 'current' legge la conf locale; 'setCurrent' chiede al server il
    // claim/re-bind (un device già legato richiede la finestra «Accoppia
    // telefono» aperta sul PC — errore 'accoppia' → il chiamante guida l'attesa).
    list: () => call(IPC.usersList),
    create: (n) => call(IPC.usersCreate, n),
    rename: (id, n) => call(IPC.usersRename, id, n),
    remove: (id) => call(IPC.usersRemove, id),
    current: () => Promise.resolve(conf?.user ?? 1),
    setCurrent: async (id) => {
      const r = await claimProfile(id);
      if (r === 'window') throw new Error('accoppia');
      if (r === 'err') throw new Error('PC non raggiungibile');
      setRemoteUser(id);
      return id;
    },
  },
  // Gestione dispositivi pairati: dal PC è admin; da remoto con device token
  // questi canali rispondono 403 (la UI li usa solo sul desktop).
  devices: {
    list: () => call<MhDevice[]>(IPC.deviceList),
    revoke: (id) => call<void>(IPC.deviceRevoke, id),
    revokeAll: () => call<number>(IPC.deviceRevokeAll),
    setUser: (id, userId) => call<void>(IPC.deviceSetUser, id, userId),
  },
};
