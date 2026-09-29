import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Playlist, LibraryTrack } from '../src/shared/types';
import type { PendingPlOp } from '../src/renderer/src/pendingSync';

// Parità telefono/desktop senza PC: playlist local-first (cache + coda op),
// compattazione della coda, gusti/recenti/stats dai segnali locali e backup
// del dispositivo. Tutto gira su localStorage → stub in memoria.

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

vi.mock('../src/renderer/src/remote', () => ({ myUserId: () => 1 }));

const { compactPlOps, overlayPlaylists, localTaste, mergeTaste, localRecent, exportDeviceBackup, importDeviceBackup } = await import('../src/renderer/src/localData');
const { phoneVidId } = await import('../src/renderer/src/phoneLocal');

const op = (o: PendingPlOp['op'], args: unknown[], ts = Date.now()): PendingPlOp => ({ op: o, args, ts });
const track = (id: number, over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id, videoId: `v${id}`, title: `T${id}`, artist: `A${id}`, filePath: `/f${id}.mp3`,
  addedAt: 0, playCount: 0, liked: false, source: 'library', ...over,
});
const setQueue = (ops: PendingPlOp[]) => data.set('mh-pending-pl:u1', JSON.stringify(ops));

beforeEach(() => data.clear());

describe('compattazione coda playlist', () => {
  it('create+remove della stessa playlist temporanea → sparisce tutto', () => {
    const out = compactPlOps([op('create', ['Mix', 'lista', -5]), op('addRef', [-5, { videoId: 'x', title: 't', artist: 'a' }]), op('rename', [-5, 'X']), op('remove', [-5])]);
    expect(out).toEqual([]);
  });
  it('rename di una playlist temporanea confluisce nella create', () => {
    const out = compactPlOps([op('create', ['Mix', 'lista', -5]), op('rename', [-5, 'Nuovo nome'])]);
    expect(out).toHaveLength(1);
    expect(out[0].args[0]).toBe('Nuovo nome');
  });
  it('rename ripetuti su playlist del PC → vale l\'ultimo', () => {
    const out = compactPlOps([op('rename', [3, 'a']), op('rename', [3, 'b'])]);
    expect(out.map((o) => o.args[1])).toEqual(['b']);
  });
  it('removeTrack annulla l\'add precedente (per id e per ref)', () => {
    expect(compactPlOps([op('add', [3, 9]), op('removeTrack', [3, 9])])).toEqual([]);
    const ref = { videoId: 'yt1', title: 't', artist: 'a' };
    expect(compactPlOps([op('addRef', [3, ref]), op('removeTrack', [3, phoneVidId('yt1')])])).toEqual([]);
  });
  it('op su playlist del PC (id > 0) non si perdono', () => {
    const ops = [op('remove', [7]), op('add', [8, 2])];
    expect(compactPlOps(ops)).toHaveLength(2);
  });
});

describe('playlist offline (overlay cache + coda)', () => {
  const base: Playlist[] = [{ id: 1, name: 'Rock', kind: 'lista', createdAt: 0, tracks: [track(10)] }];
  it('create/addRef/rename/move/remove si vedono subito', () => {
    data.set('mh-lib-cache:u1', JSON.stringify([track(10), track(11)]));
    setQueue([
      op('create', ['Offline', 'lista', -42], 1),
      op('addRef', [-42, { videoId: 'yt9', title: 'Nuovo', artist: 'Band', source: 'ytmusic' }], 2),
      op('add', [1, 11], 3),
      op('move', [1, 11, -1], 4),
      op('rename', [1, 'Rock!'], 5),
    ]);
    const pls = overlayPlaylists(base);
    const off = pls.find((p) => p.id === -42)!;
    expect(off.name).toBe('Offline');
    expect(off.tracks!.map((t) => t.videoId)).toEqual(['yt9']);
    expect(off.tracks![0].id).toBe(phoneVidId('yt9')); // stesso id dei download sul telefono
    const rock = pls.find((p) => p.id === 1)!;
    expect(rock.name).toBe('Rock!');
    expect(rock.tracks!.map((t) => t.id)).toEqual([11, 10]);
  });
  it('funziona senza nessuna cache (modalità senza PC al primo avvio)', () => {
    setQueue([op('create', ['Solo telefono', 'lista', -1])]);
    expect(overlayPlaylists(null).map((p) => p.name)).toEqual(['Solo telefono']);
  });
  it('remove di una playlist del PC la nasconde', () => {
    setQueue([op('remove', [1])]);
    expect(overlayPlaylists(base)).toEqual([]);
  });
  it('non muta la cache passata', () => {
    setQueue([op('rename', [1, 'Altro'])]);
    overlayPlaylists(base);
    expect(base[0].name).toBe('Rock');
  });
});

