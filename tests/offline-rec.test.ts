import { describe, it, expect } from 'vitest';
import { likedTracks, offlineSuggest, offlineStation, cachedAuto } from '../src/renderer/src/offlineRec';
import type { LibraryTrack, RemoteLike } from '../src/shared/types';

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
  it('propone i più ascoltati e i like', () => {
    const library = [
      lib({ id: 1, videoId: 'hot', playCount: 50 }),
      lib({ id: 2, videoId: 'cold', playCount: 0 }),
      lib({ id: 3, videoId: 'love', liked: true }),
    ];
    const s = offlineSuggest(library, [rl('ext')]);
    const ids = s.map((t) => t.videoId);
    expect(ids).toContain('hot');
    expect(ids).toContain('love');
    expect(ids).toContain('ext');
    expect(new Set(ids).size).toBe(ids.length); // niente duplicati
    for (const t of s) { expect(t.reason).toBeTruthy(); expect(t.score).toBeGreaterThan(0); }
  });
  it('libreria vuota e nessun like → lista vuota, non crash', () => {
    expect(offlineSuggest([], [])).toEqual([]);
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
});

describe('cache scalette (mh-auto-cache)', () => {
  it('senza localStorage torna null invece di esplodere', () => {
    expect(cachedAuto('st:per-te')).toBeNull(); // node env: niente localStorage
  });
});
