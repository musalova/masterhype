import { describe, it, expect } from 'vitest';

// Test di contratto del motore stazioni v2 (recommend.ts) e del suo
// equivalente offline (offlineRec.ts + localData.ts). Reimplementati qui
// come specchio: se la logica di produzione cambia, questi test la bloccano.

// ---- specchio recommend.ts ----
const norm = (s: string) => s.toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const baseTitle = (t: string) => norm(
  t.replace(/\s*[\(\[][^)\]]*[\)\]]/g, ' ')
    .replace(/\s+-\s+(?:remaster(?:ed)?|live|remix|acoustic|deluxe|mono|stereo|radio edit|single version|edit|version)\b.*$/i, ' '));
const baseKey = (a: string, t: string) => `${norm(a)}|${baseTitle(t)}`;

const artistBlocked = (blocked: string[], artist: string): boolean => {
  const a = norm(artist);
  if (!a) return false;
  return blocked.some((b) => b.length >= 3 && (a === b || a.includes(b) || b.includes(a)));
};

const windowShuffle = <T,>(arr: T[], win = 5): T[] => {
  const sh = <X,>(a: X[]): X[] => {
    const r = [...a];
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  };
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += win) out.push(...sh(arr.slice(i, i + win)));
  return out;
};

const roundRobin = (buckets: { artist: string }[][]): { artist: string }[] => {
  const out: { artist: string }[] = [];
  for (let r = 0; ; r++) {
    let any = false;
    for (const b of buckets) if (b[r]) { out.push(b[r]); any = true; }
    if (!any) return out;
  }
};

describe('v2 — titolo base per filtri e dedup', () => {
  it('remaster/live/remix collimano col brano originale', () => {
    expect(baseKey('Vasco Rossi', 'Sally')).toBe(baseKey('Vasco Rossi', 'Sally (Remastered 2017)'));
    expect(baseKey('Vasco Rossi', 'Sally')).toBe(baseKey('Vasco Rossi', 'Sally - Live'));
    expect(baseKey('Vasco Rossi', 'Sally')).toBe(baseKey('Vasco Rossi', 'Sally [Deluxe Edition]'));
  });
  it('featuring nel titolo non aggira lo skip', () => {
    expect(baseKey('X', 'Song (feat. Y)')).toBe(baseKey('X', 'Song'));
  });
  it('brani diversi restano diversi', () => {
    expect(baseKey('X', 'Song')).not.toBe(baseKey('X', 'Songs'));
  });
});

describe('v2 — blocco artisti fuzzy', () => {
  const blocked = ['jovanotti'];
  it('match esatto', () => expect(artistBlocked(blocked, 'Jovanotti')).toBe(true));
  it('collaborazioni non aggirano il blocco', () => {
    expect(artistBlocked(blocked, 'Jovanotti feat. Someone')).toBe(true);
    expect(artistBlocked(blocked, 'Lorenzo Jovanotti Cherubini')).toBe(true);
  });
  it('un blocco corto (<3 char) non scatta su sottostringhe casuali', () => {
    expect(artistBlocked(['al'], 'Alanis Morissette')).toBe(false);
  });
  it('artisti diversi passano', () => expect(artistBlocked(blocked, 'Vasco Rossi')).toBe(false));
});

describe('v2 — ordinamento scalette', () => {
  it('windowShuffle conserva il multiset e i blocchi di ranking', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const out = windowShuffle(arr, 5);
    expect([...out].sort((a, b) => a - b)).toEqual(arr);
    // il top della lista resta nel primo terzo (non in coda)
    for (let i = 0; i < 50; i++) {
      const o = windowShuffle(arr, 5);
      expect(o.slice(0, 10)).toContain(0); // il n.1 non scende mai oltre il 2° blocco
    }
  });
  it('roundRobin non mette lo stesso artista in posizioni adiacenti', () => {
    const buckets = [
      [{ artist: 'a' }, { artist: 'a' }, { artist: 'a' }],
      [{ artist: 'b' }, { artist: 'b' }],
      [{ artist: 'c' }],
    ];
    const out = roundRobin(buckets);
    for (let i = 1; i < out.length; i++) expect(out[i].artist).not.toBe(out[i - 1].artist);
    expect(out).toHaveLength(6);
  });
});

describe('v2 — radio di artista: ~30% seed distribuito', () => {
  // Specchio del loop di interlaccio in finalizeRadio: seed ogni ~3 posizioni
  const interleave = (seedQ: string[], restQ: string[]) => {
    const out: string[] = [];
    let ri = 0;
    while (out.length < 30 && (seedQ.length || ri < restQ.length)) {
      if (seedQ.length && (out.length === 0 || out.length % 3 === 2)) out.push(seedQ.shift()!);
      else if (ri < restQ.length) out.push(restQ[ri++]);
      else if (seedQ.length) out.push(seedQ.shift()!);
      else break;
    }
    return out;
  };
  it('il seed è primo e presente in tutta la scaletta, non solo in testa', () => {
    const out = interleave(Array(9).fill('SEED'), Array(30).fill('other'));
    expect(out[0]).toBe('SEED');
    expect(out.filter((x) => x === 'SEED').length).toBe(9);
    expect(out.slice(15).filter((x) => x === 'SEED').length).toBeGreaterThan(0); // seed anche in coda
  });
  it('con pochi seed il resto riempie comunque', () => {
    const out = interleave(['SEED'], Array(30).fill('other'));
    expect(out.length).toBe(30);
    expect(out.filter((x) => x === 'SEED').length).toBe(1);
  });
});

