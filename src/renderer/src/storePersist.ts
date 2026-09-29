// Persistenza dello store: chiavi mh-pref-* condivise PC↔telefono e chiavi
// locali per-utente. Estratto da store.ts — funzioni pure, niente stato zustand.
import type { LibraryTrack } from '../../shared/types';
import { myUserId } from './remote';
import { loadPref, savePref } from './persist';

// Chiavi 'mh-pref-*': si sincronizzano sullo store condiviso PC↔telefono
export const CD_KEY = 'mh-pref-cdqueue';
// Download avviati "per il CD" ancora in corso: persistiti (chiave locale, non
// condivisa) così un riavvio dell'app non perde l'aggiunta automatica.
// Per-utente: un'aggiunta avviata dal profilo A non deve finire nel CD del B.
const PENDING_CD_KEY = () => `mh-cd-pending:u${myUserId()}`;
const loadPendingCd = (): Set<string> => {
  try {
    const legacy = localStorage.getItem('mh-cd-pending'); // migrazione → profilo corrente
    if (legacy != null && localStorage.getItem(PENDING_CD_KEY()) == null)
      localStorage.setItem(PENDING_CD_KEY(), legacy);
    if (legacy != null) localStorage.removeItem('mh-cd-pending');
    return new Set(JSON.parse(localStorage.getItem(PENDING_CD_KEY()) ?? '[]') as string[]);
  }
  catch { return new Set(); }
};
const savePendingCd = (s: Set<string>) => {
  try { localStorage.setItem(PENDING_CD_KEY(), JSON.stringify([...s])); } catch { /* quota */ }
};
export class PendingCdSet extends Set<string> {
  add(v: string): this { super.add(v); savePendingCd(this); return this; }
  delete(v: string): boolean { const r = super.delete(v); savePendingCd(this); return r; }
  clear(): void { super.clear(); savePendingCd(this); }
}
export const loadPendingCdSet = (): PendingCdSet => {
  const s = new PendingCdSet();
  for (const v of loadPendingCd()) Set.prototype.add.call(s, v); // senza trigger di savePendingCd
  return s;
};

export const VOL_KEY = 'mh-pref-volume';
export const persistCd = (q: LibraryTrack[]) => savePref(CD_KEY, q.map((t) => t.id));
export const savedVolume = () => loadPref<number>(VOL_KEY, 0.8);
export const XF_KEY = 'mh-pref-crossfade';
// Tollera i formati storici: '0' grezzo (legacy), '"0"', false, 0
export const savedXf = () => { const v = loadPref<unknown>(XF_KEY, true); return v !== false && v !== 0 && v !== '0'; };
export const PREF_KEY = 'mh-pref-player';

export type Screen = 'home' | 'stations' | 'search' | 'library' | 'playlists' | 'cd' | 'trends' | 'assistant' | 'downloads' | 'settings';
export interface PlayerPrefs {
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  radio: boolean; // a fine coda continua con brani simili (upNext)
}

// Autoplay stile Spotify: a fine coda la radio continua con brani simili.
// Default ON (come "Autoplay similar content" di Spotify); la scelta persiste.
export const savedPrefs = (): PlayerPrefs => {
  const p = loadPref<{ shuffle?: boolean; repeat?: string; radio?: boolean }>(PREF_KEY, {});
  return { shuffle: !!p.shuffle, repeat: p.repeat === 'all' || p.repeat === 'one' ? p.repeat : 'off', radio: p.radio ?? true };
};
export const savePrefs = (p: { shuffle: boolean; repeat: string; radio: boolean }) =>
  savePref(PREF_KEY, { shuffle: p.shuffle, repeat: p.repeat, radio: p.radio });
export const QUEUE_KEY = 'mh-pref-queue';
export const SCREEN_KEY = 'mh-pref-screen';
export const SCREENS: Screen[] = ['home', 'stations', 'search', 'library', 'playlists', 'cd', 'trends', 'assistant', 'downloads', 'settings'];
// Riapre l'app sull'ultima schermata visitata (preferenza persistente)
export const savedScreen = (): Screen => {
  const s = loadPref<Screen>(SCREEN_KEY, 'home');
  return SCREENS.includes(s) ? s : 'home';
};
