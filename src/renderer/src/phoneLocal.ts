import type { LibraryTrack } from '../../shared/types';
import { myUserId, isRemote } from './remote';

// Musica scaricata SUL telefono: IndexedDB (funziona uguale in app Android e
// browser/PWA — niente plugin Capacitor da mantenere). Ogni record contiene il
// blob MP3 + la copertina + i metadati, così la libreria si renderizza anche
// completamente offline.
//
// Multi-utente: i BLOB restano condivisi (stesso file = stesso contenuto, e
// permette l'ascolto cross-profilo di tracce della libreria comune), ma
// l'INDICE dei metadati è per-profilo (`mh-phone-index:u<id>`): le righe
// "solo telefono" di un profilo non compaiono nella libreria dell'altro.

export interface PhoneEntry {
  id: number;            // id libreria PC, oppure id sintetico < 0 per brani solo-videoId
  meta: LibraryTrack;    // per renderizzare la riga senza server
  blob: Blob;            // mp3
  cover?: Blob;          // copertina
  size: number;
  addedAt: number;
  u?: number;            // profilo proprietario (assente = legacy: profilo corrente)
}

// Brani scaricati sul telefono senza passare dal PC (risultati di ricerca,
// like remoti…): non hanno un id libreria → id sintetico NEGATIVO stabile
// (FNV-1a del videoId) — mai in collisione con gli id SQLite (>0).
export function phoneVidId(videoId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < videoId.length; i++) {
    h ^= videoId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return -(Math.abs(h | 0) || 1);
}

const DB_NAME = 'mh-phone';
const STORE = 'tracks';
// Indice leggero dei metadati in localStorage: getAll() di IndexedDB
// materializza TUTTI i blob MP3 in RAM — inaccettabile solo per sapere
// gli id presenti. La verità resta il DB; l'indice è ricostruibile.
// Per-profilo: le mete "solo telefono" di un utente non si mostrano all'altro.
const INDEX_KEY = () => `mh-phone-index:u${myUserId()}`;
const LEGACY_INDEX_KEY = 'mh-phone-index';

// Migrazione: l'indice legacy non namespacizzato appartiene al profilo attuale
// (i device mono-profilo continuano a vedere i propri download).
try {
  const legacy = localStorage.getItem(LEGACY_INDEX_KEY);
  if (legacy != null) {
    if (localStorage.getItem(INDEX_KEY()) == null) localStorage.setItem(INDEX_KEY(), legacy);
    localStorage.removeItem(LEGACY_INDEX_KEY);
  }
} catch { /* */ }

export function phoneIndex(): Record<number, LibraryTrack> {
  try { return JSON.parse(localStorage.getItem(INDEX_KEY()) ?? '{}') as Record<number, LibraryTrack>; }
  catch { return {}; }
}
// localStorage non è transazionale col put IndexedDB: la garanzia di
// consistenza è il reconcile al boot (ripesca meta e `u` dal record), non
// questa scrittura. Il retry copre solo una quota localStorage transitoria.
function writeIndex(ix: Record<number, LibraryTrack>): boolean {
  try { localStorage.setItem(INDEX_KEY(), JSON.stringify(ix)); return true; }
  catch { return false; }
}
export function phoneIndexPut(id: number, meta: LibraryTrack): void {
  const ix = phoneIndex(); ix[id] = meta;
  if (!writeIndex(ix)) writeIndex(ix);
}
export function phoneIndexDel(id: number): void {
  const ix = phoneIndex(); if (ix[id] != null) { delete ix[id]; writeIndex(ix); }
}

