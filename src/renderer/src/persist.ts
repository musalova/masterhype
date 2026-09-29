import { useEffect, useState } from 'react';
import { api } from './api';
import { onReconnected, myUserId } from './remote';

// Preferenze condivise PC↔telefono: la tabella prefs del DB è lo store unico.
// Ogni scrittura va in localStorage (lettura sincrona all'avvio) E nel DB
// condiviso — desktop via IPC, telefono via HTTP. All'avvio e a ogni
// riconnessione syncPrefs riporta le mh-pref-* dal DB nel localStorage.
//
// Condivise: volume, shuffle/repeat, crossfade, schermata, ordinamenti,
// code (player e CD Builder), opzioni assistente/CD…  — chiavi 'mh-pref-*'.

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s != null ? (JSON.parse(s) as T) : fallback;
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
      // Il dirty check va fatto AL MOMENTO dell'apply, non su uno snapshot
      // preso prima del getAll: una savePref offline fallita durante l'attesa
      // della risposta si è marcata dirty nel frattempo — sovrascriverla col
      // valore vecchio del PC la perderebbe (il flag resta ma punta al valore
      // già clobberato). dirtySet() rilegge localStorage a ogni chiave.
      if (k.startsWith('mh-pref-') && !dirtySet().has(k)) applyShared(k, v);
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
// Il payload porta `u`: i set di ALTRI profili vengono ignorati — due utenti
// sullo stesso PC non si mescolano le preferenze.
api().prefs.onEvent((p) => {
  if (p && typeof p.k === 'string' && p.k.startsWith('mh-pref-') && (p.u == null || p.u === myUserId()))
    applyShared(p.k, p.v);
});

// Cambio profilo: svuota la vista locale delle mh-pref-* — hydrate riempirà
// quelle del nuovo profilo. Le code dirty namespacizzate ('mh-pref-dirty:u*')
// restano: contengono scritture offline degli ALTRI profili.
export function clearLocalPrefs(): void {
  try {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('mh-pref-') && !k.startsWith('mh-pref-dirty')) localStorage.removeItem(k);
  } catch { /* */ }
}

// Come useState ma scrive/legge localStorage: la preferenza resta salvata
// e (essendo 'mh-pref-*') si sincronizza sullo store condiviso.
export function usePersistedState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [v, setV] = useState<T>(() => loadPref(key, initial));
  // Cambi arrivati dall'altro dispositivo → rileggo la chiave
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
