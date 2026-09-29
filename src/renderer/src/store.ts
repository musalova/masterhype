import { create } from 'zustand';
import type { TrackRef, LibraryTrack, DownloadJob, BurnProgress, Settings, SuggestedTrack, RemoteLike, MhUser } from '../../shared/types';
import { api, isRemote, mediaUrl } from './api';
import { isOnline, myUserId, setLocalUserId, resyncWhen, isStandalone, remoteBase, remoteToken, claimProfile, watchClaimWindow, markPcFresh } from './remote';
import { loadPref, savePref, migratePrefs, syncPrefs, clearLocalPrefs, pushDirty, archiveDirtyValues } from './persist';
import { queueRemoteLike, queueLibLike, queueEvent, queueSearchPick, queueListen, queueDownload, pendingLikesMap, pendingLikeEntries } from './pendingSync';
import { cachedAuto, cacheAuto, offlineStation, offlineRadio } from './offlineRec';
import { phoneReconcile, phoneIndex, phoneIndexPut, phoneIndexDel, phonePut, phoneDel, phoneInvalidate, phoneVidId, phoneMigrateId, phoneEvictOldest, phoneFreeMB } from './phoneLocal';
import { trackKey } from '../../shared/taste';

// Chiavi legacy → mh-pref-*: entrano nello store condiviso PC↔telefono
migratePrefs({
  'mh-volume': 'mh-pref-volume',
  'mh-playerprefs': 'mh-pref-player',
  'mh-crossfade': 'mh-pref-crossfade',
  'mh-cdqueue': 'mh-pref-cdqueue',
  'mh-queue-v1': 'mh-pref-queue',
});

export type Screen = 'home' | 'stations' | 'search' | 'library' | 'playlists' | 'cd' | 'trends' | 'assistant' | 'downloads' | 'settings';

interface PlayerState {
  current?: TrackRef & { local?: boolean };
  playing: boolean;
  queue: (TrackRef & { local?: boolean })[];
  queueIndex: number;
  volume: number;
  seekTo?: number;
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  radio: boolean; // a fine coda continua con brani simili (upNext)
  // Contesto della radio infinita: 'station:<id>' | 'radio:artist:<nome>' |
  // 'radio:genre:<tag>'. Guida rec:next a restare sul tema della stazione
  // invece di derivare verso il popolare. Presente solo se la coda è nata
  // da una stazione/radio — un play da ricerca/libreria lo azzera.
  stationCtx?: string;
  crossfade: boolean; // dissolvenza incrociata tra un brano e il successivo
}

// StationSel → stringa contesto per rec:next / offlineContinue
const selCtx = (sel: StationSel | null): string | undefined =>
  sel?.kind === 'radio' ? `radio:${sel.radioKind}:${sel.value}` :
  sel?.kind === 'station' ? `station:${sel.id}` : undefined;

interface Toast { id: number; text: string; kind: 'ok' | 'err' | 'info'; action?: { label: string; run: () => void } }

// Selezione stazione aperta in vista lista: 'station' = una del catalogo
// STATIONS; 'radio' = radio dinamica generata da artista o genere/tag.
export type StationSel =
  | { kind: 'station'; id: string }
  | { kind: 'radio'; radioKind: 'artist' | 'genre'; value: string };

interface AppState {
  screen: Screen;
  nav: (s: Screen) => void;
  // Cronologia delle schermate per il tasto indietro hardware (Android):
  // nav() ci accoda la schermata precedente, navBack() la riapre.
  hist: Screen[];
  navBack: () => boolean; // true = è tornato a una schermata precedente
  // Query da iniettare nella schermata Cerca (es. click su un trend non riproducibile)
  searchSeed: string | null;
  seedSearch: (q: string) => void;
  // Contesto dell'ultima ricerca: se l'utente suona un risultato, il motore
  // impara "per questa query si sceglie questo brano" (boost alla prossima ricerca)
  searchCtx: { query: string; ids: Set<string> } | null;
  setSearchCtx: (query: string, ids: string[]) => void;
  // Auto-riparazione: il main ha trovato un videoId alternativo funzionante
  healVideoId: (oldId: string, newId: string) => void;

  settings?: Settings;
  loadSettings: () => Promise<void>;

  // Profilo utente attivo su QUESTO dispositivo + lista profili sul PC.
  // Ogni profilo ha gusti/preferiti/playlist/preferenze propri — il cambio
  // ricarica l'app (stato zustand e code sono per-profilo).
  currentUser: number;
  users: MhUser[];
  loadUsers: () => Promise<void>;
  setUser: (id: number) => Promise<void>;

  library: LibraryTrack[];
  libraryLoaded: boolean; // false finché il primo loadLibrary non torna → skeleton, non "vuota"
  loadLibrary: () => Promise<void>;

  // Risoluzione stream in corso (play premuto, audio non ancora partito) —
  // scritta da PlayerBar, letta da righe/poster per mostrare lo spinner
  // esattamente dove l'utente ha toccato.
  buffering: boolean;
  setBuffering: (v: boolean) => void;

  player: PlayerState;
  play: (t: TrackRef | LibraryTrack, queue?: (TrackRef | LibraryTrack)[], index?: number, radio?: boolean) => void;
  playAt: (index: number) => void;
  enqueue: (t: TrackRef | LibraryTrack) => void; // "Aggiungi in coda" stile Spotify
  removeFromQueue: (index: number) => void;
  // Sleep timer (stile Spotify): minuti → pausa; 'end' = a fine brano
  sleepAt: number | null;
  sleepEndOfTrack: boolean;
  setSleepTimer: (v: number | 'end' | null) => void;
  toggle: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleRadio: () => void;
  radioNext: () => Promise<void>;
  toggleCrossfade: () => void;
  startStation: (stationId: string) => Promise<void>;
  startRadio: (kind: 'artist' | 'genre', value: string) => Promise<void>;

  // Stazione aperta come LISTA (stile Spotify): nessun autoplay — la
  // riproduzione parte solo con un play esplicito dalla vista dettaglio.
  stationSel: StationSel | null;
  openStation: (sel: StationSel | null) => void;
  playStation: (tracks: (TrackRef | LibraryTrack)[]) => void;
  // Lista autogenerata da aprire nella schermata Playlist (deep-link dalla Home)
  autoOpen: string | null;
  openAutoList: (id: string) => void;
  // Playlist utente da aprire (deep-link dalla sidebar)
  plSel: number | null;
  openPlaylistById: (id: number) => void;

  // like su brani remoti (non scaricati): videoId -> true
  remoteLiked: Record<string, true>;
  remoteLikeList: RemoteLike[];
  loadRemoteLikes: () => Promise<void>;
  toggleLike: (t: TrackRef | LibraryTrack) => void;
  dislike: (t: TrackRef | LibraryTrack) => void;
  recordRemote: (t: TrackRef | LibraryTrack, type: 'play' | 'skip' | 'hide') => void;
  // Completamento reale: secondi ascoltati del brano appena lasciato (motore gusti v2)
  recordListen: (t: TrackRef | LibraryTrack, playedS: number, durationS?: number) => void;
  restorePlayerQueue: () => void;

  downloads: DownloadJob[];
  addDownload: (t: TrackRef, silent?: boolean) => Promise<DownloadJob>;
  retryDownload: (id: string) => Promise<void>;
  dismissDownload: (id: string) => Promise<void>;
  clearFinishedDownloads: () => Promise<void>;

