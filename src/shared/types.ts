// Tipi condivisi tra main e renderer + nomi canali IPC.

export interface TrackRef {
  id?: number; // id in libreria (se scaricata)
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  durationS?: number;
  thumbnail?: string;
  source: 'ytmusic' | 'youtube' | 'library';
  filePath?: string;
}

export interface LibraryTrack extends TrackRef {
  id: number;
  filePath: string;
  coverPath?: string;
  genre?: string;
  year?: number;
  addedAt: number;
  playCount: number;
  liked: boolean;
  // Renderer remoto: esiste SOLO nella memoria del telefono (eliminato sul PC
  // o mai sincronizzato) — visibile e riproducibile, ma niente azioni lato PC
  phoneOnly?: boolean;
}

export interface SearchResult {
  songs: TrackRef[];
  albums: AlbumRef[];
  artists: ArtistRef[];
  playlists: PlaylistRef[];
  topResult?: TopResult;
  correctedQuery?: string; // "Forse cercavi…"
  // La risposta cruda conteneva item riproducibili ma il parser non ne ha
  // estratto nessuno (layout Innertube cambiato): NON è "nessun risultato" —
  // la UI lo dichiara invece di mostrare una pagina vuota fasulla.
  degraded?: boolean;
}

export interface TopResult {
  kind: 'artist' | 'album' | 'song' | 'playlist';
  id: string; // browseId o videoId
  title: string;
  subtitle: string;
  thumbnail?: string;
  // Solo kind song/album: estratti dal sottotitolo della card
  artist?: string;
  durationS?: number;
}

export interface ArtistPage {
  id: string;
  name: string;
  thumbnail?: string;
  subscribers?: string;
  description?: string;
  topSongs: TrackRef[];
  albums: AlbumRef[];
  singles: AlbumRef[];
  related: ArtistRef[];
  playlists: PlaylistRef[];
  videos: TrackRef[]; // live/video musicali (audio scaricabile lo stesso)
}

export interface PlaylistRef {
  id: string;
  title: string;
  author?: string;
  thumbnail?: string;
}

export interface AlbumRef {
  browseId: string;
  title: string;
  artist: string;
  year?: string;
  thumbnail?: string;
}

export interface ArtistRef {
  browseId: string;
  name: string;
  subscribers?: string;
  thumbnail?: string;
}

export interface Playlist {
  id: number;
  name: string;
  kind: 'cd-audio' | 'cd-mp3' | 'lista';
  createdAt: number;
  tracks?: LibraryTrack[];
}

export interface SuggestedTrack extends TrackRef {
  score: number;
  reason: string;
  sources: string[];
}

export interface TrendItem {
  title: string;
  artist: string;
  rank: number;
  sources: string[];
  niche: boolean;
  videoId?: string;
  thumbnail?: string;
}

export interface DriveInfo {
  id: string;
  name: string;
  driveLetter: string;
  mediaPresent: boolean;
  mediaBlank: boolean;
  mediaType: string;
  /** Stato IMAPI decodificato: blank|appendable|final-session|non-empty-session|finalized|protected|damaged|unsupported|erase-required */
  mediaState?: string;
  freeSectors: number;
  totalSectors: number;
}

export type BurnKind = 'audio' | 'data' | 'erase';

export interface BurnProgress {
  jobId: string;
  phase: 'prepare' | 'write' | 'finalize' | 'done' | 'error';
  percent: number;
  currentTrack?: string;
  trackIndex?: number;
  trackCount?: number;
  message?: string;
}

export type DownloadStatus = 'queued' | 'downloading' | 'converting' | 'tagging' | 'done' | 'error';

export interface DownloadJob {
  id: string;
  track: TrackRef;
  status: DownloadStatus;
  percent: number;
  error?: string;
  filePath?: string;
  userId?: number; // utente che ha accodato: l'evento "download" alimenta il SUO profilo gusti
}

