import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/main/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }) }));
vi.mock('../src/main/settings', () => ({ getSettings: () => ({ country: 'IT', lastfmApiKey: '' }) }));
vi.mock('../src/main/services/library', () => ({ tasteProfile: () => [], listTracks: () => [], negativeTracks: () => [], remoteLikes: () => [] }));

import { parsePrompt } from '../src/main/services/recommend';

describe('parsePrompt (prompt libero assistente)', () => {
  it('rileva vibe, seed ed esclusioni', () => {
    const p = parsePrompt('rock anni 90 per un viaggio con Ligabue e Grignani, senza Jovanotti');
    expect(p.vibe).toBe('viaggio');
    expect(p.extraTags).toContain('90s');
    expect(p.extraTags).toContain('rock');
    expect(p.seeds.map((s) => s.toLowerCase())).toContain('ligabue');
    expect(p.excluded.map((s) => s.toLowerCase())).toContain('jovanotti');
  });

  it('non tratta parole comuni come artisti', () => {
    const p = parsePrompt('musica chill con calma per la sera');
    expect(p.seeds).toHaveLength(0);
    expect(p.vibe).toBe('chill');
  });

  it('stesso nome in "con" e "senza": vince l\'esclusione', () => {
    const p = parsePrompt('con Vasco ma senza Vasco');
    expect(p.seeds).toHaveLength(0);
    expect(p.excluded.map((s) => s.toLowerCase())).toContain('vasco');
  });

  it('prompt vuoto/non riconosciuto non rompe nulla', () => {
    const p = parsePrompt('asdfgh qwerty');
    expect(p.vibe).toBeUndefined();
    expect(p.seeds).toHaveLength(0);
    expect(p.excluded).toHaveLength(0);
  });

  it('decenni multipli e generi', () => {
    const p = parsePrompt('pop anni 80 e un po\' di jazz');
    expect(p.extraTags).toContain('80s');
    expect(p.extraTags).toContain('pop');
    expect(p.extraTags).toContain('jazz');
  });

  // Regressione (bug reali): la regex nomi accettava solo ASCII + accenti
  // gravi — AC/DC, P!nk, Motörhead, Måneskin, Rosalía venivano rifiutati.
  it('accetta artisti con punteggiatura e diacritici nel nome', () => {
    for (const a of ['AC/DC', 'P!nk', 'Motörhead', 'Måneskin', 'Rosalía', 'Sigur Rós', "Guns N' Roses", 'R&B']) {
      const p = parsePrompt(`con ${a}`);
      expect(p.seeds).toContain(a);
    }
  });

  it('"!" dentro la parola non spezza il nome ("P!nk"), fuori sì', () => {
    expect(parsePrompt('con P!nk e Beyoncé').seeds).toContain('P!nk');
    const p = parsePrompt('con Ligabue! e Vasco');
    expect(p.seeds).toContain('Ligabue');
    expect(p.seeds).toContain('Vasco');
  });

  it('refuso "dwe": "cena per due" attiva il vibe romantico', () => {
    expect(parsePrompt('playlist per una cena per due').vibe).toBe('romantico');
  });
});
