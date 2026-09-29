import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { app, shell } from 'electron';
import { IPC } from '../shared/types';
import type { Settings, TrackRef, Playlist, AssistantRequest, LibraryTrack, AppInfo } from '../shared/types';
import * as appUpdate from './services/appUpdate';
import { getSettings, setSettings } from './settings';
import * as ytmusic from './services/ytmusic';
import * as downloader from './services/downloader';
import * as library from './services/library';
import * as burner from './services/burner';
import * as sources from './services/sources';
import * as users from './services/users';
import * as devices from './services/devices';
import { suggest, assistant, stationTracks, stationContinue, radioForArtist, radioForGenre, autoPlaylist } from './services/recommend';
import { getTrends } from './services/trends';
import * as telemetry from './services/telemetry';
import * as engine from './services/engine';
import { exportBackup, importBackup } from './services/backup';
import { getDb } from './db';

// Mappa canale → handler: UNICA sorgente di verità, usata sia da ipc.ts
// (ipcMain.handle) sia dal server remoto LAN (remote.ts). Così il telefono
// ottiene esattamente lo stesso comportamento del desktop — ricerca che
// impara, auto-riparazione stream, gusti, playlist… tutto condiviso.
//
// MULTI-UTENTE: ogni handler riceve `u` (user_id) come primo argomento,
// iniettato dal chiamante — ipc.ts passa il profilo desktop corrente,
// remote.ts quello autenticato dall'header X-MH-User. Mai fidarsi di un
// user_id negli args del client: i dati personali sono scope-ati su `u`.
//
// I canali che sul desktop aprono dialoghi nativi (file picker, save dialog)
// qui hanno varianti "headless": scrivono direttamente in Documenti o
// rispondono null. ipc.ts li registra con la versione desktop.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dispatch boundary IPC/HTTP
type Handler = (u: number, ...args: any[]) => any;

// Profilo attivo sul PC: validato contro la tabella users (se il profilo
// salvato è stato eliminato, ripiega sul primo disponibile)
export function desktopUser(): number {
  const id = getSettings().currentUser;
  if (id && users.userExists(id)) return id;
  const first = users.listUsers()[0];
  return first?.id ?? 1;
}

// Stato now-playing inviato dai client remoti (telefono) → aggiorna il tray
let playerStateListener: ((s: { title?: string; artist?: string; playing: boolean; remote?: boolean }) => void) | null = null;
export function setPlayerStateListener(fn: typeof playerStateListener): void { playerStateListener = fn; }

// La ricerca si auto-migliora (condivisa con ipc.ts):
// · filtra i videoId noti come difettosi
// · boosta i risultati scelti in passato per la stessa query (per utente)
// · ritenta con query semplificata se a vuoto
async function searchImpl(u: number, q: string, expand?: boolean) {
  let out = await ytmusic.search(q, expand);
  if (!out.songs.length) {
    const simplified = q.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (simplified && telemetry.normKey(simplified) !== telemetry.normKey(q)) {
      try { const retry = await ytmusic.search(simplified, expand); if (retry.songs.length) out = retry; } catch { /* */ }
    }
  }
  if (!out.songs.length) { telemetry.report('search-empty', { query: q }); return out; }
  const bad = telemetry.badIds();
  if (bad.size) out.songs = out.songs.filter((s) => !bad.has(s.videoId));
  const boosts = telemetry.pickBoosts(q, u).filter((id) => !bad.has(id));
  if (boosts.length) {
    const rank = new Map(boosts.map((id, i) => [id, i]));
    out.songs.sort((a, b) => (rank.get(a.videoId) ?? 99) - (rank.get(b.videoId) ?? 99));
  }
  return out;
}

// Export M3U8 headless: salva in Documenti senza dialogo (per i client remoti)
function exportM3uHeadless(u: number, id: number): string | null {
  const pl = library.listPlaylists(u).find((p) => p.id === id);
  if (!pl?.tracks?.length) return null;
  const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`];
  for (const t of pl.tracks) {
    if (!t.filePath) continue;
    lines.push(`#EXTINF:${Math.round(t.durationS ?? 0)},${t.artist} - ${t.title}`);
    lines.push(t.filePath);
  }
  const out = join(app.getPath('documents'), `${pl.name.replace(/[^\wàèéìòù -]/gi, '')}.m3u8`);
  writeFileSync(out, lines.join('\r\n'), 'utf-8');
  return out;
}

