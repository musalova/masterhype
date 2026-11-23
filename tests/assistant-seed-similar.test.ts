import { describe, it, expect, vi } from 'vitest';

// Regressione (bug reale): i top degli artisti AFFINI ai seed entravano in
// pool con videoId '' e `pool.filter(t => t.videoId)` li scartava al 100% —
// l'arricchimento Deezer era silenziosamente inutile. Con sorgenti mockate il
// CD DEVE contenere i brani degli affini risolti via searchSongs+vid_cache.

vi.mock('../src/main/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT', lastfmApiKey: '', spotifyClientId: '', spotifyClientSecret: '' }) }));
vi.mock('../src/main/services/library', () => ({
  tasteProfile: () => [],
  listTracks: () => [],
  negativeTracks: () => [],
  remoteLikes: () => [],
  recentlyPlayed: () => [],
}));
vi.mock('../src/main/services/ytmusic', () => ({
  upNext: async () => [],
  charts: async () => [],
  // Ricerca YT deterministico: "artista titolo" → videoId noto
  searchSongs: async (q: string) => {
    const db: Record<string, { videoId: string; title: string; artist: string }> = {
      'Seed Artist Seed Song': { videoId: 'vSeed', title: 'Seed Song', artist: 'Seed Artist' },
      'Similar One Sim Song A': { videoId: 'vA', title: 'Sim Song A', artist: 'Similar One' },
      'Similar Two Sim Song B': { videoId: 'vB', title: 'Sim Song B', artist: 'Similar Two' },
    };
    const r = db[q];
    return r ? [{ ...r, thumbnail: 'th.jpg', durationS: 200 }] : [];
  },
}));
vi.mock('../src/main/services/sources', () => ({
  deezerRelatedArtists: async (a: string) => (a === 'Seed Artist' ? ['Similar One', 'Similar Two'] : []),
  lastfmSimilarArtists: async () => [],
  deezerArtistTop: async (a: string) =>
    a === 'Seed Artist' ? [{ title: 'Seed Song', artist: 'Seed Artist' }]
      : a === 'Similar One' ? [{ title: 'Sim Song A', artist: 'Similar One' }]
        : a === 'Similar Two' ? [{ title: 'Sim Song B', artist: 'Similar Two' }] : [],
  deezerChart: async () => [],
  lastfmSimilarTracks: async () => [],
  lastfmArtistTags: async () => [],
  artistGenreTags: async () => [],
  lastfmTagTopArtists: async () => [],
  lastfmTagTopTracks: async () => [],
  spotifyConnected: async () => false,
  spotifyNewReleases: async () => [],
}));

import { assistant } from '../src/main/services/recommend';

describe('assistant: artisti affini ai seed', () => {
  it('risolve i videoId degli affini invece di scartarli tutti', async () => {
    const res = await assistant(1, {
      vibe: 'scoperte', targetMinutes: 0, discoveryPct: 100,
      seedArtists: ['Seed Artist'], excludeArtists: [],
    });
    const all = [...res.tracks, ...res.alternates];
    // Gli affini DEVONO comparire col videoId risolto (prima: 0 su N)
    const simA = all.find((t) => t.artist === 'Similar One' && t.title === 'Sim Song A');
    const simB = all.find((t) => t.artist === 'Similar Two' && t.title === 'Sim Song B');
    expect(simA?.videoId).toBe('vA');
    expect(simB?.videoId).toBe('vB');
    expect(simA?.reason).toContain('affine a Seed Artist');
    // e il seed stesso continua a entrare
    expect(all.some((t) => t.artist === 'Seed Artist' && t.videoId === 'vSeed')).toBe(true);
  });
});
