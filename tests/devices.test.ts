import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// devices.ts è puro ma passa per db.ts → electron.app.getPath(userData).
// Mock di electron su una dir temporanea: il test gira su SQLite vero.
// TMP è letto lazy dentro getPath (chiamato in beforeAll, dopo l'init del modulo).
const TMP = mkdtempSync(join(tmpdir(), 'mh-devices-'));
vi.mock('electron', () => ({ app: { getPath: () => TMP } }));

import { initDb, getDb } from '../src/main/db';
import * as devices from '../src/main/services/devices';

// Token per dispositivo: confine di sicurezza dei profili remoti —
// mint/hash/bind/rebind/revoke/unbind devono reggere sul DB reale.

describe('devices (token per dispositivo)', () => {
  beforeAll(() => initDb());

  it('mint: token in chiaro una volta, nel DB solo l\'hash sha256', () => {
    const d = devices.mintDevice('Pixel 8');
    expect(d.id).toBeGreaterThan(0);
    expect(d.token.length).toBeGreaterThan(16);
    // il plaintext non deve apparire in nessuna colonna
    const rows = getDb().prepare('SELECT * FROM devices').all() as { token_hash: string }[];
    expect(rows.every((r) => r.token_hash !== d.token)).toBe(true);
    expect(rows.find((r) => r.token_hash.length === 64)).toBeTruthy();
  });

  it('deviceByToken: risolve il device mintato, ignora token sconosciuti', () => {
    const d = devices.mintDevice('Tablet');
    const found = devices.deviceByToken(d.token);
    expect(found?.id).toBe(d.id);
    expect(found?.name).toBe('Tablet');
    expect(found?.userId).toBeNull(); // pairato ma non associato
    expect(devices.deviceByToken('token-inventato')).toBeNull();
    expect(devices.deviceByToken('')).toBeNull();
  });

  it('bindDevice lega a un profilo; setDeviceUser riassegna/slega', () => {
    const d = devices.mintDevice();
    devices.bindDevice(d.id, 7);
    expect(devices.deviceByToken(d.token)?.userId).toBe(7);
    devices.setDeviceUser(d.id, 9);
    expect(devices.deviceByToken(d.token)?.userId).toBe(9);
    devices.setDeviceUser(d.id, null); // admin slega → torna "da associare"
    expect(devices.deviceByToken(d.token)?.userId).toBeNull();
  });

  it('revokeDevice: il token muore subito (deviceByToken → null)', () => {
    const d = devices.mintDevice();
    devices.bindDevice(d.id, 1);
    devices.revokeDevice(d.id);
    expect(devices.deviceByToken(d.token)).toBeNull();
    expect(devices.listDevices().some((x) => x.id === d.id)).toBe(false);
  });

  it('unbindUserDevices: profilo eliminato → device slegati ma pairati', () => {
    const a = devices.mintDevice();
    const b = devices.mintDevice();
    devices.bindDevice(a.id, 42);
    devices.bindDevice(b.id, 43);
    devices.unbindUserDevices(42);
    expect(devices.deviceByToken(a.token)?.userId).toBeNull();
    expect(devices.deviceByToken(b.token)?.userId).toBe(43); // gli altri restano
  });

  it('listDevices: tutti i device, mai l\'hash del token', () => {
    const list = devices.listDevices();
    expect(list.length).toBeGreaterThan(0);
    for (const d of list) {
      expect(d).not.toHaveProperty('token_hash');
      expect(typeof d.id).toBe('number');
      expect(d.createdAt).toBeGreaterThan(0);
    }
  });
});
