import { describe, it, expect } from 'vitest';
import { parseLrc } from '../src/main/services/sources';

describe('parseLrc', () => {
  it('parsa timestamp mm:ss.xx in secondi e tiene il testo', () => {
    const lrc = '[00:12.50]Prima riga\n[01:05.00]Seconda riga\n[02:30.99]Terza';
    const out = parseLrc(lrc);
    expect(out).toEqual([
      { t: 12.5, text: 'Prima riga' },
      { t: 65, text: 'Seconda riga' },
      { t: 150.99, text: 'Terza' },
    ]);
  });

  it('ignora righe senza timestamp (metadati LRC, righe vuote)', () => {
    const lrc = '[ti:Titolo]\n[ar:Artista]\n\n[00:05.00]Riga vera\n[by:qualcuno]';
    const out = parseLrc(lrc);
    expect(out).toEqual([{ t: 5, text: 'Riga vera' }]);
  });

  it('ordina per timestamp anche se il file è disordinato', () => {
    const lrc = '[00:30.00]Dopo\n[00:10.00]Prima';
    const out = parseLrc(lrc);
    expect(out.map((l) => l.text)).toEqual(['Prima', 'Dopo']);
  });

  it('righe vuote di testo restano con text vuoto (filtrate a monte)', () => {
    const out = parseLrc('[00:10.00]   \n[00:20.00]Testo');
    expect(out).toHaveLength(2);
    expect(out[0].text).toBe('');
  });

  it('timestamp con centesimi e millesimi', () => {
    expect(parseLrc('[01:23.4]x')[0].t).toBeCloseTo(83.4);
    expect(parseLrc('[01:23.456]x')[0].t).toBeCloseTo(83.456);
  });
});

describe('selezione riga attiva (logica NowPlaying)', () => {
  // Replica la scansione del componente: ultima riga con t <= time + 0.4
  const synced = parseLrc('[00:00.00]Intro\n[00:10.00]A\n[00:20.00]B\n[00:30.00]C');
  const activeAt = (time: number) => {
    let idx = -1;
    for (let i = 0; i < synced.length; i++) { if (synced[i].t <= time + 0.4) idx = i; else break; }
    return idx;
  };

  it('prima della prima riga: -1', () => expect(activeAt(-1)).toBe(-1));
  it('a 0s: riga 0', () => expect(activeAt(0)).toBe(0));
  it('a metà strofa: riga corrente', () => expect(activeAt(15)).toBe(1));
  it('anticipo 0.4s: la riga si illumina appena prima', () => expect(activeAt(19.7)).toBe(2));
  it('fine brano: ultima riga', () => expect(activeAt(200)).toBe(3));
});