// ---- LRU eviction: quota IndexedDB esaurita → si buttano i download più ---
// vecchi invece di fallire. Lista cross-profilo in localStorage (i blob sono
// condivisi, l'eviction pure): {id, addedAt, size}. Ricostruibile dal DB.
const LRU_KEY = 'mh-phone-lru';
interface LruEntry { id: number; addedAt: number; size: number }
function lruList(): LruEntry[] {
  try { const v = JSON.parse(localStorage.getItem(LRU_KEY) ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function lruWrite(list: LruEntry[]): void {
  try { localStorage.setItem(LRU_KEY, JSON.stringify(list)); } catch { /* */ }
}
function lruPut(id: number, addedAt: number, size: number): void {
  lruWrite([...lruList().filter((e) => e.id !== id), { id, addedAt, size }]);
}
function lruDel(id: number): void {
  lruWrite(lruList().filter((e) => e.id !== id));
}
// Libera spazio cancellando i download più vecchi (escluso `keepId` = quello
// che si sta scrivendo). Ritorna gli ID eliminati — il chiamante riprova il put
// e aggiorna store/indicatori (le entry legacy con size 0 liberano comunque).
export async function phoneEvictOldest(needBytes: number, keepId?: number): Promise<number[]> {
  const evicted: number[] = [];
  let freed = 0;
  for (const e of lruList().filter((x) => x.id !== keepId).sort((a, b) => a.addedAt - b.addedAt)) {
    if (evicted.length && freed >= needBytes) break;
    await phoneDel(e.id);
    phoneIndexDel(e.id);
    phoneInvalidate(e.id);
    freed += e.size || 0;
    evicted.push(e.id);
  }
  return evicted;
}

// Storage "persistente": senza navigator.storage.persist() i blob IDB e le
// code localStorage poggiano su storage best-effort — sotto pressione quota il
// browser può sfrattare TUTTA l'origine (download sul telefono compresi).
// Nell'APK la WebView è ragionevolmente stabile; il client browser (UI servita
// dal PC in un tab Chrome) è invece sfrattabile. Il browser decide da solo
// (engagement, spazio): a noi basta chiederlo una volta, al primo uso del DB.
let persistAsked = false;
function ensureStoragePersistence(): void {
  if (persistAsked || !isRemote()) return; // su desktop IDB non tiene nulla di critico
  persistAsked = true;
  try {
    void navigator.storage?.persist?.().then((granted) => {
      if (!granted) console.warn('[phoneLocal] storage persistente negato — i download possono essere sfrattati sotto pressione quota');
    }).catch(() => {});
  } catch { /* api assente */ }
}

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  ensureStoragePersistence();
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    t.onerror = () => rej(t.error);
  });
}

