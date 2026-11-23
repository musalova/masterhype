import { describe, it, expect } from 'vitest';
import { playNextAt, movedQueue, clearedQueue, queueIndexOf } from '../src/renderer/src/queueOps';
import type { TrackRef } from '../src/shared/types';

const T = (id: string, artist = 'A', title = id): TrackRef => ({ videoId: id, artist, title, source: 'ytmusic' });
const q = (...ids: string[]) => ids.map((i) => T(i));

describe('queueIndexOf — dedup', () => {
  it('trova per videoId e per chiave artist|title anche con videoId diverso', () => {
    const queue = q('a', 'b', 'c');
    expect(queueIndexOf(queue, T('b'))).toBe(1);
    expect(queueIndexOf(queue, { videoId: 'altro', artist: 'A', title: 'c', source: 'ytmusic' })).toBe(2);
    expect(queueIndexOf(queue, T('zz'))).toBe(-1);
  });
});

describe('playNextAt — Riproduci dopo', () => {
  it('inserisce subito dopo il brano in riproduzione', () => {
    const r = playNextAt(q('a', 'b', 'c'), 0, T('x'))!;
    expect(r.queue.map((t) => t.videoId)).toEqual(['a', 'x', 'b', 'c']);
    expect(r.queueIndex).toBe(0);
    expect(r.queue[r.queueIndex].videoId).toBe('a'); // il brano corrente non cambia
  });

  it('brano già in coda: si SPOSTA dopo il corrente, niente duplicati', () => {
    const r = playNextAt(q('a', 'b', 'c', 'd'), 0, T('c'))!;
    expect(r.queue.map((t) => t.videoId)).toEqual(['a', 'c', 'b', 'd']);
    expect(r.queueIndex).toBe(0);
  });

  it('brano in coda PRIMA del corrente: spostandolo l\'indice si ricalibra', () => {
    const r = playNextAt(q('a', 'b', 'c', 'd'), 2, T('a'))!;
    expect(r.queue.map((t) => t.videoId)).toEqual(['b', 'c', 'a', 'd']);
    expect(r.queueIndex).toBe(1);
    expect(r.queue[r.queueIndex].videoId).toBe('c');
  });

  it('il brano corrente → null (niente da fare)', () => {
    expect(playNextAt(q('a', 'b'), 0, T('a'))).toBeNull();
    // anche per chiave artist|title equivalente
    expect(playNextAt(q('a', 'b'), 0, { videoId: 'x', artist: 'A', title: 'a', source: 'ytmusic' })).toBeNull();
  });
});

describe('movedQueue — riordino drag&drop', () => {
  it('sposta in giù: il corrente resta puntato sullo stesso brano', () => {
    const r = movedQueue(q('a', 'b', 'c', 'd'), 2, 0, 2); // 'a' da 0 a 2, corrente 'c'
    expect(r.queue.map((t) => t.videoId)).toEqual(['b', 'c', 'a', 'd']);
    expect(r.queue[r.queueIndex].videoId).toBe('c');
  });

  it('sposta in su oltre il corrente: indice si sposta di +1', () => {
    const r = movedQueue(q('a', 'b', 'c', 'd'), 1, 3, 0); // 'd' in testa, corrente 'b'
    expect(r.queue.map((t) => t.videoId)).toEqual(['d', 'a', 'b', 'c']);
    expect(r.queueIndex).toBe(2);
    expect(r.queue[r.queueIndex].videoId).toBe('b');
  });

  it('sposta il brano corrente stesso: l\'indice lo segue', () => {
    const r = movedQueue(q('a', 'b', 'c'), 0, 0, 2);
    expect(r.queue.map((t) => t.videoId)).toEqual(['b', 'c', 'a']);
    expect(r.queueIndex).toBe(2);
    expect(r.queue[r.queueIndex].videoId).toBe('a');
  });

  it('indici invalidi o from==to → coda identica (stesso riferimento)', () => {
    const queue = q('a', 'b');
    for (const [f, t] of [[0, 0], [-1, 1], [0, 5], [9, 0], [-3, -2]]) {
      const r = movedQueue(queue, 0, f, t);
      expect(r.queue).toBe(queue);
      expect(r.queueIndex).toBe(0);
    }
  });
});

describe('clearedQueue — Svuota coda', () => {
  it('resta solo il brano in riproduzione (indice 0)', () => {
    const r = clearedQueue(q('a', 'b', 'c'), 1);
    expect(r.queue.map((t) => t.videoId)).toEqual(['b']);
    expect(r.queueIndex).toBe(0);
  });

  it('niente in riproduzione → coda vuota e indice -1', () => {
    const r = clearedQueue(q('a', 'b'), -1);
    expect(r.queue).toHaveLength(0);
    expect(r.queueIndex).toBe(-1);
  });
});
