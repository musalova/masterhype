import { useEffect, useState } from 'react';
import { api } from './api';
import { onReconnected, myUserId } from './remote';

// Preferenze: DEFAULT = DISPOSITIVO, condivise = whitelist.
// Ogni chiave 'mh-pref-*' sta in localStorage (lettura sincrona all'avvio) e
// basta — schermata, coda player, tema, ordinamenti, opzioni, shuffle… sono
// scelte di QUESTO apparecchio: un set fatto sul PC non deve mai riscrivere
// quelle del telefono (era il bug "il telefono perde tutte le preferenze").
// Sincronizzano col DB del PC SOLO le chiavi in SHARED_PREF_KEYS — oggi una
// sola, la tracklist CD: è un artefatto di lavoro comune (il masterizzatore
// è sul PC), non una preferenza. Per quelle vale il vecchio modello:
// scrittura locale + push (dirty se fallisce) e hydrate/broadcast live.
// 'mh-device-*' restano mai-sincronizzate per definizione (volume/muto:
// uno "0" scritto dal PC lasciava il telefono silenzioso irrimediabilmente).
export const SHARED_PREF_KEYS: ReadonlySet<string> = new Set(['mh-pref-cdqueue']);

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    if (s == null) return fallback;
    // 'null' letterale (chiave corrotta o vecchio savePref(null)) non è un
    // valore di pref valido: JSON.parse lo restituirebbe e i consumer
    // crasherebbero leggendo proprietà (mh-pref-player.shuffle → boot rotto)
    // o peggio (mh-pref-volume → Number(null)=0 → dispositivo muto).
    const v = JSON.parse(s) as T | null;
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// ---- Chiavi "sporche": modificate mentre il PC era irraggiungibile ----
// Persistono in localStorage: un riavvio offline non le perde. Al primo
// contatto col PC vengono spinte (poi l'hydrate riempie il resto).
// Multi-utente: la lista è namespacizzata per profilo — le scritture
// offline del profilo A non devono finire nel namespace del profilo B.
const DIRTY_KEY = () => `mh-pref-dirty:u${myUserId()}`;
const dirtySet = (): Set<string> => {
  try { return new Set(JSON.parse(localStorage.getItem(DIRTY_KEY()) ?? '[]') as string[]); }
  catch { return new Set(); }
};
const saveDirty = (s: Set<string>) => {
  try { localStorage.setItem(DIRTY_KEY(), JSON.stringify([...s])); } catch { /* */ }
};
const markDirty = (k: string) => { const d = dirtySet(); if (!d.has(k)) { d.add(k); saveDirty(d); } };
const clearDirty = (k: string) => { const d = dirtySet(); if (d.delete(k)) saveDirty(d); };

// Migrazione: la dirty list legacy (senza utente) appartiene al profilo attuale
try {
  const legacy = localStorage.getItem('mh-pref-dirty');
  if (legacy != null) {
    if (localStorage.getItem(DIRTY_KEY()) == null) localStorage.setItem(DIRTY_KEY(), legacy);
    localStorage.removeItem('mh-pref-dirty');
  }
} catch { /* */ }

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Anche la scrittura LOCALE notifica i consumer della stessa chiave:
    // due componenti montati su 'mh-pref-x' restano allineati subito, senza
    // attendere l'eco del server (che a PC spento non arriverebbe mai).
    // In microtask: savePref può girare dentro un updater setState di React —
    // un setState sincrono di ALTRI componenti durante il render è vietato.
    if (typeof window !== 'undefined')
      queueMicrotask(() => window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: key })));
  } catch { /* quota */ }
  // Chiave del dispositivo: finisce qui — niente push, niente dirty, niente
  // hydrate che la possa sovrascrivere. Solo la whitelist viaggia col PC.
  if (!SHARED_PREF_KEYS.has(key)) return;
  // Pubblica nello store condiviso (DB del PC). Se fallisce — telefono
  // offline o PC spento — la chiave resta "sporca" e riparte al reconnect.
  void api().prefs.set(key, value)
    .then(() => clearDirty(key))
    // Dirty anche su desktop: se la scrittura nel DB fallisce (DB locked,
    // disco pieno) la chiave locale divergerebbe dallo store condiviso e
    // l'hydrate al prossimo avvio la perderebbe — col flag riparte la push.
    .catch(() => markDirty(key));
}