// Preferenze condivise PC↔telefono, namespacizzate per profilo: la chiave
// fisica è 'u<userId>:mh-pref-*', il client vede solo le sue chiavi logiche.
const prefKey = (u: number, k: string) => `u${u}:${k}`;
const prefsAll = (u: number) => {
  const out: Record<string, unknown> = {};
  const prefix = `u${u}:`;
  for (const r of getDb().prepare('SELECT k, v FROM prefs WHERE k LIKE ?').all(`${prefix}mh-pref-%`) as { k: string; v: string }[]) {
    try { out[r.k.slice(prefix.length)] = JSON.parse(r.v); } catch { /* */ }
  }
  return out;
};
// Broadcast delle preferenze: ogni set arriva live agli altri dispositivi
// (desktop via webContents.send, telefoni via SSE) — il payload porta `u`
// così ogni client ignora i set dei profili altrui.
type NotifyFn = (channel: string, payload: unknown) => void;
let notify: NotifyFn = () => {};
export function setHandlersNotifier(fn: NotifyFn): void { notify = fn; }

const prefsSet = (u: number, k: string, v: unknown) => {
  // Il filtro va QUI, non solo in /api/prefs: il canale condiviso /api/call
  // raggiunge questo handler direttamente e bypasserebbe il check sull'URL.
  // Charset + lunghezza: un client autenticato resta nel namespace mh-pref-*
  // ma non può piantare chiavi arbitrarie enormi (es. payload da MB in
  // 'mh-pref-queue' di un profilo) — il charset copre tutte le chiavi reali.
  if (typeof k !== 'string' || !/^mh-pref-[a-z0-9-]{1,48}$/.test(k)) throw new Error('chiave non valida');
  const sv = v === null || v === undefined ? '' : JSON.stringify(v);
  if (sv.length > 262_144) throw new Error('valore troppo grande'); // mh-pref-queue arriva a ~100KB (200 tracce)
  const pk = prefKey(u, k);
  if (v === null || v === undefined) getDb().prepare('DELETE FROM prefs WHERE k=?').run(pk);
  else getDb().prepare('INSERT OR REPLACE INTO prefs (k,v) VALUES (?,?)').run(pk, sv);
  notify(IPC.prefsEvent, { k, v, u }); // il writer si riapplica da solo: idempotente
};

// ---- Playlist con brani non ancora in libreria (stile Spotify) ----
// "Aggiungi a playlist" vale per QUALSIASI brano: se non è in libreria il PC
// lo scarica e lo aggiunge appena il download finisce. Le attese sono
// persistite: sopravvivono a un riavvio del PC (la coda download pure).
interface PendingPlAdd { videoId: string; plId: number; u: number; ts?: number }
const plPendingFile = () => join(app.getPath('userData'), 'playlist-pending.json');
let plPending: PendingPlAdd[] | null = null;
function loadPlPending(): PendingPlAdd[] {
  if (plPending) return plPending;
  // Scadenza 30 giorni: un download fallito e mai ritentato non resta in attesa per sempre
  const minTs = Date.now() - 30 * 86_400_000;
  try { plPending = (JSON.parse(readFileSync(plPendingFile(), 'utf-8')) as PendingPlAdd[]).filter((x) => x?.videoId && x.plId > 0 && (x.ts ?? Date.now()) > minTs); }
  catch { plPending = []; }
  return plPending;
}
function savePlPending(): void {
  try { writeFileSync(plPendingFile(), JSON.stringify(plPending ?? [])); } catch { /* */ }
}
function addRefToPlaylist(u: number, plId: number, t: TrackRef): { added: boolean; queued: boolean } {
  const lib = (t?.id != null && t.id > 0 ? library.getTrack(t.id, u) : undefined) ?? (t?.videoId ? library.findByVideoId(t.videoId, u) : undefined);
  if (lib) { library.addToPlaylist(plId, lib.id, u); return { added: true, queued: false }; }
  if (!t?.videoId || t.videoId.startsWith('local:')) throw new Error('brano non disponibile per il download');
  if (!library.listPlaylists(u).some((p) => p.id === plId)) throw new Error('Playlist non trovata');
  const job = downloader.enqueue(t, u);
  if (job.status === 'done') {
    const now = library.findByVideoId(t.videoId, u);
    if (now) { library.addToPlaylist(plId, now.id, u); return { added: true, queued: false }; }
  }
  const list = loadPlPending();
  if (!list.some((x) => x.videoId === t.videoId && x.plId === plId && x.u === u)) {
    list.push({ videoId: t.videoId, plId, u, ts: Date.now() });
    savePlPending();
  }
  return { added: false, queued: true };
}
downloader.onDownloadDone((job) => {
  const list = loadPlPending();
  const mine = list.filter((x) => x.videoId === job.track.videoId);
  if (!mine.length) return;
  plPending = list.filter((x) => x.videoId !== job.track.videoId);
  savePlPending();
  for (const p of mine) {
    const t = library.findByVideoId(p.videoId, p.u);
    try { if (t) library.addToPlaylist(p.plId, t.id, p.u); } catch { /* playlist eliminata nel frattempo */ }
  }
  notify(IPC.libraryChanged, null);
});

