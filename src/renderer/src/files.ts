import { Capacitor, registerPlugin } from '@capacitor/core';

// File "dell'utente" sul dispositivo che li chiede: backup, report, M3U.
// APK → plugin nativo Files (MediaStore → cartella Download, visibile in
// "File"/"Download" e condivisibile); browser/PWA → download classico.
// Il desktop usa i dialoghi nativi del main (ipc.ts), non passa di qui.

interface FilesPlugin {
  saveToDownloads(o: { name: string; mime: string; data: string }): Promise<{ path: string }>;
}
const plugin = Capacitor.isNativePlatform() ? registerPlugin<FilesPlugin>('Files') : null;

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Ritorna il percorso/nome mostrabile all'utente, null se annullato/fallito.
export async function saveTextFile(name: string, text: string, mime = 'text/plain'): Promise<string | null> {
  if (plugin) {
    const r = await plugin.saveToDownloads({ name, mime, data: toBase64(text) });
    return r.path || `Download/${name}`;
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return name;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

// Selettore file: DEVE partire dentro il gesto dell'utente (onClick sincrono),
// altrimenti WebView/Chrome bloccano l'apertura. Risolve [] se annullato.
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let done = false;
    const finish = (f: File[]) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    // 'cancel' esiste su Chrome ≥113; altrove il focus di ritorno fa da fallback
    input.addEventListener('cancel', () => finish([]));
    window.addEventListener('focus', () => setTimeout(() => { if (!input.files?.length) finish([]); }, 1500), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export async function readJsonFile(f: File): Promise<unknown> {
  return JSON.parse(await f.text()) as unknown;
}