  cdQueue: LibraryTrack[];
  addToCd: (t: LibraryTrack, silent?: boolean) => void;
  downloadToCd: (t: TrackRef) => Promise<void>;
  removeFromCd: (id: number) => void;
  moveCd: (id: number, dir: -1 | 1) => void;
  setCdQueue: (tracks: LibraryTrack[]) => void;
  clearCd: () => void;
  pendingCd: Set<string>; // videoId da aggiungere al CD appena il download finisce

  // Brani scaricati fisicamente SUL telefono (IndexedDB): riproducibili offline
  phoneIds: Set<number>;
  phoneDl: Set<number>; // id con download-sul-telefono in corso
  phoneDlPct: Record<number, number>; // progresso 0..1 del download in corso (sorgente PC)
  phoneDlMeta: Record<number, TrackRef>; // brano del download in corso (schermata Download)
  phoneInit: () => Promise<void>;
  downloadToPhone: (t: TrackRef | LibraryTrack) => Promise<void>;
  removeFromPhone: (id: number) => Promise<void>;
  // Import di file audio scelti dall'utente: desktop → libreria del PC;
  // telefono → memoria del telefono (offline) + libreria del PC se raggiungibile
  importAudioFiles: (files: File[]) => Promise<void>;

  // Cache Home: evita il refetch (lento) a ogni visita — TTL gestito in Home
  homeCache?: { sugg: SuggestedTrack[]; charts: TrackRef[]; at: number };
  setHomeCache: (sugg: SuggestedTrack[], charts: TrackRef[]) => void;

  // homeCache namespaced per profilo: i suggerimenti riflettono i gusti
  homeCacheKey: () => string;

  burnProgress?: BurnProgress;

  toasts: Toast[];
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
}

let toastId = 0;
let sleepIv: ReturnType<typeof setInterval> | null = null;

// Chiavi 'mh-pref-*': si sincronizzano sullo store condiviso PC↔telefono
const CD_KEY = 'mh-pref-cdqueue';
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
class PendingCdSet extends Set<string> {
  add(v: string): this { super.add(v); savePendingCd(this); return this; }
  delete(v: string): boolean { const r = super.delete(v); savePendingCd(this); return r; }
  clear(): void { super.clear(); savePendingCd(this); }
}
const VOL_KEY = 'mh-pref-volume';
const persistCd = (q: LibraryTrack[]) => savePref(CD_KEY, q.map((t) => t.id));
const savedVolume = () => loadPref<number>(VOL_KEY, 0.8);
const XF_KEY = 'mh-pref-crossfade';
// Tollera i formati storici: '0' grezzo (legacy), '"0"', false, 0
const savedXf = () => { const v = loadPref<unknown>(XF_KEY, true); return v !== false && v !== 0 && v !== '0'; };
const PREF_KEY = 'mh-pref-player';
// Autoplay stile Spotify: a fine coda la radio continua con brani simili.
// Default ON (come "Autoplay similar content" di Spotify); la scelta persiste.
const savedPrefs = (): { shuffle: boolean; repeat: PlayerState['repeat']; radio: boolean } => {
  const p = loadPref<{ shuffle?: boolean; repeat?: string; radio?: boolean }>(PREF_KEY, {});
  return { shuffle: !!p.shuffle, repeat: p.repeat === 'all' || p.repeat === 'one' ? p.repeat : 'off', radio: p.radio ?? true };
};
const savePrefs = (p: PlayerState) => savePref(PREF_KEY, { shuffle: p.shuffle, repeat: p.repeat, radio: p.radio });
const QUEUE_KEY = 'mh-pref-queue';
const SCREEN_KEY = 'mh-pref-screen';
const SCREENS: Screen[] = ['home', 'stations', 'search', 'library', 'playlists', 'cd', 'trends', 'assistant', 'downloads', 'settings'];
// Riapre l'app sull'ultima schermata visitata (preferenza persistente)
const savedScreen = (): Screen => {
  const s = loadPref<Screen>(SCREEN_KEY, 'home');
  return SCREENS.includes(s) ? s : 'home';
};
// Dedup "stessa canzone" anche con videoId diversi (remaster, topic channel, ecc.)
// — stessa chiave esatta del server (shared/taste.trackKey: NFD+punteggiatura).
const normKey = (t: { artist: string; title: string }) => trackKey(t.artist, t.title);

