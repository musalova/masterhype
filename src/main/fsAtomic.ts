// Scritture su disco a prova di crash/blackout per i file di stato del PC
// (settings.json, coda download, attese playlist). Il PC è il server di casa
// e resta acceso per settimane: una writeFileSync interrotta a metà (blackout,
// BSOD, disco pieno) lasciava un JSON troncato → al boot settings azzerate
// (cartella libreria, chiavi Spotify/Last.fm, codice del PC rigenerato).
//
// Schema: scrivi su <file>.tmp → fsync → rename atomico sopra l'originale.
// Puro (niente electron): testabile in vitest.

import { openSync, writeSync, fsyncSync, closeSync, renameSync, writeFileSync, unlinkSync, readFileSync, copyFileSync, existsSync } from 'node:fs';

export function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd); // i byte sono sul disco PRIMA che il rename li renda visibili
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch {
    // Windows: antivirus/indicizzatore può tenere l'originale aperto (EPERM/
    // EBUSY) — meglio una scrittura non atomica che perdere il salvataggio.
    writeFileSync(file, data);
    try { unlinkSync(tmp); } catch { /* */ }
  }
}

// Legge un JSON con fallback sulla copia di sicurezza `<file>.bak` (l'ultima
// versione letta con successo — vedi snapshotBackup). null = né l'uno né
// l'altro sono leggibili.
export function readJsonWithBackup<T>(file: string): { value: T; fromBackup: boolean } | null {
  for (const [p, fromBackup] of [[file, false], [`${file}.bak`, true]] as const) {
    try {
      if (!existsSync(p)) continue;
      return { value: JSON.parse(readFileSync(p, 'utf-8')) as T, fromBackup };
    } catch { /* corrotto: prova la copia */ }
  }
  return null;
}

// Copia di sicurezza dell'ultimo file valido: chiamata dopo una lettura
// riuscita, così un file corrotto al prossimo avvio ripiega su questa.
export function snapshotBackup(file: string): void {
  try { copyFileSync(file, `${file}.bak`); } catch { /* best-effort */ }
}
