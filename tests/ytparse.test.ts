import { describe, it, expect } from 'vitest';
import { toTrack } from '../src/shared/ytparse';

const base = { video_id: 'abcdefghijk' };

describe('toTrack — recupero artista', () => {
  it('usa item.artists quando presente', () => {
    const t = toTrack({ ...base, title: 'Song', artists: [{ name: 'Vasco Rossi' }] });
    expect(t?.artist).toBe('Vasco Rossi');
    expect(t?.title).toBe('Song');
  });

  it('toglie il suffisso "- Topic" dal byline', () => {
    const t = toTrack({ ...base, title: 'Bohemian Rhapsody', short_byline_text: 'Queen - Topic' });
    expect(t?.artist).toBe('Queen');
  });

  it('recupera l\'artista dal titolo "Artista - Titolo" quando il byline manca', () => {
    const t = toTrack({ ...base, title: 'Queen - Bohemian Rhapsody' });
    expect(t?.artist).toBe('Queen');
    expect(t?.title).toBe('Bohemian Rhapsody');
  });

  it('NON splitta "Titolo - Remastered" (suffisso di versione, non artista)', () => {
    const t = toTrack({ ...base, title: 'Bohemian Rhapsody - Remastered' });
    expect(t?.artist).toBe('Sconosciuto');
    expect(t?.title).toBe('Bohemian Rhapsody - Remastered');
  });

  it('NON splitta "Titolo - Live" né "Titolo - Radio Edit"', () => {
    expect(toTrack({ ...base, title: 'Thunderstruck - Live' })?.artist).toBe('Sconosciuto');
    expect(toTrack({ ...base, title: 'Blue Monday - Extended' })?.artist).toBe('Sconosciuto');
  });

  it('resta Sconosciuto solo quando nessuna fonte ha un artista', () => {
    const t = toTrack({ ...base, title: 'Brano senza autore' });
    expect(t?.artist).toBe('Sconosciuto');
  });

  it('tratta "N/A" come assente e tenta il recupero dal titolo', () => {
    const t = toTrack({ ...base, title: 'Pink Floyd - Wish You Were Here', artist: 'N/A' });
    expect(t?.artist).toBe('Pink Floyd');
  });

  it('NON splitta quando il presunto artista è metadato ("Official Video")', () => {
    const t = toTrack({ ...base, title: 'Official Video - Qualcosa' });
    expect(t?.artist).toBe('Sconosciuto');
  });

  it('i separatori – e — funzionano come "-"', () => {
    expect(toTrack({ ...base, title: 'Nirvana – Come As You Are' })?.artist).toBe('Nirvana');
    expect(toTrack({ ...base, title: 'Daft Punk — Get Lucky' })?.artist).toBe('Daft Punk');
  });
});
