import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC } from '../shared/types';
import type {
  Settings, TrackRef, SearchResult, DownloadJob, LibraryTrack, Playlist,
  SuggestedTrack, TrendItem, DriveInfo, BurnProgress, AssistantRequest,
  AssistantResult, AppStats, AlbumRef, ArtistPage, RemoteLike, LyricsResult,
  PlayStreamResult, IssueStats, MhUser, MhDevice, OnboardArtist, AppInfo, AppUpdateState,
} from '../shared/types';

const on = (channel: string) => (cb: (payload: unknown) => void) => {
  const l = (_e: Electron.IpcRendererEvent, p: unknown) => cb(p);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, patch),
    // Ogni setSettings (nostro, di un altro client o interno al main)
    // broadcasta lo stato intero: i renderer lo applicano live.
    onEvent: on(IPC.settingsEvent) as (cb: (s: Settings) => void) => () => void,
  },
  yt: {
    search: (q: string, expand?: boolean): Promise<SearchResult> => ipcRenderer.invoke(IPC.search, q, expand),
    streamUrl: (videoId: string): Promise<string> => ipcRenderer.invoke(IPC.streamUrl, videoId),
    // Risoluzione auto-riparante: se lo stream è difettoso cerca un'alternativa da solo
    playStream: (videoId: string, artist: string, title: string): Promise<PlayStreamResult> =>
      ipcRenderer.invoke(IPC.playStream, videoId, artist, title),
    searchPick: (query: string, t: { videoId: string; artist?: string; title?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.searchPick, query, t),
    suggest: (q: string): Promise<string[]> => ipcRenderer.invoke(IPC.searchSuggest, q),
    videoUrl: (videoId: string, maxH?: number): Promise<string> => ipcRenderer.invoke(IPC.videoUrl, videoId, maxH),
    // LUFS misurato per lo stream (null finché l'analisi in background non finisce)
    loudness: (videoId: string): Promise<number | null> => ipcRenderer.invoke(IPC.loudness, videoId),
    lyrics: (artist: string, title: string, durationS?: number): Promise<LyricsResult> =>
      ipcRenderer.invoke(IPC.lyrics, artist, title, durationS),
    upNext: (videoId: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.upNext, videoId),
    charts: (country: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.charts, country),
    albumTracks: (id: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.albumTracks, id),
    artistTop: (id: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.artistTop, id),
    artistPage: (id: string): Promise<ArtistPage> => ipcRenderer.invoke(IPC.artistPage, id),
    playlistTracks: (id: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.playlistTracks, id),
  },
  downloads: {
    enqueue: (t: TrackRef): Promise<DownloadJob> => ipcRenderer.invoke(IPC.downloadEnqueue, t),
    list: (): Promise<DownloadJob[]> => ipcRenderer.invoke(IPC.downloadList),
    retry: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.downloadRetry, id),
    dismiss: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.downloadDismiss, id),
    clearFinished: (): Promise<number> => ipcRenderer.invoke(IPC.downloadClear),
    onEvent: on(IPC.downloadEvent) as (cb: (j: DownloadJob) => void) => () => void,
  },
  library: {
    list: (): Promise<LibraryTrack[]> => ipcRenderer.invoke(IPC.libraryList),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.libraryRemove, id),
    restore: (id: number): Promise<void> => ipcRenderer.invoke(IPC.libraryRestore, id),
    stats: (): Promise<AppStats> => ipcRenderer.invoke(IPC.libraryStats),
    like: (id: number, liked: boolean): Promise<void> => ipcRenderer.invoke(IPC.libraryLike, id, liked),
    play: (id: number): Promise<void> => ipcRenderer.invoke(IPC.libraryPlay, id),
    skip: (id: number): Promise<void> => ipcRenderer.invoke(IPC.librarySkip, id),
    importFiles: (paths: string[]): Promise<number> => ipcRenderer.invoke(IPC.libraryImport, paths),
    recent: (limit?: number): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.libraryRecent, limit),
    // like su tracce non scaricate + eventi di ascolto da stream remoto
    likeRemote: (t: TrackRef, liked: boolean): Promise<void> => ipcRenderer.invoke(IPC.libraryLikeRemote, t, liked),
    remoteLikes: (): Promise<RemoteLike[]> => ipcRenderer.invoke(IPC.libraryRemoteLikes),
    remoteEvent: (e: { trackId?: number; artist: string; title?: string; videoId?: string; thumbnail?: string; type: 'play' | 'skip' | 'hide' }): Promise<void> =>
      ipcRenderer.invoke(IPC.libraryRemoteEvent, e),
    taste: (kind?: string): Promise<{ kind: string; value: string; weight: number }[]> =>
      ipcRenderer.invoke(IPC.libraryTaste, kind),
    tasteReset: (): Promise<void> => ipcRenderer.invoke(IPC.libraryTasteReset),
    // Motore gusti v2: completamento reale dell'ascolto (0..1) e onboarding
    listen: (r: { trackId?: number; videoId?: string; artist: string; title?: string; thumbnail?: string; playedS: number; durationS?: number }): Promise<void> =>
      ipcRenderer.invoke(IPC.libraryListen, r),
    tasteSeed: (names: string[]): Promise<void> => ipcRenderer.invoke(IPC.libraryTasteSeed, names),
    // Broadcast "libreria cambiata" dall'altro dispositivo → ricarica live
    onChanged: on(IPC.libraryChanged) as (cb: () => void) => () => void,
  },
  playlists: {
    list: (): Promise<Playlist[]> => ipcRenderer.invoke(IPC.playlistList),
    create: (name: string, kind: Playlist['kind']): Promise<Playlist> => ipcRenderer.invoke(IPC.playlistCreate, name, kind),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.playlistDelete, id),
    rename: (id: number, name: string): Promise<void> => ipcRenderer.invoke(IPC.playlistRename, id, name),
    add: (plId: number, trackId: number): Promise<void> => ipcRenderer.invoke(IPC.playlistAdd, plId, trackId),
    removeTrack: (plId: number, trackId: number): Promise<void> => ipcRenderer.invoke(IPC.playlistRemove, plId, trackId),
    move: (plId: number, trackId: number, dir: -1 | 1): Promise<void> => ipcRenderer.invoke(IPC.playlistMove, plId, trackId, dir),
    export: (id: number): Promise<string | null> => ipcRenderer.invoke(IPC.playlistExport, id),
    // Qualsiasi brano (anche non scaricato): se manca il PC lo scarica e
    // lo aggiunge alla playlist appena pronto
    addRef: (plId: number, t: TrackRef): Promise<{ added: boolean; queued: boolean }> =>
      ipcRenderer.invoke(IPC.playlistAddRef, plId, t),
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.appInfo),
    updateStatus: (): Promise<AppUpdateState> => ipcRenderer.invoke(IPC.appUpdateStatus),
    updateCheck: (): Promise<AppUpdateState> => ipcRenderer.invoke(IPC.appUpdateCheck),
    updateInstall: (): Promise<void> => ipcRenderer.invoke(IPC.appUpdateInstall),
    onUpdateEvent: on(IPC.appUpdateEvent) as (cb: (s: AppUpdateState) => void) => () => void,
  },
  rec: {
    suggest: (): Promise<SuggestedTrack[]> => ipcRenderer.invoke(IPC.recommend),
    assistant: (req: AssistantRequest): Promise<AssistantResult> => ipcRenderer.invoke(IPC.assistant, req),
    station: (id: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.station, id),
    radio: (kind: 'artist' | 'genre', value: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.radio, kind, value),
    next: (videoId: string, artist: string, ctx?: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.stationNext, videoId, artist, ctx),
    autoplaylist: (id: string): Promise<TrackRef[]> => ipcRenderer.invoke(IPC.autoplaylist, id),
    onboard: (): Promise<OnboardArtist[]> => ipcRenderer.invoke(IPC.recOnboard),
    trends: (): Promise<TrendItem[]> => ipcRenderer.invoke(IPC.trends),
    trendsRefresh: (): Promise<TrendItem[]> => ipcRenderer.invoke(IPC.trendsRefresh),
  },
  burn: {
    drives: (): Promise<DriveInfo[]> => ipcRenderer.invoke(IPC.burnDrives),
    start: (kind: 'audio' | 'data', driveId: string, tracks: LibraryTrack[], name: string): Promise<void> =>
      ipcRenderer.invoke(IPC.burnStart, kind, driveId, tracks, name),
    erase: (driveId: string, full: boolean): Promise<void> => ipcRenderer.invoke(IPC.burnErase, driveId, full),
    eject: (driveId: string): Promise<void> => ipcRenderer.invoke(IPC.burnEject, driveId),
    onEvent: on(IPC.burnEvent) as (cb: (p: BurnProgress) => void) => () => void,
  },
  spotify: {
    auth: (): Promise<boolean> => ipcRenderer.invoke(IPC.spotifyAuth),
    status: (): Promise<boolean> => ipcRenderer.invoke(IPC.spotifyStatus),
    importTaste: (): Promise<{ imported: number }> => ipcRenderer.invoke(IPC.spotifyImport),
  },
  lastfm: {
    test: (key: string): Promise<boolean> => ipcRenderer.invoke(IPC.testLastfm, key),
  },
  player: {
    // tasti multimediali hardware (play/pausa/avanti/indietro) dal main
    onMediaKey: on(IPC.mediaKey) as (cb: (action: 'toggle' | 'next' | 'prev') => void) => () => void,
    // stato now-playing verso il main (tray icon: tooltip + menu)
    updateState: (s: { title?: string; artist?: string; playing: boolean }): void =>
      ipcRenderer.send(IPC.playerState, s),
  },
  diag: {
    stats: (): Promise<IssueStats> => ipcRenderer.invoke(IPC.issuesStats),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.issuesClear),
    exportReport: (): Promise<string | null> => ipcRenderer.invoke(IPC.issuesExport),
    reportText: (): Promise<string> => ipcRenderer.invoke(IPC.issuesReportText),
    report: (kind: string, d: { message?: string; artist?: string; title?: string; videoId?: string; query?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.issuesReport, kind, d),
    // Uso funzioni (schermate/azioni): solo locale, per capire cosa migliorare
    track: (name: string): Promise<void> => ipcRenderer.invoke(IPC.uxTrack, name),
  },
  backup: {
    export: (): Promise<string | null> => ipcRenderer.invoke(IPC.backupExport),
    import: (data?: unknown): Promise<{ taste: number; likes: number; playlists: number; device?: number } | null> =>
      ipcRenderer.invoke(IPC.backupImport, data),
    data: (): Promise<unknown> => ipcRenderer.invoke(IPC.backupData),
  },
  sys: {
    openFolder: (p: string): Promise<void> => ipcRenderer.invoke(IPC.openFolder, p),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickFolder),
    // Electron >=32: File.path non esiste più, serve webUtils
    pathForFile: (f: File): string => webUtils.getPathForFile(f),
  },
  remote: {
    // Info di pairing per il telefono: indirizzo LAN, porta, codice,
    // indirizzi alternativi (es. Tailscale per raggiungere il PC fuori casa)
    info: (): Promise<{ enabled: boolean; ip: string; port: number; token: string; alts: string[] }> =>
      ipcRenderer.invoke(IPC.remoteInfo),
  },
  pairing: {
    // "Accoppia telefono": per ~90s /pair consegna il codice ai device che
    // chiedono (trovati via discovery UDP) — zero digitazione sul telefono.
    open: (): Promise<{ leftMs: number }> => ipcRenderer.invoke(IPC.pairingOpen),
    status: (): Promise<{ leftMs: number }> => ipcRenderer.invoke(IPC.pairingStatus),
    // Codice monouso per il QR (TTL ~5min): il QR non porta più il codice
    // condiviso admin — lo riscatta in un device token via /pair.
    code: (): Promise<{ code: string; leftMs: number }> => ipcRenderer.invoke(IPC.pairingCode),
    onUsed: on(IPC.pairingUsed) as (cb: (p: { name?: string; ip: string }) => void) => () => void,
  },
  prefs: {
    // Preferenze condivise nella tabella prefs del DB: il PC le pubblica
    // e i client remoti le leggono — memoria unica tra desktop e telefono,
    // namespacizzata sul profilo corrente (gli altri profili sono invisibili)
    getAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke(IPC.prefsGet),
    set: (k: string, v: unknown): Promise<void> => ipcRenderer.invoke(IPC.prefsSet, k, v),
    onEvent: on(IPC.prefsEvent) as (cb: (p: { k: string; v: unknown; u?: number }) => void) => () => void,
  },
  users: {
    // Profili utente: gusti/preferiti/playlist separati per persona.
    // setCurrent cambia il profilo DEL PC (desktop-only); il renderer fa reload.
    list: (): Promise<MhUser[]> => ipcRenderer.invoke(IPC.usersList),
    create: (name: string): Promise<MhUser> => ipcRenderer.invoke(IPC.usersCreate, name),
    rename: (id: number, name: string): Promise<void> => ipcRenderer.invoke(IPC.usersRename, id, name),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.usersRemove, id),
    current: (): Promise<number> => ipcRenderer.invoke(IPC.usersCurrent),
    setCurrent: (id: number): Promise<number> => ipcRenderer.invoke(IPC.usersSetCurrent, id),
  },
  devices: {
    // Dispositivi remoti pairati: token per device legato a UN profilo.
    // Gestione dal PC — da remoto questi canali sono admin-only (403).
    list: (): Promise<MhDevice[]> => ipcRenderer.invoke(IPC.deviceList),
    revoke: (id: number): Promise<void> => ipcRenderer.invoke(IPC.deviceRevoke, id),
    // Compromesso/sniffato: scollega TUTTI i device in un colpo
    revokeAll: (): Promise<number> => ipcRenderer.invoke(IPC.deviceRevokeAll),
    // Riassegna il profilo di un device (null = slega: ri-sceglierà al gate)
    setUser: (id: number, userId: number | null): Promise<void> => ipcRenderer.invoke(IPC.deviceSetUser, id, userId),
  },
};

export type MasterHypeApi = typeof api;
contextBridge.exposeInMainWorld('masterhype', api);
