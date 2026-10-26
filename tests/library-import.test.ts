import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Import di file locali (drag&drop / upload dal telefono) su SQLite in-memory
// e file system reale in una cartella temporanea.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT UNIQUE, title TEXT NOT NULL,
    artist TEXT NOT NULL, album TEXT, genre TEXT, year INTEGER, duration_s INTEGER, file_path TEXT NOT NULL,
    cover_path TEXT, play_count INTEGER DEFAULT 0, added_at INTEGER NOT NULL, deleted_at INTEGER);
  CREATE TABLE track_likes (track_id INTEGER, user_id INTEGER, ts INTEGER, PRIMARY KEY (track_id, user_id));
  CREATE TABLE remote_likes (video_id TEXT, title TEXT, artist TEXT, thumbnail TEXT, duration_s INTEGER,
    ts INTEGER, user_id INTEGER, PRIMARY KEY (video_id, user_id));
`);
vi.mock('../src/main/db', () => ({ getDb: () => db }));

let library: typeof import('../src/main/services/library');
beforeAll(async () => { library = await import('../src/main/services/library'); });

const root = mkdtempSync(join(tmpdir(), 'mh-import-'));
const libDir = join(root, 'MasterHype');
const probe = () => ({ title: 'Albachiara', artist: 'Vasco Rossi', durationS: 260 });
const audio = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'ID3fake'); return p; };

describe('importLocalFile', () => {
  it('cartella SORELLA con lo stesso prefisso non conta come "dentro la libreria"', () => {
    const src = audio(join(root, 'MasterHypeExtra', 'brano.mp3'));
    const t = library.importLocalFile(src, libDir, probe)!;
    // copiato DENTRO la libreria, non registrato al path esterno
    expect(t.filePath.startsWith(join(libDir, ''))).toBe(true);
    expect(t.filePath).not.toBe(src);
    expect(existsSync(t.filePath)).toBe(true);
  });

  it('file già dentro la libreria → registrato sul posto, nessuna copia', () => {
    const src = audio(join(libDir, 'sub', 'gia-qui.mp3'));
    const before = readdirSync(libDir).length;
    const t = library.importLocalFile(src, libDir, () => ({ title: 'Qui', artist: 'Io' }))!;
    expect(t.filePath).toBe(src);
    expect(readdirSync(libDir).length).toBe(before);
  });

  it('re-import dello stesso file → stessa traccia, nessuna copia orfana', () => {
    const src = audio(join(root, 'esterni', 'Ligabue - Certe notti.mp3'));
    const p = () => ({ title: 'Certe notti', artist: 'Ligabue' });
    const a = library.importLocalFile(src, libDir, p)!;
    const filesAfterFirst = readdirSync(libDir).length;
    const b = library.importLocalFile(src, libDir, p)!;
    expect(b.id).toBe(a.id);
    expect(b.filePath).toBe(a.filePath);
    expect(readdirSync(libDir).length).toBe(filesAfterFirst);
  });

  it('re-import di un brano nel cestino lo ripristina senza ricopiarlo', () => {
    const src = audio(join(root, 'esterni', 'Queen - Bohemian Rhapsody.mp3'));
    const p = () => ({ title: 'Bohemian Rhapsody', artist: 'Queen' });
    const a = library.importLocalFile(src, libDir, p)!;
    library.removeTrack(a.id); // soft-delete
    expect(library.findByVideoId(a.videoId)).toBeUndefined();
    const files = readdirSync(libDir).length;
    const b = library.importLocalFile(src, libDir, p)!;
    expect(b.id).toBe(a.id);
    expect(library.findByVideoId(a.videoId)?.id).toBe(a.id);
    expect(readdirSync(libDir).length).toBe(files);
  });
});
