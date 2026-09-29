import { powerSaveBlocker, Notification } from 'electron';
import { spawn, execFile } from 'child_process';
import { join } from 'path';
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, readdirSync, statfsSync, linkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import type { DriveInfo, BurnProgress, LibraryTrack } from '../../shared/types';
import { IPC } from '../../shared/types';
import { binDir, ffmpegPath } from './downloader';
import { recordBurn } from './library';
import { report } from './telemetry';
import { getSettings } from '../settings';

type NotifyFn = (channel: string, payload: unknown) => void;
let notify: NotifyFn = () => {};
export function setBurnNotifier(fn: NotifyFn): void { notify = fn; }

const helper = () => join(binDir(), 'BurnHelper.exe');

// --- Durante una scrittura il PC non deve andare in sospensione (rovinerebbe il disco) ---
let blockerId: number | null = null;
// Una sola masterizzazione alla volta: PC e telefono possono avviarne due
// insieme — due scritture parallele sullo stesso drive produrrebbero spazzatura
let burnMutex = false;
export function isBurning(): boolean { return blockerId != null || burnMutex; }
function burnStart(): void {
  if (blockerId == null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
}
function burnEnd(ok: boolean, name: string): void {
  if (blockerId != null) { try { powerSaveBlocker.stop(blockerId); } catch { /* */ } blockerId = null; }
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'MasterHype',
        body: ok ? `"${name}" masterizzato — il CD è pronto!` : `Masterizzazione di "${name}" fallita`,
        silent: false,
      }).show();
    }
  } catch { /* notifiche non disponibili */ }
}

export async function listDrives(): Promise<DriveInfo[]> {
  return new Promise((resolve) => {
    execFile(helper(), ['list-drives'], { windowsHide: true, timeout: 20000 }, (e, so) => {
      try {
        const last = so.trim().split('\n').pop() ?? '';
        resolve(JSON.parse(last).drives ?? []);
      } catch {
        resolve([]);
      }
    });
  });
}

