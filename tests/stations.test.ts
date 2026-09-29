import { describe, it, expect } from 'vitest';
import { STATIONS } from '../src/shared/types';

// Test di contratto sulle nuove logiche Spotify-like: le regole sono
// reimplementate qui come specchio di library.ts/recommend.ts — se la
// logica di produzione cambia, questi test devono cambiare con lei.

describe('stazioni', () => {
  it('hanno id unici', () => {
    const ids = STATIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('le stazioni generiche hanno una query, le personalizzate no', () => {
    for (const s of STATIONS) {
      if (s.group === 'per-te' || s.id === 'classifiche') expect(s.query).toBeUndefined();
      else expect(s.query).toBeTruthy();
    }
  });
  it('coprono mood, genere, decennio e novità', () => {
    const groups = new Set(STATIONS.map((s) => s.group));
    for (const g of ['per-te', 'mood', 'genere', 'decennio', 'news']) expect(groups.has(g as never)).toBe(true);
  });
  it('tutte hanno nome, descrizione e gradiente', () => {
    for (const s of STATIONS) {
      expect(s.name.length).toBeGreaterThan(1);
      expect(s.desc.length).toBeGreaterThan(5);
      expect(s.grad).toMatch(/^from-\S+ to-\S+$/);
    }
  });
});

describe('like remoti', () => {
  // Specchio di likeRemote/addTrack: il like sopravvive al download
  it('un like remoto si trasferisce alla traccia scaricata', () => {
    const remoteLikes = new Map<string, { title: string; artist: string }>();
    const library = new Map<string, { liked: boolean }>();
    const likeRemote = (videoId: string, title: string, artist: string, liked: boolean) => {
      if (liked) remoteLikes.set(videoId, { title, artist }); else remoteLikes.delete(videoId);
    };
    const addTrack = (videoId: string) => {
      const liked = remoteLikes.has(videoId);
      if (liked) remoteLikes.delete(videoId);
      library.set(videoId, { liked });
    };
    likeRemote('abc123', 'Felicità', 'Calcutta', true);
    expect(remoteLikes.has('abc123')).toBe(true);
    addTrack('abc123');
    expect(library.get('abc123')!.liked).toBe(true);
    expect(remoteLikes.has('abc123')).toBe(false); // riconciliato
  });
  it('unlike remoto cancella la riga', () => {
    const remoteLikes = new Map([['x', { title: 't', artist: 'a' }]]);
    remoteLikes.delete('x');
    expect(remoteLikes.size).toBe(0);
  });
});

describe('segnali negativi (algoritmo cinico)', () => {
  // Specchio di negativeTracks(): esclusi solo se skip >= 2 E skip > play
  const isNegative = (skips: number, plays: number) => skips >= 2 && skips > plays;
  it('2 skip senza play = escluso', () => expect(isNegative(2, 0)).toBe(true));
  it('1 skip solo non basta (potrebbe essere distrazione)', () => expect(isNegative(1, 0)).toBe(false));
  it('più play che skip = resta', () => expect(isNegative(3, 5)).toBe(false));
  it('parità non basta', () => expect(isNegative(2, 2)).toBe(false));
});

describe('decadimento temporale dei gusti', () => {
  // Specchio di tasteProfile(): half-life 45gg positivi, 90gg negativi
  const decayed = (w: number, daysAgo: number) => {
    const halfLife = w >= 0 ? 45 : 90;
    return w * Math.pow(0.5, Math.max(0, daysAgo) / halfLife);
  };
  it('un like di ieri pesa quasi pieno', () => {
    expect(decayed(3, 1)).toBeGreaterThan(2.9);
  });
  it('un like di 45 giorni pesa la metà', () => {
    expect(decayed(3, 45)).toBeCloseTo(1.5, 5);
  });
  it('un dislike decade più lento: a 45gg pesa >60%', () => {
    expect(decayed(-3, 45)).toBeLessThan(-2); // |-3*0.707| = 2.12
  });
  it('eventi futuri (clock skew) non amplificano', () => {
    expect(decayed(3, -10)).toBe(3);
  });
});

describe('eventi remoto nel profilo gusti', () => {
  // Specchio dei pesi in recordEvent()
  const weights = { like: 3, download: 2.5, burn: 2, play: 1, skip: -1, hide: -2, unlike: -3 };
  it('unlike punisce quanto like premia', () => {
    expect(Math.abs(weights.unlike)).toBe(weights.like);
  });
  it('lo skip pesa meno del dislike esplicito ma conta', () => {
    expect(weights.skip).toBeLessThan(0);
    expect(Math.abs(weights.skip)).toBeLessThan(Math.abs(weights.unlike));
  });
  it('"meno così" pesa tra skip e unlike', () => {
    expect(Math.abs(weights.hide)).toBeGreaterThan(Math.abs(weights.skip));
    expect(Math.abs(weights.hide)).toBeLessThan(Math.abs(weights.unlike));
  });
});
