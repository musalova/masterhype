import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Re-rank dei risultati di ricerca sui gusti del profilo: artisti amati su,
// dislikati giù (mai se l'utente li cerca per nome), dedup delle varianti,
// affinità brano. DB in-memory con le tabelle toccate da tasteProfile e
// trackAffinity.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE taste_profile (kind TEXT, value TEXT, weight REAL DEFAULT 0, updated_at INTEGER, user_id INTEGER DEFAULT 1, PRIMARY KEY (kind,value,user_id));
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER, artist TEXT, genre TEXT, type TEXT NOT NULL,
    ts INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 1, title TEXT, video_id TEXT, thumbnail TEXT,
    hour INTEGER, dow INTEGER, played_s INTEGER, duration_s INTEGER);
`);
vi.mock('../src/main/db', () => ({ getDb: () => db }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT' }) }));
vi.mock('../src/main/services/sources', () => ({ lastfmArtistTags: async () => [] }));
vi.mock('../src/main/services/ytmusic', () => ({ upNext: async () => [], searchSongs: async () => [], charts: async () => [] }));

let recommend: typeof import('../src/main/services/recommend');
let library: typeof import('../src/main/services/library');
beforeAll(async () => {
  recommend = await import('../src/main/services/recommend');
  library = await import('../src/main/services/library');
});

const t = (videoId: string, artist: string, title: string) => ({ videoId, artist, title });
const ev = (type: string, artist: string, title: string, ts = Date.now()) =>
  db.prepare('INSERT INTO events (artist,title,type,ts,user_id) VALUES (?,?,?,?,1)').run(artist, title, type, ts);

describe('rankSearchResults — il profilo ordina la ricerca', () => {
  it('gli artisti amati sorpassano posizioni di YouTube più basse', () => {
    library.bumpTaste('artist', 'vasco rossi', 8, 1);
    const out = recommend.rankSearchResults(1, 'canzone rock', [
      t('v1', 'Unknown Act', 'Canzone Rock'),
      t('v2', 'Vasco Rossi', 'Canzone Rock'),
    ]);
    expect(out[0].videoId).toBe('v2');
  });

  it('artista dislikato scende, MA risale se lo cerchi per nome', () => {
    library.bumpTaste('artist', 'disliked band', -5, 1);
    const q = 'brano';
    const out = recommend.rankSearchResults(1, q, [
      t('w1', 'Disliked Band', 'Brano'),
      t('w2', 'Other Artist', 'Brano'),
    ]);
    expect(out[0].videoId).toBe('w2');
    const named = recommend.rankSearchResults(1, 'disliked band live', [
      t('w1', 'Disliked Band', 'Live'),
      t('w3', 'Other Artist', 'Live'),
    ]);
    expect(named[0].videoId).toBe('w1'); // ricerca per nome: il dislike non deve filtrare
  });

  it('dedup delle varianti Song/Video dello stesso brano', () => {
    const out = recommend.rankSearchResults(1, 'albachiara', [
      t('a1', 'Vasco Rossi', 'Albachiara'),
      t('a2', 'Vasco Rossi', 'Albachiara (Video)'),
      t('a3', 'Vasco Rossi', 'Albachiara - Remastered'),
      t('b1', 'Queen', 'Bohemian Rhapsody'),
    ]);
    expect(out.filter((x) => x.artist === 'Vasco Rossi')).toHaveLength(1);
    expect(out).toHaveLength(2);
  });

  it('brano già ascoltato/amato sale; skip ripetuto scende', () => {
    ev('complete', 'Pink Floyd', 'Comfortably Numb');
    ev('skip', 'Sconosciuto', 'Traccia X'); ev('skip', 'Sconosciuto', 'Traccia X');
    const out = recommend.rankSearchResults(1, 'numb traccia', [
      t('x1', 'Sconosciuto', 'Traccia X'),
      t('x2', 'Pink Floyd', 'Comfortably Numb'),
    ]);
    expect(out[0].videoId).toBe('x2');
  });

  it('lista corta e vuota: niente eccezioni, identità preservata', () => {
    expect(recommend.rankSearchResults(1, 'q', [])).toEqual([]);
    const one = [t('o1', 'A', 'B')];
    expect(recommend.rankSearchResults(1, 'q', one)).toBe(one);
  });
});
