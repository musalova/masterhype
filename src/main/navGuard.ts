// Guardia pura (niente electron) della navigazione della finestra — testabile in vitest.
import { fileURLToPath } from 'url';
import { normalize, sep } from 'path';

// La finestra (preload con API IPC) può navigare SOLO dentro la directory del
// renderer — file://…/out/renderer/ in produzione — o sul dev-server in
// sviluppo. file:// generico non basta: oltre ai file locali arbitrari,
// file://host/share è una share UNC — contenuto remoto su Windows.
export function allowedNavigation(url: string, rendererDir: string, devUrl?: string): boolean {
  if (devUrl && url.startsWith(devUrl)) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:' || u.hostname) return false; // host = share UNC
    const root = rendererDir.endsWith(sep) ? rendererDir : rendererDir + sep;
    const lower = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    // normalize(): eventuali '..' sopravvissuti al parser URL non escono dalla root.
    return lower(normalize(fileURLToPath(u))).startsWith(lower(root));
  } catch {
    return false; // URL non parsabile o file URL non valido: blocca
  }
}
