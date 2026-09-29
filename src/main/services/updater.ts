// Auto-update dei binari esterni (yt-dlp): YouTube cambia spesso e yt-dlp
// pubblica fix quasi ogni settimana. Invece di richiedere una nuova release
// dell'app, scarichiamo l'ultimo yt-dlp.exe ufficiale in userData/bin e lo
// preferiamo a quello bundled. Check throttled a 1 volta/giorno.

import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, renameSync, statSync } from 'fs';
import { execFile } from 'child_process';
import { ytDlpPath } from './downloader';
import { getSettings } from '../settings';
import { report } from './telemetry';

const userBinDir = () => join(app.getPath('userData'), 'bin');
const localYtDlp = () => join(userBinDir(), 'yt-dlp.exe');
const stateFile = () => join(userBinDir(), 'update-state.json');

interface UpdState { checkedAt: number; version?: string }
const loadState = (): UpdState => {
  try { return JSON.parse(readFileSync(stateFile(), 'utf-8')) as UpdState; } catch { return { checkedAt: 0 }; }
};
const saveState = (s: UpdState) => {
  try { mkdirSync(userBinDir(), { recursive: true }); writeFileSync(stateFile(), JSON.stringify(s)); } catch { /* */ }
};

function currentVersion(): Promise<string> {
  return new Promise((res) => {
    execFile(ytDlpPath(), ['--version'], { windowsHide: true, timeout: 15000 },
      (e, so) => res(e ? '' : so.trim()));
  });
}

async function fetchLatestTag(): Promise<{ tag: string; url: string } | null> {
  try {
    const r = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
      headers: { 'User-Agent': 'MasterHype/0.1', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] };
    const asset = (j.assets ?? []).find((a) => a.name === 'yt-dlp.exe');
    if (!j.tag_name || !asset) return null;
    return { tag: j.tag_name, url: asset.browser_download_url };
  } catch { return null; }
}

// Lanciata all'avvio: controlla max 1 volta al giorno, scarica in .tmp + rename atomico.
// Mai bloccante, mai fatale — gli errori finiscono solo in telemetria.
export async function maybeUpdateYtDlp(): Promise<void> {
  try {
    if (!getSettings().autoUpdateTools) return;
    const st = loadState();
    if (Date.now() - st.checkedAt < 24 * 3600_000) return;
    saveState({ ...st, checkedAt: Date.now() });

    const latest = await fetchLatestTag();
    if (!latest) return;
    const cur = await currentVersion();
    if (cur === latest.tag) { saveState({ checkedAt: Date.now(), version: cur }); return; }

    const tmp = join(userBinDir(), 'yt-dlp.exe.tmp');
    const res = await fetch(latest.url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download ${res.status}`);
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    if (statSync(tmp).size < 1_000_000) throw new Error('download troncato');
    renameSync(tmp, localYtDlp());
    saveState({ checkedAt: Date.now(), version: latest.tag });
    report('generic', { message: `yt-dlp aggiornato: ${cur || '?'} → ${latest.tag}` });
  } catch (e) {
    report('generic', { message: `auto-update yt-dlp fallito: ${e instanceof Error ? e.message : e}` });
  }
}
