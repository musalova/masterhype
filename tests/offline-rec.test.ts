import { describe, it, expect, vi } from 'vitest';
import { likedTracks, offlineSuggest, offlineStation, cachedAuto } from '../src/renderer/src/offlineRec';
import type { LibraryTrack, RemoteLike } from '../src/shared/types';

// Nessun backend né rete esterna: i gate iTunes/MusicBrainz (itunesGenreOf)
// devono fallire in fetch come da contratto "rete assente", senza attese reali.
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('rete assente (test)'); }));

// Fallback offline del motore gusti (PC spento): verifica delle parti pure —
// likedTracks, offlineSuggest, e i rami di offlineStation che non toccano la
// rete (preferiti/mix da libreria+like cachate). I rami che chiamano
// directSearch/directCharts tornano [] in ambiente test senza backend: si
// verifica solo che non esplodano (fail-safe), non la qualità dei risultati.

const lib = (over: Partial<LibraryTrack>): LibraryTrack => ({
  id: 1, videoId: 'v', title: 'T', artist: 'A', filePath: '/x.mp3',
  addedAt: 0, playCount: 0, liked: false, source: 'ytmusic', ...over,
});

const rl = (videoId: string): RemoteLike => ({
  videoId, title: `Liked ${videoId}`, artist: 'Art', ts: 0,
});

describe('fallback offline — brani piaciuti', () => {
  it('unisce like di libreria e like remoti non scaricati', () => {
    const library = [lib({ id: 1, videoId: 'a', liked: true }), lib({ id: 2, videoId: 'b' })];
    const likes = likedTracks(library, [rl('a'), rl('c')]);
    expect(likes.map((t) => t.videoId).sort()).toEqual(['a', 'c']); // 'a' una volta sola
  });
  it('un like remoto già in libreria non duplica', () => {
    const library = [lib({ videoId: 'a', liked: true })];
    expect(likedTracks(library, [rl('a')])).toHaveLength(1);
  });
  it('sopravvive a videoId mancanti', () => {
    const likes = likedTracks([lib({ videoId: undefined })], [rl('x')]);
    expect(likes).toHaveLength(1);
  });
});

describe('fallback offline — suggest', () => {
  it('propone i più ascoltati e i like', async () => {
    const library = [
      lib({ id: 1, videoId: 'hot', playCount: 50 }),
      lib({ id: 2, videoId: 'cold', playCount: 0 }),
      lib({ id: 3, videoId: 'love', liked: true }),
    ];
    // rete assente in test → upNext fallisce e restano le certezze locali
    const s = await offlineSuggest(library, [rl('ext')]);
    const ids = s.map((t) => t.videoId);
    expect(ids).toContain('hot');
    expect(ids).toContain('love');
    expect(ids).toContain('ext');
    expect(new Set(ids).size).toBe(ids.length); // niente duplicati
    for (const t of s) { expect(t.reason).toBeTruthy(); expect(t.score).toBeGreaterThan(0); }
  });
  it('libreria vuota e nessun like → lista vuota, non crash', async () => {
    expect(await offlineSuggest([], [])).toEqual([]);
  });
});

describe('fallback offline — stazioni', () => {
  it('"preferiti" usa i like locali senza rete', async () => {
    const library = [lib({ videoId: 'a', liked: true }), lib({ videoId: 'b' })];
    const t = await offlineStation('preferiti', library, [rl('c')]);
    expect(new Set(t.map((x) => x.videoId))).toEqual(new Set(['a', 'c']));
  });
  it('id sconosciuto non esplode (rete assente → [])', async () => {
    const t = await offlineStation('novita-te', [], []);
    expect(Array.isArray(t)).toBe(true);
  });
  it('stazione "mood" con query e rete assente → []', async () => {
    const t = await offlineStation('workout', [], []);
    expect(Array.isArray(t)).toBe(true);
  });
  it('"preferiti" con prev: i già mostrati escono (Rigenera = scaletta nuova)', async () => {
    // 12 like: prev ne copre 3 → restano solo i 9 freschi (min 8 rispettato)
    const library = Array.from({ length: 12 }, (_, i) =>
      lib({ videoId: `v${i}`, title: `Song ${i}`, artist: `Artist ${i}`, liked: true }));
    const prev = library.slice(0, 3);
    const out = await offlineStation('preferiti', library, [], prev);
    const ids = new Set(out.map((x) => x.videoId));
    expect(out.length).toBe(9);
    for (const p of prev) expect(ids.has(p.videoId)).toBe(false);
  });
  it('"preferiti" con prev che copre quasi tutto: i visti rientrano in coda', async () => {
    // pool sotto il minimo: meglio una ripetizione che una stazione vuota
    const library = Array.from({ length: 10 }, (_, i) =>
      lib({ videoId: `v${i}`, title: `Song ${i}`, artist: `Artist ${i}`, liked: true }));
    const prev = library.slice(0, 9);
    const out = await offlineStation('preferiti', library, [], prev);
    expect(out.length).toBe(10); // fresh 1 < 8 → riammessi i visti
  });
});

describe('cache scalette (mh-auto-cache)', () => {
  it('senza localStorage torna null invece di esplodere', () => {
    expect(cachedAuto('st:per-te')).toBeNull(); // node env: niente localStorage
  });
});