// Applicazione live: una chiave arrivata dal DB condiviso (evento broadcast
// o hydrate) aggiorna localStorage E lo stato React in esecuzione.
const LIVE_EVENT = 'mh-pref-live';
function applyShared(key: string, value: unknown): void {
  try {
    const next = JSON.stringify(value);
    if (localStorage.getItem(key) === next) return; // stessa scrittura: niente loop
    localStorage.setItem(key, next);
    window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: key }));
  } catch { /* */ }
}

// Sincronizzazione bidirezionale:
// 1) spinge le chiavi sporche (modifiche fatte offline da questo dispositivo)
// 2) idrata dal PC tutte le altre mh-pref-* (modifiche fatte dall'altro lato)
let syncing = false, syncAgain = false;
export async function syncPrefs(): Promise<void> {
  // Boot + reconnect possono invocarla insieme: senza guard due sync
  // interleaved potrebbero pushare/hydratare la stessa chiave in ordine
  // sbagliato. Se è già in corso, accodiamo una sola riesecuzione.
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try { await syncPrefsBody(); } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; void syncPrefs(); }
  }
}
// Valori "sporchi" archiviati: prima del cambio profilo, le scritture non
// ancora arrivate al PC vengono parcheggiate sotto 'mh-dval:u<uid>:<key>'.
// Al prossimo login di QUEL profilo tornano nelle chiavi logiche e nella
// dirty list → vengono spinte al PC come se nulla fosse successo.
const DVAL_PFX = (uid: number) => `mh-dval:u${uid}:`;
export function archiveDirtyValues(): void {
  try {
    for (const k of dirtySet()) {
      const v = localStorage.getItem(k);
      if (v != null) localStorage.setItem(DVAL_PFX(myUserId()) + k, v);
    }
  } catch { /* */ }
}
function restoreArchivedValues(): void {
  try {
    const pfx = DVAL_PFX(myUserId());
    for (const dk of Object.keys(localStorage)) {
      if (!dk.startsWith(pfx)) continue;
      const k = dk.slice(pfx.length);
      const v = localStorage.getItem(dk);
      if (v != null && localStorage.getItem(k) == null) localStorage.setItem(k, v);
      localStorage.removeItem(dk);
    }
  } catch { /* */ }
}

// Spinge al PC le chiavi modificate offline da questo profilo/dispositivo.
// Esportata: il cambio profilo la usa come flush "best effort" prima di
// archiviare ciò che non è riuscito a partire.
export async function pushDirty(): Promise<void> {
  for (const k of dirtySet()) {
    // Chiavi non condivise rimaste dirty da versioni precedenti: il flag si
    // consuma senza push — scriverle e poi cancellarle via sweep è un giro
    // inutile, e sul PC non devono comunque più stare.
    if (!SHARED_PREF_KEYS.has(k)) { clearDirty(k); continue; }
    const raw = localStorage.getItem(k);
    if (raw == null) { clearDirty(k); continue; }
    try {
      await api().prefs.set(k, JSON.parse(raw));
      clearDirty(k);
    } catch { /* una chiave fallita resta dirty e non affama le altre: a PC morto call() fail-fasta subito, iterare è gratuito */ }
  }
}

async function syncPrefsBody(): Promise<void> {
  restoreArchivedValues(); // un cambio profilo offline non deve perdere modifiche
  await pushDirty();
  try {
    const all = await api().prefs.getAll();
    for (const [k, v] of Object.entries(all ?? {})) {
      if (!k.startsWith('mh-pref-')) continue;
      if (!SHARED_PREF_KEYS.has(k)) {
        // Copia stale di una chiave ora per-dispositivo (scritta da una
        // versione vecchia): la cancelliamo dal PC — non è più roba sua.
        // set(k,null)=DELETE; l'evento broadcast è filtrato dalla whitelist.
        void api().prefs.set(k, null).catch(() => {});
        continue;
      }
      // Il dirty check va fatto AL MOMENTO dell'apply, non su uno snapshot
      // preso prima del getAll: una savePref offline fallita durante l'attesa
      // della risposta si è marcata dirty nel frattempo — sovrascriverla col
      // valore vecchio del PC la perderebbe (il flag resta ma punta al valore
      // già clobberato). dirtySet() rilegge localStorage a ogni chiave.
      if (!dirtySet().has(k)) applyShared(k, v);
    }
  } catch { /* store condiviso non raggiungibile: restano le pref locali */ }
}