export interface MhUser {
  id: number;
  name: string;
  color: string;
  createdAt: number;
}

// Dispositivo remoto pairato: token per device legato a UN profilo (userId
// null = pairato ma in attesa della scelta "Chi sei?"). Il token in chiaro
// non esce mai dal server/DB — qui arriva solo la vista pubblica.
export interface MhDevice {
  id: number;
  name: string;
  userId: number | null;
  createdAt: number;
  lastSeen: number;
}

export interface Settings {
  libraryDir: string;
  audioQuality: '320' | '256' | '192';
  normalizeAudio: boolean;
  trimSilence: boolean;
  burnSpeed: number; // 0 = auto
  country: string; // per charts, es. 'IT'
  lastfmApiKey: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyConnected: boolean;
  spotifyRefreshToken: string;
  autoUpdateTools: boolean; // aggiorna yt-dlp da solo quando esce una release nuova
  remoteEnabled: boolean; // server LAN per telefono/tablet
  remoteToken: string;    // codice di pairing (generato automaticamente)
  remotePort: number;     // porta del server LAN
  keepAwake: boolean;     // il PC non va in sospensione mentre il server remoto è attivo
  autostart: boolean;     // avvia con Windows: il server resta raggiungibile dal telefono
  currentUser: number;    // profilo attivo sul PC (i dispositivi remoti scelgono il loro)
  updateUrl: string;      // feed pubblico aggiornamenti (EXE + APK) — '' = nessuno
  autoUpdateApp: boolean; // controlla/scarica da solo le nuove versioni dell'app
}

// Stato dell'auto-aggiornamento dell'app desktop (electron-updater)
export interface AppUpdateState {
  phase: 'idle' | 'disabled' | 'checking' | 'downloading' | 'ready' | 'uptodate' | 'error';
  current: string;   // versione installata
  version?: string;  // versione in arrivo / pronta
  pct?: number;      // progresso download 0..1
  msg?: string;
  notes?: string;
  feed?: string;
}

// Info versione del PC (anche per i telefoni: che app gira e che APK serve)
export interface AppInfo {
  version: string;
  apk?: { versionCode: number; versionName?: string; size?: number };
  feed?: string;
}

export interface AssistantRequest {
  vibe: string; // es. 'energico', 'chill', 'anni90', 'scoperte'
  targetMinutes: number; // 74/80 per audio CD, 0 = mp3
  discoveryPct: number; // 0-100 quota brani nuovi
  prompt?: string; // testo libero: "rock anni 90 per un viaggio con Ligabue, senza Jovanotti"
  seedArtists?: string[]; // "parti da questi artisti"
  excludeArtists?: string[]; // "senza questi"
}

export interface AssistantResult {
  tracks: SuggestedTrack[];
  alternates: SuggestedTrack[]; // ricambi per "sostituisci" sul risultato
  totalMinutes: number;
  explanation: string;
  parsed?: { seeds: string[]; excluded: string[]; extraTags: string[] }; // cosa ha capito dal prompt
}

export interface AppStats {
  trackCount: number;
  totalMinutes: number;
  playlistCount: number;
  burnedCount: number;
  topArtists: { artist: string; weight: number }[];
  topGenres: { genre: string; weight: number }[];
}

// ---- Stazioni: raccolte tipo radio per mood/genere/decennio/novità ----
// Click → coda iniziale + radio infinita, senza dover cercare i titoli.

// Testo del brano (LRCLIB): synced = righe LRC con timestamp in secondi
export interface LyricsResult {
  found: boolean;
  synced?: { t: number; text: string }[];
  plain?: string;
}

// Onboarding cold-start: artista proposto al primo avvio di un profilo
export interface OnboardArtist { name: string; thumbnail?: string }

export interface RemoteLike {
  videoId: string; title: string; artist: string; thumbnail?: string; durationS?: number; ts: number;
}

// ---- Telemetria / auto-miglioramento ----

