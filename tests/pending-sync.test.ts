import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingPlOp } from '../src/renderer/src/pendingSync';
import type { Playlist, LibraryTrack } from '../src/shared/types';

// Drain delle code offline: resurrezione di playlist eliminate sul PC,
// convergenza dell'ordine via 'reorder', drain a due fasi sul tasteReset e
// drop segnalato (non silenzioso). localStorage → stub in memoria.

const data = new Map<string, string>();
const storage = new Proxy({
  getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
  setItem: (k: string, v: string) => { data.set(k, String(v)); },
  removeItem: (k: string) => { data.delete(k); },
  clear: () => data.clear(),
} as Record<string | symbol, unknown>, {
  ownKeys: (t) => [...Reflect.ownKeys(t), ...data.keys()],
  getOwnPropertyDescriptor: (t, k) => (data.has(k as string)
    ? { enumerable: true, configurable: true, value: data.get(k as string) }
    : Reflect.getOwnPropertyDescriptor(t, k)),
});
(globalThis as unknown as { localStorage: unknown }).localStorage = storage;

const h = vi.hoisted(() => ({
  remote: [] as string[],
  apiCalls: [] as string[],
  impl: null as null | ((c: string, a: unknown[]) => unknown),
}));

vi.mock('../src/renderer/src/remote', () => ({
  myUserId: () => 1,
  isOnline: () => true,
  callRemote: (c: string, ...a: unknown[]) => {
    h.remote.push(`${c}:${JSON.stringify(a)}`);
    return Promise.resolve(h.impl ? h.impl(c, a) : undefined);
  },
}));

const apiStub = {
  library: {
    likeRemote: (t: { artist?: string }) => { h.apiCalls.push(`likeRemote:${t.artist}`); return Promise.resolve(); },
    like: () => Promise.resolve(),
    remoteEvent: (e: { artist?: string }) => { h.apiCalls.push(`event:${e.artist}`); return Promise.resolve(); },
    listen: (r: { artist?: string }) => { h.apiCalls.push(`listen:${r.artist}`); return Promise.resolve(); },
    remove: () => Promise.resolve(),
    restore: () => Promise.resolve(),
    tasteSeed: () => Promise.resolve(),
    tasteReset: () => { h.apiCalls.push('tasteReset'); return Promise.resolve(); },
  },
  yt: { searchPick: () => Promise.resolve() },
  downloads: { enqueue: () => Promise.resolve() },
  settings: { set: () => Promise.resolve() },
};
vi.mock('../src/renderer/src/api', () => ({ api: () => apiStub }));

const { drainPending } = await import('../src/renderer/src/pendingSync');

const pl = (ops: PendingPlOp[]) => data.set('mh-pending-pl:u1', JSON.stringify(ops));
const queue = () => JSON.parse(data.get('mh-pending-pl:u1') ?? '[]') as PendingPlOp[];
const op = (o: PendingPlOp['op'], args: unknown[], ts = Date.now()): PendingPlOp => ({ op: o, args, ts });
const track = (id: number): LibraryTrack => ({
  id, videoId: `v${id}`, title: `T${id}`, artist: `A${id}`, filePath: `/f${id}.mp3`,
  addedAt: 0, playCount: 0, liked: false, source: 'library',
});
const base: Playlist[] = [{ id: 7, name: 'Rock', kind: 'lista', createdAt: 0, tracks: [track(10), track(11)] }];
const cachePl = () => data.set('mh-pl-cache:u1', JSON.stringify(base));

beforeEach(() => { data.clear(); h.remote.length = 0; h.apiCalls.length = 0; h.impl = null; });

describe('drain: tasteReset è un confine temporale', () => {
  it('segnali pre-reset prima, post-reset dopo', async () => {
    data.set('mh-pending-events:u1', JSON.stringify([
      { videoId: 'a', artist: 'prima', title: 'A', type: 'play', ts: 1 },
      { videoId: 'b', artist: 'dopo', title: 'B', type: 'play', ts: 10 },
    ]));
    data.set('mh-pending-listen:u1', JSON.stringify([
      { videoId: 'c', artist: 'post', playedS: 40, ts: 20 },
    ]));
    pl([op('tasteReset', [], 5)]);
    const r = await drainPending();
    expect(r.sent).toBe(4);
    expect(h.apiCalls).toEqual(['event:prima', 'tasteReset', 'event:dopo', 'listen:post']);
    expect(queue()).toEqual([]);
  });
});

describe('drain: playlist eliminata sul PC', () => {
  it('rename/add/addRef resuscitano la playlist dallo stato overlay', async () => {
    cachePl();
    pl([op('rename', [7, 'Rock!']), op('add', [7, 12])]);
    h.impl = (c, a) => {
      if ((c === 'pl:rename' || c === 'pl:add') && a[0] === 7) throw new Error('Playlist non trovata');
      if (c === 'pl:create') return { id: 99, name: a[0], kind: a[1], createdAt: 1, tracks: [] };
      return undefined;
    };
    const r = await drainPending();
    expect(r.resurrected).toBe(1);
    expect(r.dropped).toBe(0);
    // ricreata col nome dell'overlay (il rename era già materializzato in locale)
    expect(h.remote.some((x) => x.startsWith('pl:create:["Rock!"'))).toBe(true);
    // tracce ricreate + op successive rimappate sull'id nuovo
    expect(h.remote.some((x) => x === 'pl:add:[99,10]')).toBe(true);
    expect(h.remote.some((x) => x === 'pl:add:[99,11]')).toBe(true);
    expect(h.remote.some((x) => x === 'pl:add:[99,12]')).toBe(true);
    expect(queue()).toEqual([]);
  });
  it('remove/removeTrack/move su playlist sparita = obiettivo raggiunto, niente drop', async () => {
    pl([op('remove', [7]), op('move', [8, 5, 1])]);
    h.impl = () => { throw new Error('Playlist non trovata'); };
    const r = await drainPending();
    expect(r.dropped).toBe(0);
    expect(r.resurrected).toBe(0);
    expect(queue()).toEqual([]);
  });
  it('perdita reale non silenziosa: playlist mai vista → dropped conteggiato', async () => {
    pl([op('rename', [50, 'X'])]);
    h.impl = () => { throw new Error('Playlist non trovata'); };
    const r = await drainPending();
    expect(r.dropped).toBe(1);
    expect(queue()).toEqual([]);
  });
});

describe('drain: convergenza ordine', () => {
  it('i move accodano un reorder con l\'ordine finale dell\'overlay', async () => {
    cachePl();
    pl([op('move', [7, 10, 1])]);
    const r = await drainPending();
    expect(h.remote.some((x) => x === 'pl:move:[7,10,1]')).toBe(true);
    const reorder = h.remote.find((x) => x.startsWith('pl:reorder:'));
    expect(reorder).toBe('pl:reorder:[7,[11,10]]'); // overlay: 10 mosso +1 → [11,10]
    expect(r.dropped).toBe(0);
    expect(queue()).toEqual([]);
  });
});