// Solo le chiavi: NON caricare i blob (getAll li metterebbe tutti in RAM).
export const phoneKeys = (): Promise<number[]> =>
  tx('readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>)
    .then((ks) => ks.map(Number).filter((n) => Number.isFinite(n)))
    .catch(() => [] as number[]);

// Riconcilia indice↔DB all'avvio: l'IDB fa fede (scritture localStorage non
// atomiche rispetto al put); le meta mancanti si recuperano dai record —
// ma SOLO per i record del profilo corrente (e.u assente = legacy → corrente).
export async function phoneReconcile(): Promise<{ ids: number[]; metas: Record<number, LibraryTrack> }> {
  const ids = await phoneKeys();
  const ix = phoneIndex();
  const metas: Record<number, LibraryTrack> = {};
  for (const id of ids) {
    if (ix[id]) { metas[id] = ix[id]; continue; }
    const e = await phoneGet(id); // record completo (raro: solo se indice perso)
    if (e && (e.u == null || e.u === myUserId())) { metas[id] = e.meta; phoneIndexPut(id, e.meta); }
  }
  const cur = phoneIndex();
  let dirty = false;
  for (const k of Object.keys(cur)) if (!ids.includes(Number(k))) { delete cur[Number(k)]; dirty = true; }
  if (dirty) writeIndex(cur);
  // lru coerente col DB: drop degli id spariti + seed dei record legacy (mai
  // passati da phonePut dopo questa feature → addedAt 0 = più vecchi di tutti,
  // primi candidati a eviction; size 0 — non leggiamo i record per saperla).
  const lru = lruList().filter((e) => ids.includes(e.id));
  for (const id of ids) if (!lru.some((e) => e.id === id)) lru.push({ id, addedAt: 0, size: 0 });
  lruWrite(lru);
  return { ids, metas };
}

export const phoneHas = (id: number): Promise<boolean> =>
  tx('readonly', (s) => s.getKey(id)).then((k) => k != null).catch(() => false);

export const phonePut = (e: PhoneEntry): Promise<unknown> =>
  // Il proprietario va scritto SUL record: senza `u` la entry è "legacy" e al
  // reconcile ricadrebbe nel profilo attivo di turno (leak multi-utente).
  tx('readwrite', (s) => s.put({ ...e, u: e.u ?? myUserId() }))
    .then((r) => { lruPut(e.id, e.addedAt, e.size); return r; });

export const phoneDel = (id: number): Promise<unknown> =>
  tx('readwrite', (s) => s.delete(id)).then((r) => { lruDel(id); return r; });

export const phoneGet = (id: number): Promise<PhoneEntry | undefined> =>
  tx('readonly', (s) => s.get(id) as IDBRequest<PhoneEntry | undefined>).catch(() => undefined);

// Migrazione standalone→profilo reale: l'indice localStorage è stato
// rinominato :u1→:u<to> ma i record IDB portano ancora u=1 — senza questa
// passata un login successivo col profilo 1 li "riconquisterebbe" da legacy
// al reconcile (riapparirebbero sotto l'utente sbagliato).
export async function phoneReassignUser(from: number, to: number): Promise<void> {
  try {
    for (const id of await phoneKeys()) {
      const e = await phoneGet(id);
      if (e && e.u === from) await phonePut({ ...e, u: to });
    }
  } catch { /* best-effort: i blob restano comunque suonabili */ }
}

// Object URL cache: evita di rigonfiare blob da IndexedDB a ogni play
const urlCache = new Map<string, string>();

export function phoneInvalidate(id: number): void {
  for (const k of [`a${id}`, `c${id}`]) {
    const u = urlCache.get(k);
    if (u) { URL.revokeObjectURL(u); urlCache.delete(k); }
  }
}

// Migrazione id sintetico→id reale: un brano scaricato sul telefono con id
// videoId (<0) che poi entra in libreria sul PC (id>0) deve seguire l'id reale —
// altrimenti il badge "sul telefono" si spegne e l'utente riscarica il file.
// Se l'id di destinazione esiste già (doppio download) → dedup: il vecchio sparisce.
export async function phoneMigrateId(from: number, to: number): Promise<boolean> {
  if (!(from < 0) || !(to > 0) || from === to) return false;
  const e = await phoneGet(from);
  if (!e) return false;
  if (!(await phoneHas(to))) {
    await phonePut({ ...e, id: to, u: e.u ?? myUserId(), meta: { ...e.meta, id: to } });
  }
  await phoneDel(from);
  const ix = phoneIndex();
  if (ix[from] != null) {
    if (ix[to] == null) ix[to] = { ...ix[from], id: to };
    delete ix[from];
    writeIndex(ix);
  }
  phoneInvalidate(from);
  phoneInvalidate(to);
  return true;
}

// <audio> demuxa i file frammentati (DASH/fMP4 — oggi l'audio mp4 di YouTube
// arriva così) SOLO via HTTP(S): da blob: dà MEDIA_ELEMENT_SRC_NOT_SUPPORTED
// e nemmeno MediaSource lo accetta su WebView. Il service worker serve i blob
// di IndexedDB su /__phone/<id> con Range → identico a uno stream remoto.
let swReady: Promise<boolean> | null = null;
let swLastFail = 0;
function phoneSw(): Promise<boolean> {
  // Fallimento (rete giù, SW in aggiornamento): si ritenta — un errore
  // transitorio non deve spegnere il playback locale per tutta la sessione.
  // Cooldown 15s: i retry non devono martellare register() a ogni play.
  if (!swReady && Date.now() - swLastFail < 15_000) return Promise.resolve(false);
  swReady ??= (async () => {
    try {
      if (!('serviceWorker' in navigator)) return false;
      await navigator.serviceWorker.register('/sw.js');
      await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 4000))]);
      // Il worker attivo non basta: serve il controllo della pagina (claim())
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => {
          navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
          setTimeout(r, 2000);
        });
      }
      return !!navigator.serviceWorker.controller;
    } catch { return false; }
  })().then((ok) => {
    if (!ok) { swLastFail = Date.now(); swReady = null; }
    return ok;
  });
  return swReady;
}

export async function phoneAudioUrl(id: number): Promise<string | null> {
  const key = `a${id}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const e = await phoneGet(id);
  if (!e) return null;
  const u = (await phoneSw()) ? `__phone/${id}` : URL.createObjectURL(e.blob);
  urlCache.set(key, u);
  return u;
}
export async function phoneCoverUrl(id: number): Promise<string | null> {
  const key = `c${id}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const e = await phoneGet(id);
  if (!e?.cover) return null;
  const u = URL.createObjectURL(e.cover);
  urlCache.set(key, u);
  return u;
}

// Risoluzione unificata per una traccia qualsiasi: prima l'id libreria,
// poi l'id sintetico del videoId. Una get IndexedDB è economica e gli URL
// sono in cache — chiamabile a ogni play senza race con l'init.
export async function phoneAudioUrlFor(t: { id?: number | null; videoId?: string }): Promise<string | null> {
  if (t.id != null) {
    const u = await phoneAudioUrl(t.id);
    if (u) return u;
  }
  if (t.videoId) {
    const u = await phoneAudioUrl(phoneVidId(t.videoId));
    if (u) return u;
  }
  return null;
}

// Stima spazio: IndexedDB in genere condivide la quota origine con il resto
export async function phoneFreeMB(): Promise<number | null> {
  try {
    const est = await navigator.storage.estimate();
    if (est.quota == null || est.usage == null) return null;
    return Math.max(0, Math.round((est.quota - est.usage) / 1e6));
  } catch { return null; }
}