export interface PlayStreamResult {
  url: string;
  videoId: string;   // può differire da quello richiesto se il brano è stato auto-riparato
  healed: boolean;
}

export interface IssueEntry {
  ts: number; kind: string; message?: string;
  artist?: string; title?: string; videoId?: string; query?: string; healed: number;
}

export interface IssueStats {
  byKind: Record<string, number>;
  healed: number;        // brani riparati automaticamente
  bad: number;           // stream difettosi conosciuti
  picks: number;         // scelte di ricerca imparate
  topFailing: { artist: string; title: string; c: number }[];
  recent: IssueEntry[];
  // Campioni della cascata stream per client Innertube (ultimi 7gg, dal campo):
  // okRate basso su un client = quel client sta morendo, non la rete.
  clients?: { client: string; n: number; okRate: number; avgMs: number; devices: string[] }[];
}

export interface StationDef {
  id: string;
  name: string;
  desc: string;
  group: 'per-te' | 'mood' | 'genere' | 'decennio' | 'news';
  query?: string;       // stazioni generiche: risolte con ricerca YT Music
  grad: string;         // gradiente tailwind della card
}

export const STATIONS: StationDef[] = [
  // Personalizzate (risolte dal profilo gusti, non da query)
  { id: 'per-te', name: 'La tua stazione', desc: 'I tuoi artisti e i loro affini, in flusso continuo', group: 'per-te', grad: 'from-accent to-accent2' },
  { id: 'preferiti', name: 'I tuoi preferiti', desc: 'Tutto ciò che hai messo tra i preferiti', group: 'per-te', grad: 'from-rose-500 to-pink-700' },
  { id: 'novita-te', name: 'Novità per te', desc: 'Uscite recenti vicine ai tuoi gusti', group: 'per-te', grad: 'from-emerald-500 to-teal-700' },
  { id: 'scoperte', name: 'Scoperte', desc: 'Brani nuovi scelti dal motore dei gusti', group: 'per-te', grad: 'from-amber-400 to-rose-700' },
  // Mood
  { id: 'energia', name: 'Energia', desc: 'Carica massima: rock, edm, pump up', group: 'mood', query: 'workout pump up energetic hits', grad: 'from-orange-500 to-red-700' },
  { id: 'chill', name: 'Chill', desc: 'Acustica, relax e atmosfera', group: 'mood', query: 'chill acoustic relaxing songs', grad: 'from-teal-300 to-emerald-700' },
  { id: 'festa', name: 'Festa', desc: 'Dance e hit da cantare a squarciagola', group: 'mood', query: 'party dance hits', grad: 'from-yellow-400 to-pink-700' },
  { id: 'viaggio', name: 'Viaggio', desc: 'La colonna sonora della strada', group: 'mood', query: 'road trip driving rock classics', grad: 'from-amber-500 to-orange-700' },
  { id: 'romantico', name: 'Romantico', desc: 'Ballad e canzoni d\'amore', group: 'mood', query: 'love songs romantic ballads', grad: 'from-pink-400 to-rose-700' },
  { id: 'sera', name: 'Sera', desc: 'Lounge, jazz e ritmi lenti', group: 'mood', query: 'evening lounge jazz downtempo', grad: 'from-amber-700 to-stone-900' },
  // Generi
  { id: 'italiana', name: 'Italiana', desc: 'Cantautori e pop italiano', group: 'genere', query: 'canzoni italiane belle cantautori', grad: 'from-green-500 to-emerald-800' },
  { id: 'rap-it', name: 'Rap italiano', desc: 'La scena rap e trap di casa nostra', group: 'genere', query: 'rap italiano hits', grad: 'from-zinc-500 to-neutral-800' },
  { id: 'rock', name: 'Rock', desc: 'Chitarre, classici e new wave', group: 'genere', query: 'rock classics hits', grad: 'from-red-600 to-stone-800' },
  { id: 'dance', name: 'Dance', desc: 'EDM, club e mani al cielo', group: 'genere', query: 'edm dance club hits', grad: 'from-pink-500 to-orange-600' },
  { id: 'indie-it', name: 'Indie italiano', desc: 'L\'altra faccia del pop italiano', group: 'genere', query: 'indie italiano', grad: 'from-lime-500 to-green-800' },
  { id: 'latina', name: 'Latina', desc: 'Reggaeton e ritmi latini', group: 'genere', query: 'latin reggaeton hits', grad: 'from-yellow-500 to-orange-700' },
  // Decenni
  { id: 'anni70', name: 'Anni \'70', desc: 'I classici che non muoiono mai', group: 'decennio', query: 'anni 70 hits 70s classics', grad: 'from-amber-600 to-yellow-800' },
  { id: 'anni80', name: 'Anni \'80', desc: 'Synth, pop e spalline', group: 'decennio', query: 'anni 80 hits 80s', grad: 'from-pink-500 to-rose-800' },
  { id: 'anni90', name: 'Anni \'90', desc: 'Eurodance e pop della decade', group: 'decennio', query: 'anni 90 dance hits 90s', grad: 'from-teal-500 to-green-800' },
  { id: 'anni2000', name: 'Anni 2000', desc: 'Le hit del nuovo millennio', group: 'decennio', query: 'hits anni 2000 2000s', grad: 'from-slate-400 to-teal-800' },
  { id: 'anni2010', name: 'Anni 2010', desc: 'Il decennio dello streaming', group: 'decennio', query: '2010s hits', grad: 'from-slate-500 to-gray-800' },
  // News
  { id: 'classifiche', name: 'In classifica ora', desc: 'Le hit del momento in Italia', group: 'news', grad: 'from-accent2 to-accent' },
];

