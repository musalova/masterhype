import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC } from '../src/shared/types';

// E2E del server remoto VERO (remote.ts → createServer → fetch HTTP):
// mockati solo Electron, settings, handlers e i servizi periferici — la
// logica di auth (authed/uidFor, device token, admin-only, claim) è quella
// di produzione. Il punto del test: X-MH-User non deve più essere una
// credenziale — con un device token il profilo è il binding server-side.

const TMP = mkdtempSync(join(tmpdir(), 'mh-remote-'));
const PORT = 48555;
const ADMIN = 'ADMINTOK-condiviso';

vi.mock('electron', () => ({ app: { getPath: () => TMP, getVersion: () => '0.0.0-test', isPackaged: false } }));
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ remoteEnabled: true, remotePort: PORT, remoteToken: ADMIN }),
}));
vi.mock('../src/main/handlers', () => ({
  handlers: {
    [IPC.usersList]: () => [{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }, { id: 3, name: 'P3' }],
    [IPC.usersCurrent]: (u: number) => u,
    [IPC.libraryRemoteLikes]: (u: number) => [{ videoId: `like-di-u${u}` }],
    [IPC.settingsSet]: (u: number, p: unknown) => p, // eco: verifica sanitize
    // Admin-only (in produzione delegano a services/devices): qui stubbati
    // sul servizio reale — ciò che conta è il gate ADMIN_ONLY di remote.ts.
    [IPC.deviceList]: () => listDevices(),
    [IPC.deviceRevoke]: (_u: number, id: number) => revokeDevice(id),
    [IPC.deviceSetUser]: (_u: number, id: number, userId: number | null) => setDeviceUser(id, userId),
    [IPC.usersRemove]: () => { throw new Error('stub'); },
    [IPC.deviceRevokeAll]: () => revokeAllDevices(),
    [IPC.pairingOpen]: () => ({ leftMs: 0 }),
    [IPC.pairingCode]: () => ({ code: mintPairCode(), leftMs: 300_000 }),
  },
}));
vi.mock('../src/main/services/users', () => ({ userExists: (id: number) => id >= 1 && id <= 3 }));
vi.mock('../src/main/services/library', () => ({ getTrack: () => undefined }));
vi.mock('../src/main/services/telemetry', () => ({ report: () => {} }));
vi.mock('../src/main/update', () => ({ serveUpdateRoutes: () => {} }));
vi.mock('../src/main/services/appUpdate', () => ({ feedUrl: () => '' }));
vi.mock('../src/main/discovery', () => ({ startDiscovery: () => {}, stopDiscovery: () => {} }));

import { startRemoteServer, stopRemoteServer } from '../src/main/remote';
import { openPairingWindow, mintPairCode } from '../src/main/pairing';
import { initDb } from '../src/main/db';
import { listDevices, revokeDevice, revokeAllDevices, setDeviceUser } from '../src/main/services/devices';

