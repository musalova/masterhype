import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Regressione (report reali): senza lastfmApiKey il PC non aveva alcun gate di
// genere — Guns N' Roses in "Italiana", Bollywood in "Festa", baby-dance e
// canali in "Novità"/Onboarding, stock/AI in "Viaggio"/"Chill". La cascata
// Last.fm → iTunes → MusicBrainz (parità col telefono) lo chiude.

const TMP = mkdtempSync(join(tmpdir(), 'mh-gategenre-'));
vi.mock('electron', () => ({ app: { getPath: () => TMP } }));

import { initDb, getDb } from '../src/main/db';
import { initSettings } from '../src/main/settings';
import { itunesArtistGenre, mbArtistTags, artistGenreTags } from '../src/main/services/sources';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const jsonOk = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('gate di genere senza chiave Last.fm', () => {
  beforeAll(() => { initDb(); initSettings(); fetchMock.mockReset(); });
  afterAll(() => vi.unstubAllGlobals());

  it('iTunes: match norm esatto preferito al primo risultato', async () => {
    fetchMock.mockResolvedValue(jsonOk({ results: [
      { artistName: 'Queensrÿche', primaryGenreName: 'Metal' },
      { artistName: 'Queen', primaryGenreName: 'Rock' },
    ] }));
    expect(await itunesArtistGenre('Queen')).toBe('rock');
    // persistito in artist_genres (cache lunga: i generi non cambiano)
    const row = getDb().prepare('SELECT itunes FROM artist_genres WHERE artist=?')
      .get('queen') as { itunes: string };
    expect(row.itunes).toBe('rock');
    // la seconda chiamata non ripaga la rete (cache sessione + DB)
    const n = fetchMock.mock.calls.length;
    expect(await itunesArtistGenre('Queen')).toBe('rock');
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it('cascata: senza chiave → iTunes primaryGenre', async () => {
    fetchMock.mockResolvedValue(jsonOk({ results: [{ artistName: 'Guns N Roses', primaryGenreName: 'Rock' }] }));
    expect(await artistGenreTags('Guns N Roses')).toEqual(['rock']);
    expect(fetchMock.mock.lastCall?.[0]).toContain('itunes.apple.com');
  });

  it('cascata: iTunes non classifica → tag MusicBrainz', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('itunes')
        ? jsonOk({ results: [] })
        : jsonOk({ artists: [{ name: 'Obscure Act', tags: [{ name: 'Italian' }, { name: 'Cantautori' }] }] }));
    expect(await artistGenreTags('Obscure Act')).toEqual(['italian', 'cantautori']);
    // MusicBrainz ha ricevuto uno User-Agent (403 senza)
    const mbCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('musicbrainz'));
    expect((mbCall?.[1] as { headers: Record<string, string> }).headers['User-Agent']).toBeTruthy();
    // e i tag sono persistiti
    const row = getDb().prepare('SELECT mb FROM artist_genres WHERE artist=?').get('obscure act') as { mb: string };
    expect(row.mb).toContain('italian');
  });

  it('MusicBrainz dal cache-store non ripaga la rete', async () => {
    const n = fetchMock.mock.calls.length;
    expect(await mbArtistTags('Obscure Act')).toEqual(['italian', 'cantautori']);
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  // ULTIMO: il breaker resta marcato nello stato del modulo per tutta la suite.
  it('iTunes 4xx → breaker persistente: smette di chiamare', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as Response);
    expect(await itunesArtistGenre('Rate Limited Act')).toBeNull();
    const n = fetchMock.mock.calls.length;
    expect(await itunesArtistGenre('Another Act')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(n); // nessuna nuova chiamata: breaker
  });
});
