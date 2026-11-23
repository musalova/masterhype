import { describe, it, expect, beforeEach, vi } from 'vitest';

// Controparte deterministica dei test live (assistant-live / assistant-prompt,
// sotto MH_LIVE → `npm run test:live`): la pipeline suggest()/assistant() con
// fixture mockate — nessuna rete. Verifica i filtri che il live copriva solo
// "a naso": dedup tra fonti, owned/negKeys/artista bloccato fuori, risoluzione
// videoId via searchSongs, cold-start da chart, esclusione da prompt libero.

const { FIX, defaults } = vi.hoisted(() => {
  const defaults = () => ({
    artists: [
      { kind: 'artist', value: 'vasco rossi', weight: 3.5 },
      { kind: 'artist', value: 'jovanotti', weight: -2 },  // bloccato: hide/unlike o >=2 skip
      { kind: 'artist', value: 'nas', weight: -2 },        // bloccato: NON deve coprire "anastacia"
    ] as { kind: string; value: string; weight: number }[],
    tags: [] as { kind: string; value: string; weight: number }[],
    lib: [{ id: 1, videoId: 'vAlba', title: 'Albachiara', artist: 'Vasco Rossi',
      filePath: 'x.mp3', source: 'library', addedAt: 1, playCount: 5, liked: true }] as unknown[],
    neg: [{ artist: 'Ligabue', title: 'Certe notti' }] as { artist: string; title: string }[],
    remote: [] as unknown[],
  });
  return { FIX: defaults(), defaults };
});

vi.mock('../src/main/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT', lastfmApiKey: '', spotifyClientId: '', spotifyClientSecret: '' }) }));
vi.mock('../src/main/services/library', () => ({
  tasteProfile: (_u: number, kind?: string) => kind === 'artist' ? FIX.artists : FIX.tags,
  listTracks: () => FIX.lib,
  negativeTracks: () => FIX.neg,
  remoteLikes: () => FIX.remote,
  recentlyPlayed: () => [],
}));

const VIDS: Record<string, { videoId: string; title: string; artist: string }> = {
  'Ligabue Balliamo sul mondo': { videoId: 'vBalliamo', title: 'Balliamo sul mondo', artist: 'Ligabue' },
  'Vasco Rossi Sally': { videoId: 'vSally', title: 'Sally', artist: 'Vasco Rossi' },
  'Gianluca Grignani Rimmel': { videoId: 'vGrig', title: 'Rimmel', artist: 'Gianluca Grignani' },
  'Jovanotti Penso positivo': { videoId: 'vPenso', title: 'Penso positivo', artist: 'Jovanotti' },
  'Vasco Rossi Vivere': { videoId: 'vVivere', title: 'Vivere', artist: 'Vasco Rossi' },
  'Deez Act Deez Hit': { videoId: 'vDeez', title: 'Deez Hit', artist: 'Deez Act' },
};

vi.mock('../src/main/services/ytmusic', () => ({
  upNext: async (vid: string) => vid === 'vAlba' ? [
    { videoId: 'vLiga', title: 'Certe notti', artist: 'Ligabue' },                    // negKeys → fuori
    { videoId: 'vAlba2', title: 'Albachiara', artist: 'Vasco Rossi' },                // owned → fuori
    { videoId: 'vJov', title: 'Una canzone', artist: 'Jovanotti' },                   // artista bloccato → fuori
    { videoId: 'vNas', title: 'One Mic', artist: 'Nas' },                             // artista bloccato → fuori
    { videoId: 'vUrlando', title: 'Urlando contro il cielo', artist: 'Ligabue' },     // anche da Deezer → dedup
    { videoId: 'vAna', title: 'Left Outside Alone', artist: 'Anastacia' },            // "nas" NON la blocca (ex FP)
  ] : [],
  charts: async () => [{ videoId: 'c1', title: 'Hit Uno', artist: 'Chart Act' }],
  searchSongs: async (q: string) => { const r = VIDS[q]; return r ? [{ ...r, thumbnail: 'th.jpg', durationS: 200 }] : []; },
}));