// ---- Canali IPC ----
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsEvent: 'settings:event', // broadcast live PC↔telefono a ogni settings.set
  search: 'yt:search',
  searchSuggest: 'yt:searchSuggest',
  streamUrl: 'yt:streamUrl',
  playStream: 'yt:playStream',
  videoUrl: 'yt:videoUrl',
  loudness: 'yt:loudness',
  searchPick: 'yt:searchPick',
  lyrics: 'yt:lyrics',
  upNext: 'yt:upNext',
  charts: 'yt:charts',
  albumTracks: 'yt:albumTracks',
  artistTop: 'yt:artistTop',
  artistPage: 'yt:artistPage',
  playlistTracks: 'yt:playlistTracks',
  downloadEnqueue: 'dl:enqueue',
  downloadList: 'dl:list',
  downloadEvent: 'dl:event',
  downloadRetry: 'dl:retry',
  downloadDismiss: 'dl:dismiss',
  downloadClear: 'dl:clear',
  libraryList: 'lib:list',
  libraryRemove: 'lib:remove',
  libraryRestore: 'lib:restore',
  libraryStats: 'lib:stats',
  libraryLike: 'lib:like',
  libraryPlay: 'lib:play',
  librarySkip: 'lib:skip',
  libraryImport: 'lib:import',
  libraryRecent: 'lib:recent',
  libraryChanged: 'lib:changed', // broadcast: un dispositivo ha modificato la libreria → l'altro ricarica
  libraryLikeRemote: 'lib:likeRemote',
  libraryRemoteLikes: 'lib:remoteLikes',
  libraryRemoteEvent: 'lib:remoteEvent',
  libraryTaste: 'lib:taste',
  libraryTasteReset: 'lib:tasteReset',
  libraryListen: 'lib:listen',        // completamento ascolto (motore gusti v2)
  libraryTasteSeed: 'lib:tasteSeed',  // onboarding: semina il profilo con artisti scelti
  recOnboard: 'rec:onboard',          // artisti proposti per l'onboarding
  uxTrack: 'ux:track',                // uso funzioni (solo locale)
  playlistList: 'pl:list',
  playlistCreate: 'pl:create',
  playlistDelete: 'pl:delete',
  playlistRename: 'pl:rename',
  playlistAdd: 'pl:add',
  playlistRemove: 'pl:remove',
  playlistMove: 'pl:move',
  playlistReorder: 'pl:reorder',      // convergenza ordine post-drain (telefono vince)
  playlistExport: 'pl:export',
  recommend: 'rec:suggest',
  assistant: 'rec:assistant',
  station: 'rec:station',
  stationNext: 'rec:next',          // continuazione radio con contesto stazione
  radio: 'rec:radio',
  autoplaylist: 'rec:autoplaylist',
  trends: 'trends:get',
  trendsRefresh: 'trends:refresh',
  burnDrives: 'burn:drives',
  burnStart: 'burn:start',
  burnErase: 'burn:erase',
  burnEject: 'burn:eject',
  burnEvent: 'burn:event',
  spotifyAuth: 'spotify:auth',
  spotifyStatus: 'spotify:status',
  spotifyImport: 'spotify:importTaste',
  testLastfm: 'lastfm:test',
  openFolder: 'sys:openFolder',
  pickFolder: 'sys:pickFolder',
  mediaKey: 'player:mediaKey',
  playerState: 'player:state',
  issuesStats: 'diag:stats',
  issuesClear: 'diag:clear',
  issuesExport: 'diag:export',
  issuesReport: 'diag:report',
  backupExport: 'backup:export',
  backupImport: 'backup:import',
  backupData: 'backup:data',          // backup come JSON (il telefono lo salva in locale)
  issuesReportText: 'diag:reportText', // report diagnostica come testo (idem)
  streamStats: 'diag:streamStats',   // batch di campioni cascata dal campo {client,ms,ok,device}
  remoteInfo: 'remote:info',
  pairingOpen: 'pairing:open',     // apre la finestra "Accoppia telefono" (~90s)
  pairingStatus: 'pairing:status', // ms residui della finestra
  pairingUsed: 'pairing:used',     // broadcast: un device ha completato /pair
  pairingCode: 'pairing:code',     // mint codice monouso per il QR (admin-only)
  prefsGet: 'remote:prefs:get',
  prefsSet: 'remote:prefs:set',
  prefsEvent: 'remote:prefs:event', // broadcast live PC↔telefono a ogni set
  // ---- Profili utente ----
  usersList: 'users:list',
  usersCreate: 'users:create',
  usersRename: 'users:rename',
  usersRemove: 'users:remove',
  usersCurrent: 'users:current',
  usersSetCurrent: 'users:setCurrent',
  // ---- Dispositivi remoti (token per device → profilo) ----
  // list/revoke/setUser = gestione dal PC (admin-only da remoto);
  // register/claim/whoami = bootstrap del device, gestiti dentro remote.ts.
  deviceList: 'device:list',
  deviceRevoke: 'device:revoke',
  deviceRevokeAll: 'device:revokeAll', // scollega TUTTI i device (admin)
  deviceSetUser: 'device:setUser',     // args (deviceId, userId|null)
  deviceRegister: 'device:register',   // admin → mint di un token dispositivo
  deviceClaim: 'device:claim',         // lega QUESTO device al profilo scelto
  deviceWhoami: 'device:whoami',       // {admin, user} del token corrente
  // ---- Versione / aggiornamenti app ----
  appInfo: 'app:info',                 // versione PC + APK servito ai telefoni
  appUpdateStatus: 'app:updStatus',
  appUpdateCheck: 'app:updCheck',
  appUpdateInstall: 'app:updInstall',  // desktop-only (riavvia il PC-server)
  appUpdateEvent: 'app:updEvent',      // broadcast stato download/pronto
  // ---- Playlist con brani non ancora in libreria ----
  playlistAddRef: 'pl:addRef',         // aggiunge un TrackRef: se manca lo scarica e lo aggiunge al 'done'
} as const;