export const useApp = create<AppState>((set, get) => ({
  screen: savedScreen(),
  hist: [],
  nav: (screen) => {
    if (!SCREENS.includes(screen)) return; // nome invalido → mai crashare nel boundary
    const cur = get().screen;
    const changed = screen !== cur;
    savePref(SCREEN_KEY, screen);
    set((s) => ({ screen, hist: changed && cur !== s.hist[s.hist.length - 1] ? [...s.hist.slice(-19), cur] : s.hist }));
    if (changed) void api().diag.track(`screen:${screen}`).catch(() => {});
  },
  navBack: () => {
    const h = get().hist;
    if (!h.length) return false;
    const prev = h[h.length - 1];
    savePref(SCREEN_KEY, prev);
    set({ screen: prev, hist: h.slice(0, -1) });
    void api().diag.track(`screen:${prev}`).catch(() => {});
    return true;
  },
  searchSeed: null,
  seedSearch: (q) => set((s) => ({
    searchSeed: q, screen: 'search',
    hist: s.screen !== 'search' && s.screen !== s.hist[s.hist.length - 1] ? [...s.hist.slice(-19), s.screen] : s.hist,
  })),
  searchCtx: null,
  setSearchCtx: (query, ids) => set({ searchCtx: { query, ids: new Set(ids) } }),
  healVideoId: (oldId, newId) => set((s) => {
    const swap = (t: TrackRef & { local?: boolean }) => (t.videoId === oldId && !t.filePath ? { ...t, videoId: newId } : t);
    return { player: { ...s.player, queue: s.player.queue.map(swap), current: s.player.current ? swap(s.player.current) : s.player.current } };
  }),

  loadSettings: async () => {
    try {
      const s = await api().settings.get();
      set({ settings: s });
      try { localStorage.setItem('mh-settings-cache', JSON.stringify(s)); } catch { /* quota */ }
    } catch {
      // Offline/non pairato: ultima copia vista (le impostazioni sono globali
      // del PC, non per-profilo); gli schermi usano comunque settings?.
      if (isRemote()) {
        try { const c = localStorage.getItem('mh-settings-cache'); if (c) set({ settings: JSON.parse(c) as Settings }); } catch { /* */ }
      }
    }
  },

  library: [],
  libraryLoaded: false,
  buffering: false,
  setBuffering: (v) => set({ buffering: v }),
  loadLibrary: async () => {
    // Cache per-profilo (il flag `liked` è per-utente): la chiave legacy
    // 'mh-lib-cache' non namespacizzata viene migrata al profilo corrente.
    const cacheKey = `mh-lib-cache:u${myUserId()}`;
    let library: LibraryTrack[] = [];
    try {
      const list = await api().library.list();
      // Risposta non-array (payload inatteso): mai scriverla nella cache —
      // un "undefined"/null salvato distrugge la copia buona per l'offline.
      library = Array.isArray(list) ? list : [];
      // Cache dell'ultima libreria vista: offline il telefono mostra comunque
      // le righe (riproducibili solo quelle scaricate sul dispositivo)
      if (isRemote() && Array.isArray(list)) {
        try { localStorage.setItem(cacheKey, JSON.stringify(library)); localStorage.removeItem('mh-lib-cache'); markPcFresh(); } catch { /* quota */ }
      }
    } catch (e) {
      if (!isRemote()) throw e;
      try {
        const cached = localStorage.getItem(cacheKey) ?? localStorage.getItem('mh-lib-cache');
        const parsed = cached != null ? JSON.parse(cached) : null;
        if (Array.isArray(parsed)) {
          library = (parsed as LibraryTrack[]).map((t) =>
            // Le thumbnail cache sono URL /media/cover sul PC morto → rotte.
            // Col telefono online la cover YouTube del videoId funziona.
            t.thumbnail && /\/media\/cover\//.test(t.thumbnail) && t.videoId && !t.videoId.includes(':')
              ? { ...t, thumbnail: `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg` }
              : t);
        }
      } catch { /* cache corrotta: libreria vuota, il banner guida */ }
    }
    if (isRemote()) {
      // Brano scaricato sul telefono con id sintetico (videoId) che ORA ha un
      // id libreria reale: migra la copia IndexedDB sull'id reale — altrimenti
      // il badge "sul telefono" si spegne e l'utente riscarica lo stesso file.
      for (const t of library) {
        if (t.videoId && !(t.id <= 0) && !get().phoneIds.has(t.id)) {
          const vid = phoneVidId(t.videoId);
          if (get().phoneIds.has(vid)) {
            await phoneMigrateId(vid, t.id).catch(() => false);
            set((s) => { const n = new Set(s.phoneIds); n.delete(vid); n.add(t.id); return { phoneIds: n }; });
          }
        }
      }
    }
    if (isRemote()) {
      // Brani presenti SOLO sul telefono (es. eliminati sul PC dopo il
      // download): restano visibili e riproducibili, marcati 'local'.
      const have = new Set(library.map((t) => t.id));
      const ix = phoneIndex();
      for (const id of get().phoneIds) {
        const meta = ix[id];
        if (!have.has(id) && meta) library.push({ ...meta, id, phoneOnly: true });
      }
    }
    set({ library });
    // Ripristina la tracklist CD salvata (solo tracce ancora esistenti)
    try {
      const ids = JSON.parse(localStorage.getItem(CD_KEY) ?? '[]') as number[];
      const restored = ids.map((id) => library.find((t) => t.id === id)).filter((t): t is LibraryTrack => !!t);
      set({ cdQueue: restored });
    } catch { /* storage corrotto */ }
    set({ libraryLoaded: true });
  },

  player: { playing: false, queue: [], queueIndex: -1, volume: savedVolume(), ...savedPrefs(), crossfade: savedXf() },
  play: (t, queue, index, radio) => {
    let q = (queue ?? [t]) as PlayerState['queue'];
    let found = q.findIndex((x) => x.videoId === t.videoId);
    if (found < 0 && index == null) { q = [t as TrackRef & { local?: boolean }]; found = 0; }
    const i = index ?? found;
    const current = (q[i] ?? t) as TrackRef & { local?: boolean };
    set((s) => ({ player: { ...s.player, queue: q, queueIndex: i, current, playing: true, radio: radio ?? s.player.radio, stationCtx: radio === true ? s.player.stationCtx : undefined } }));
    get().recordRemote(current, 'play');
    // Apprendimento ricerca: se il brano viene dai risultati dell'ultima query,
    // ricorda la scelta → alla prossima ricerca uguale arriva in cima.
    // Offline: la scelta va in coda come gli altri segnali — non si perde.
    const ctx = get().searchCtx;
    if (ctx?.ids.has(current.videoId)) void api().yt.searchPick(ctx.query, current).catch(() => queueSearchPick(ctx.query, current));
  },
  playAt: (index) => {
    const q = get().player.queue;
    if (index >= 0 && index < q.length) get().play(q[index], q, index);
  },
  removeFromQueue: (index) => {
    const s = get();
    const q = [...s.player.queue];
    q.splice(index, 1);
    if (index === s.player.queueIndex) {
      // Stava suonando la traccia rimossa: suona quella che prende il suo posto,
      // rispettando lo stato play/pausa (se era in pausa resta in pausa)
      if (q.length) {
        const i = Math.min(index, q.length - 1);
        const wasPlaying = s.player.playing;
        get().play(q[i], q, i);
        if (!wasPlaying) set((x) => ({ player: { ...x.player, playing: false } }));
      } else set({ player: { ...s.player, queue: q, queueIndex: -1, current: undefined, playing: false } });
      return;
    }
    const qi = index < s.player.queueIndex ? s.player.queueIndex - 1 : s.player.queueIndex;
    set({ player: { ...s.player, queue: q, queueIndex: q.length ? qi : -1 } });
  },
  // "Aggiungi in coda": appende dopo l'ultimo brano (dedup su videoId e
  // artista|titolo — lo stesso brano non entra due volte in coda).
  enqueue: (t) => {
    const s = get();
    if (!s.player.current) { s.play(t); return; }
    const dup = s.player.queue.some((x) => x.videoId === t.videoId || normKey(x) === normKey(t));
    if (dup || s.player.current.videoId === t.videoId) { s.toast('Già in coda', 'info'); return; }
    set((x) => ({ player: { ...x.player, queue: [...x.player.queue, t as TrackRef & { local?: boolean }] } }));
    s.toast(`In coda: ${t.title}`, 'ok');
  },
  // Sleep timer stile Spotify: un check ogni 5s; 'end' lo consuma PlayerBar
  // all'onEnded del brano corrente.
  sleepAt: null,
  sleepEndOfTrack: false,
  setSleepTimer: (v) => {
    if (sleepIv) { clearInterval(sleepIv); sleepIv = null; }
    if (v == null) { set({ sleepAt: null, sleepEndOfTrack: false }); return; }
    if (v === 'end') {
      set({ sleepAt: null, sleepEndOfTrack: true });
      get().toast('Pausa a fine brano', 'ok');
      return;
    }
    set({ sleepAt: Date.now() + v * 60_000, sleepEndOfTrack: false });
    get().toast(`La musica si ferma tra ${v} min`, 'ok');
    sleepIv = setInterval(() => {
      const s = get();
      if (s.sleepAt && Date.now() >= s.sleepAt) {
        s.setSleepTimer(null);
        if (s.player.playing) s.toggle();
        s.toast('Timer di spegnimento — musica in pausa', 'info');
      }
    }, 5000);
  },
  toggle: () => set((s) => ({ player: { ...s.player, playing: !s.player.playing } })),
  stop: () => set((s) => ({ player: { ...s.player, playing: false, current: undefined } })),
  next: () => {
    const p = get().player;
    if (p.shuffle && p.queue.length > 1) {
      let i = p.queueIndex;
      while (i === p.queueIndex) i = Math.floor(Math.random() * p.queue.length);
      get().play(p.queue[i], p.queue, i);
      return;
    }
    if (p.queueIndex < p.queue.length - 1) get().play(p.queue[p.queueIndex + 1], p.queue, p.queueIndex + 1);
    else if (p.repeat === 'all' && p.queue.length) get().play(p.queue[0], p.queue, 0);
    else if (p.radio) void get().radioNext(); // skip manuale sull'ultimo: la radio continua
    else set((s) => ({ player: { ...s.player, playing: false } }));
  },
  prev: () => {
    const p = get().player;
    if (p.queueIndex > 0) get().play(p.queue[p.queueIndex - 1], p.queue, p.queueIndex - 1);
  },
  setVolume: (v) => {
    savePref(VOL_KEY, v);
    set((s) => ({ player: { ...s.player, volume: v } }));
  },
  toggleShuffle: () => set((s) => {
    const player = { ...s.player, shuffle: !s.player.shuffle };
    savePrefs(player);
    return { player };
  }),
  cycleRepeat: () => set((s) => {
    const player = { ...s.player, repeat: s.player.repeat === 'off' ? 'all' as const : s.player.repeat === 'all' ? 'one' as const : 'off' as const };
    savePrefs(player);
    return { player };
  }),
  toggleRadio: () => set((s) => {
    const player = { ...s.player, radio: !s.player.radio };
    savePrefs(player);
    return { player };
  }),
  toggleCrossfade: () => {
    savePref(XF_KEY, !get().player.crossfade);
    set((s) => ({ player: { ...s.player, crossfade: !s.player.crossfade } }));
  },
  // Radio: la coda è finita → continua con brani simili a quello appena suonato
  radioNext: async () => {
    const p = get().player;
    const cur = p.current;
    if (!cur) return;
    // La fetch upNext può durare 1-3s: senza questo flag il player mostrava
    // "morto" (fine coda) mentre invece sta cercando il brano successivo.
    set({ buffering: true });
    try {
      // Con contesto stazione il motore filtra e riordina sui gusti e resta
      // ancorato al seme; senza (radio manuale su una coda qualsiasi) upNext nudo.
      const ups = p.stationCtx
        ? await api().rec.next(cur.videoId, cur.artist, p.stationCtx).catch(() => api().yt.upNext(cur.videoId))
        : await api().yt.upNext(cur.videoId);
      // Stato fresco dopo l'await: usare lo snapshot `p` perderebbe i cambi
      // di coda fatti dall'utente mentre la rete rispondeva
      const p2 = useApp.getState().player;
      if (p2.current?.videoId !== cur.videoId) return; // cambiato nel frattempo
      // dedup su videoId E su artista|titolo: lo stesso brano con altro videoId
      // (remaster, topic channel) non deve rientrare in coda
      const seenKeys = new Set(p2.queue.map((x) => normKey(x)));
      const fresh = ups.filter((u) => u.videoId && !p2.queue.some((x) => x.videoId === u.videoId) && !seenKeys.has(normKey(u))).slice(0, 15);
      if (!fresh.length) { set((s) => ({ player: { ...s.player, playing: false }, buffering: false })); return; }
      // Trim: la radio crescerebbe all'infinito — tieni solo 25 brani di
      // cronologia dietro l'indice (prev() resta utile), memoria limitata.
      let q = [...p2.queue, ...fresh];
      let i = p2.queueIndex + 1;
      const drop = Math.max(0, i - 25);
      if (drop > 0) { q = q.slice(drop); i -= drop; }
      const nextT = q[i];
      set((s) => ({ player: { ...s.player, queue: q, queueIndex: i, current: nextT, playing: true } }));
      get().recordRemote(nextT, 'play');
      // buffering resta true: lo spegne PlayerBar quando il nuovo stream è pronto
    } catch {
      set((s) => ({ player: { ...s.player, playing: false }, buffering: false }));
    }
  },

  // Avvia una stazione: carica la coda iniziale e accende la radio infinita
  startStation: async (stationId) => {
    let tracks: TrackRef[] | null = null;
    try {
      tracks = await api().rec.station(stationId);
      if (tracks.length) cacheAuto(`st:${stationId}`, tracks);
    } catch {
      // PC spento: ultima scaletta generata dal PC, poi approssimazione locale
      tracks = cachedAuto<TrackRef[]>(`st:${stationId}`)
        ?? await offlineStation(stationId, get().library, get().remoteLikeList).catch(() => []);
    }
    if (!tracks?.length) { get().toast('Stazione vuota, riprova tra poco', 'err'); return; }
    set((s) => ({ player: { ...s.player, queue: tracks, queueIndex: 0, current: tracks[0], playing: true, radio: true, stationCtx: `station:${stationId}` } }));
    get().recordRemote(tracks[0], 'play');
  },

  // Radio on-the-fly da artista o genere: "Radio di Vasco", "Radio italian rock"
  startRadio: async (kind, value) => {
    let tracks: TrackRef[] | null = null;
    try {
      tracks = await api().rec.radio(kind, value);
      if (tracks.length) cacheAuto(`radio:${kind}:${value}`, tracks);
    } catch {
      tracks = cachedAuto<TrackRef[]>(`radio:${kind}:${value}`)
        ?? await offlineRadio(kind, value).catch(() => []);
    }
    if (!tracks?.length) { get().toast('Radio non disponibile ora', 'err'); return; }
    set((s) => ({ player: { ...s.player, queue: tracks, queueIndex: 0, current: tracks[0], playing: true, radio: true, stationCtx: `radio:${kind}:${value}` } }));
    get().recordRemote(tracks[0], 'play');
    get().toast(kind === 'artist' ? `Radio di ${value}` : `Radio ${value}`, 'ok');
  },

  // Apertura stazione in modalità lista (stile Spotify): il click sulla
  // card NON avvia nulla — mostra la scaletta generata; il play è esplicito.
  stationSel: null,
  openStation: (sel) => {
    set({ stationSel: sel });
    if (sel) get().nav('stations');
  },
  autoOpen: null,
  openAutoList: (id) => {
    set({ autoOpen: id });
    get().nav('playlists');
  },
  plSel: null,
  openPlaylistById: (id) => {
    set({ plSel: id });
    get().nav('playlists');
  },
  // Play esplicito dalla vista lista: la scaletta diventa coda e la radio
  // infinita resta accesa a fine coda (radioNext continua con brani simili).
  playStation: (tracks) => {
    if (!tracks.length) { get().toast('Stazione vuota, riprova tra poco', 'err'); return; }
    set((s) => ({ player: { ...s.player, queue: tracks as PlayerState['queue'], queueIndex: 0, current: tracks[0] as PlayerState['current'], playing: true, radio: true, stationCtx: selCtx(s.stationSel) } }));
    get().recordRemote(tracks[0], 'play');
  },

  remoteLiked: {},
  remoteLikeList: [],
  // Profilo attivo: su remoto arriva dalla conf (X-MH-User), su desktop
  // dallo specchio 'mh-user' scritto all'avvio
  currentUser: myUserId(),
  users: [],
  loadUsers: async () => {
    const list = await api().users.list().catch(() => null);
    if (list) {
      set({ users: list });
      try { localStorage.setItem('mh-users-cache', JSON.stringify(list)); } catch { /* quota */ }
      return;
    }
    // PC giù: ultima lista vista (i profili sono globali, non per-utente)
    try { set({ users: JSON.parse(localStorage.getItem('mh-users-cache') ?? '[]') as MhUser[] }); }
    catch { set({ users: [] }); }
  },
  // Cambio profilo — la sequenza conta:
  // 0) REMOTO: il profilo è il binding del device token → claim al PC. Un
  //    device già legato ad altro richiede la finestra «Accoppia telefono»
  //    aperta sul PC (il confine di sicurezza è questo); in attesa, watchClaim
  //    riprova da solo. PC giù → niente switch: i dati serviti resterebbero
  //    del profilo legato, incoerenti con quelli locali.
  // 1) spinge al PC le scritture offline pendenti MENTRE il vecchio profilo
  //    è ancora attivo (le chiavi dirty sono namespacizzate per utente);
  // 2) archivia i valori non partiti sotto 'mh-dval:u<vecchio>:*' — li
  //    ritroverà al prossimo login di quel profilo;
  // 3) svuota la vista locale delle mh-pref-* (sono del vecchio profilo);
  // 4) aggiorna il profilo attivo (remoto: conf.user; desktop: settings);
  // 5) reload: hydrate riempie le pref del nuovo profilo, coda/like/cache
  //    ripartono puliti. Mai saltare 2-3 o il nuovo profilo vedrebbe le
  //    preferenze dell'altro.
  setUser: async (id) => {
    if (id === get().currentUser) return;
    if (isRemote()) {
      await pushDirty().catch(() => {});
      const r = await claimProfile(id);
      if (r === 'window') {
        get().toast('Cambio profilo in attesa: sul PC apri Impostazioni → Telefono e premi «Accoppia telefono»', 'info');
        watchClaimWindow(id, () => { void get().setUser(id); });
        return;
      }
      if (r === 'err') { get().toast(`Cambio profilo non riuscito — serve il PC raggiungibile`, 'err'); return; }
    }
    archiveDirtyValues();
    clearLocalPrefs();
    setLocalUserId(id);
    try { await api().users.setCurrent(id); } catch { /* */ }
    location.reload();
  },
  homeCacheKey: () => `mh-home-cache:u${myUserId()}`,
  // Home offline: suggerimenti e classifiche dell'ultima visita al PC (per profilo)
  homeCache: (() => {
    try { return JSON.parse(localStorage.getItem(`mh-home-cache:u${myUserId()}`) ?? 'null') ?? undefined; }
    catch { return undefined; }
  })(),
  loadRemoteLikes: async () => {
    // cached() in remote.ts serve l'ultima copia vista se il PC è giù;
    // in standalone (mai pairato) arriva null — la base è vuota.
    const likes = await api().library.remoteLikes().catch(() => null);
    const pend = pendingLikesMap();
    // Fetch fallita E niente in coda → stato attuale va bene com'è.
    // Fetch fallita MA like accodati → vanno comunque applicati: senza questo
    // i cuori fatti offline/modo senza-PC sembrerebbero persi a ogni riavvio.
    if (!likes && !pend.size) return;
    const remoteLiked = Object.fromEntries((likes ?? []).map((r) => [r.videoId, true as const]));
    const remoteLikeList = [...(likes ?? [])];
    // Like fatti offline non ancora drenati: il cuore resta acceso/spento
    // come deciso dall'utente, prima che il PC riceva la coda — e la raccolta
    // "Brani che ti piacciono" li vede subito (metadati dal TrackRef in coda).
    for (const [vid, on] of pend) {
      if (on) remoteLiked[vid] = true; else delete remoteLiked[vid];
    }
    for (const e of pendingLikeEntries()) {
      if (!remoteLikeList.some((r) => r.videoId === e.videoId)) remoteLikeList.push(e);
    }
    // Un-like fatto offline: il cuore si spegne (sopra) ma la riga deve
    // sparire ANCHE dalla lista — altrimenti resta fino al prossimo drain.
    const filtered = remoteLikeList.filter((r) => pend.get(r.videoId) !== false);
    set({ remoteLiked, remoteLikeList: filtered });
  },

  // Like universale: locale per id, remoto per videoId
  toggleLike: (t) => {
    const s = get();
    const lib = t as LibraryTrack;
    const cand = lib.id != null ? lib : s.library.find((x) => x.videoId === t.videoId);
    // Solo un id REALE (>0) e non phoneOnly può andare su track_likes: gli
    // id sintetici dei brani "solo telefono" violano la FK sul server, e un
    // id positivo orfano (file sul telefono, traccia eliminata sul PC) farebbe
    // lo stesso → like perso + veleno permanente nella coda. Per quelli si
    // usa il like remoto per videoId.
    const local = cand && !cand.phoneOnly && (cand.id ?? 0) > 0 ? cand : undefined;
    if (local) {
      const liked = !local.liked;
      // PC giù: il like resta in coda sul telefono e arriva al PC al ritorno
      void api().library.like(local.id, liked).catch(() => queueLibLike(local.id, liked));
      set({ library: s.library.map((x) => (x.id === local.id ? { ...x, liked } : x)) });
      if (!liked) void api().library.likeRemote(t, false).catch(() => queueRemoteLike(t, false)); // pulisci anche eventuale like remoto
      return;
    }
    if (!t.videoId) return;
    const liked = !s.remoteLiked[t.videoId];
    const remoteLiked = { ...s.remoteLiked };
    if (liked) remoteLiked[t.videoId] = true; else delete remoteLiked[t.videoId];
    const remoteLikeList = liked
      ? [{ videoId: t.videoId, title: t.title, artist: t.artist, thumbnail: t.thumbnail, durationS: t.durationS, ts: Date.now() }, ...s.remoteLikeList]
      : s.remoteLikeList.filter((r) => r.videoId !== t.videoId);
    set({ remoteLiked, remoteLikeList });
    // Riga "solo telefono" (id sintetico): il cuore della riga legge libTrack.liked
    // → va aggiornato anche lui, e il meta persistito tiene il flag al reload.
    if (cand) {
      set((x) => ({ library: x.library.map((r) => (r.id === cand.id ? { ...r, liked } : r)) }));
      const m = phoneIndex()[cand.id];
      if (m) phoneIndexPut(cand.id, { ...m, liked });
    }
    void api().library.likeRemote(t, liked).catch(() => queueRemoteLike(t, liked));
  },

  // "Meno così": dislike deliberato — pesa più dello skip, toglie il brano dalla coda
  dislike: (t) => {
    const s = get();
    get().recordRemote(t, 'hide');
    // il dislike vince sul like, remoto o locale che sia
    const lib = t as LibraryTrack;
    const local = lib.id != null ? lib : s.library.find((x) => x.videoId === t.videoId);
    if (local?.liked || s.remoteLiked[t.videoId]) get().toggleLike(t);
    const qi = s.player.queue.findIndex((x) => x.videoId === t.videoId);
    if (qi >= 0) get().removeFromQueue(qi);
    get().toast(`Ok, meno brani come "${t.title}"`, 'info');
  },

  // Eventi di ascolto: locale per id (play_count + evento con metadati),
  // remoto con metadati (nutre gusti, "recenti" e negativi per-brano)
  recordRemote: (t, type) => {
    const lib = t as LibraryTrack;
    const cand = lib.id != null ? lib : get().library.find((x) => x.videoId === t.videoId);
    // Righe "solo telefono" NON esistono sul PC: library.play/skip su di loro
    // farebbe UPDATE su 0 righe senza evento (call "riuscita" → niente coda →
    // ascolto perso). Vanno SEMPRE per il ramo evento-per-videoId.
    const local = cand && !cand.phoneOnly ? cand : undefined;
    if (local && (type === 'play' || type === 'skip')) {
      // Anche i conteggi locali vanno in coda: la storia di ascolto non si perde
      if (type === 'play') void api().library.play(local.id).catch(() => queueEvent({ trackId: local.id, artist: t.artist, title: t.title, videoId: t.videoId, thumbnail: t.thumbnail, type: 'play' }));
      else void api().library.skip(local.id).catch(() => queueEvent({ trackId: local.id, artist: t.artist, title: t.title, videoId: t.videoId, thumbnail: t.thumbnail, type: 'skip' }));
      return;
    }
    const e = { trackId: local?.id, artist: t.artist, title: t.title, videoId: t.videoId, thumbnail: t.thumbnail, type };
    void api().library.remoteEvent(e).catch(() => queueEvent(e));
  },

  recordListen: (t, playedS, durationS) => {
    if (!(playedS >= 30)) return; // sotto i 30s decide lo skip, non il completamento
    const lib = t as LibraryTrack;
    const cand = lib.id != null ? lib : get().library.find((x) => x.videoId === t.videoId);
    const local = cand && !cand.phoneOnly ? cand : undefined;
    const r = { trackId: local?.id, videoId: t.videoId, artist: t.artist, title: t.title, thumbnail: t.thumbnail, playedS, durationS: durationS ?? t.durationS };
    void api().library.listen(r).catch(() => queueListen(r)); // offline: in coda, arriva al ritorno
  },

  // Riapre la coda dell'ultima sessione: in pausa, pronta a ripartire
  restorePlayerQueue: () => {
    try {
      const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as
        { queue?: (TrackRef & { local?: boolean })[]; index?: number; radio?: boolean } | null;
      if (!saved?.queue?.length) return;
      const queue = saved.queue.filter((t) => t && (t.videoId || (t as LibraryTrack).filePath))
        // Bonifica metadati salvati da versioni con il bug "[object Object]"
        .map((t) => (typeof t.artist === 'string' && !t.artist.startsWith('[object') ? t : { ...t, artist: 'Sconosciuto' }));
      if (!queue.length) return;
      const index = Math.min(Math.max(0, saved.index ?? 0), queue.length - 1);
      set((s) => ({
        player: { ...s.player, queue, queueIndex: index, current: queue[index], radio: !!saved.radio, playing: false },
      }));
    } catch { /* storage corrotto */ }
  },

  downloads: [],
  addDownload: async (t, silent = false) => {
    try {
      const job = await api().downloads.enqueue(t);
      if (!silent) {
        get().toast(
          job.status === 'done' ? `${t.title} è già in libreria` : `In coda: ${t.artist} - ${t.title}`,
          job.status === 'done' ? 'ok' : 'info');
      }
      return job;
    } catch (e) {
      // PC spento/irraggiungibile: la richiesta resta in pendingSync e il
      // download parte da solo alla riconnessione. Job fittizio 'queued' per
      // non fingere un completamento che non c'è stato.
      if (!isRemote() || isOnline()) throw e; // errore applicativo: propagato
      queueDownload(t);
      if (!silent) get().toast(`${t.title}: ${isStandalone() ? 'in coda — scarico sul PC quando lo colleghi' : `PC offline — scarico sul PC ${resyncWhen()}`}`, 'info');
      return { id: `pending-${t.videoId}`, track: t, status: 'queued', percent: 0 };
    }
  },
  retryDownload: async (id) => { await api().downloads.retry(id); },
  dismissDownload: async (id) => {
    await api().downloads.dismiss(id);
    set((s) => ({ downloads: s.downloads.filter((j) => j.id !== id) }));
  },
  clearFinishedDownloads: async () => {
    await api().downloads.clearFinished();
    set((s) => ({ downloads: s.downloads.filter((j) => !['done', 'error'].includes(j.status)) }));
  },

  cdQueue: [],
  pendingCd: new PendingCdSet(loadPendingCd()),
  addToCd: (t, silent = false) => {
    // Esiste solo nella memoria del telefono: il PC non ha il file → non masterizzabile
    if ((t as LibraryTrack).phoneOnly) {
      if (!silent) get().toast(`"${t.title}" è solo sul telefono — non si può masterizzare`, 'err');
      return;
    }
    // dedup anche su artista+titolo: la stessa canzone con videoId diverso non entra due volte
    if (get().cdQueue.some((x) => x.id === t.id || normKey(x) === normKey(t))) {
      if (!silent) get().toast(`${t.title} è già nella tracklist`, 'info');
      return;
    }
    set((s) => {
      const cdQueue = [...s.cdQueue, t];
      persistCd(cdQueue);
      return { cdQueue };
    });
    if (!silent) get().toast(`${t.title} aggiunto al CD`, 'ok');
  },
  // Un click: se non è in libreria, scarica e aggiunge al CD appena pronto
  downloadToCd: async (t) => {
    const lib = get().library.find((x) => x.videoId === t.videoId);
    if (lib) { get().addToCd(lib); return; }
    try {
      const job = await api().downloads.enqueue(t);
      if (job.status === 'done') {
        await get().loadLibrary();
        const l = get().library.find((x) => x.videoId === t.videoId);
        if (l) get().addToCd(l);
      } else if (job.status === 'error') {
        // errore già emesso prima del pendingCd: senza questo resterebbe appeso per sempre
        get().toast(`Download fallito: ${t.title}`, 'err');
      } else {
        get().pendingCd.add(t.videoId); // il listener download lo aggiunge al 'done'
        get().toast(`${t.title} in download — lo aggiungo al CD appena pronto`, 'info');
      }
    } catch (e) {
      if (isRemote() && !isOnline()) {
        // PC spento: preparazione CD possibile — download accodato, la traccia
        // entra in tracklist al 'done' (drain pendingCd al reconnect).
        queueDownload(t);
        get().pendingCd.add(t.videoId);
        get().toast(`${t.title}: ${isStandalone() ? 'in coda — scarico e aggiungo al CD quando colleghi un PC' : `PC offline — scarico e aggiungo al CD ${resyncWhen()}`}`, 'info');
      } else {
        get().pendingCd.delete(t.videoId);
        get().toast(`Download non avviato: ${e instanceof Error ? e.message : e}`, 'err');
      }
    }
  },
  removeFromCd: (id) => set((s) => {
    const cdQueue = s.cdQueue.filter((t) => t.id !== id);
    persistCd(cdQueue);
    return { cdQueue };
  }),
  moveCd: (id, dir) => set((s) => {
    const q = [...s.cdQueue];
    const i = q.findIndex((t) => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= q.length) return s;
    [q[i], q[j]] = [q[j], q[i]];
    persistCd(q);
    return { cdQueue: q };
  }),
  setCdQueue: (tracks) => { persistCd(tracks); set({ cdQueue: tracks }); },
  clearCd: () => { persistCd([]); set({ cdQueue: [] }); },

  // ---- Brani sul telefono (IndexedDB): ascolto offline e fuori casa ----
  phoneIds: new Set<number>(),
  phoneDl: new Set<number>(),
  phoneDlPct: {},
  phoneDlMeta: {},
  phoneInit: async () => {
    if (!isRemote()) return;
    const { ids, metas } = await phoneReconcile();
    set({ phoneIds: new Set(ids) });
    // Merge subito delle tracce orfane (loadLibrary può essere già corso
    // in parallelo): chi non è in libreria rientra marcato 'local'.
    set((s) => {
      const have = new Set(s.library.map((t) => t.id));
      const extra = ids.filter((id) => !have.has(id) && metas[id]).map((id) => ({ ...metas[id], id, phoneOnly: true }));
      return extra.length ? { library: [...s.library, ...extra] } : s;
    });
  },
  // Scarica QUALSIASI brano sul telefono: file del PC se esiste ed è
  // raggiungibile, altrimenti stream YouTube diretto (PC spento ma telefono
  // online — come il download offline di Spotify). Brani non in libreria →
  // id sintetico negativo, entrano in libreria come righe "solo telefono".
  downloadToPhone: async (t) => {
    if (!isRemote()) return;
    const lib = t as LibraryTrack;
    const pid = lib.id ?? (t.videoId ? phoneVidId(t.videoId) : undefined);
    if (pid == null) return;
    if (get().phoneDl.has(pid) || get().phoneIds.has(pid)) return; // doppio tap / già presente
    set((s) => ({ phoneDl: new Set(s.phoneDl).add(pid), phoneDlMeta: { ...s.phoneDlMeta, [pid]: t } }));
    const clearPct = () => set((s) => {
      const n = { ...s.phoneDlPct }; delete n[pid];
      const m = { ...s.phoneDlMeta }; delete m[pid];
      return { phoneDlPct: n, phoneDlMeta: m };
    });
    try {
      // Quota proattiva: sotto ~64MB liberi l'eviction LRU parte PRIMA del
      // download, non a fallimento avvenuto — l'utente non scopre il pieno
      // dal toast d'errore. Il retry-on-QuotaExceeded resta come rete finale.
      const freeMB = await phoneFreeMB().catch(() => null);
      if (freeMB != null && freeMB < 64) {
        const evicted = await phoneEvictOldest((64 - freeMB) * 1e6, pid).catch(() => [] as number[]);
        if (evicted.length) {
          set((s) => ({
            phoneIds: new Set([...s.phoneIds].filter((x) => !evicted.includes(x))),
            library: s.library.filter((x) => !evicted.includes(x.id ?? 0) || !x.phoneOnly),
          }));
          get().toast(`Spazio quasi pieno: liberati i ${evicted.length} download più vecchi`, 'info');
        }
      }
      let blob: Blob | null = null;
      if (lib.id != null && lib.filePath && isOnline()) {
        // File sul PC via stream: timeout sugli header (20s) + watchdog di
        // stallo sul corpo (30s senza byte → abort → fallback diretto).
        // Un PC "mezzo morto" (TCP accettato, mai risposta) non deve appendersi.
        blob = await fetchTrackBlob(mediaUrl('audio', lib.id), (p) =>
          set((s) => ({ phoneDlPct: { ...s.phoneDlPct, [pid]: p } })));
      }
      if (!blob) {
        const { directPlayStream, mhFetch } = await import('./direct');
        // playStream (non streamUrl): stessa auto-riparazione del play — se il
        // videoId è gated/rimosso cerca un candidato alternativo invece di fallire.
        const s = await directPlayStream(t.videoId, t.artist, t.title);
        const res = await mhFetch(s.url); // googlevideo/audius: nativo nell'APK
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const cl = Number(res.headers.get('content-length') ?? 0);
        blob = await res.blob();
        // Integrità: Content-Length dichiarato ≠ byte arrivati = troncato —
        // mai persistere. <1KB non è un file audio valido (risposta mangiata).
        if (cl > 0 && blob.size !== cl) throw new Error('download troncato dalla rete');
        if (blob.size < 1024) throw new Error('file audio non valido');
      }
      // Copertina best-effort (PC o thumbnail YouTube): non blocca il download.
      // /media/cover esiste solo per id reali (>0): sintetici → thumbnail.
      let cover: Blob | undefined;
      const coverUrl = lib.id != null && lib.id > 0 && isOnline() ? mediaUrl('cover', lib.id) : t.thumbnail;
      if (coverUrl) {
        try { const c = await fetch(coverUrl); if (c.ok) cover = await c.blob(); } catch { /* */ }
      }
      const meta = {
        ...t, id: pid, filePath: lib.filePath ?? '',
        addedAt: lib.addedAt ?? Date.now(), playCount: lib.playCount ?? 0, liked: !!lib.liked,
      } as LibraryTrack;
      phoneInvalidate(pid); // re-download: l'object URL vecchio puntava al blob vecchio
      try {
        await phonePut({ id: pid, meta, blob, cover, size: blob.size, addedAt: Date.now() });
      } catch (e) {
        // Quota piena: eviction LRU dei download più vecchi e UN retry — se
        // non basta cade nel catch esterno col toast "spazio insufficiente".
        if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) throw e;
        const evicted = await phoneEvictOldest(blob.size, pid);
        if (!evicted.length) throw e;
        await phonePut({ id: pid, meta, blob, cover, size: blob.size, addedAt: Date.now() });
        // Store coerente: i badge "sul telefono" e le righe phoneOnly degli
        // eliminati spariscono subito, non al prossimo reconcile.
        set((s) => ({
          phoneIds: new Set([...s.phoneIds].filter((x) => !evicted.includes(x))),
          library: s.library.filter((x) => !evicted.includes(x.id ?? 0) || !x.phoneOnly),
        }));
        get().toast(`Spazio quasi pieno: eliminati ${evicted.length} download più vecchi`, 'info');
      }
      phoneIndexPut(pid, meta);
      set((s) => ({
        phoneIds: new Set(s.phoneIds).add(pid),
        library: lib.id == null && !s.library.some((x) => x.id === pid)
          ? [...s.library, { ...meta, phoneOnly: true }]
          : s.library,
      }));
      get().toast(`${t.title} sul telefono — ascoltabile offline`, 'ok');
    } catch (e) {
      const quota = e instanceof DOMException && e.name === 'QuotaExceededError';
      get().toast(quota ? 'Spazio insufficiente sul telefono' : `Download sul telefono fallito: ${e instanceof Error ? e.message : e}`, 'err');
      throw e;
    } finally {
      clearPct();
      set((s) => { const n = new Set(s.phoneDl); n.delete(pid); return { phoneDl: n }; });
    }
  },
  removeFromPhone: async (id) => {
    await phoneDel(id);
    phoneIndexDel(id);
    phoneInvalidate(id);
    set((s) => {
      const n = new Set(s.phoneIds); n.delete(id);
      // Se era una riga "solo telefono" (orfana), sparisce anche dalla lista
      const library = s.library.some((t) => t.id === id && t.phoneOnly)
        ? s.library.filter((t) => !(t.id === id && t.phoneOnly))
        : s.library;
      return { phoneIds: n, library };
    });
  },

  importAudioFiles: async (files) => {
    const s = get();
    if (!files.length) return;
    if (!isRemote()) {
      // Desktop: stessa pipeline del drag&drop (copia in libreria + tag)
      const paths = files.map((f) => { try { return api().sys.pathForFile(f); } catch { return ''; } }).filter(Boolean);
      try {
        const n = paths.length ? await api().library.importFiles(paths) : 0;
        if (n > 0) { s.toast(`${n} file importati in libreria`, 'ok'); await get().loadLibrary().catch(() => {}); }
        else s.toast('Nessun file audio valido tra quelli scelti', 'err');
      } catch { s.toast('Import fallito — riprova', 'err'); }
      return;
    }
    let local = 0, onPc = 0;
    const added: LibraryTrack[] = [];
    for (const f of files) {
      if (!/^audio\//.test(f.type) && !/\.(mp3|m4a|aac|flac|wav|ogg|opus|webm)$/i.test(f.name)) continue;
      // 1) Copia sul telefono: suona subito, anche senza rete
      const base = f.name.replace(/\.[^.]+$/, '');
      const m = /^(.+?)\s*-\s*(.+)$/.exec(base);
      const videoId = `local:phone-${phoneVidId(`${f.name}|${f.size}`) * -1}`;
      const id = phoneVidId(videoId);
      const durationS = await audioDuration(f);
      const meta = {
        id, videoId, title: (m?.[2] ?? base).trim(), artist: (m?.[1] ?? 'Importato').trim(),
        durationS, source: 'library', filePath: '', addedAt: Date.now(), playCount: 0, liked: false,
      } as LibraryTrack;
      try {
        await phonePut({ id, meta, blob: f, size: f.size, addedAt: Date.now() });
        phoneIndexPut(id, meta);
        added.push(meta);
        local++;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'QuotaExceededError') { s.toast('Spazio insufficiente sul telefono', 'err'); break; }
      }
      // 2) PC raggiungibile: il file entra anche nella libreria condivisa
      if (isOnline()) {
        try {
          const res = await fetch(`${remoteBase()}/api/upload?name=${encodeURIComponent(f.name)}`, {
            method: 'POST', body: f,
            headers: { 'Content-Type': 'application/octet-stream', 'X-MH-Token': remoteToken(), 'X-MH-User': String(myUserId()) },
          });
          const j = (await res.json().catch(() => ({}))) as { r?: number };
          if (res.ok && (j.r ?? 0) > 0) onPc++;
        } catch { /* PC caduto a metà: resta la copia sul telefono */ }
      }
    }
    if (added.length) {
      set((x) => ({
        phoneIds: new Set([...x.phoneIds, ...added.map((t) => t.id)]),
        library: [...x.library.filter((t) => !added.some((a) => a.id === t.id)), ...added.map((t) => ({ ...t, phoneOnly: true }))],
      }));
    }
    if (onPc) {
      await get().loadLibrary().catch(() => {});
      // Lo stesso brano ora esiste anche sul PC (id reale): la copia locale
      // segue quell'id → niente doppioni in libreria, resta offline.
      for (const a of added) {
        const real = get().library.find((t) => !t.phoneOnly && t.id > 0 && t.videoId.startsWith('local:')
          && normKey(t) === normKey(a) && !get().phoneIds.has(t.id));
        if (real && await phoneMigrateId(a.id, real.id).catch(() => false)) {
          set((x) => {
            const ids = new Set(x.phoneIds); ids.delete(a.id); ids.add(real.id);
            return { phoneIds: ids, library: x.library.filter((t) => t.id !== a.id) };
          });
        }
      }
    }
    if (!local && !onPc) { s.toast('Nessun file audio valido tra quelli scelti', 'err'); return; }
    s.toast(onPc
      ? `${local} file sul telefono e nella libreria del PC`
      : `${local} file importati sul telefono — ascoltabili offline`, 'ok');
  },

  setHomeCache: (sugg, charts) => {
    const v = { sugg, charts, at: Date.now() };
    try { localStorage.setItem(get().homeCacheKey(), JSON.stringify(v)); } catch { /* quota */ }
    set({ homeCache: v });
  },

  toasts: [],
  toast: (text, kind = 'info', action) => {
    // Dedup: offline ogni azione fallisce con lo stesso errore → niente spam
    if (get().toasts.some((t) => t.text === text)) return;
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, action }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 7000 : 4000);
  },
}));