// Versione del PC + APK che servirebbe ai telefoni (UI "Aggiornamenti")
let apkInfoFn: () => AppInfo['apk'] = () => undefined;
export function setApkInfoProvider(fn: () => AppInfo['apk']): void { apkInfoFn = fn; }

export const handlers: Record<string, Handler> = {
  [IPC.settingsGet]: () => getSettings(),
  [IPC.settingsSet]: (_u: number, patch: Partial<Settings>) => setSettings(patch),

  // ---- Profili utente ----
  // `u` è l'identità del chiamante: 'users:current' restituisce proprio quella
  // (su desktop è il profilo in settings, su remoto quello dell'header).
  [IPC.usersList]: () => users.listUsers(),
  [IPC.usersCreate]: (u: number, name: string) => users.createUser(name),
  [IPC.usersRename]: (u: number, id: number, name: string) => users.renameUser(id, name),
  [IPC.usersRemove]: (u: number, id: number) => {
    if (id === u) throw new Error('Non puoi eliminare il profilo che stai usando');
    users.deleteUser(id);
    // Se era il profilo attivo del PC, ripiega sul primo rimasto
    if (getSettings().currentUser === id) setSettings({ currentUser: desktopUser() });
  },
  [IPC.usersCurrent]: (u: number) => u,
  // NOTA: users:setCurrent NON è qui — è desktop-only (cambia il profilo del PC,
  // registrato in ipc.ts). Il profilo di un dispositivo remoto è il binding
  // del suo token (tabella devices), non un'impostazione del PC.
  //
  // ---- Dispositivi remoti (gestione dal PC) ----
  // Da remoto sono ADMIN-ONLY (remote.ts): un device token riceve 403 — un
  // telefono non deve poter revocare/ri-legare altri dispositivi né toccare
  // i profili altrui (users:remove/rename sono admin-only per lo stesso motivo).
  [IPC.deviceList]: () => devices.listDevices(),
  [IPC.deviceRevoke]: (_u: number, id: number) => devices.revokeDevice(id),
  [IPC.deviceRevokeAll]: () => devices.revokeAllDevices(),
  [IPC.deviceSetUser]: (_u: number, id: number, userId: number | null) => {
    if (userId != null && !users.userExists(userId)) throw new Error('Profilo non trovato');
    devices.setDeviceUser(id, userId);
  },

  [IPC.search]: searchImpl,
  // Suggerimenti live mentre digiti (la risposta è un array di sezioni —
  // l'estrazione è in ytparse.searchSuggestions)
  [IPC.searchSuggest]: (_u: number, q: string) => ytmusic.suggestions(String(q ?? '')),
  [IPC.streamUrl]: (_u: number, videoId: string) => downloader.streamUrl(videoId),
  [IPC.playStream]: (_u: number, videoId: string, artist: string, title: string) =>
    downloader.playStream(videoId, artist, title),
  [IPC.searchPick]: (u: number, query: string, t: { videoId: string; artist?: string; title?: string }) =>
    telemetry.recordPick(query, t.videoId, t.artist, t.title, u),
  [IPC.videoUrl]: (_u: number, videoId: string, maxH?: number) => downloader.videoUrl(videoId, maxH),
  [IPC.loudness]: (_u: number, videoId: string) => downloader.loudnessOf(videoId),
  [IPC.lyrics]: (_u: number, artist: string, title: string, durationS?: number) =>
    sources.fetchLyrics(artist, title, durationS),
  [IPC.upNext]: (_u: number, videoId: string) => ytmusic.upNext(videoId),
  [IPC.charts]: (_u: number, country: string) => ytmusic.charts(country),
  [IPC.albumTracks]: (_u: number, id: string) => ytmusic.albumTracks(id),
  [IPC.artistTop]: (_u: number, id: string) => ytmusic.artistTop(id),
  [IPC.artistPage]: (_u: number, id: string) => ytmusic.artistPage(id),
  [IPC.playlistTracks]: (_u: number, id: string) => ytmusic.playlistTracks(id),

  [IPC.downloadEnqueue]: (u: number, track: TrackRef) => downloader.enqueue(track, u),
  [IPC.downloadList]: () => downloader.listJobs(),
  [IPC.downloadRetry]: (_u: number, id: string) => downloader.retryJob(id),
  [IPC.downloadDismiss]: (_u: number, id: string) => downloader.dismissJob(id),
  [IPC.downloadClear]: () => downloader.clearFinished(),

  [IPC.libraryList]: (u: number) => library.listTracks(u),
  // Le mutazioni della libreria fanno broadcast 'lib:changed': l'ALTRO
  // dispositivo (telefono↔PC) ricarica e non mostra mai dati stale.
  [IPC.libraryRemove]: (_u: number, id: number) => { library.removeTrack(id); notify(IPC.libraryChanged, null); },
  [IPC.libraryRestore]: (_u: number, id: number) => { library.restoreTrack(id); notify(IPC.libraryChanged, null); },
  [IPC.libraryStats]: (u: number) => library.stats(u),
  [IPC.libraryLike]: (u: number, id: number, liked: boolean) => { library.setLiked(id, liked, u); notify(IPC.libraryChanged, null); },
  [IPC.libraryPlay]: (u: number, id: number) => library.markPlayed(id, u),
  [IPC.librarySkip]: (u: number, id: number) => library.markSkipped(id, u),
  // Desktop: i path arrivano dal drag&drop. Remoto: niente file system → 0.
  // (PRIMA: tornava sempre 0 anche su desktop → import drag&drop rotto)
  [IPC.libraryImport]: (u: number, paths?: string[]) =>
    Array.isArray(paths) && paths.length
      ? downloader.importFiles(paths, u).then((n) => { if (n) notify(IPC.libraryChanged, null); return n; })
      : Promise.resolve(0),
  [IPC.libraryRecent]: (u: number, limit?: number) => library.recentlyPlayed(limit ?? 10, u),
  [IPC.libraryLikeRemote]: (u: number, t: TrackRef, liked: boolean) => { library.likeRemote(t, liked, u); notify(IPC.libraryChanged, null); },
  [IPC.libraryRemoteLikes]: (u: number) => library.remoteLikes(u),
  [IPC.libraryRemoteEvent]: (u: number, e: { trackId?: number; artist: string; title?: string; videoId?: string; thumbnail?: string; type: 'play' | 'skip' | 'hide' }) =>
    library.recordRemoteEvent(e, u),

  [IPC.playlistList]: (u: number) => library.listPlaylists(u),
  [IPC.playlistCreate]: (u: number, name: string, kind: Playlist['kind']) => library.createPlaylist(name, kind, u),
  [IPC.playlistDelete]: (u: number, id: number) => library.deletePlaylist(id, u),
  [IPC.playlistRename]: (u: number, id: number, name: string) => library.renamePlaylist(id, name, u),
  [IPC.playlistAdd]: (u: number, plId: number, trackId: number) => library.addToPlaylist(plId, trackId, u),
  [IPC.playlistRemove]: (u: number, plId: number, trackId: number) => library.removeFromPlaylist(plId, trackId, u),
  [IPC.playlistMove]: (u: number, plId: number, trackId: number, dir: -1 | 1) => library.moveInPlaylist(plId, trackId, dir, u),
  [IPC.playlistReorder]: (u: number, plId: number, ids: number[]) =>
    Array.isArray(ids) ? library.reorderPlaylist(plId, ids.map(Number).filter((n) => n > 0), u) : undefined,
  [IPC.playlistExport]: (u: number, id: number) => exportM3uHeadless(u, id),
  [IPC.playlistAddRef]: (u: number, plId: number, t: TrackRef) => addRefToPlaylist(u, plId, t),

  [IPC.recommend]: (u: number) => suggest(u),
  [IPC.assistant]: (u: number, req: AssistantRequest) => assistant(u, req),
  [IPC.station]: (u: number, id: string) => stationTracks(u, id),
  [IPC.stationNext]: (u: number, videoId: string, artist: string, ctx?: string) =>
    stationContinue(u, String(videoId ?? ''), String(artist ?? ''), typeof ctx === 'string' ? ctx : undefined),
  [IPC.radio]: (u: number, kind: 'artist' | 'genre', value: string) =>
    kind === 'artist' ? radioForArtist(u, value) : radioForGenre(u, value),
  [IPC.autoplaylist]: (u: number, id: string) => autoPlaylist(u, id),
  [IPC.libraryTaste]: (u: number, kind?: string) => library.tasteProfile(u, kind),
  [IPC.libraryTasteReset]: (u: number) => library.resetTaste(u),
  // Motore gusti v2: completamento ascolto, onboarding, uso funzioni
  [IPC.libraryListen]: (u: number, r: engine.ListenReport) => engine.recordListen(r, u),
  [IPC.libraryTasteSeed]: (u: number, names: string[]) => engine.seedTaste(Array.isArray(names) ? names : [], u),
  [IPC.recOnboard]: () => engine.onboardArtists(),
  [IPC.uxTrack]: (u: number, name: string) => engine.trackUsage(String(name ?? ''), u),
  [IPC.trends]: (u: number) => getTrends(u, false),
  [IPC.trendsRefresh]: (u: number) => getTrends(u, true),

  // Masterizzazione: il telefono pilota il masterizzatore del PC — funziona!
  [IPC.burnDrives]: () => burner.listDrives(),
  [IPC.burnStart]: (u: number, kind: 'audio' | 'data', driveId: string, tracks: LibraryTrack[], name: string) => {
    // Le tracce si ri-risolvono per id sul DB: il client remoto manda la sua
    // copia dei metadati e un filePath fidato è un buco (potrebbe puntare a
    // file arbitrari del PC o essere stale dopo uno spostamento della libreria)
    const resolved = (tracks ?? []).map((t) => library.getTrack(t?.id)).filter((t): t is LibraryTrack => !!t);
    if (!resolved.length) throw new Error('tracce non trovate in libreria');
    // Mai masterizzare silenziosamente meno di quanto chiesto: l'utente deve saperlo
    const dropped = (tracks?.length ?? 0) - resolved.length;
    if (dropped > 0) throw new Error(`${dropped} brani non più in libreria — aggiorna la tracklist e riprova`);
    return kind === 'audio' ? burner.burnAudio(driveId, resolved, name, u) : burner.burnData(driveId, resolved, name, u);
  },
  [IPC.burnErase]: (_u: number, driveId: string, full: boolean) => burner.eraseDisc(driveId, full),
  [IPC.burnEject]: (_u: number, driveId: string) => burner.ejectDisc(driveId),

  [IPC.spotifyStatus]: () => sources.spotifyConnected(),
  [IPC.spotifyImport]: async (u: number) => {
    const artists = await sources.spotifyImportTopArtists();
    for (const a of artists) library.bumpTaste('artist', a, 3, u);
    return { imported: artists.length };
  },
  [IPC.testLastfm]: (_u: number, key: string) => sources.lastfmTestKey(key),

  [IPC.openFolder]: (_u: number, p: string) => shell.openPath(p),
  [IPC.pickFolder]: () => null, // niente dialogo nativo su client remoto

  // Diagnostica (installazione, non per utente)
  [IPC.issuesStats]: () => telemetry.stats(),
  [IPC.issuesClear]: () => telemetry.clearAll(),
  [IPC.issuesExport]: () => {
    const out = join(app.getPath('documents'), 'masterhype-report.txt');
    writeFileSync(out, telemetry.exportReport(), 'utf-8');
    return out;
  },
  [IPC.issuesReport]: (_u: number, kind: string, d: { message?: string; artist?: string; title?: string; videoId?: string; query?: string }) => {
    if (kind === 'stream-dead' && d.videoId) downloader.noteStreamDead(d.videoId, d.artist, d.title);
    else telemetry.report(kind, d);
  },
  // Metriche cascata stream raccolte sul dispositivo (coda mh-stream-clients)
  [IPC.streamStats]: (_u: number, rows: telemetry.ClientSampleIn[]) => telemetry.recordClientStats(rows),

  // Backup headless: salva in Documenti; l'import remoto accetta il JSON nel body.
  // È sempre del profilo richiedente — mai dei dati di altri utenti.
  [IPC.backupExport]: (u: number) => {
    const out = join(app.getPath('documents'), `masterhype-backup-${u}.json`);
    writeFileSync(out, JSON.stringify(exportBackup(u), null, 2), 'utf-8');
    return out;
  },
  [IPC.backupImport]: (u: number, data?: unknown) => {
    if (data != null) return importBackupWithDownloads(data, u); // remoto: JSON passato direttamente
    return null;
  },
  // Backup come dato (non file sul PC): il telefono lo salva nella SUA memoria
  [IPC.backupData]: (u: number) => exportBackup(u),
  [IPC.issuesReportText]: () => telemetry.exportReport(),

  // Stato now-playing dal client remoto → tray/menu del PC (marcato "telefono")
  [IPC.playerState]: (_u: number, s: { title?: string; artist?: string; playing: boolean }) => {
    playerStateListener?.({ ...s, remote: true });
  },

  // Versione e aggiornamenti dell'app desktop. L'install è desktop-only
  // (deny-list in remote.ts: riavvierebbe il server sotto i piedi dei client).
  [IPC.appInfo]: (): AppInfo => ({ version: app.getVersion(), apk: apkInfoFn(), feed: appUpdate.feedUrl() || undefined }),
  [IPC.appUpdateStatus]: () => appUpdate.appUpdateState(),
  [IPC.appUpdateCheck]: () => appUpdate.checkAppUpdate(true),
  [IPC.appUpdateInstall]: () => appUpdate.installAppUpdate(),

  // Info pairing + preferenze condivise (namespacizzate per profilo)
  'remote:prefs:get': (u: number) => prefsAll(u),
  'remote:prefs:set': (u: number, k: string, v: unknown) => prefsSet(u, k, v),
};

