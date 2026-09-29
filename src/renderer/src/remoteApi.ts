// Specchio di MasterHypeApi via HTTP: ogni metodo chiama il PC con call()
// (remote.ts) e, dove serve, ripiega su cache/diretto/coda quando il PC è giù.
// Gli helper qui sotto (ytCall/cached/localFirst/plOp…) sono ESCLUSIVI di
// questo specchio — la connessione (conf, SSE, online) resta in remote.ts.

import { IPC } from '../../shared/types';
import type { Playlist, TrackRef, AppStats, AppInfo, AppUpdateState, MhDevice } from '../../shared/types';
import type { MasterHypeApi } from '../../preload/index';
import {
  callRemote as call, on, isOnline, myUserId, pcGone, markPcFresh,
  claimProfile, setRemoteUser,
} from './remote';
import { enqueueIssue } from './fieldDiag';
import {
  directSearch, directStream, directPlayStream, directVideoUrl, directSuggestions,
  directLyrics, directUpNext, directCharts, directAlbumTracks, directArtistTop,
  directArtistPage, directPlaylistTracks,
} from './direct';

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
    // Report fallito per rete giù → va in coda mh-pending-issues e risale al
    // reconnect (drainFieldDiag); errore applicativo a PC vivo → non si accoda.
    report: (k, d) => call<void>(IPC.issuesReport, k, d).catch((e) => {
      if (!isOnline()) enqueueIssue(k, d);
      throw e;
    }),
    streamStats: (rows) => call<void>(IPC.streamStats, rows),
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
    current: () => Promise.resolve(myUserId()),
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
