import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Regressione: i nomi artista NON devono passare da norm() prima delle API
// esterne. norm() serve SOLO ai confronti interni (chiavi, dedup, pesi) —
// alle API distrugge la forma leggibile: "AC/DC"→"acdc", "P!nk"→"pnk",
// "blink-182"→"blink182" → lookup falliti o omonimi sbagliati.

let db: DatabaseSync;
function mkDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER, artist TEXT,
      type TEXT NOT NULL, title TEXT, video_id TEXT, thumbnail TEXT, ts INTEGER NOT NULL,
      user_id INTEGER NOT NULL, played_s INTEGER, duration_s INTEGER, hour INTEGER, dow INTEGER);
    CREATE TABLE artist_cooc (user_id INTEGER NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
      n INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (user_id,a,b));
    CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, artist TEXT, genre TEXT, deleted_at INTEGER);
    CREATE TABLE vid_cache (k TEXT PRIMARY KEY, video_id TEXT, thumbnail TEXT, duration_s INTEGER, fetched_at INTEGER NOT NULL);
  `);
  return d;
}

db = mkDb();
vi.mock('../src/main/db', () => ({ getDb: () => db }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT', lastfmApiKey: '', spotifyClientId: '', spotifyClientSecret: '' }) }));
vi.mock('../src/main/services/library', () => ({
  tasteProfile: () => [], listTracks: () => [], negativeTracks: () => [],
  remoteLikes: () => [], recentlyPlayed: () => [],
}));
vi.mock('../src/main/services/ytmusic', () => ({
  upNext: vi.fn(async () => [] as { videoId: string; title: string; artist: string }[]),
  charts: async () => [],
  searchSongs: vi.fn(async () => [] as { videoId: string; title: string; artist: string }[]),
}));
// sources parzialmente reale: pickDeezerArtist/deezerSearchArtist sono le
// funzioni sotto test; i wrapper chiamati da recommend sono mock ispezionabili.
vi.mock('../src/main/services/sources', async (importActual) => ({
  ...(await importActual<typeof import('../src/main/services/sources')>()),
  deezerRelatedArtists: vi.fn(async () => [] as string[]),
  lastfmSimilarArtists: vi.fn(async () => [] as string[]),
  deezerArtistTop: vi.fn(async () => [] as { title: string; artist: string }[]),
  lastfmArtistTags: vi.fn(async () => [] as string[]),
  artistGenreTags: vi.fn(async () => [] as string[]),
  deezerChart: async () => [],
  lastfmSimilarTracks: async () => [],
  lastfmTagTopArtists: async () => [],
  lastfmTagTopTracks: async () => [],
  spotifyConnected: async () => false,
  spotifyNewReleases: async () => [],
}));

import * as sources from '../src/main/services/sources';
import * as ytmusic from '../src/main/services/ytmusic';
import { radioForArtist, stationContinue } from '../src/main/services/recommend';
import { artistRawNames } from '../src/main/services/engine';

const dzTop = vi.mocked(sources.deezerArtistTop);
const agTags = vi.mocked(sources.artistGenreTags);
const dzRel = vi.mocked(sources.deezerRelatedArtists);
const lfSim = vi.mocked(sources.lastfmSimilarArtists);
const upNext = vi.mocked(ytmusic.upNext);
const searchSongs = vi.mocked(ytmusic.searchSongs);

beforeEach(() => { db = mkDb(); vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('radioForArtist: alle API arriva il nome originale, non norm()', () => {
  it('seed e simili conservano punteggiatura e trattini', async () => {
    dzTop.mockImplementation(async (a) => {
      if (a === 'AC/DC') return [{ title: 'Back in Black', artist: 'AC/DC' }];
      if (a === 'blink-182') return [{ title: 'Dammit', artist: 'blink-182' }];
      return [];
    });
    dzRel.mockResolvedValue(['blink-182']);
    lfSim.mockResolvedValue(['P!nk']);
    searchSongs.mockResolvedValue([]);

    await radioForArtist(1, 'AC/DC');

    const topQueries = dzTop.mock.calls.map((c) => c[0]);
    expect(topQueries).toContain('AC/DC');       // il seed va a Deezer com'è
    expect(topQueries).toContain('blink-182');   // simile Deezer col trattino
    expect(topQueries).toContain('P!nk');        // simile Last.fm col "!"

    // i tag genere vengono chiesti per i candidati reali (forma originale)
    const tagQueries = agTags.mock.calls.map((c) => c[0]);
    for (const q of tagQueries) {
      // mai la forma distrutta da norm()
      expect(['acdc', 'pnk', 'blink182']).not.toContain(q);
    }
    expect(tagQueries).toContain('blink-182');
  });
});

describe('stationContinue: i tag artista si chiedono col nome vero', () => {
  it('upNext "AC/DC"/"P!nk" → artistGenreTags("AC/DC"/"P!nk")', async () => {
    upNext.mockResolvedValue([
      { videoId: 'va', title: 'Song A', artist: 'AC/DC', source: 'ytmusic' },
      { videoId: 'vb', title: 'Song B', artist: 'P!nk', source: 'ytmusic' },
    ]);
    agTags.mockResolvedValue(['rock']);

    await stationContinue(1, 'vSeed', 'Seed Artist', 'radio:genre:rock');

    const tagQueries = agTags.mock.calls.map((c) => c[0]);
    expect(tagQueries).toContain('AC/DC');
    expect(tagQueries).toContain('P!nk');
    expect(tagQueries).not.toContain('acdc');
    expect(tagQueries).not.toContain('pnk');
  });
});

describe('pickDeezerArtist: niente più data[0] cieco', () => {
  it('omonimo in testa: vince il match esatto sul nome', () => {
    const a = sources.pickDeezerArtist([
      { id: 1, name: 'Nirvana (UK)', nb_fan: 300 },
      { id: 2, name: 'Nirvana', nb_fan: 5_000_000 },
    ], 'Nirvana');
    expect(a?.id).toBe(2);
  });
  it('il match esatto batte anche chi ha più fan', () => {
    const a = sources.pickDeezerArtist([
      { id: 1, name: 'P!nk Tribute Band', nb_fan: 999_999 },
      { id: 2, name: 'P!nk', nb_fan: 5 },
    ], 'P!nk');
    expect(a?.name).toBe('P!nk');
  });
  it('la query normalizzata trova comunque l’artista giusto', () => {
    const a = sources.pickDeezerArtist([
      { id: 1, name: 'AC DC Live Experience', nb_fan: 90 },
      { id: 2, name: 'AC/DC', nb_fan: 10 },
    ], 'acdc');
    expect(a?.name).toBe('AC/DC');
  });
  it('a parità di match vince chi ha più fan', () => {
    const a = sources.pickDeezerArtist([
      { id: 1, name: 'Micky Finn', nb_fan: 50 },
      { id: 2, name: 'Micky Finn', nb_fan: 900 },
    ], 'Micky Finn');
    expect(a?.id).toBe(2);
  });
  it('nessun candidato utile → fallback al primo come prima', () => {
    const a = sources.pickDeezerArtist([{ id: 1, name: 'Unrelated' }], 'zzz query');
    expect(a?.id).toBe(1);
    expect(sources.pickDeezerArtist([], 'x')).toBeNull();
  });
});

describe('deezerSearchArtist: query con il nome originale', () => {
  it('"AC/DC" va a Deezer come AC%2FDC, non "acdc"', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string | URL) => {
      urls.push(String(u));
      return { ok: true, json: async () => ({ data: [{ id: 7, name: 'AC/DC', nb_fan: 9e6 }] }) } as Response;
    }));
    const a = await sources.deezerSearchArtist('AC/DC');
    expect(a?.name).toBe('AC/DC');
    expect(urls[0]).toContain('q=AC%2FDC');
  });
  it('sceglie il risultato giusto tra gli omonimi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ data: [
        { id: 1, name: 'Nirvana (UK)', nb_fan: 300 },
        { id: 2, name: 'Nirvana', nb_fan: 5_000_000 },
      ] }),
    } as Response)));
    const a = await sources.deezerSearchArtist('nirvana');
    expect(a?.id).toBe(2);
  });
});

describe('artistRawNames: chiave norm → nome reale', () => {
  it('recupera la forma originale da eventi e libreria', () => {
    db.prepare("INSERT INTO events (artist,type,ts,user_id) VALUES ('AC/DC','play',?,1)").run(Date.now());
    db.prepare("INSERT INTO tracks (artist) VALUES ('P!nk')").run();
    const m = artistRawNames(1);
    expect(m.get('acdc')).toBe('AC/DC');
    expect(m.get('pnk')).toBe('P!nk');
    expect(m.get('miles davis')).toBeUndefined();
  });
});