// Durata di un file audio locale (metadata del browser), undefined se illeggibile
function audioDuration(f: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const a = new Audio();
    const done = (d?: number) => { URL.revokeObjectURL(url); resolve(d && Number.isFinite(d) ? Math.round(d) : undefined); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done();
    setTimeout(() => done(), 5000);
    a.src = url;
  });
}

// Download progressivo dal PC con deadline: 20s agli header, 30s senza byte
// sul corpo → abort (il chiamante ripiega sullo stream diretto). Progresso
// 0..1 via onPct quando Content-Length è noto.
async function fetchTrackBlob(url: string, onPct?: (pct: number) => void): Promise<Blob | null> {
  const ctl = new AbortController();
  const dead = (ms: number) => setTimeout(() => ctl.abort(), ms);
  let timer = dead(20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal }).catch(() => null);
    if (!res?.ok || !res.body) return null;
    const total = Number(res.headers.get('content-length') ?? 0);
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      clearTimeout(timer); timer = dead(30_000); // stallo: byte fermi → abort
      chunks.push(value);
      got += value.length;
      if (total > 0 && onPct) onPct(Math.min(1, got / total));
    }
    // Corpo troncato (TCP RST a metà download): MAI persistere un blob
    // "completo" fasullo — null → il chiamante ripiega sullo stream diretto.
    if (!got || (total > 0 && got !== total)) return null;
    return new Blob(chunks, { type: res.headers.get('content-type') ?? 'audio/mpeg' });
  } catch { return null; } // abort/rete: il chiamante decide il fallback
  finally { clearTimeout(timer); }
}

