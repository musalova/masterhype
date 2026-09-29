import { describe, it, expect, vi } from 'vitest';

// Riproduzione live del bug "22x stesso brano": mock di DB/settings,
// chiamate di rete REALI (Deezer + YouTube Music).

vi.mock('../src/main/db', () => ({
  getDb: () => ({
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      run: () => ({}),
    }),
  }),
}));

vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ country: 'IT', lastfmApiKey: '', spotifyClientId: '', spotifyClientSecret: '' }),
}));

vi.mock('../src/main/services/library', () => ({
  // Simula la situazione reale: 1 traccia scaricata+riprodotta (non liked),
  // profilo gusti con "vasco rossi" da evento download.
  tasteProfile: (_u: number, kind?: string) =>
    kind === 'artist' ? [{ kind: 'artist', value: 'vasco rossi', weight: 3.5 }] : [],
  listTracks: () => [{
    id: 1, videoId: 'abc', title: 'Albachiara', artist: 'Vasco Rossi',
    filePath: 'x.mp3', source: 'library', addedAt: 1, playCount: 1, liked: false,
  }],
  negativeTracks: () => [],
  remoteLikes: () => [],
  recentlyPlayed: () => [],
}));

import { suggest, assistant } from '../src/main/services/recommend';

describe('assistant live', () => {
  it('non deve produrre duplicati title+artist', async () => {
    const res = await assistant(1, { vibe: 'energico', targetMinutes: 80, discoveryPct: 40 });
    console.log('TRACKS:', res.tracks.length, 'explanation:', res.explanation);
    for (const t of res.tracks) console.log(' -', t.artist, '|', t.title, '|', t.videoId, '|', t.reason);
    const keys = res.tracks.map((t) => `${t.artist.toLowerCase()}|${t.title.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 120000);

  it('suggest ritorna candidati vari', async () => {
    const s = await suggest(1, 25);
    console.log('SUGGEST:', s.length);
    for (const t of s) console.log(' *', t.artist, '|', t.title);
    const keys = s.map((t) => `${t.artist.toLowerCase()}|${t.title.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  }, 120000);
});