// Canali registrati da ipc.ts con varianti desktop (dialoghi nativi / OAuth):
// qui NON devono essere re-registrati via ipcMain.handle.
export const desktopOnlyChannels = new Set<string>([
  IPC.playlistExport,
  IPC.issuesExport,
  IPC.backupExport,
  IPC.backupImport,
  IPC.pickFolder,
  IPC.spotifyAuth,
  IPC.playerState, // arriva via ipcMain.on (send), non via invoke
  IPC.usersSetCurrent, // il profilo del PC lo decide il PC, non un client remoto
]);

// Legge un backup JSON da file (variante desktop con dialogo in ipc.ts)
export function importBackupFromFile(path: string, u: number): unknown {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return importBackupWithDownloads(data, u);
}

// Import completo: i brani delle playlist che mancano in libreria vengono
// scaricati e ricollegati alla playlist al termine del download.
function importBackupWithDownloads(data: unknown, u: number) {
  // File creato dal telefono: { app:'masterhype-bundle', profile, device } —
  // sul PC conta il profilo (lo stato del dispositivo resta al telefono).
  const b = data as { app?: string; profile?: unknown } | null;
  if (b?.app === 'masterhype-bundle') {
    if (!b.profile) throw new Error('Questo backup contiene solo dati del telefono: importalo dall\'app sul telefono');
    data = b.profile;
  }
  const r = importBackup(data, u, (plId, t) => {
    const thumb = t.thumbnail ?? (/^[\w-]{11}$/.test(t.videoId) ? `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg` : undefined);
    addRefToPlaylist(u, plId, { ...t, thumbnail: thumb, source: 'ytmusic' });
  });
  notify(IPC.libraryChanged, null);
  return r;
}
