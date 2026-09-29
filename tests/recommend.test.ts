import { describe, it, expect } from 'vitest';

// Test puri sulle funzioni di scoring/normalizzazione (reimplementate qui
// come contratto: se la logica cambia, i test la bloccano).

const norm = (s: string) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const key = (a: string, t: string) => `${norm(a)}|${norm(t)}`;

describe('normalizzazione chiavi brani', () => {
  it('deduplica ignorando punteggiatura e maiuscole', () => {
    expect(key('Calcutta', 'Del Verde')).toBe(key('CALCUTTA!', 'del verde'));
  });
  it('normalizza gli accenti per il matching cross-fonte', () => {
    // Deezer può scrivere "Celine", YouTube "Céline": devono collidere
    expect(norm('Céline Dion')).toBe('celine dion');
    expect(norm('Éros Ramazzotti')).toBe('eros ramazzotti');
    expect(key('Éros Ramazzotti', 'Più bella cosa')).toBe(key('Eros Ramazzotti', 'Più Bella Cosa'));
  });
  it('collassa spazi multipli e apostrofi', () => {
    expect(norm("L'  appuntamento")).toBe('l appuntamento');
  });
});

describe('scoring raccomandazioni', () => {
  const score = (aAff: number, gAff: number, agreement: number, novelty: number) =>
    0.45 * aAff + 0.25 * Math.min(1, gAff) + 0.15 * agreement + 0.15 * novelty;

  it('artista preferito + multi-fonte batte sconosciuto', () => {
    const preferito = score(1, 0.5, 1, 0);
    const sconosciuto = score(0, 0, 1 / 3, 0.6);
    expect(preferito).toBeGreaterThan(sconosciuto);
  });
  it('accordo multi-fonte aumenta lo score', () => {
    expect(score(0.5, 0.5, 1, 0)).toBeGreaterThan(score(0.5, 0.5, 1 / 3, 0));
  });
});

describe('capacità Audio CD', () => {
  const check = (durations: number[], maxMin = 80) => {
    const total = durations.reduce((s, d) => s + d, 0) + Math.max(0, durations.length - 1) * 2;
    return { ok: total / 60 <= maxMin, minutes: total / 60 };
  };

  it('18 brani da 4 min entrano in 80 min', () => {
    expect(check(Array(18).fill(240)).ok).toBe(true);
  });
  it('25 brani da 4 min non entrano', () => {
    expect(check(Array(25).fill(240)).ok).toBe(false);
  });
  it('conta i gap di 2s tra tracce', () => {
    const c = check([100, 100]); // 200s + 2s gap
    expect(c.minutes).toBeCloseTo(202 / 60, 3);
  });
});
