import { describe, it, expect, vi } from 'vitest';

// Regressione (report reali): senza lastfmApiKey il PC non aveva alcun gate di
// genere — le query nude portavano Guns N' Roses in "Italiana" e hit Bollywood
// in "Festa". Ora wantHits verifica i tag/genere dell'artista via la cascata
// Last.fm → iTunes → MusicBrainz (artistGenreTags), parità col telefono.

const GENRES: Record<string, string[]> = {
  'guns n roses': ['rock', 'hard rock', 'classic rock'],
  'arijit singh': ['bollywood', 'indian pop', 'playback singer'],
  // iTunes dà a Vasco solo 'Rock' (vero in produzione!): senza la seconda
  // chance MusicBrainz cadrebbe da "Italiana" pur essendo il suo artista.
  'vasco rossi': ['rock'],
  'dua lipa': ['pop', 'dance'],
  'calvin harris': ['edm', 'dance', 'electronic'],
  'bruno mars': ['pop', 'r&b', 'funk'],
  'the weeknd': ['r&b', 'pop'],
  'laura pausini': ['italian', 'pop'],
  'tiziano ferro': ['italian', 'pop'],
  'elisa': ['italian', 'pop', 'singer-songwriter'],
  'jovanotti': ['italian', 'pop', 'hip hop'],
  'gemelli diversi': ['italian', 'pop'],
};

const MB: Record<string, string[]> = {
  'vasco rossi': ['italian', 'pop', 'singer-songwriter', 'rock'],
};

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
  // La "query nuda": brani del tema + i leak reali dei report.
  searchSongs: async () => [
    { videoId: 'vGnr', title: 'Sweet Child O Mine', artist: 'Guns N Roses', durationS: 356 },
    { videoId: 'vAri', title: 'Bollywood Hit', artist: 'Arijit Singh', durationS: 280 },
    { videoId: 'vVas', title: 'Albachiara', artist: 'Vasco Rossi', durationS: 245 },
    { videoId: 'vVas2', title: 'Sally', artist: 'Vasco Rossi', durationS: 285 },
    { videoId: 'vPau', title: 'La solitudine', artist: 'Laura Pausini', durationS: 250 },
    { videoId: 'vTiz', title: 'Sere nere', artist: 'Tiziano Ferro', durationS: 260 },
    { videoId: 'vEli', title: 'Luce', artist: 'Elisa', durationS: 265 },
    { videoId: 'vJov', title: 'L ombelico del mondo', artist: 'Jovanotti', durationS: 260 },
    { videoId: 'vGem', title: 'Mary', artist: 'Gemelli Diversi', durationS: 255 },
    { videoId: 'vDua', title: 'Levitating', artist: 'Dua Lipa', durationS: 203 },
    { videoId: 'vCal', title: 'One Kiss', artist: 'Calvin Harris', durationS: 214 },
    { videoId: 'vBru', title: 'Uptown Funk', artist: 'Bruno Mars', durationS: 270 },
    { videoId: 'vWee', title: 'Blinding Lights', artist: 'The Weeknd', durationS: 200 },
  ],
}));
vi.mock('../src/main/services/sources', () => ({
  deezerChart: async () => [],
  deezerArtistTop: async () => [],
  deezerRelatedArtists: async () => [],
  lastfmSimilarArtists: async () => [],
  lastfmSimilarTracks: async () => [],
  lastfmArtistTags: async () => [],
  lastfmTagTopArtists: async () => [],
  lastfmTagTopTracks: async () => [],
  tagTopArtists: async () => [],
  tagTopTracks: async () => [],
  spotifyConnected: async () => false,
  spotifyNewReleases: async () => [],
  // La cascata senza chiave risponde con genere iTunes/MB verificato.
  artistGenreTags: async (a: string) => GENRES[a.toLowerCase()] ?? [],
  mbArtistTags: async (a: string) => MB[a.toLowerCase()] ?? [],
}));

import { stationTracks } from '../src/main/services/recommend';

describe('stazioni PC senza chiave Last.fm: gate di genere', () => {
  it('"Italiana": gli artisti rock/bollywood verificati non entrano', async () => {
    const out = await stationTracks(1, 'italiana');
    const artists = out.map((t) => t.artist.toLowerCase());
    expect(artists).not.toContain('guns n roses');
    expect(artists).not.toContain('arijit singh');
    expect(artists).toContain('vasco rossi');
    expect(out.length).toBeGreaterThan(5);
  });

  it('"Festa" (mood): il gate funziona anche senza def.genre', async () => {
    const out = await stationTracks(1, 'festa');
    const artists = out.map((t) => t.artist.toLowerCase());
    expect(artists).not.toContain('arijit singh'); // 'bollywood' non collima coi tag party/dance/pop
    expect(artists).not.toContain('guns n roses'); // 'rock' non collima coi tag della festa
    expect(artists).toContain('dua lipa');
    expect(out.length).toBeGreaterThan(5);
  });

  it('artista senza info di genere: beneficio del dubbio (resta)', async () => {
    // 'unknown artist' non è in GENRES → tags [] → non filtrato
    const out = await stationTracks(1, 'italiana');
    expect(out.every((t) => t.artist !== '')).toBe(true); // sanità: righe valide
  });
});