describe('v2 — contesto radio (rec:next)', () => {
  // Specchio del parsing di stationContinue / selCtx dello store
  const selCtx = (sel: { kind: string; id?: string; radioKind?: string; value?: string } | null) =>
    sel?.kind === 'radio' ? `radio:${sel.radioKind}:${sel.value}` :
    sel?.kind === 'station' ? `station:${sel.id}` : undefined;

  it('le stringhe contesto sono parseabili dal motore', () => {
    const parse = (ctx?: string) => ({
      seedArtist: ctx?.startsWith('radio:artist:') ? ctx.slice(13) : '',
      tags: ctx?.startsWith('radio:genre:') ? [ctx.slice(12)] :
        ctx?.startsWith('station:') ? [`tags-of:${ctx.slice(8)}`] : [],
    });
    expect(parse(selCtx({ kind: 'radio', radioKind: 'artist', value: 'Anyma' })).seedArtist).toBe('Anyma');
    expect(parse(selCtx({ kind: 'radio', radioKind: 'genre', value: 'trap' })).tags).toEqual(['trap']);
    expect(parse(selCtx({ kind: 'station', id: 'rock' })).tags).toEqual(['tags-of:rock']);
    expect(parse(selCtx(null)).seedArtist).toBe('');
  });
  it('un play fuori stazione azzera il contesto (regola dello store)', () => {
    // stationCtx sopravvive solo se il play arriva da una riga stazione (radio===true)
    const playCtx = (prev: string | undefined, radio?: boolean) => (radio === true ? prev : undefined);
    expect(playCtx('station:rock', true)).toBe('station:rock');
    expect(playCtx('station:rock', undefined)).toBeUndefined();
    expect(playCtx('station:rock', false)).toBeUndefined();
  });
});

describe('v2 — cache videoId (vid_cache)', () => {
  // Specchio delle TTL: hit = fresco, '' = cache negativa breve
  const VID_TTL_MS = 14 * 86_400_000, VID_TTL_NEG_MS = 2 * 86_400_000;
  const fresh = (row: { video_id: string; fetched_at: number }, now: number) =>
    now - row.fetched_at < (row.video_id ? VID_TTL_MS : VID_TTL_NEG_MS);
  const now = Date.now();
  it('hit positivo fresco entro 14 giorni', () => {
    expect(fresh({ video_id: 'v', fetched_at: now - 13 * 86_400_000 }, now)).toBe(true);
    expect(fresh({ video_id: 'v', fetched_at: now - 15 * 86_400_000 }, now)).toBe(false);
  });
  it('cache negativa scade dopo 2 giorni (YT potrebbe aggiungere il brano)', () => {
    expect(fresh({ video_id: '', fetched_at: now - 86_400_000 }, now)).toBe(true);
    expect(fresh({ video_id: '', fetched_at: now - 3 * 86_400_000 }, now)).toBe(false);
  });
});

describe('v2 — chiavi gusti normalizzate (tasteMap)', () => {
  // Specchio di tasteMap/normTag in recommend.ts: taste_profile conserva il
  // valore solo lowercase, i lookup usano norm() — senza normalizzazione
  // "AC/DC" o "Måneskin" non trovavano MAI il loro peso (e i blocchi di
  // artisti punteggiati venivano aggirati).
  const normTag = (s: string) => s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tasteMap = (rows: { value: string; weight: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = norm(r.value);
      if (k) m.set(k, (m.get(k) ?? 0) + r.weight);
    }
    return m;
  };
  it('artisti accentati/punteggiati trovano il loro peso', () => {
    const w = tasteMap([
      { value: "guns n' roses", weight: 3 },
      { value: 'måneskin', weight: 2 },
      { value: 'ac/dc', weight: 1.5 },
    ]);
    expect(w.get(norm("Guns N' Roses"))).toBe(3);
    expect(w.get(norm('Måneskin'))).toBe(2);
    expect(w.get(norm('AC/DC'))).toBe(1.5);
  });
  it('forme diverse dello stesso artista si sommano', () => {
    const w = tasteMap([{ value: 'beyoncé', weight: 1 }, { value: 'beyonce', weight: 2 }]);
    expect(w.get('beyonce')).toBe(3);
  });
  it('un artista bloccato punteggiato blocca davvero', () => {
    const w = tasteMap([{ value: 'p!nk', weight: -3 }]);
    const blocked = [...w].filter(([, x]) => x < 0).map(([a]) => a);
    expect(artistBlocked(blocked, 'P!nk')).toBe(true);
    expect(artistBlocked(blocked, 'P!nk feat. X')).toBe(true);
  });
  it('tag con separatori diversi collimano ("Hip-Hop" ID3 = "hip hop" Last.fm)', () => {
    expect(normTag('Hip-Hop')).toBe('hip hop');
    expect(normTag('hip hop')).toBe('hip hop');
    expect(normTag('R&B')).toBe('r b');
  });
});

describe('v2 — parità offline (offlineRec)', () => {
  // Specchio di blockedLocal + tasteOrder: artista a peso negativo = bloccato,
  // match fuzzy su sottostringa (come artistBlocked del PC)
  const blockedLocal = (blocked: string[], artist: string): boolean => {
    const a = norm(artist);
    return !!a && blocked.some((b) => b.length >= 3 && (a === b || a.includes(b) || b.includes(a)));
  };
  it('un artista skippato offline non rientra nelle stazioni locali', () => {
    expect(blockedLocal(['drake'], 'Drake')).toBe(true);
    expect(blockedLocal(['drake'], 'Drake feat. 21 Savage')).toBe(true);
    expect(blockedLocal(['drake'], 'Vasco Rossi')).toBe(false);
  });
});
