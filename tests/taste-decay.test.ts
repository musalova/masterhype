import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Decadimento temporale dei gusti (taste_profile): il peso memorizzato è
// ancorato a updated_at e prima di sommare un nuovo segnale va decaduto FINO
// A ORA. Bug storico: bumpTaste sommava il delta sul grezzo e azzerava
// updated_at — un singolo play su un artista sentito mesi fa resuscitava al
// 100% tutto il peso accumulato.
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

let library: typeof import('../src/main/services/library');
let backup: typeof import('../src/main/services/backup');
beforeAll(async () => {
  library = await import('../src/main/services/library');
  backup = await import('../src/main/services/backup');
});
beforeEach(() => { db = mkDb(); });

const DAY = 86_400_000;
const U = 1;
const seed = (w: number, daysAgo: number, u = U) =>
  db.prepare('INSERT INTO taste_profile (kind,value,weight,updated_at,user_id) VALUES (?,?,?,?,?)')
    .run('artist', 'vasco rossi', w, Date.now() - daysAgo * DAY, u);
const stored = (u = U) =>
  (db.prepare("SELECT weight FROM taste_profile WHERE kind='artist' AND value='vasco rossi' AND user_id=?").get(u) as { weight: number } | undefined)?.weight;
const decay = (w: number, days: number, hl: number) => w * Math.pow(0.5, days / hl);

describe('bumpTaste — il peso storico decade prima della somma', () => {
  it('un play su un artista sentito 90gg fa NON resuscita il peso storico', () => {
    seed(10, 90);
    library.bumpTaste('artist', 'Vasco Rossi', 1, U);
    // 10 * 0.5^(90/45) + 1 = 3.5 — non 11 come prima
    expect(stored()).toBeCloseTo(decay(10, 90, 45) + 1, 5);
  });
  it('peso di ieri somma quasi pieno', () => {
    seed(10, 1);
    library.bumpTaste('artist', 'Vasco Rossi', 1, U);
    expect(stored()).toBeCloseTo(decay(10, 1, 45) + 1, 5);
  });
  it('peso negativo: half-life 90gg', () => {
    seed(-4, 180);
    library.bumpTaste('artist', 'Vasco Rossi', -1, U);
    // -4 * 0.5^(180/90) - 1 = -2
    expect(stored()).toBeCloseTo(decay(-4, 180, 90) - 1, 5);
  });
  it('primo segnale: nessun decadimento, peso = delta', () => {
    library.bumpTaste('artist', 'Vasco Rossi', 3, U);
    expect(stored()).toBe(3);
  });
  it('segnali vicini nel tempo restano cumulativi', () => {
    library.bumpTaste('artist', 'Vasco Rossi', 1, U);
    library.bumpTaste('artist', 'Vasco Rossi', 1, U);
    expect(stored()).toBeCloseTo(2, 5);
  });
  it('updated_at si ancora a "ora": la lettura non decade ulteriormente', () => {
    seed(10, 90);
    library.bumpTaste('artist', 'Vasco Rossi', 1, U);
    const read = library.tasteProfile(U, 'artist').find((r) => r.value === 'vasco rossi');
    expect(read?.weight).toBeCloseTo(stored()!, 5);
  });
  it('lettura senza bump: il decadimento resta applicato in tasteProfile', () => {
    seed(8, 45);
    expect(library.tasteProfile(U, 'artist').find((r) => r.value === 'vasco rossi')?.weight).toBeCloseTo(4, 5);
  });
});

describe('backup — stesso decadimento su export e merge', () => {
  it('export: il file porta il peso decaduto a "ora"', () => {
    seed(8, 45);
    const b = backup.exportBackup(U);
    expect(b.taste.find((t) => t.value === 'vasco rossi')?.weight).toBeCloseTo(4, 5);
  });
  it('import: lo stored decade prima di sommare il backup', () => {
    seed(8, 90); // vale 2 oggi
    backup.importBackup({
      app: 'masterhype', version: 2, exportedAt: Date.now(),
      taste: [{ kind: 'artist', value: 'vasco rossi', weight: 4 }], remoteLikes: [], playlists: [],
    }, U);
    expect(stored()).toBeCloseTo(2 + 4, 5); // non 12
  });
  it('import: anche il peso del backup decade per la sua età', () => {
    backup.importBackup({
      app: 'masterhype', version: 2, exportedAt: Date.now() - 90 * DAY,
      taste: [{ kind: 'artist', value: 'vasco rossi', weight: 8 }], remoteLikes: [], playlists: [],
    }, U);
    expect(stored()).toBeCloseTo(2, 5); // 8 * 0.5^(90/45)
  });
  it('import: cap ±10 preservato', () => {
    seed(9, 0);
    backup.importBackup({
      app: 'masterhype', version: 2, exportedAt: Date.now(),
      taste: [{ kind: 'artist', value: 'vasco rossi', weight: 9 }], remoteLikes: [], playlists: [],
    }, U);
    expect(stored()).toBe(10);
  });
});
