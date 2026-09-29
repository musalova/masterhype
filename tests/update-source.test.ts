import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findUpdateSource, servedManifest, serveUpdateRoutes } from '../src/main/update';

// findUpdateSource(dirs): ogni cartella può avere app-update.json + l'APK
// indicato dal campo `file` (default 'MasterHype-Android.apk'). Vince il
// versionCode più alto tra le cartelle valide; le corrotte si ignorano.
const APK = 'MasterHype-Android.apk';
function dir() { return mkdtempSync(join(tmpdir(), 'mhupd-')); }
function put(d: string, name: string, content: string) { writeFileSync(join(d, name), content); }
const manifest = (v: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ versionName: `0.0.${v}`, versionCode: v, ...extra });

describe('findUpdateSource', () => {
  it('senza nulla → null', () => {
    const d = dir();
    expect(findUpdateSource([d])).toBeNull();
    rmSync(d, { recursive: true });
  });

  it('manifest senza APK (o viceversa) → null', () => {
    const d = dir();
    put(d, 'app-update.json', manifest(10));
    expect(findUpdateSource([d])).toBeNull();
    put(d, APK, 'APK');
    expect(findUpdateSource([d])).not.toBeNull();
    rmSync(d, { recursive: true });
  });

  it('versionCode mancante/invalido → null', () => {
    const d = dir();
    put(d, APK, 'APK');
    put(d, 'app-update.json', JSON.stringify({ versionName: 'x', versionCode: 'nope' }));
    expect(findUpdateSource([d])).toBeNull();
    rmSync(d, { recursive: true });
  });

  it('campo `file` custom rispettato', () => {
    const d = dir();
    put(d, 'custom-name.apk', 'APK');
    put(d, 'app-update.json', manifest(7, { file: 'custom-name.apk' }));
    const found = findUpdateSource([d]);
    expect(found?.apkPath).toBe(join(d, 'custom-name.apk'));
    rmSync(d, { recursive: true });
  });

  it('tra due cartelle vince il versionCode più alto', () => {
    const a = dir(); const b = dir();
    put(a, APK, 'A'); put(a, 'app-update.json', manifest(9));
    put(b, APK, 'B'); put(b, 'app-update.json', manifest(12));
    const found = findUpdateSource([a, b]);
    expect(found?.manifest.versionCode).toBe(12);
    expect(found?.apkPath).toBe(join(b, APK));
    rmSync(a, { recursive: true }); rmSync(b, { recursive: true });
  });
});

describe('servedManifest', () => {
  it('sha256 e size vengono dal file reale, url canonico', () => {
    const d = dir();
    const body = 'fake-apk-body';
    put(d, APK, body);
    put(d, 'app-update.json', manifest(5, { sha256: 'bugiardo' }));
    const src = findUpdateSource([d])!;
    const m = servedManifest(src);
    expect(m.url).toBe('/update/app.apk');
    expect(m.size).toBe(body.length);
    // sha ricalcolato: quello dichiarato nel json non ci si può fidare
    expect(m.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(m.sha256).not.toBe('bugiardo');
    rmSync(d, { recursive: true });
  });
});

// E2E HTTP reale delle route: stesso wiring di remote.ts (auth a parte —
// lì è un if su authed() prima di chiamare serveUpdateRoutes).
function mount(dirs: string[]): Promise<{ srv: Server; base: string }> {
  const srv = createServer((req, res) => {
    if (req.url === '/update/manifest.json' || req.url === '/update/app.apk') {
      serveUpdateRoutes(dirs, req.url, res);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () =>
    r({ srv, base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` })));
}

describe('serveUpdateRoutes (HTTP e2e)', () => {
  it('manifest → JSON coerente; app.apk → byte esatti col Content-Length giusto', async () => {
    const d = dir();
    const body = 'APK-BYTES-0123456789';
    put(d, APK, body);
    put(d, 'app-update.json', manifest(42, { notes: 'test' }));
    const { srv, base } = await mount([d]);
    try {
      const mr = await fetch(`${base}/update/manifest.json`);
      expect(mr.status).toBe(200);
      const m = await mr.json() as Record<string, unknown>;
      expect(m.versionCode).toBe(42);
      expect(m.url).toBe('/update/app.apk');
      expect(m.size).toBe(body.length);
      expect(m.sha256).toBe(createHash('sha256').update(body).digest('hex'));

      const ar = await fetch(`${base}/update/app.apk`);
      expect(ar.status).toBe(200);
      expect(Number(ar.headers.get('content-length'))).toBe(body.length);
      const got = Buffer.from(await ar.arrayBuffer()).toString();
      expect(got).toBe(body);
    } finally { srv.close(); rmSync(d, { recursive: true }); }
  });

  it('nessuna sorgente valida → 404 su entrambe', async () => {
    const d = dir();
    const { srv, base } = await mount([d]);
    try {
      expect((await fetch(`${base}/update/manifest.json`)).status).toBe(404);
      expect((await fetch(`${base}/update/app.apk`)).status).toBe(404);
    } finally { srv.close(); rmSync(d, { recursive: true }); }
  });

  it('manifest avvelenato con `file: ../../x` non serve file fuori dalla dir', async () => {
    const d = dir();
    put(d, 'app-update.json', manifest(9, { file: '../../segreto.apk' }));
    const { srv, base } = await mount([d]);
    try {
      // basename() neutralizza la traversata: cerca "segreto.apk" dentro d →
      // non c'è → sorgente invalida → 404 (mai il file esterno)
      expect((await fetch(`${base}/update/app.apk`)).status).toBe(404);
    } finally { srv.close(); rmSync(d, { recursive: true }); }
  });
});
