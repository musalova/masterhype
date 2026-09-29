import { getDb } from '../db';
import type { LibraryTrack, Playlist, AppStats, RemoteLike, TrackRef } from '../../shared/types';
import { existsSync, copyFileSync, mkdirSync } from 'fs';
import { basename, extname, join } from 'path';
import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTrack(r: any): LibraryTrack {
  return {
    id: r.id,
    videoId: r.video_id,
    title: r.title,
    artist: r.artist,
    album: r.album ?? undefined,
    genre: r.genre ?? undefined,
    year: r.year ?? undefined,
    durationS: r.duration_s ?? undefined,
    filePath: r.file_path,
    coverPath: r.cover_path ?? undefined,
    thumbnail: r.cover_path ? `media://cover/${r.id}` : undefined,
    source: 'library',
    addedAt: r.added_at,
    playCount: r.play_count,
    liked: !!r.liked,
  };
}

export function addTrack(t: {
  videoId: string; title: string; artist: string; album?: string;
  durationS?: number; filePath: string; coverPath?: string;
}): LibraryTrack {
  const db = getDb();
  const now = Date.now();
  // Like remoti sullo stesso videoId → like locali per OGNI utente che li aveva messi
  const convertRemoteLikes = (trackId: number) => {
    const likers = db.prepare('SELECT user_id FROM remote_likes WHERE video_id=?').all(t.videoId) as { user_id: number }[];
    for (const l of likers)
      db.prepare('INSERT OR IGNORE INTO track_likes (track_id,user_id,ts) VALUES (?,?,?)').run(trackId, l.user_id, now);
    if (likers.length) db.prepare('DELETE FROM remote_likes WHERE video_id=?').run(t.videoId);
  };
  const existing = db.prepare('SELECT id FROM tracks WHERE video_id = ?').get(t.videoId) as { id: number } | undefined;
  if (existing) {
    // Se era nel cestino (soft-delete), riscaricare il brano lo ripristina
    db.prepare('UPDATE tracks SET file_path=?, cover_path=COALESCE(?,cover_path), deleted_at=NULL WHERE id=?')
      .run(t.filePath, t.coverPath ?? null, existing.id);
    convertRemoteLikes(existing.id);
    return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id=?').get(existing.id));
  }
  const res = db.prepare(
    'INSERT INTO tracks (video_id,title,artist,album,duration_s,file_path,cover_path,added_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(t.videoId, t.title, t.artist, t.album ?? null, t.durationS ?? null, t.filePath, t.coverPath ?? null, now);
  convertRemoteLikes(Number(res.lastInsertRowid));
  return rowToTrack(db.prepare('SELECT * FROM tracks WHERE id=?').get(res.lastInsertRowid));
}

// Il LIKE della lista è per-utente: subquery su track_likes col profilo richiedente.
export function listTracks(u: number): LibraryTrack[] {
  const rows = getDb().prepare(
    `SELECT t.*, EXISTS(SELECT 1 FROM track_likes tl WHERE tl.track_id=t.id AND tl.user_id=?) AS liked
     FROM tracks t WHERE deleted_at IS NULL ORDER BY added_at DESC`).all(u);
  return rows.map(rowToTrack);
}

// u serve solo per il flag liked; media/burn usano il default (non rilevante lì)
export function getTrack(id: number, u = 1): LibraryTrack | undefined {
  const r = getDb().prepare(
    `SELECT t.*, EXISTS(SELECT 1 FROM track_likes tl WHERE tl.track_id=t.id AND tl.user_id=?) AS liked
     FROM tracks t WHERE t.id=?`).get(u, id);
  return r ? rowToTrack(r) : undefined;
}

export function findByVideoId(videoId: string, u = 1): LibraryTrack | undefined {
  const r = getDb().prepare(
    `SELECT t.*, EXISTS(SELECT 1 FROM track_likes tl WHERE tl.track_id=t.id AND tl.user_id=?) AS liked
     FROM tracks t WHERE t.video_id=? AND t.deleted_at IS NULL`).get(u, videoId);
  return r ? rowToTrack(r) : undefined;
}

// Soft-delete: il brano va nel "cestino" fino al prossimo avvio → "Annulla" possibile
export function removeTrack(id: number): void {
  getDb().prepare('UPDATE tracks SET deleted_at=? WHERE id=?').run(Date.now(), id);
}

export function restoreTrack(id: number): void {
  getDb().prepare('UPDATE tracks SET deleted_at=NULL WHERE id=?').run(id);
}

export function setLiked(id: number, liked: boolean, u: number): void {
  const db = getDb();
  if (liked) db.prepare('INSERT OR REPLACE INTO track_likes (track_id,user_id,ts) VALUES (?,?,?)').run(id, u, Date.now());
  else db.prepare('DELETE FROM track_likes WHERE track_id=? AND user_id=?').run(id, u);
  const t = getTrack(id, u);
  if (t) recordEvent(id, t.artist, liked ? 'like' : 'unlike', undefined, u);
}

// play_count resta globale (uso del file); l'evento di ascolto è per-utente
export function markPlayed(id: number, u: number): void {
  getDb().prepare('UPDATE tracks SET play_count = play_count + 1 WHERE id=?').run(id);
  const t = getTrack(id, u);
  if (t) recordEvent(id, t.artist, 'play', { title: t.title, videoId: t.videoId, thumbnail: t.thumbnail }, u);
}

// Skip entro pochi secondi: segnale negativo nel profilo gusti
export function markSkipped(id: number, u: number): void {
  const t = getTrack(id, u);
  if (t) recordEvent(id, t.artist, 'skip', { title: t.title, videoId: t.videoId, thumbnail: t.thumbnail }, u);
}

// Ultimi brani riprodotti — locali E remoti (per "Ascoltati di recente" in Home).
// Le righe remote non hanno id/filePath: TrackRow le tratta come stream.
export function recentlyPlayed(limit = 10, u = 1): TrackRef[] {
  const db = getDb();
  const local = db.prepare(
    `SELECT t.*, EXISTS(SELECT 1 FROM track_likes tl WHERE tl.track_id=t.id AND tl.user_id=?) AS liked,
            MAX(e.ts) AS last_play FROM events e
     JOIN tracks t ON t.id = e.track_id
     WHERE e.type = 'play' AND e.track_id IS NOT NULL AND e.user_id=? AND t.deleted_at IS NULL
     GROUP BY t.id ORDER BY last_play DESC LIMIT ?`).all(u, u, limit) as Parameters<typeof rowToTrack>[0][];
  const remote = db.prepare(
    `SELECT video_id, title, artist, thumbnail, MAX(ts) AS last_play FROM events
     WHERE type='play' AND track_id IS NULL AND video_id IS NOT NULL AND user_id=?
     GROUP BY video_id ORDER BY last_play DESC LIMIT ?`).all(u, limit) as
    { video_id: string; title: string; artist: string; thumbnail: string | null; last_play: number }[];
  type WithTs = TrackRef & { _ts: number };
  const merged: WithTs[] = [
    ...local.map((r) => ({ ...rowToTrack(r), _ts: (r as { last_play: number }).last_play })),
    ...remote.map((r) => ({
      videoId: r.video_id, title: r.title, artist: r.artist,
      thumbnail: r.thumbnail ?? undefined, source: 'ytmusic' as const, _ts: r.last_play,
    })),
  ];
  return merged.sort((a, b) => b._ts - a._ts).slice(0, limit).map(({ _ts, ...t }) => t);
}

// Registra in libreria un file audio locale (da drag&drop): copia nella cartella libreria
// e legge durata/tag con ffprobe. `probe`/`ffmpegDir` vengono passati dal chiamante (downloader)
// per evitare un import circolare.
export function importLocalFile(
  srcPath: string, libraryDir: string,
  probe: (p: string) => { durationS?: number; title?: string; artist?: string; album?: string },
): LibraryTrack | null {
  if (!existsSync(srcPath)) return null;
  const meta = probe(srcPath);
  const base = basename(srcPath, extname(srcPath));
  // fallback: "Artista - Titolo.ext" dal nome file
  let artist = meta.artist ?? '';
  let title = meta.title ?? '';
  if (!artist || !title) {
    const m = /^(.+?)\s*-\s*(.+)$/.exec(base);
    if (m) { artist ||= m[1].trim(); title ||= m[2].trim(); }
    else { title ||= base; artist ||= 'Importato'; }
  }
  const videoId = 'local:' + createHash('sha1').update(srcPath.toLowerCase()).digest('hex').slice(0, 12);
  mkdirSync(libraryDir, { recursive: true });
  const sanitize = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  let outPath = srcPath.startsWith(libraryDir) ? srcPath : join(libraryDir, `${sanitize(`${artist} - ${title}`)}${extname(srcPath)}`);
  if (!srcPath.startsWith(libraryDir)) {
    let n = 1;
    while (existsSync(outPath)) {
      const p = join(libraryDir, `${sanitize(`${artist} - ${title}`)} (${++n})${extname(srcPath)}`);
      if (!existsSync(p)) { outPath = p; break; }
      outPath = p;
    }
  }
  if (outPath !== srcPath) copyFileSync(srcPath, outPath);
  return addTrack({ videoId, title, artist, album: meta.album, durationS: meta.durationS, filePath: outPath });
}

// ---- Like "remoti": cuoricino su brani non scaricati (stile Spotify) ----

export function likeRemote(t: { videoId: string; title: string; artist: string; thumbnail?: string; durationS?: number }, liked: boolean, u: number): void {
  const db = getDb();
  if (liked) {
    db.prepare('INSERT OR REPLACE INTO remote_likes (video_id,title,artist,thumbnail,duration_s,ts,user_id) VALUES (?,?,?,?,?,?,?)')
      .run(t.videoId, t.title, t.artist, t.thumbnail ?? null, t.durationS ?? null, Date.now(), u);
    recordEvent(null, t.artist, 'like', undefined, u);
  } else {
    db.prepare('DELETE FROM remote_likes WHERE video_id=? AND user_id=?').run(t.videoId, u);
    recordEvent(null, t.artist, 'unlike', undefined, u);
  }
}

export function remoteLikes(u: number): RemoteLike[] {
  const rows = getDb().prepare('SELECT * FROM remote_likes WHERE user_id=? ORDER BY ts DESC').all(u) as
    { video_id: string; title: string; artist: string; thumbnail: string | null; duration_s: number | null; ts: number }[];
  return rows.map((r) => ({
    videoId: r.video_id, title: r.title, artist: r.artist,
    thumbnail: r.thumbnail ?? undefined, durationS: r.duration_s ?? undefined, ts: r.ts,
  }));
}

// Evento di ascolto generico: locale (trackId) o remoto (videoId+title).
// 'hide' = dislike deliberato: pesa più di uno skip, meno di un unlike esplicito.
export function recordRemoteEvent(e: {
  trackId?: number; artist: string; title?: string; videoId?: string; thumbnail?: string;
  type: 'play' | 'skip' | 'hide';
}, u: number): void {
  recordEvent(e.trackId ?? null, e.artist, e.type, { title: e.title, videoId: e.videoId, thumbnail: e.thumbnail }, u);
}

export function recordEvent(
  trackId: number | null, artist: string | null, type: string,
  meta?: { title?: string; videoId?: string; thumbnail?: string },
  u = 1,
): void {
  const res = getDb().prepare('INSERT INTO events (track_id, artist, type, title, video_id, thumbnail, ts, user_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(trackId, artist, type, meta?.title ?? null, meta?.videoId ?? null, meta?.thumbnail ?? null, Date.now(), u);
  // Contesto (ora/giorno) + co-occorrenza artisti nella stessa sessione
  void import('./engine').then((e) => e.enrichEvent(res.lastInsertRowid, type, artist, u)).catch(() => {});
  const weight = { like: 3, download: 2.5, burn: 2, play: 1, skip: -1, hide: -2, unlike: -3 }[type] ?? 0;
  if (artist && weight !== 0) {
    bumpTaste('artist', artist, weight, u);
    // Deduzione dei generi: i tag Last.fm dell'artista seguono lo stesso segnale
    // (like a Vasco → cresce "italian rock" → gli affini salgono nei suggerimenti).
    const a = artist;
    const d = weight * 0.35;
    void import('./sources').then((s) => s.lastfmArtistTags(a))
      .then((tags) => { for (const t of tags.slice(0, 3)) bumpTaste('tag', t, d, u); })
      .catch(() => { /* tag opzionali */ });
    // Senza Last.fm i tag restano vuoti: il genere ID3 del file è il fallback
    if (trackId) {
      const g = getDb().prepare('SELECT genre FROM tracks WHERE id=?').get(trackId) as { genre: string | null } | undefined;
      if (g?.genre) bumpTaste('genre', g.genre, d, u);
    }
  }
}

export function bumpTaste(kind: 'artist' | 'genre' | 'tag', value: string, delta: number, u: number): void {
  const db = getDb();
  // I pesi possono scendere sotto zero: un artista "disliked" viene penalizzato nei suggerimenti.
  db.prepare(`INSERT INTO taste_profile (kind,value,weight,updated_at,user_id) VALUES (?,?,?,?,?)
    ON CONFLICT(kind,value,user_id) DO UPDATE SET weight = weight + excluded.weight, updated_at = excluded.updated_at`)
    .run(kind, value.toLowerCase(), delta, Date.now(), u);
}

// Brani da non riproporre: più skip/hide che play = l'utente li salta di proposito.
// Copre locali E remoti (gli eventi portano sempre artist+title dopo il backfill).
export function negativeTracks(u: number): { artist: string; title: string }[] {
  const rows = getDb().prepare(
    `SELECT artist, title,
       SUM(CASE WHEN type IN ('skip','hide') THEN 1 ELSE 0 END) AS skips,
       SUM(CASE WHEN type='play' THEN 1 ELSE 0 END) AS plays
     FROM events
     WHERE title IS NOT NULL AND type IN ('skip','play','hide') AND user_id=?
     GROUP BY artist, title HAVING skips >= 2 AND skips > plays`).all(u) as { artist: string; title: string }[];
  return rows.map((r) => ({ artist: r.artist, title: r.title }));
}

export function tasteProfile(u: number, kind?: string): { kind: string; value: string; weight: number }[] {
  const db = getDb();
  const rows = (kind
    ? db.prepare('SELECT * FROM taste_profile WHERE kind=? AND user_id=?').all(kind, u)
    : db.prepare('SELECT * FROM taste_profile WHERE user_id=?').all(u)) as { kind: string; value: string; weight: number; updated_at: number }[];
  // Decadimento temporale: i gusti recenti pesano di più (half-life ~45 giorni).
  // I segnali negativi decadono più lentamente: un "dislike" resta affidabile a lungo.
  const now = Date.now();
  return rows
    .map((r) => {
      const days = Math.max(0, (now - r.updated_at) / 86_400_000);
      const halfLife = r.weight >= 0 ? 45 : 90;
      return { kind: r.kind, value: r.value, weight: r.weight * Math.pow(0.5, days / halfLife) };
    })
    .sort((a, b) => b.weight - a.weight);
}

// "Dimentica tutto": azzera i pesi gusti DEL PROFILO (gli eventi storici restano).
export function resetTaste(u: number): void {
  getDb().prepare('DELETE FROM taste_profile WHERE user_id=?').run(u);
}

// ---- Playlist ----

export function listPlaylists(u: number): Playlist[] {
  const db = getDb();
  const pls = db.prepare('SELECT * FROM playlists WHERE user_id=? ORDER BY created_at DESC').all(u) as {
    id: number; name: string; kind: Playlist['kind']; created_at: number;
  }[];
  return pls.map((p) => ({
    id: p.id, name: p.name, kind: p.kind, createdAt: p.created_at,
    tracks: playlistTracks(p.id, u),
  }));
}

export function playlistTracks(playlistId: number, u = 1): LibraryTrack[] {
  const rows = getDb().prepare(
    `SELECT t.*, EXISTS(SELECT 1 FROM track_likes tl WHERE tl.track_id=t.id AND tl.user_id=?) AS liked
     FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
     WHERE pt.playlist_id=? AND t.deleted_at IS NULL ORDER BY pt.position`
  ).all(u, playlistId);
  return rows.map(rowToTrack);
}

// Ownership: le operazioni su playlist verificano che appartenga all'utente —
// così un client non può toccare le playlist di un altro profilo.
function ownPlaylist(playlistId: number, u: number): void {
  const p = getDb().prepare('SELECT user_id FROM playlists WHERE id=?').get(playlistId) as { user_id: number } | undefined;
  if (!p || p.user_id !== u) throw new Error('Playlist non trovata');
}

export function createPlaylist(name: string, kind: Playlist['kind'], u: number): Playlist {
  const res = getDb().prepare('INSERT INTO playlists (name,kind,created_at,user_id) VALUES (?,?,?,?)')
    .run(name, kind, Date.now(), u);
  return { id: Number(res.lastInsertRowid), name, kind, createdAt: Date.now(), tracks: [] };
}

export function deletePlaylist(id: number, u: number): void {
  const db = getDb();
  ownPlaylist(id, u);
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=?').run(id);
  db.prepare('DELETE FROM playlists WHERE id=?').run(id);
}

export function renamePlaylist(id: number, name: string, u: number): void {
  ownPlaylist(id, u);
  getDb().prepare('UPDATE playlists SET name=? WHERE id=?').run(name, id);
}

export function addToPlaylist(playlistId: number, trackId: number, u: number): void {
  const db = getDb();
  ownPlaylist(playlistId, u);
  const max = db.prepare('SELECT COALESCE(MAX(position),-1) m FROM playlist_tracks WHERE playlist_id=?')
    .get(playlistId) as { m: number };
  db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id,track_id,position) VALUES (?,?,?)')
    .run(playlistId, trackId, max.m + 1);
}

export function removeFromPlaylist(playlistId: number, trackId: number, u: number): void {
  const db = getDb();
  ownPlaylist(playlistId, u);
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?').run(playlistId, trackId);
  // ricompatta posizioni
  const rows = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position').all(playlistId) as { track_id: number }[];
  rows.forEach((r, i) =>
    db.prepare('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?').run(i, playlistId, r.track_id));
}

export function moveInPlaylist(playlistId: number, trackId: number, dir: -1 | 1, u: number): void {
  const db = getDb();
  ownPlaylist(playlistId, u);
  const rows = db.prepare('SELECT track_id, position FROM playlist_tracks WHERE playlist_id=? ORDER BY position').all(playlistId) as { track_id: number; position: number }[];
  const i = rows.findIndex((r) => r.track_id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return;
  db.prepare('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?').run(rows[j].position, playlistId, rows[i].track_id);
  db.prepare('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?').run(rows[i].position, playlistId, rows[j].track_id);
}

// Riordino convergente (drain offline): l'ordine citato vince — è la vista del
// dispositivo che ha drenato per ultimo. Le righe non citate (es. aggiunte da
// un altro device mentre questo era offline) restano in coda preservando
// l'ordine relativo. Deterministico: due device convergono allo stesso stato.
export function reorderPlaylist(playlistId: number, trackIds: number[], u: number): void {
  const db = getDb();
  ownPlaylist(playlistId, u);
  const rows = db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY position').all(playlistId) as { track_id: number }[];
  const rank = new Map(trackIds.map((id, i) => [id, i]));
  const cited = rows.map((r) => r.track_id).filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  const rest = rows.map((r) => r.track_id).filter((id) => !rank.has(id));
  [...cited, ...rest].forEach((id, i) =>
    db.prepare('UPDATE playlist_tracks SET position=? WHERE playlist_id=? AND track_id=?').run(i, playlistId, id));
}

export function recordBurn(name: string, kind: string, tracks: LibraryTrack[], u: number): void {
  getDb().prepare('INSERT INTO burned_cds (name,kind,track_count,ts,user_id) VALUES (?,?,?,?,?)')
    .run(name, kind, tracks.length, Date.now(), u);
  for (const t of tracks) recordEvent(t.id, t.artist, 'burn', undefined, u);
}

export function stats(u: number): AppStats {
  const db = getDb();
  const tc = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(duration_s),0) s FROM tracks WHERE deleted_at IS NULL').get() as { c: number; s: number };
  const pc = db.prepare('SELECT COUNT(*) c FROM playlists WHERE user_id=?').get(u) as { c: number };
  const bc = db.prepare('SELECT COUNT(*) c FROM burned_cds WHERE user_id=?').get(u) as { c: number };
  return {
    trackCount: tc.c,
    totalMinutes: Math.round(tc.s / 60),
    playlistCount: pc.c,
    burnedCount: bc.c,
    topArtists: tasteProfile(u, 'artist').slice(0, 8).map((r) => ({ artist: r.value, weight: r.weight })),
    topGenres: tasteProfile(u, 'genre').slice(0, 8).map((r) => ({ genre: r.value, weight: r.weight })),
  };
}