// Persistenza coda: salva (debounced) a ogni cambio del player
let qTimer: ReturnType<typeof setTimeout> | undefined;
useApp.subscribe((s, prev) => {
  if (s.player === prev.player) return;
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const p = useApp.getState().player;
    // 'mh-pref-queue' → la coda si condivide col PC: riprendi dove eri rimasto
    savePref(QUEUE_KEY, { queue: p.queue.slice(0, 200), index: p.queueIndex, radio: p.radio });
  }, 800);
});

// Cambi live dall'altro dispositivo (broadcast prefs del DB condiviso):
// applica solo allo stato — niente savePref, il valore è già sul server.
window.addEventListener('mh-pref-live', (e) => {
  const key = (e as CustomEvent<string>).detail;
  const s = useApp.getState();
  if (key === CD_KEY) {
    try {
      const ids = JSON.parse(localStorage.getItem(CD_KEY) ?? '[]') as number[];
      const cdQueue = ids.map((id) => s.library.find((t) => t.id === id)).filter((t): t is LibraryTrack => !!t);
      useApp.setState({ cdQueue });
    } catch { /* */ }
  } else if (key === VOL_KEY) {
    const volume = savedVolume();
    useApp.setState({ player: { ...s.player, volume } });
  } else if (key === PREF_KEY) {
    useApp.setState({ player: { ...s.player, ...savedPrefs() } });
  } else if (key === XF_KEY) {
    useApp.setState({ player: { ...s.player, crossfade: savedXf() } });
  }
  // mh-pref-queue e mh-pref-screen non si applicano live: non interrompiamo
  // la riproduzione né rubiamo la navigazione — valgono al prossimo avvio.
});

// Rete di sicurezza: una promise rifiutata non gestita (es. azione su schermata
// con PC spento) diventa un toast invece di rumore muto in console. Gli errori
// "offline"/"non configurato" sono attesi — li spiega già il banner.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? '');
  if (/^(offline|non configurato|unauthorized)/.test(msg)) return;
  useApp.getState().toast(`Operazione non riuscita${msg ? `: ${msg.slice(0, 140)}` : ''}`, 'err');
});

// Debug/testing via CDP
(window as unknown as { __app: typeof useApp }).__app = useApp;

// Auto-test dispositivo (Impostazioni → Verifica): esposto su window anche per
// i test CDP — gira il codice VERO dell'app, niente mock.
import { runSelfTest } from './selftest';
(window as unknown as { __selftest: typeof runSelfTest }).__selftest = runSelfTest;