// Verifica che il volume di %TEMP% abbia spazio per il lavoro — scoprirlo a
// metà conversione costa tempo e lascia spazzatura
function assertTempSpace(needBytes: number): void {
  try {
    const st = statfsSync(tmpdir());
    if (st.bavail * st.bsize < needBytes) {
      const mb = Math.ceil(needBytes / 1048576);
      throw new Error(`Spazio insufficiente in TEMP: servono ~${mb} MB liberi`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Spazio')) throw e; // statfs non supportato: si prova comunque
  }
}

function stageDataDir(tracks: LibraryTrack[]): string {
  const dir = join(tmpdir(), 'masterhype-cd-' + randomUUID());
  mkdirSync(dir, { recursive: true });
  const used = new Set<string>();
  tracks.forEach((t, i) => {
    const sub = join(dir, safe(t.artist), safe(t.album || 'Singoli'));
    mkdirSync(sub, { recursive: true });
    // "01 - " preserva l'ordine della tracklist (l'autoradio legge in ordine alfabetico)
    const base = `${String(i + 1).padStart(2, '0')} - ${safe(`${t.artist} - ${t.title}`)}`;
    // Nomi sanitizzati possono collidere ("A?B" = "A|B"): dedup esplicito
    let name = `${base}.mp3`, n = 1;
    const key = () => join(sub, name).toLowerCase();
    while (used.has(key())) { n++; name = `${base} (${n}).mp3`; }
    used.add(key());
    const dst = join(sub, name);
    try { linkSync(t.filePath, dst); } // stesso volume: zero copia
    catch { copyFileSync(t.filePath, dst); }
  });
  return dir;
}

function safe(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Traccia';
}

async function toWav(src: string, out: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // -map_metadata -1 + bitexact: niente chunk LIST/INFO/extra — IMAPI2 AddAudioTrack
    // rifiuta WAV con chunk oltre fmt+data ("flusso audio non valido")
    execFile(ffmpegPath(), ['-y', '-i', src, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-ar', '44100', '-ac', '2', '-sample_fmt', 's16', '-f', 'wav', out],
      { windowsHide: true, timeout: 240_000 }, // un file corrotto non deve bloccare il CD per sempre
      (e, _so, se) => (e ? reject(new Error(se?.slice(-200) || 'ffmpeg')) : resolve()));
  });
}

function assertFiles(tracks: LibraryTrack[]): void {
  const missing = tracks.filter((t) => !t.filePath || !existsSync(t.filePath));
  if (missing.length) throw new Error(`File mancanti su disco: ${missing.map((t) => t.title).join(', ')}`);
  // file tronchi (0 byte) esistono ma non sono brani: fallire qui è gratis
  const empty = tracks.filter((t) => { try { return statSync(t.filePath).size < 1024; } catch { return true; } });
  if (empty.length) throw new Error(`File danneggiati: ${empty.map((t) => t.title).join(', ')}`);
}

export async function burnAudio(driveId: string, tracks: LibraryTrack[], name: string, u = 1): Promise<void> {
  if (burnMutex) throw new Error('Una masterizzazione è già in corso');
  burnMutex = true;
  try { await burnAudioInner(driveId, tracks, name, u); } finally { burnMutex = false; }
}
async function burnAudioInner(driveId: string, tracks: LibraryTrack[], name: string, u: number): Promise<void> {
  if (!tracks.length) throw new Error('nessuna traccia');
  assertFiles(tracks);
  const jobId = randomUUID();
  const send = (p: Partial<BurnProgress>) => notify(IPC.burnEvent, { jobId, ...p });

  const wavDir = join(tmpdir(), 'masterhype-wav-' + jobId);
  mkdirSync(wavDir, { recursive: true });
  burnStart();
  let ok = false;
  try {
    // ~800 MB di WAV per 80 min: meglio saperlo prima che a metà conversione
    assertTempSpace(tracks.reduce((s, t) => s + (t.durationS ?? 210) * 176400 + 1024, 0));
    // 1) decode MP3 -> WAV 44.1/16/stereo (formato CDA), 3 conversioni in parallelo
    const wavs: string[] = new Array(tracks.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < tracks.length) {
        const i = next++;
        const t = tracks[i];
        const out = join(wavDir, `${String(i + 1).padStart(2, '0')}.wav`);
        await toWav(t.filePath, out);
        wavs[i] = out;
        done++;
        send({ phase: 'prepare', percent: Math.round((done / tracks.length) * 40), message: `Conversione ${done}/${tracks.length}: ${t.title}`, trackIndex: done, trackCount: tracks.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, tracks.length) }, worker));
    // 1b) capacità REALE (settori WAV, non metadati) vs disco — l'ultima
    // linea di difesa prima di toccare il laser: oltre = abort, zero coaster
    const realSectors = wavs.reduce((s, w) => s + Math.ceil((statSync(w).size - 44) / 2352), 0);
    const drive = (await listDrives()).find((d) => d.id === driveId);
    const need = realSectors + (tracks.length - 1) * 150 + 11250;
    if (drive && drive.freeSectors > 0 && need > drive.freeSectors) {
      throw new Error(`La scaletta reale (${(need / 4500).toFixed(1)} min) non entra nel disco (${(drive.freeSectors / 4500).toFixed(1)} min) — togli brani e riprova`);
    }
    if (drive && !drive.mediaPresent) throw new Error('Nessun disco nel masterizzatore');
    if (drive && !drive.mediaBlank) throw new Error('Il disco non è vuoto — cancellalo o inserisci un CD vergine');
    // 2) masterizza
    const listFile = join(wavDir, 'files.txt');
    writeFileSync(listFile, wavs.join('\n'), 'utf-8');
    // CD-Text: "artista|titolo" per traccia — l'autoradio mostra i nomi sul display
    const titlesFile = join(wavDir, 'titles.txt');
    writeFileSync(titlesFile, tracks.map((t) => `${t.artist}|${t.title}`).join('\n'), 'utf-8');
    const speed = getSettings().burnSpeed;
    // il helper segnala il WAV temporaneo (es. "01"): mappo al titolo reale
    const sendTitled = (p: Partial<BurnProgress>) => {
      if (p.trackIndex != null && tracks[p.trackIndex - 1]) p.currentTrack = tracks[p.trackIndex - 1].title;
      send(p);
    };
    await runHelper(['burn-audio', '--drive', driveId, '--files', listFile, '--titles', titlesFile, '--album', name, '--speed', String(speed)], sendTitled, tracks.length);
    recordBurn(name, 'audio', tracks, u);
    ok = true;
    await ejectDisc(driveId).catch(() => {}); // espelli il disco finito
  } catch (e) {
    // Errori di scrittura tracciati: servono a capire drive/media problematici
    report('burn', { message: `audio "${name}" (${tracks.length} tracce): ${e instanceof Error ? e.message : e}` });
    throw e;
  } finally {
    burnEnd(ok, name);
    try { rmSync(wavDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

export async function burnData(driveId: string, tracks: LibraryTrack[], name: string, u = 1): Promise<void> {
  if (burnMutex) throw new Error('Una masterizzazione è già in corso');
  burnMutex = true;
  try { await burnDataInner(driveId, tracks, name, u); } finally { burnMutex = false; }
}
async function burnDataInner(driveId: string, tracks: LibraryTrack[], name: string, u: number): Promise<void> {
  if (!tracks.length) throw new Error('nessuna traccia');
  assertFiles(tracks);
  const jobId = randomUUID();
  const send = (p: Partial<BurnProgress>) => notify(IPC.burnEvent, { jobId, ...p });
  send({ phase: 'prepare', percent: 2, message: 'Preparazione file' });
  assertTempSpace(tracks.reduce((s, t) => s + (t.durationS ?? 210) * (+(getSettings().audioQuality || '320') / 8) * 1.1, 0));
  const dir = stageDataDir(tracks);
  const listFile = join(tmpdir(), `mh-list-${jobId}.txt`);
  burnStart();
  let ok = false;
  try {
    // Stato disco ri-letto ora: tra la UI e la scrittura il vassoio può essere cambiato
    const drive = (await listDrives()).find((d) => d.id === driveId);
    if (drive && !drive.mediaPresent) throw new Error('Nessun disco nel masterizzatore');
    if (drive && !drive.mediaBlank) throw new Error('Il disco non è vuoto — cancellalo o inserisci un CD vergine');
    writeFileSync(listFile, dir, 'utf-8');
    const speed = getSettings().burnSpeed;
    await runHelper(['burn-data', '--drive', driveId, '--files', listFile, '--label', name, '--speed', String(speed)], send, tracks.length);
    recordBurn(name, 'mp3', tracks, u);
    ok = true;
    await ejectDisc(driveId).catch(() => {});
  } catch (e) {
    report('burn', { message: `mp3 "${name}" (${tracks.length} tracce): ${e instanceof Error ? e.message : e}` });
    throw e;
  } finally {
    burnEnd(ok, name);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    try { rmSync(listFile, { force: true }); } catch { /* temp */ }
  }
}

export async function eraseDisc(driveId: string, full: boolean): Promise<void> {
  if (burnMutex) throw new Error('Una masterizzazione è già in corso');
  burnMutex = true;
  try { await eraseDiscInner(driveId, full); } finally { burnMutex = false; }
}
async function eraseDiscInner(driveId: string, full: boolean): Promise<void> {
  const jobId = randomUUID();
  const send = (p: Partial<BurnProgress>) => notify(IPC.burnEvent, { jobId, ...p });
  // la fase 'write' del helper va mostrata come preparazione, non "Scrittura"
  const remap = (p: Partial<BurnProgress>) => send({ ...p, phase: p.phase === 'write' ? 'prepare' : p.phase });
  try {
    await runHelper(['erase', '--drive', driveId, ...(full ? ['--full'] : [])], remap, 0);
  } catch (e) {
    report('burn', { message: `erase${full ? ' full' : ''}: ${e instanceof Error ? e.message : e}` });
    throw e;
  }
}

export async function ejectDisc(driveId: string): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile(helper(), ['eject', '--drive', driveId], { windowsHide: true }, () => resolve());
  });
}

function runHelper(args: string[], send: (p: Partial<BurnProgress>) => void, trackCount: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(helper(), args, { windowsHide: true });
    let buf = '';
    let failed: string | null = null;
    proc.stdout.on('data', (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.phase === 'error') failed = p.message;
          else if (p.phase === 'write' && trackCount) {
            send({ phase: 'write', percent: 40 + Math.round(p.percent * 0.58), currentTrack: p.current, trackIndex: p.trackIndex, trackCount });
          } else send(p);
        } catch { /* linea non-JSON: ignora */ }
      }
    });
    let stderrTail = '';
    proc.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-500); });
    proc.on('close', (code) => {
      if (failed) reject(new Error(failed));
      else if (code !== 0) reject(new Error(`BurnHelper exit ${code}${stderrTail ? `: ${stderrTail.slice(-200)}` : ''}`));
      else resolve();
    });
    proc.on('error', (e) => reject(e));
  });
}

// Verifica capacità audio CD: 80 min standard (74 per sicurezza opzionale)
export function audioCapacityCheck(tracks: LibraryTrack[], maxMinutes = 80): { ok: boolean; minutes: number; over: number } {
  const total = tracks.reduce((s, t) => s + (t.durationS ?? 210), 0) + Math.max(0, tracks.length - 1) * 2; // gap 2s
  const minutes = total / 60;
  return { ok: minutes <= maxMinutes, minutes, over: Math.max(0, minutes - maxMinutes) };
}
