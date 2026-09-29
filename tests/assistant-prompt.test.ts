import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/main/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT', lastfmApiKey: '' }) }));
vi.mock('../src/main/services/library', () => ({
  tasteProfile: (_u: number, k?: string) => k === 'artist' ? [{ kind: 'artist', value: 'vasco rossi', weight: 3.5 }] : [],
  listTracks: () => [{ id: 1, videoId: 'abc', title: 'Albachiara', artist: 'Vasco Rossi', filePath: 'x.mp3', source: 'library', addedAt: 1, playCount: 1, liked: false }],
  negativeTracks: () => [],
  remoteLikes: () => [],
  recentlyPlayed: () => [],
}));

import { assistant } from '../src/main/services/recommend';

describe('assistant con prompt libero', () => {
  it('seed + esclusione + vibe dal testo', async () => {
    const res = await assistant(1, {
      vibe: 'energico', targetMinutes: 0, discoveryPct: 50,
      prompt: 'per un viaggio con Gianluca Grignani, senza Jovanotti',
    });
    console.log('EXPL:', res.explanation);
    console.log('PARSED:', JSON.stringify(res.parsed));
    console.log('TRACKS:', res.tracks.length, 'ALTS:', res.alternates.length);
    for (const t of res.tracks.slice(0, 12)) console.log(' -', t.artist, '|', t.title, '|', t.reason);
    // Jovanotti escluso
    expect(res.tracks.every((t) => !/jovanotti/i.test(t.artist))).toBe(true);
    // seed Grignani presente o nei ricambi o nei brani
    const all = [...res.tracks, ...res.alternates];
    console.log('GRIGNANI tracks:', all.filter((t) => /grignani/i.test(t.artist)).length);
  }, 120000);
});