// Rinomina chiavi legacy → mh-pref-* mantenendo i valori salvati.
export function migratePrefs(map: Record<string, string>): void {
  for (const [from, to] of Object.entries(map)) {
    try {
      const v = localStorage.getItem(from);
      if (v != null && localStorage.getItem(to) == null) localStorage.setItem(to, v);
      if (v != null) localStorage.removeItem(from);
    } catch { /* */ }
  }
}

// Quando il telefono ritrova il PC (rientro in Wi-Fi, PC riacceso): re-sync.
onReconnected(() => { void syncPrefs(); });

// Broadcast live: un set fatto dall'altro dispositivo arriva qui in tempo
// reale (es. il telefono riordina il CD → il PC vede subito la nuova scaletta).
// Solo chiavi della whitelist: una pref dell'altro device non ci riguarda.
// Il payload porta `u`: i set di ALTRI profili vengono ignorati — due utenti
// sullo stesso PC non si mescolano le preferenze.
api().prefs.onEvent((p) => {
  if (p && typeof p.k === 'string' && SHARED_PREF_KEYS.has(p.k) && (p.u == null || p.u === myUserId()))
    applyShared(p.k, p.v);
});

// Cambio profilo: svuota la vista locale delle chiavi CONDIVISE — hydrate
// riempirà quelle del nuovo profilo. Le pref del dispositivo sopravvivono
// (sono dell'apparecchio, non del profilo). Le code dirty namespacizzate
// ('mh-pref-dirty:u*') restano: contengono scritture offline di ALTRI profili.
export function clearLocalPrefs(): void {
  try {
    for (const k of Object.keys(localStorage))
      if (SHARED_PREF_KEYS.has(k)) localStorage.removeItem(k);
  } catch { /* */ }
}

// Come useState ma scrive/legge localStorage: la preferenza resta salvata.
// Se la chiave è nella whitelist condivisa si sincronizza anche col PC.
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => loadPref(key, initial));
  // Cambi sulla stessa chiave → rileggo (scrittura locale, o sync se condivisa)
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setV(loadPref(key, initial));
    };
    window.addEventListener(LIVE_EVENT, h);
    return () => window.removeEventListener(LIVE_EVENT, h);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (nv: T | ((p: T) => T)) =>
    setV((p) => {
      const x = typeof nv === 'function' ? (nv as (p: T) => T)(p) : nv;
      savePref(key, x);
      return x;
    });
  return [v, set];
}

// ---- Chiavi 'mh-device-*': stato del DISPOSITIVO, mai sincronizzato ----
// Volume e muto appartengono all'apparecchio che suona, non al profilo
// (modello Spotify). In pratica una mh-pref-* non condivisa si comporta
// allo stesso modo; 'mh-device-*' resta il prefisso esplicito per lo stato
// hardware — il server prefs rifiuterebbe comunque chiavi fuori 'mh-pref-*'.
// LIVE_EVENT resta: allinea i consumer della STESSA chiave sullo
// stesso dispositivo (slider in NowPlaying ↔ elementi <audio> in PlayerBar).
export function saveDevice(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (typeof window !== 'undefined')
      queueMicrotask(() => window.dispatchEvent(new CustomEvent(LIVE_EVENT, { detail: key })));
  } catch { /* quota */ }
}

// Come usePersistedState ma esplicito per le chiavi 'mh-device-*':
// localStorage e basta — nessun push al PC, nessuna hydrate che le sovrascriva.
export function useDeviceState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => loadPref(key, initial));
  useEffect(() => {
    const h = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setV(loadPref(key, initial));
    };
    window.addEventListener(LIVE_EVENT, h);
    return () => window.removeEventListener(LIVE_EVENT, h);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (nv: T | ((p: T) => T)) =>
    setV((p) => {
      const x = typeof nv === 'function' ? (nv as (p: T) => T)(p) : nv;
      saveDevice(key, x);
      return x;
    });
  return [v, set];
}
