import { describe, it, expect, vi, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// Motore gusti v2 su SQLite in-memory: schema minimo delle tabelle toccate.
// Le dipendenze Electron/rete sono mockate: qui si testa SOLO la logica.
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id INTEGER, artist TEXT, genre TEXT, type TEXT NOT NULL,
    ts INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 1, title TEXT, video_id TEXT, thumbnail TEXT,
    hour INTEGER, dow INTEGER, played_s INTEGER, duration_s INTEGER);
  CREATE TABLE taste_profile (kind TEXT, value TEXT, weight REAL DEFAULT 0, updated_at INTEGER, user_id INTEGER DEFAULT 1, PRIMARY KEY (kind,value,user_id));
  CREATE TABLE artist_cooc (user_id INTEGER, a TEXT, b TEXT, n INTEGER DEFAULT 1, ts INTEGER, PRIMARY KEY (user_id,a,b));
  CREATE TABLE usage (user_id INTEGER, name TEXT, n INTEGER DEFAULT 1, ts INTEGER, PRIMARY KEY (user_id,name));
  CREATE TABLE tracks (id INTEGER PRIMARY KEY, video_id TEXT, title TEXT, artist TEXT, genre TEXT, deleted_at INTEGER);
`);
vi.mock('../src/main/db', () => ({ getDb: () => db }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT' }) }));
vi.mock('../src/main/services/ytmusic', () => ({ charts: async () => [{ videoId: 'a', title: 'T', artist: 'Chart Artist', thumbnail: 'x' }] }));
vi.mock('../src/main/services/sources', () => ({
  deezerChart: async () => [{ title: 'D', artist: 'Deezer Artist', rank: 1 }],
  deezerArtistTop: async () => [],
  lastfmArtistTags: async () => ['rock'],
}));

let engine: typeof import('../src/main/services/engine');
let library: typeof import('../src/main/services/library');
beforeAll(async () => {
  engine = await import('../src/main/services/engine');
  library = await import('../src/main/services/library');
});

describe('completamento ascolto', () => {
  it('≥85% → complete e +1.2 sull artista', () => {
    engine.recordListen({ artist: 'Vasco Rossi', title: 'Albachiara', videoId: 'v1', playedS: 230, durationS: 250 }, 1);
    const ev = db.prepare("SELECT type, hour, dow FROM events WHERE video_id='v1'").get() as { type: string; hour: number; dow: number };
    expect(ev.type).toBe('complete');
    expect(ev.hour).toBeGreaterThanOrEqual(0);
    expect(ev.dow).toBeGreaterThanOrEqual(0);
    const w = db.prepare("SELECT weight FROM taste_profile WHERE kind='artist' AND value='vasco rossi'").get() as { weight: number };
    expect(w.weight).toBeCloseTo(1.2);
  });
  it('25-85% → partial senza peso; <30s → ignorato', () => {
    engine.recordListen({ artist: 'X', title: 'Y', videoId: 'v2', playedS: 100, durationS: 250 }, 1);
    engine.recordListen({ artist: 'Z', title: 'W', videoId: 'v3', playedS: 10, durationS: 250 }, 1);
    expect((db.prepare("SELECT type FROM events WHERE video_id='v2'").get() as { type: string }).type).toBe('partial');
    expect(db.prepare("SELECT 1 FROM events WHERE video_id='v3'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM taste_profile WHERE value='x'").get()).toBeUndefined();
  });
});

describe('co-occorrenza', () => {
  it('due play nella stessa sessione legano gli artisti (coppia ordinata)', async () => {
    library.recordEvent(null, 'Ligabue', 'play', { title: 'Certe notti', videoId: 'l1' }, 1);
    await new Promise((r) => setTimeout(r, 30)); // enrichEvent è async (import dinamico)
    library.recordEvent(null, 'Vasco Rossi', 'play', { title: 'Brava', videoId: 'l2' }, 1);
    await new Promise((r) => setTimeout(r, 60));
    const row = db.prepare("SELECT a, b, n FROM artist_cooc WHERE user_id=1").get() as { a: string; b: string; n: number };
    expect(row).toBeTruthy();
    expect([row.a, row.b]).toEqual(['ligabue', 'vasco rossi']);
    expect(engine.cooccurring(1, 'Vasco Rossi')).toContain('ligabue');
    expect(engine.cooccurring(1, 'Ligabue')).toContain('vasco rossi');
  });
  it('stesso artista di fila non conta', async () => {
    const before = (db.prepare('SELECT COUNT(*) c FROM artist_cooc').get() as { c: number }).c;
    library.recordEvent(null, 'Vasco Rossi', 'play', { title: 'Sally', videoId: 'l3' }, 1);
    await new Promise((r) => setTimeout(r, 60));
    expect((db.prepare('SELECT COUNT(*) c FROM artist_cooc').get() as { c: number }).c).toBe(before);
  });
});

describe('affinità per brano', () => {
  it('complete > play, skip/hide sottraggono', () => {
    library.recordEvent(null, 'A', 'skip', { title: 'Skippato', videoId: 's1' }, 2);
    library.recordEvent(null, 'A', 'skip', { title: 'Skippato', videoId: 's1' }, 2);
    engine.recordListen({ artist: 'A', title: 'Amato', videoId: 's2', playedS: 240, durationS: 250 }, 2);
    const aff = engine.trackAffinity(2);
    expect(aff.get('a|amato')!).toBeGreaterThan(1);
    expect(aff.get('a|skippato')!).toBeLessThan(0);
  });
  it('è isolata per utente', () => {
    expect(engine.trackAffinity(3).size).toBe(0);
  });
});

describe('contesto orario', () => {
  it('senza abbastanza dati non introduce bias', () => {
    expect(engine.contextBoosts(3).size).toBe(0);
  });
  it('con play ripetuti nella fascia → boost normalizzato 0..1', () => {
    const now = new Date();
    for (let i = 0; i < 3; i++)
      db.prepare("INSERT INTO events (artist,type,ts,user_id,title,hour,dow) VALUES ('Mattiniero','play',?,4,'t',?,?)")
        .run(Date.now() - i * 1000, now.getHours(), now.getDay());
    const b = engine.contextBoosts(4, now);
    expect(b.get('mattiniero')).toBe(1);
  });
});

describe('onboarding e uso funzioni', () => {
  it('propone artisti dedup con classici sempre presenti', async () => {
    const list = await engine.onboardArtists();
    const names = list.map((a) => a.name);
    expect(names).toContain('Chart Artist');
    expect(names).toContain('Deezer Artist');
    expect(names).toContain('Vasco Rossi');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
  });
  it('seedTaste semina il profilo con peso 6 per artista', async () => {
    await engine.seedTaste(['Coldplay', 'Queen'], 5);
    const w = db.prepare("SELECT weight FROM taste_profile WHERE user_id=5 AND value='coldplay'").get() as { weight: number };
    expect(w.weight).toBe(6);
  });
  it('trackUsage conta e aggrega', () => {
    engine.trackUsage('screen:home', 1); engine.trackUsage('screen:home', 1); engine.trackUsage('screen:home', 2);
    expect(engine.usageStats().find((u) => u.name === 'screen:home')?.n).toBe(3);
    engine.trackUsage('x'.repeat(80), 1); // troppo lungo: ignorato
    expect(engine.usageStats().some((u) => u.name.length > 60)).toBe(false);
  });
});