const base = `http://127.0.0.1:${PORT}`;
const call = async (c: string, a: unknown[] = [], tok = ADMIN, u?: number) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-MH-Token': tok };
  if (u != null) headers['X-MH-User'] = String(u);
  const res = await fetch(`${base}/api/call`, { method: 'POST', headers, body: JSON.stringify({ c, a }) });
  const j = (await res.json().catch(() => ({}))) as { r?: unknown; e?: string };
  return { status: res.status, r: j.r, e: j.e, bound: res.headers.get('x-mh-bound-user') };
};
const pair = () => fetch(`${base}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

describe('server remoto — auth a due livelli (admin / device token)', () => {
  beforeAll(() => { initDb(); startRemoteServer(); });
  afterAll(() => stopRemoteServer());

  it('admin: X-MH-User sceglie il profilo (compatibilità gestione)', async () => {
    expect((await call(IPC.usersCurrent, [], ADMIN, 3)).r).toBe(3);
    expect((await call(IPC.usersCurrent)).r).toBe(1); // assente → legacy 1
    expect((await call(IPC.usersCurrent, [], ADMIN, 99)).status).toBe(401);
  });

  it('codice monouso QR: riscatta senza finestra, monouso, admin-only nel mint', async () => {
    openPairingWindow(0); // finestra chiusa: il codice basta da solo
    const minted = await call(IPC.pairingCode, []);
    const code = (minted.r as { code: string }).code;
    expect(typeof code).toBe('string');
    // un device token NON può mintare codici QR
    openPairingWindow(60_000);
    const { t: devTok } = (await (await pair()).json()) as { t: string };
    openPairingWindow(0);
    expect((await call(IPC.pairingCode, [], devTok)).status).toBe(403);
    // riscatto: POST /pair {code} → device token (non legato)
    const res = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'QRPhone', code }),
    });
    expect(res.status).toBe(200);
    const { t } = (await res.json()) as { t: string };
    expect(t).not.toBe(ADMIN);
    expect((await call(IPC.usersCurrent, [], t)).status).toBe(401); // non legato
    // monouso: lo STESSO codice rifiutato al secondo giro
    const again = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Altro', code }),
    });
    expect(again.status).toBe(403);
    // codice inventato → 403
    const fake = await fetch(`${base}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'codice-inventato-xyz' }),
    });
    expect(fake.status).toBe(403);
  });

  it('/pair: finestra chiusa → 403; aperta → device token (NON il codice condiviso)', async () => {
    openPairingWindow(0);
    expect((await pair()).status).toBe(403);
    openPairingWindow(60_000);
    const res = await pair();
    expect(res.status).toBe(200);
    const { t } = (await res.json()) as { t: string };
    expect(t).not.toBe(ADMIN);
    expect(t.length).toBeGreaterThan(16);
  });

  it('device appena pairato: non legato → dati 401, ma users:list aperta (gate)', async () => {
    openPairingWindow(60_000);
    const { t } = (await (await pair()).json()) as { t: string };
    expect((await call(IPC.usersCurrent, [], t)).status).toBe(401);
    const list = await call(IPC.usersList, [], t);
    expect(list.status === 200 && Array.isArray(list.r)).toBe(true);
  });

  it('claim: device legato a u2 → X-MH-User=u3 IGNORATO, X-MH-Bound-User=2', async () => {
    openPairingWindow(60_000);
    const { t } = (await (await pair()).json()) as { t: string };
    expect((await call(IPC.deviceClaim, [2], t)).status).toBe(200);
    const likes = await call(IPC.libraryRemoteLikes, [], t, 3); // header altrui!
    expect(likes.bound).toBe('2');
    expect((likes.r as { videoId: string }[])[0].videoId).toBe('like-di-u2');
    // re-bind a un altro profilo: la finestra è ancora aperta → consentito
    expect((await call(IPC.deviceClaim, [3], t)).status).toBe(200);
  });

  it('rebind senza finestra aperta → 403 (il binding non si cambia con un header)', async () => {
    openPairingWindow(60_000);
    const { t } = (await (await pair()).json()) as { t: string };
    await call(IPC.deviceClaim, [1], t);
    openPairingWindow(0);
    const r = await call(IPC.deviceClaim, [2], t);
    expect(r.status).toBe(403);
    // il binding resta 1
    expect((await call(IPC.usersCurrent, [], t, 2)).bound).toBe('1');
  });

  it('admin-only da device token → 403 (list/revoke/setUser/remove/rename/pairing:open)', async () => {
    openPairingWindow(60_000);
    const { t } = (await (await pair()).json()) as { t: string };
    await call(IPC.deviceClaim, [1], t);
    for (const c of [IPC.deviceList, IPC.deviceRevoke, IPC.deviceSetUser, IPC.deviceRegister, IPC.usersRemove, IPC.pairingOpen]) {
      expect((await call(c, c === IPC.deviceSetUser ? [1, 2] : [1], t)).status).toBe(403);
    }
    // ma l'admin li usa
    expect((await call(IPC.deviceList, [])).status).toBe(200);
    openPairingWindow(0);
  });

  it('claim implicito: device non legato + X-MH-User valido su canale dati → si lega', async () => {
    openPairingWindow(60_000);
    const { t } = (await (await pair()).json()) as { t: string };
    openPairingWindow(0); // finestra chiusa: il PRIMO claim resta libero
    const r = await call(IPC.libraryRemoteLikes, [], t, 2);
    expect(r.status).toBe(200);
    expect(r.bound).toBe('2');
    // …e da ora è legato: header diverso ignorato
    expect((await call(IPC.usersCurrent, [], t, 1)).bound).toBe('2');
  });

  it('device:register solo admin; il device mintato arriva non legato', async () => {
    const reg = await call(IPC.deviceRegister, ['TestDev']);
    const tok = (reg.r as { token: string }).token;
    expect(typeof tok).toBe('string');
    expect((await call(IPC.usersCurrent, [], tok)).status).toBe(401);
    expect((await call(IPC.deviceWhoami, [], tok)).r).toEqual({ admin: false, user: null });
    expect((await call(IPC.deviceWhoami)).r).toEqual({ admin: true, user: 1 });
  });

  it('revokeAll admin: scollega TUTTI i device in un colpo; da device → 403', async () => {
    openPairingWindow(60_000);
    const { t: t1 } = (await (await pair()).json()) as { t: string };
    // secondo device via register: due /pair ravvicinati prenderebbero il rate-limit 2s/IP
    const { token: t2 } = (await call(IPC.deviceRegister, ['Dev2'])).r as { token: string };
    await call(IPC.deviceClaim, [1], t1);
    await call(IPC.deviceClaim, [2], t2);
    openPairingWindow(0);
    // un device non può scollegare gli altri
    expect((await call(IPC.deviceRevokeAll, [], t1)).status).toBe(403);
    // admin sì: entrambi i token muoiono alla prossima richiesta
    const n = (await call(IPC.deviceRevokeAll, [])).r;
    expect(typeof n).toBe('number');
    expect((await call(IPC.usersList, [], t1)).status).toBe(401);
    expect((await call(IPC.usersList, [], t2)).status).toBe(401);
  });

  it('admin setUser/revoke: rilega il device e poi lo uccide (→401)', async () => {
    const reg = await call(IPC.deviceRegister, ['Vittima']);
    const tok = (reg.r as { token: string }).token;
    await call(IPC.deviceClaim, [1], tok);
    const devs = (await call(IPC.deviceList, [])).r as { id: number; name: string }[];
    const dev = devs.find((d) => d.name === 'Vittima')!;
    await call(IPC.deviceSetUser, [dev.id, 3]);
    expect((await call(IPC.usersCurrent, [], tok)).r).toBe(3);
    await call(IPC.deviceRevoke, [dev.id]);
    expect((await call(IPC.usersList, [], tok)).status).toBe(401);
  });

  it('deny-list remota (path/finestre PC) e users:setCurrent mai esposti', async () => {
    expect((await call(IPC.libraryImport, [['/etc/passwd']])).status).toBe(403);
    expect((await call('users:setCurrent', [2])).status).toBe(404);
    const r = await call(IPC.settingsSet, [{ remoteToken: 'HACKED', theme: 'dark' }]);
    expect((r.r as Record<string, unknown>).remoteToken).toBeUndefined(); // sanitize
  });
});
