import { describe, it, expect } from 'vitest';
import { nextShuffleIndex, shuffleKey } from '../src/renderer/src/shuffle';

const q = (n: number) => Array.from({ length: n }, (_, i) => ({ videoId: `v${i}`, artist: 'A', title: `T${i}` }));

// Simula un giro completo come fa lo store: il brano scelto entra in `played`.
function runRound(queue: ReturnType<typeof q>, start: number, played: Set<string>, repeatAll: boolean, steps: number) {
  const order: number[] = [];
  let cur = start;
  played.add(shuffleKey(queue[cur]));
  for (let s = 0; s < steps; s++) {
    const ni = nextShuffleIndex(queue, cur, played, repeatAll);
    if (ni == null) break;
    order.push(ni);
    played.add(shuffleKey(queue[ni]));
    cur = ni;
  }
  return order;
}

describe('shuffle a sacchetto', () => {
  it('un giro suona ogni brano UNA volta, poi finisce (repeat off)', () => {
    const queue = q(10);
    const order = runRound(queue, 3, new Set(), false, 50);
    expect(order).toHaveLength(9); // tutti tranne quello di partenza
    expect(new Set(order).size).toBe(9);
    expect(order).not.toContain(3);
  });

  it('repeat all: a giro esaurito ne riparte uno nuovo senza ripetere subito il corrente', () => {
    const queue = q(4);
    const played = new Set<string>();
    const order = runRound(queue, 0, played, true, 12);
    expect(order).toHaveLength(12); // non si ferma mai
    for (let i = 1; i < order.length; i++) expect(order[i]).not.toBe(order[i - 1]);
    // nei primi 3 passi (primo giro) nessuna ripetizione
    expect(new Set(order.slice(0, 3)).size).toBe(3);
  });

  it('duplicati in coda (stessa chiave) contano una volta', () => {
    const queue = [...q(3), { videoId: 'v1', artist: 'A', title: 'T1' }];
    const order = runRound(queue, 0, new Set(), false, 10);
    expect(order.map((i) => queue[i].videoId).sort()).toEqual(['v1', 'v2']);
  });

  it('coda di un solo brano: nessun successivo', () => {
    expect(nextShuffleIndex(q(1), 0, new Set(), true)).toBeNull();
    expect(nextShuffleIndex(q(1), 0, new Set(), false)).toBeNull();
  });

  it('rnd deterministico: sceglie tra i candidati non ancora usciti', () => {
    const queue = q(5);
    const played = new Set(['v0', 'v1']);
    // candidati: 2,3,4 (0 corrente, 1 già uscito) → rnd 0.99 → l'ultimo
    expect(nextShuffleIndex(queue, 0, played, false, () => 0.99)).toBe(4);
    expect(nextShuffleIndex(queue, 0, played, false, () => 0)).toBe(2);
  });

  it('righe senza videoId: chiave artista|titolo', () => {
    expect(shuffleKey({ artist: 'Vasco', title: 'Albachiara' })).toBe('Vasco|Albachiara');
    expect(shuffleKey({ videoId: 'x', artist: 'Vasco', title: 'Albachiara' })).toBe('x');
  });
});
