import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Backup del profilo: i like sui brani SCARICATI (track_likes) non devono
// andare persi — nel file viaggiano per video_id e all'import si riattaccano
// alla libreria o restano in remote_likes in attesa del download.

let db: DatabaseSync;
function mkDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, created_at INTEGER);
    CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT UNIQUE, title TEXT NOT NULL,
      artist TEXT NOT NULL, album TEXT, genre TEXT, year INTEGER, duration_s INTEGER, file_path TEXT NOT NULL,
      cover_path TEXT, play_count INTEGER DEFAULT 0, added_at INTEGER NOT NULL, deleted_at INTEGER);
    CREATE TABLE track_likes (track_id INTEGER NOT NULL, user_id INTEGER NOT NULL, ts INTEGER NOT NULL,
      PRIMARY KEY (track_id, user_id));
    CREATE TABLE remote_likes (video_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
      thumbnail TEXT, duration_s INTEGER, ts INTEGER NOT NULL, user_id INTEGER NOT NULL,
      PRIMARY KEY (video_id, user_id));
    CREATE TABLE taste_profile (kind TEXT NOT NULL, value TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (kind, value, user_id));
    CREATE TABLE playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'lista',
      created_at INTEGER NOT NULL, user_id INTEGER NOT NULL);
    CREATE TABLE playlist_tracks (playlist_id INTEGER NOT NULL, track_id INTEGER NOT NULL, position INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id));
  `);
  d.prepare('INSERT INTO users (name,color,created_at) VALUES (?,?,?)').run('Utente', '#2dd4bf', 1);
  return d;
}

db = mkDb();
vi.mock('../src/main/db', () => ({ getDb: () => db }));

let backup: typeof import('../src/main/services/backup');
let library: typeof import('../src/main/services/library');
beforeAll(async () => {
  backup = await import('../src/main/services/backup');
  library = await import('../src/main/services/library');
});
beforeEach(() => { db = mkDb(); });

const U = 1;
const VID = 'dQw4w9WgXcQ';
const seedTrack = (videoId: string, title = 'Titolo', artist = 'Artista'): number => {
  db.prepare('INSERT INTO tracks (video_id,title,artist,file_path,added_at) VALUES (?,?,?,?,?)')
    .run(videoId, title, artist, `C:/lib/${videoId}.mp3`, 1000);
  return (db.prepare('SELECT id FROM tracks WHERE video_id=?').get(videoId) as { id: number }).id;
};
const likeTrack = (id: number, ts = 500, u = U) =>
  db.prepare('INSERT INTO track_likes (track_id,user_id,ts) VALUES (?,?,?)').run(id, u, ts);
const likeRemote = (videoId: string, ts = 700, u = U) =>
  db.prepare('INSERT INTO remote_likes (video_id,title,artist,thumbnail,duration_s,ts,user_id) VALUES (?,?,?,?,?,?,?)')
    .run(videoId, 'Remoto', 'Artista R', null, null, ts, u);
const remoteLikesOf = () =>
  db.prepare('SELECT * FROM remote_likes WHERE user_id=?').all(U) as { video_id: string }[];
const trackLiked = (id: number, u = U) =>
  !!db.prepare('SELECT 1 FROM track_likes WHERE track_id=? AND user_id=?').get(id, u);
const asFile = (b: unknown) => JSON.parse(JSON.stringify(b)) as unknown; // passa per il JSON salvato

describe('backup del profilo — like sui brani scaricati', () => {
  it('export: i like di track_likes entrano nel file per video_id', () => {
    const id = seedTrack(VID, 'Never Gonna Give You Up', 'Rick Astley');
    likeTrack(id, 555);
    const b = backup.exportBackup(U);
    const l = b.remoteLikes.find((x) => x.videoId === VID);
    expect(l).toMatchObject({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', ts: 555 });
    // la cover locale non è portabile → thumbnail ricavata dal videoId
    expect(l?.thumbnail).toBe(`https://i.ytimg.com/vi/${VID}/mqdefault.jpg`);
  });

  it('PC nuovo: il like attende in remote_likes e si converte a track_likes al download', () => {
    likeTrack(seedTrack(VID, 'Song', 'Artist'), 555);
    const data = asFile(backup.exportBackup(U));

    db = mkDb(); // PC di arrivo: libreria vuota
    const r = backup.importBackup(data, U);
    expect(r.likes).toBe(1);
    expect(remoteLikesOf().map((x) => x.video_id)).toEqual([VID]);

    // l'utente scarica il brano → convertRemoteLikes riattacca il cuore
    const t = library.addTrack({ videoId: VID, title: 'Song', artist: 'Artist', filePath: 'C:/lib/x.mp3' });
    expect(remoteLikesOf()).toHaveLength(0);
    expect(trackLiked(t.id)).toBe(true);
    expect(library.listTracks(U)[0].liked).toBe(true);
  });

  it('stesso PC: reimport → like diretto su track_likes, niente remote_like penzolanti', () => {
    const id = seedTrack(VID);
    likeTrack(id);
    const data = asFile(backup.exportBackup(U));
    db.prepare('DELETE FROM track_likes').run(); // cuore perso nel frattempo
    backup.importBackup(data, U);
    expect(trackLiked(id)).toBe(true);
    expect(remoteLikesOf()).toHaveLength(0);
  });

  it('backup vecchio (solo remote_likes) reimportato dopo il download → track_likes', () => {
    const id = seedTrack(VID);
    const data = {
      app: 'masterhype', version: 2, exportedAt: 1, taste: [],
      remoteLikes: [{ videoId: VID, title: 'Song', artist: 'Artist', ts: 555 }],
      playlists: [],
    };
    backup.importBackup(data, U);
    expect(trackLiked(id)).toBe(true);
    expect(remoteLikesOf()).toHaveLength(0);
  });

  it('brano nel cestino all\'import: il like resta in remote_likes e rientra al re-download', () => {
    const id = seedTrack(VID);
    likeTrack(id);
    const data = asFile(backup.exportBackup(U));
    db.prepare('DELETE FROM track_likes').run();
    db.prepare('UPDATE tracks SET deleted_at=1 WHERE id=?').run(id); // cestinato
    backup.importBackup(data, U);
    expect(trackLiked(id)).toBe(false);
    expect(remoteLikesOf().map((x) => x.video_id)).toEqual([VID]);
    // riscaricare il brano ripristina la riga E il like
    const t = library.addTrack({ videoId: VID, title: 'Titolo', artist: 'Artista', filePath: 'C:/lib/x.mp3' });
    expect(trackLiked(t.id)).toBe(true);
    expect(remoteLikesOf()).toHaveLength(0);
  });

  it('dedup: stesso video_id in remote_likes e track_likes → una sola voce nel file', () => {
    const id = seedTrack(VID);
    likeTrack(id);
    likeRemote(VID); // bordo: like remoto sullo stesso brano
    const b = backup.exportBackup(U);
    expect(b.remoteLikes.filter((x) => x.videoId === VID)).toHaveLength(1);
  });

  it('scope per utente: l\'export di u1 non include i like di u2', () => {
    db.prepare('INSERT INTO users (name,color,created_at) VALUES (?,?,?)').run('Altro', '#fff', 2);
    const id = seedTrack(VID);
    likeTrack(id, 500, 2); // like dell'altro profilo
    likeRemote('otherVideo11', 600, 2);
    const b = backup.exportBackup(U);
    expect(b.remoteLikes).toHaveLength(0);
  });
});