vi.mock('../src/main/services/sources', () => ({
  deezerRelatedArtists: async (a: string) => a.toLowerCase() === 'vasco rossi' ? ['Ligabue']
    : a.toLowerCase() === 'gianluca grignani' ? ['Jovanotti', 'Vasco Rossi'] : [],
  lastfmSimilarArtists: async () => [],
  deezerArtistTop: async (a: string) => ({
    'ligabue': [{ title: 'Urlando contro il cielo', artist: 'Ligabue' }, { title: 'Balliamo sul mondo', artist: 'Ligabue' }],
    'gianluca grignani': [{ title: 'Rimmel', artist: 'Gianluca Grignani' }],
    'jovanotti': [{ title: 'Penso positivo', artist: 'Jovanotti' }],
    'vasco rossi': [{ title: 'Vivere', artist: 'Vasco Rossi' }],
  } as Record<string, { title: string; artist: string }[]>)[a.toLowerCase()] ?? [],
  deezerChart: async () => [{ title: 'Deez Hit', artist: 'Deez Act', rank: 1 }],
  lastfmSimilarTracks: async (artist: string, title: string) =>
    artist === 'Vasco Rossi' && title === 'Albachiara' ? [{ title: 'Sally', artist: 'Vasco Rossi' }] : [],
  artistGenreTags: async () => [],
  mbArtistTags: async () => [],
  lastfmTagTopArtists: async () => [],
  lastfmTagTopTracks: async () => [],
  spotifyConnected: async () => false,
  spotifyNewReleases: async () => [],
}));

import { suggest, assistant } from '../src/main/services/recommend';

describe('suggest — pipeline deterministica', () => {
  beforeEach(() => { Object.assign(FIX, defaults()); });

  it('dedup tra fonti, owned/negKeys/bloccati fuori, videoId risolti', async () => {
    const s = await suggest(1, 25);
    // 'Urlando' arriva da upNext E da deezerArtistTop(ligabue): una sola volta
    expect(s.filter((t) => t.title === 'Urlando contro il cielo')).toHaveLength(1);
    // già in libreria → mai proposta
    expect(s.every((t) => t.title !== 'Albachiara')).toBe(true);
    // skippata di proposito → mai proposta
    expect(s.every((t) => t.title !== 'Certe notti')).toBe(true);
    // artisti a peso <= -2 bloccati (anche se arrivano dalle fonti)
    expect(s.every((t) => !/jovanotti/i.test(t.artist))).toBe(true);
    expect(s.every((t) => t.artist !== 'Nas')).toBe(true);
    // il blocco di "nas" NON copre "anastacia" (era falso positivo per sottostringa)
    expect(s.some((t) => t.artist === 'Anastacia')).toBe(true);
    // i candidati senza videoId si risolvono via searchSongs (Deezer/Last.fm)
    expect(s.find((t) => t.title === 'Balliamo sul mondo')?.videoId).toBe('vBalliamo');
    expect(s.find((t) => t.title === 'Sally')?.videoId).toBe('vSally');
    // invarianti di output: mai "Sconosciuto", sempre videoId + reason + dedup
    const keys = s.map((t) => `${t.artist.toLowerCase()}|${t.title.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of s) {
      expect(t.videoId).toBeTruthy();
      expect(t.reason).toBeTruthy();
      expect(t.artist).not.toMatch(/sconosciuto/i);
    }
  });

  it('cold start: senza gusti né like propone le chart', async () => {
    FIX.artists = []; FIX.lib = []; FIX.remote = [];
    const s = await suggest(1, 10);
    expect(s.some((t) => t.title === 'Hit Uno' && t.videoId === 'c1')).toBe(true);
    expect(s.some((t) => t.title === 'Deez Hit' && t.videoId === 'vDeez')).toBe(true);
  });
});

describe('assistant — prompt libero deterministico', () => {
  beforeEach(() => { Object.assign(FIX, defaults()); });

  it('"senza Jovanotti" esclude i suoi brani anche dagli affini del seed', async () => {
    const res = await assistant(1, {
      vibe: 'viaggio', targetMinutes: 0, discoveryPct: 50,
      prompt: 'per un viaggio con Gianluca Grignani, senza Jovanotti',
    });
    expect(res.parsed?.seeds).toContain('Gianluca Grignani');
    expect(res.parsed?.excluded).toContain('jovanotti');
    const all = [...res.tracks, ...res.alternates];
    // Jovanotti entra nel pool come affine del seed: il filtro deve comunque
    // tagliarlo (sia i brani risolti che quelli del seed esplicito)
    expect(all.every((t) => !/jovanotti/i.test(t.artist))).toBe(true);
    // il seed produce brani con videoId risolto
    const grig = all.find((t) => /grignani/i.test(t.artist) && t.title === 'Rimmel');
    expect(grig?.videoId).toBe('vGrig');
    // gli affini NON esclusi restano (Vasco Rossi affine a Grignani)
    expect(all.some((t) => t.artist === 'Vasco Rossi' && t.title === 'Vivere')).toBe(true);
  });
});
