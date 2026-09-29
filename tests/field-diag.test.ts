import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enqueueIssue, noteClientSample, drainFieldDiag, pendingDiagCount } from '../src/renderer/src/fieldDiag';

// Telemetria dal campo: i report raccolti a PC spento non si perdono — si
// accodano e risalgono al reconnect. Coda merge-safe + stop on network error,
// stessa semantica di pendingSync.

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
  online: true,
  impl: null as null | ((c: string, a: unknown[]) => unknown),
}));

vi.mock('../src/renderer/src/remote', () => ({
  isOnline: () => h.online,
  callRemote: (c: string, ...a: unknown[]) => {
    h.remote.push(`${c}:${JSON.stringify(a)}`);
    return Promise.resolve(h.impl ? h.impl(c, a) : undefined);
  },
}));

vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' } }));

beforeEach(() => { data.clear(); h.remote.length = 0; h.online = true; h.impl = null; });

describe('fieldDiag — telemetria dal campo', () => {
  it('issue e campioni client si accodano e risalgono al drain', async () => {
    enqueueIssue('stream-dead', { videoId: 'v1', artist: 'A', title: 'T' });
    noteClientSample('WEB', 1200, false);
    noteClientSample('TV_SIMPLY', 800, true);
    expect(pendingDiagCount()).toBe(3);

    const r = await drainFieldDiag();
    expect(r.sent).toBe(3);
    expect(pendingDiagCount()).toBe(0);
    // Prima il batch metriche, poi il report — i campioni portano client/ms/ok/device
    expect(h.remote[0]).toContain('diag:streamStats');
    expect(h.remote[0]).toContain('"client":"WEB"');
    expect(h.remote[0]).toContain('"device":"android"');
    expect(h.remote[1]).toBe('diag:report:["stream-dead",{"videoId":"v1","artist":"A","title":"T"}]');
  });

  it('offline → il drain non invia niente e conserva la coda', async () => {
    enqueueIssue('play', { message: 'x' });
    h.online = false;
    const r = await drainFieldDiag();
    expect(r.sent).toBe(0);
    expect(pendingDiagCount()).toBe(1);
    expect(h.remote).toEqual([]);
  });

  it('rete cade a metà drain → il resto resta in coda (merge-safe)', async () => {
    enqueueIssue('a', {});
    enqueueIssue('b', {});
    h.impl = (c) => { if (h.remote.length > 1) { h.online = false; throw new Error('net down'); } };
    const r = await drainFieldDiag();
    expect(r.sent).toBe(1);
    expect(pendingDiagCount()).toBe(1); // 'b' conservato per il prossimo drain
  });

  it('errore applicativo a PC vivo → retry budget poi scarto', async () => {
    enqueueIssue('bad', { message: 'poison' });
    h.impl = () => { throw new Error('400 bad request'); };
    await drainFieldDiag(); // tries=1
    await drainFieldDiag(); // tries=2
    const r = await drainFieldDiag(); // terzo tentativo → scartato
    expect(r.sent).toBe(0);
    expect(pendingDiagCount()).toBe(0);
  });

  it('enqueue durante il drain non viene perso', async () => {
    enqueueIssue('first', {});
    h.impl = () => { if (h.remote.length === 1) enqueueIssue('second', {}); };
    await drainFieldDiag();
    expect(pendingDiagCount()).toBe(1); // 'second' resta, 'first' è partito
  });
});
