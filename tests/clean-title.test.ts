import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanTitle } from '../src/shared/taste';

const file = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(file(path), 'utf8');

// Pulizia titoli da upload YouTube: packaging ("(Official Video)", " - 4K",
// "Artista - Titolo") non deve arrivare a display, nomi file, tag MP3, CD-Text.
// La regola vive UNA VOLTA in shared/taste.cleanTitle — PC e telefono uguali.
describe('cleanTitle — packaging da upload', () => {
  it('toglie le parentesi interamente rumore-video', () => {
    expect(cleanTitle('Sally (Official Video)')).toBe('Sally');
    expect(cleanTitle('Brava [Official Audio]')).toBe('Brava');
    expect(cleanTitle('Song (Official Music Video)')).toBe('Song');
    expect(cleanTitle('Song (Lyrics)')).toBe('Song');
    expect(cleanTitle('Song (Lyric Video)')).toBe('Song');
    expect(cleanTitle('Song (4K)')).toBe('Song');
    expect(cleanTitle('Song (Audio) (Official Video)')).toBe('Song');
    expect(cleanTitle('Song (Videoclip Ufficiale)')).toBe('Song');
  });

  it('conserva le parentesi informative (versioni, feat., live)', () => {
    expect(cleanTitle('Song (feat. Some Artist)')).toBe('Song (feat. Some Artist)');
    expect(cleanTitle('Song (Remastered 2011)')).toBe('Song (Remastered 2011)');
    expect(cleanTitle('Song (Live)')).toBe('Song (Live)');
    expect(cleanTitle('Song (Acoustic)')).toBe('Song (Acoustic)');
    expect(cleanTitle('Song (Deluxe Edition)')).toBe('Song (Deluxe Edition)');
  });

  it('toglie la coda "- rumore" anche senza parentesi, pure ripetuta', () => {
    expect(cleanTitle('Song - Official Video')).toBe('Song');
    expect(cleanTitle('Song | Lyrics')).toBe('Song');
    expect(cleanTitle('Song - 4K')).toBe('Song');
    expect(cleanTitle('Song - HD')).toBe('Song');
    expect(cleanTitle('Song - Official Audio - HD')).toBe('Song');
  });

  it('non tocca code informative', () => {
    expect(cleanTitle('Song - Live at Wembley')).toBe('Song - Live at Wembley');
    expect(cleanTitle('Song - Remastered')).toBe('Song - Remastered');
    expect(cleanTitle('Song - Acoustic Version')).toBe('Song - Acoustic Version');
  });

  it('toglie il prefisso "Artista - " SOLO se uguale al campo artista', () => {
    expect(cleanTitle('Vasco Rossi - Sally', 'Vasco Rossi')).toBe('Sally');
    expect(cleanTitle('AC/DC - Back in Black', 'AC/DC')).toBe('Back in Black');
    expect(cleanTitle('Blink-182 - All The Small Things', 'blink-182')).toBe('All The Small Things');
    // Prefisso diverso dall'artista noto → è parte del titolo, non si tocca
    expect(cleanTitle('Queen - Sally', 'Vasco Rossi')).toBe('Queen - Sally');
    // Senza artista noto il prefisso resta (potrebbe essere il titolo vero)
    expect(cleanTitle('Vasco Rossi - Sally')).toBe('Vasco Rossi - Sally');
  });

  it('mai vuoto: ripiega sul titolo originale', () => {
    expect(cleanTitle('(Official Video)')).toBe('(Official Video)');
    expect(cleanTitle('')).toBe('');
  });
});

// Applicazione: la pulizia sta nei PUNTI D'INGRESSO, non in ogni consumer —
// ytparse.toTrack (stream YT PC+telefono), library.rowToTrack (lettura DB),
// recommend.addCand (candidati stazioni: chiave+query+display già puliti).
describe('cleanTitle — punti di applicazione', () => {
  it('toTrack pulisce titolo e lo passa artista-aware', () => {
    const src = read('src/shared/ytparse.ts');
    expect(src).toContain('cleanTitle(title, artist || undefined)');
  });

  it('rowToTrack ripulisce i titoli archiviati sporchi in lettura', () => {
    const src = read('src/main/services/library.ts');
    expect(src).toContain('cleanTitle(r.title, r.artist)');
  });

  it('addCand normalizza il titolo prima di chiave e display', () => {
    const src = read('src/main/services/recommend.ts');
    expect(src).toContain('title = cleanTitle(title, artist)');
  });
});

// Gate stazioni zero-config: senza Last.fm i semi 'tag' venivano da funzioni
// che restituivano [] → stazioni su catalogo cieco. Ora la cascata
// Last.fm→Deezer /genre+|/chart/{id} copre il catalogo senza chiave,
// e il veto scene è calibrato su settings.country (Bollywood in India = tema).
describe('stazioni zero-config — catalogo tag e veto regionale', () => {
  it('tagTopArtists/tagTopTracks cascadano Last.fm → catalogo Deezer per-genere', () => {
    const src = read('src/main/services/sources.ts');
    expect(src).toContain('deezerTagCatalog');
    expect(src).toContain('/genre/${id}/artists');
    expect(src).toContain('/chart/${id}/tracks');
    expect(src).toContain('tagTopArtists');
    expect(src).toContain('tagTopTracks');
    const rec = read('src/main/services/recommend.ts');
    expect(rec).toContain('tagTopArtists(stag)');
    expect(rec).toContain('tagTopTracks(stag)');
  });

  it('sceneVeto distingue junk universale e scene regionali (paese)', () => {
    const src = read('src/main/services/recommend.ts');
    expect(src).toContain('OFF_THEME_JUNK');
    expect(src).toContain('OFF_THEME_REGIONAL');
    expect(src).toContain('getSettings().country');
  });
});