describe('gusti, recenti e backup locali', () => {
  it('gusti dai segnali accodati; skip e "meno così" pesano in negativo', () => {
    data.set('mh-pending-events:u1', JSON.stringify([
      { artist: 'Vasco', type: 'play', ts: 1 }, { artist: 'Vasco', type: 'play', ts: 2 },
      { artist: 'Pippo', type: 'hide', ts: 3 },
    ]));
    data.set('mh-pending-likes:u1', JSON.stringify([{ videoId: 'x', liked: true, t: { artist: 'Ligabue' }, ts: 4 }]));
    const t = localTaste('artist');
    expect(t[0].value).toBe('ligabue');
    expect(t.find((x) => x.value === 'pippo')!.weight).toBeLessThan(0);
  });
  it('un azzeramento in coda cancella i segnali precedenti (e la copia del PC)', () => {
    data.set('mh-pending-events:u1', JSON.stringify([{ artist: 'Vasco', type: 'play', ts: 1 }, { artist: 'Nek', type: 'play', ts: 10 }]));
    setQueue([op('tasteReset', [], 5)]);
    expect(localTaste('artist').map((x) => x.value)).toEqual(['nek']);
    expect(mergeTaste([{ kind: 'artist', value: 'vasco', weight: 9 }], 'artist').map((x) => x.value)).toEqual(['nek']);
  });
  it('merge: copia del PC + segnali offline', () => {
    data.set('mh-pending-events:u1', JSON.stringify([{ artist: 'Vasco', type: 'play', ts: 1 }]));
    const m = mergeTaste([{ kind: 'artist', value: 'vasco', weight: 2 }], 'artist');
    expect(m[0]).toEqual({ kind: 'artist', value: 'vasco', weight: 3 });
  });
  it('recenti: play accodati, più nuovi in testa, senza doppioni', () => {
    data.set('mh-pending-events:u1', JSON.stringify([
      { videoId: 'a', title: 'A', artist: 'x', type: 'play', ts: 1 },
      { videoId: 'b', title: 'B', artist: 'x', type: 'play', ts: 3 },
      { videoId: 'a', title: 'A', artist: 'x', type: 'play', ts: 2 },
      { videoId: 'c', title: 'C', artist: 'x', type: 'skip', ts: 4 },
    ]));
    expect(localRecent().map((t) => t.videoId)).toEqual(['b', 'a']);
  });
  it('backup dispositivo: niente token del PC, code unite al ripristino', () => {
    data.set('mh-remote-conf', JSON.stringify({ base: 'http://x', token: 'SEGRETO' }));
    data.set('mh-pref-volume', '0.5');
    data.set('mh-pending-likes:u1', JSON.stringify([{ videoId: 'a' }]));
    const b = exportDeviceBackup();
    expect(JSON.stringify(b)).not.toContain('SEGRETO');
    data.clear();
    data.set('mh-pending-likes:u1', JSON.stringify([{ videoId: 'z' }]));
    data.set('mh-pref-volume', '0.9');
    importDeviceBackup(b);
    expect(JSON.parse(data.get('mh-pending-likes:u1')!).map((x: { videoId: string }) => x.videoId).sort()).toEqual(['a', 'z']);
    expect(data.get('mh-pref-volume')).toBe('0.9'); // il dispositivo vince sulle preferenze
    expect(() => importDeviceBackup({ app: 'altro' })).toThrow();
  });
});
