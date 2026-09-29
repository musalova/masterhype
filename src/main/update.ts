import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ServerResponse } from 'node:http';

// Sorgente aggiornamenti APK servita dal PC ai telefoni pairati.
// Ogni directory candidata può contenere:
//   app-update.json   → { versionCode, versionName, file, size, sha256, notes? }
//   <file>            → l'APK (default 'MasterHype-Android.apk')
// Vince il manifest con versionCode più alto tra tutte le directory valide.
// Modulo puro (niente electron): le directory le decide il chiamante.

export interface UpdateSource {
  dir: string;
  manifest: Record<string, unknown> & { versionCode: number };
  apkPath: string;
}

export function findUpdateSource(dirs: string[]): UpdateSource | null {
  let best: UpdateSource | null = null;
  for (const dir of dirs) {
    try {
      const manPath = join(dir, 'app-update.json');
      if (!existsSync(manPath)) continue;
      const man = JSON.parse(readFileSync(manPath, 'utf8')) as Record<string, unknown>;
      const vc = Number(man.versionCode);
      if (!Number.isFinite(vc) || vc <= 0) continue;
      // `file` deve essere un nome file nudo dentro `dir`: un manifest con
      // "../../x" farebbe servire file arbitrari del PC a chiunque abbia il
      // token sulla LAN → si accetta solo il basename, niente path.
      const apkName = basename(String(man.file ?? 'MasterHype-Android.apk'));
      if (!apkName || apkName === '.' || !apkName.toLowerCase().endsWith('.apk')) continue;
      const apkPath = join(dir, apkName);
      if (!existsSync(apkPath) || !statSync(apkPath).isFile()) continue;
      if (!best || vc > best.manifest.versionCode) best = { dir, manifest: man as UpdateSource['manifest'], apkPath };
    } catch { /* manifest corrotto/dir illeggibile: la ignoriamo */ }
  }
  return best;
}

// sha256 calcolato una sola volta per (path, mtime): il manifest lo serve a
// ogni check, l'hash di 30-40MB non si ripaga a ogni richiesta.
const shaCache = new Map<string, { mtimeMs: number; size: number; sha: string }>();
export function apkSha256(file: string): string {
  const st = statSync(file);
  const hit = shaCache.get(file);
  // mtime+size: una sostituzione "a pari timestamp" non deve servire lo sha
  // del file vecchio (la verifica lato telefono lo bloccherebbe comunque).
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  shaCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha });
  return sha;
}

// Manifest da servire al telefono: campi del json + url canonico + size/sha256
// sempre presenti (calcolati dal file reale — il json può anche non averli).
export function servedManifest(src: UpdateSource): Record<string, unknown> {
  return {
    ...src.manifest,
    url: '/update/app.apk',
    size: statSync(src.apkPath).size,
    sha256: apkSha256(src.apkPath),
  };
}

// Route /update/* pure (niente electron): remote.ts ci passa le sue directory
// e la response dopo il check del token. Testabili via HTTP vero in vitest.
// pathname è già stato confrontato dal router: qui serve solo quale dei due.
export function serveUpdateRoutes(dirs: string[], pathname: string, res: ServerResponse): void {
  const src = findUpdateSource(dirs);
  if (!src) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ e: 'nessun aggiornamento' }));
    return;
  }
  if (pathname === '/update/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(servedManifest(src)));
    return;
  }
  // /update/app.apk — stream del file (il client verifica sha256 dal manifest)
  const size = statSync(src.apkPath).size;
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': size,
    'Cache-Control': 'no-store',
  });
  const s = createReadStream(src.apkPath);
  res.on('close', () => { try { s.destroy(); } catch { /* */ } });
  s.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  s.pipe(res);
}
