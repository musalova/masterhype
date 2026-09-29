// Backup/restore del profilo utente: gusti imparati, like remoti e playlist.
// Il profilo è il vero valore accumulato — deve sopravvivere a reinstallazioni
// e cambi di PC. Formato: JSON con versione per future migrazioni.
// v2: ogni backup è DI UN profilo — export/import sono scope-ati sull'utente.

import { getDb } from '../db';

interface BackupFile {
  app: 'masterhype';
  version: 1 | 2;
  exportedAt: number;
  user?: { id: number; name: string };
  taste: { kind: string; value: string; weight: number }[];
  remoteLikes: { videoId: string; title: string; artist: string; thumbnail?: string; durationS?: number; ts: number }[];
  playlists: { name: string; kind: string; tracks: { videoId?: string; title?: string; artist?: string; thumbnail?: string; durationS?: number }[] }[];
}

// Traccia di playlist non presente in libreria al momento dell'import:
// il chiamante la fa scaricare e aggiungere (handlers.addRefToPlaylist).
export type MissingTrackFn = (plId: number, t: { videoId: string; title: string; artist: string; thumbnail?: string; durationS?: number }) => void;

export function exportBackup(u: number): BackupFile {
  const db = getDb();
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(u) as { id: number; name: string } | undefined;
  const taste = db.prepare('SELECT kind, value, weight FROM taste_profile WHERE user_id=?').all(u) as BackupFile['taste'];
  const remoteLikes = db.prepare(
    'SELECT video_id as videoId, title, artist, thumbnail, duration_s as durationS, ts FROM remote_likes WHERE user_id=?'
  ).all(u) as BackupFile['remoteLikes'];
  const playlists = (db.prepare('SELECT id, name, kind FROM playlists WHERE user_id=?').all(u) as { id: number; name: string; kind: string }[])
    .map((p) => ({
      name: p.name, kind: p.kind,
      tracks: (db.prepare(
        `SELECT t.video_id as videoId, t.title, t.artist, t.duration_s as durationS FROM playlist_tracks pt
         JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id=? ORDER BY pt.position`
      ).all(p.id) as BackupFile['playlists'][0]['tracks']),
    }));
  return {
    app: 'masterhype', version: 2, exportedAt: Date.now(),
    user: user ? { id: user.id, name: user.name } : undefined,
    taste, remoteLikes, playlists,
  };
}

// Merge, non sostituzione: i pesi si sommano (cap ±10), i like si uniscono,
// le playlist vengono create solo se non esiste già una con lo stesso nome.
// Tutto viene importato nel profilo `u` richiedente — anche un backup v1
// (mono-utente) finisce nel profilo corrente.
export function importBackup(raw: unknown, u: number, onMissing?: MissingTrackFn): { taste: number; likes: number; playlists: number } {
  const b = raw as Partial<BackupFile>;
  if (b?.app !== 'masterhype' || !Array.isArray(b.taste)) throw new Error('File di backup non valido');
  const db = getDb();
  let nTaste = 0, nLikes = 0, nPl = 0;

  const upTaste = db.prepare(
    `INSERT INTO taste_profile (kind, value, weight, updated_at, user_id) VALUES (?,?,?,?,?)
     ON CONFLICT(kind, value, user_id) DO UPDATE SET weight = MAX(-10, MIN(10, weight + excluded.weight)), updated_at = excluded.updated_at`);
  for (const t of b.taste) {
    if (!t.kind || !t.value || typeof t.weight !== 'number') continue;
    upTaste.run(t.kind, t.value, t.weight, Date.now(), u); nTaste++;
  }

  const insLike = db.prepare(
    `INSERT INTO remote_likes (video_id, title, artist, thumbnail, duration_s, ts, user_id)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(video_id, user_id) DO NOTHING`);
  for (const l of b.remoteLikes ?? []) {
    if (!l.videoId || !l.title || !l.artist) continue;
    insLike.run(l.videoId, l.title, l.artist, l.thumbnail ?? null, l.durationS ?? null, l.ts ?? Date.now(), u); nLikes++;
  }

  const findPl = db.prepare('SELECT id FROM playlists WHERE name=? AND kind=? AND user_id=?');
  const insPl = db.prepare('INSERT INTO playlists (name, kind, created_at, user_id) VALUES (?,?,?,?)');
  const findTrack = db.prepare('SELECT id FROM tracks WHERE video_id=? AND deleted_at IS NULL');
  const insPt = db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)
     ON CONFLICT(playlist_id, track_id) DO NOTHING`);
  for (const p of b.playlists ?? []) {
    if (!p.name || !Array.isArray(p.tracks)) continue;
    const kind = ['cd-audio', 'cd-mp3', 'lista'].includes(p.kind ?? '') ? p.kind! : 'lista';
    const exist = findPl.get(p.name, kind, u) as { id: number } | undefined;
    if (exist) continue; // stessa playlist già presente: non duplicare
    const plId = (insPl.run(p.name, kind, Date.now(), u).lastInsertRowid as number);
    let pos = 0;
    for (const tr of p.tracks) {
      // Tracce già in libreria: ricollegate subito. Le altre (backup portato su
      // un PC nuovo, o fatto dal telefono) vengono scaricate e aggiunte al 'done'.
      const t = tr.videoId ? findTrack.get(tr.videoId) as { id: number } | undefined : undefined;
      if (t) insPt.run(plId, t.id, pos++);
      else if (onMissing && tr.videoId && !tr.videoId.startsWith('local:') && tr.title && tr.artist) {
        try { onMissing(plId, { videoId: tr.videoId, title: tr.title, artist: tr.artist, thumbnail: tr.thumbnail, durationS: tr.durationS }); } catch { /* */ }
      }
    }
    nPl++;
  }
  return { taste: nTaste, likes: nLikes, playlists: nPl };
}
