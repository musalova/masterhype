import { app } from 'electron';
import { spawn, execFile } from 'child_process';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, writeFileSync, readFileSync, copyFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import type { TrackRef, DownloadJob, DownloadStatus } from '../../shared/types';
import { getSettings } from '../settings';
import { IPC } from '../../shared/types';
import { addTrack, recordEvent, bumpTaste, findByVideoId, importLocalFile } from './library';
import { lastfmArtistTags, audiusSearch, audiusStreamUrl } from './sources';
import { audiusMatch } from '../../shared/ytparse';
import { mapLimit } from './util';
import { report, markBadStream, isBadStream } from './telemetry';
import { searchSongs } from './ytmusic';
import { getDb } from '../db';

type NotifyFn = (channel: string, payload: unknown) => void;
let notify: NotifyFn = () => {};

export function setNotifier(fn: NotifyFn): void {
  notify = fn;
}

export function binDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'bin');
  // appPath = repo root con `electron .` / electron-vite dev;
  // = <repo>/out/main se lanciato come `electron out/main/index.js`
  const base = app.getAppPath();
  for (const cand of [join(base, 'resources', 'bin'), join(base, '..', '..', 'resources', 'bin')]) {
    if (existsSync(join(cand, 'yt-dlp.exe'))) return cand;
  }
  return join(base, 'resources', 'bin');
}

export function ytDlpPath(): string {
  // Preferisci il binario auto-aggiornato in userData (vedi services/updater.ts);
  // fallback al bundled. Se il file locale è corrotto (<1MB) si ignora.
  const local = join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
  try {
    if (existsSync(local) && statSync(local).size > 1_000_000) return local;
  } catch { /* */ }
  return join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
}

export function ffmpegPath(): string {
  const bundled = join(binDir(), 'ffmpeg.exe');
  return existsSync(bundled) ? bundled : 'ffmpeg';
}

export function ffprobePath(): string {
  const bundled = join(binDir(), 'ffprobe.exe');
  return existsSync(bundled) ? bundled : 'ffprobe';
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

const jobs = new Map<string, DownloadJob>();
const queue: string[] = [];
let active = 0;
const MAX_PARALLEL = 2; // 2 download+conversioni in parallelo: ~dimezza l'attesa su code lunghe
const claimedPaths = new Set<string>(); // evita che 2 job paralleli scelgano lo stesso file di output

// Listener "download finito" (es. playlist che aspettano il brano): ricevono
// il job 'done' con la traccia già registrata in libreria.
const doneListeners = new Set<(job: DownloadJob) => void>();
export function onDownloadDone(fn: (job: DownloadJob) => void): () => void {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
}

// Coda persistente: i job non finiti sopravvivono a riavvio/aggiornamento
// del PC (prima si perdevano in silenzio — anche quelli chiesti dal
// telefono o arrivati dalla coda offline). Scrittura debounced.
const queueFile = () => join(app.getPath('userData'), 'download-queue.json');
let persistT: ReturnType<typeof setTimeout> | undefined;
function persistQueue(): void {
  clearTimeout(persistT);
  persistT = setTimeout(() => {
    const pending = [...jobs.values()]
      .filter((j) => !['done', 'error'].includes(j.status))
      .map((j) => ({ track: j.track, userId: j.userId ?? 1 }));
    try { writeFileSync(queueFile(), JSON.stringify(pending)); } catch { /* disco pieno: la coda resta in memoria */ }
  }, 500);
}
export function restoreQueue(): number {
  try {
    if (!existsSync(queueFile())) return 0;
    const saved = JSON.parse(readFileSync(queueFile(), 'utf-8')) as { track: TrackRef; userId?: number }[];
    let n = 0;
    for (const s of Array.isArray(saved) ? saved : []) {
      if (s?.track?.videoId) { enqueue(s.track, s.userId ?? 1); n++; }
    }
    return n;
  } catch { return 0; }
}

function emit(job: DownloadJob): void {
  notify(IPC.downloadEvent, { ...job });
  persistQueue();
  if (job.status === 'done') for (const fn of doneListeners) { try { fn({ ...job }); } catch { /* listener non deve rompere la coda */ } }
}

export function listJobs(): DownloadJob[] {
  // La Map preserva l'ordine di inserimento (cronologico) — il sort per uuid
  // precedente mescolava la lista in ordine casuale
  return [...jobs.values()];
}

export function retryJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || j.status !== 'error') return false;
  j.status = 'queued';
  j.percent = 0;
  j.error = undefined;
  queue.push(j.id);
  emit(j);
  pump();
  return true;
}

export function dismissJob(id: string): boolean {
  const j = jobs.get(id);
  if (!j || !['done', 'error'].includes(j.status)) return false;
  jobs.delete(id);
  return true;
}

export function clearFinished(): number {
  let n = 0;
  for (const [id, j] of jobs) {
    if (['done', 'error'].includes(j.status)) { jobs.delete(id); n++; }
  }
  return n;
}

export function enqueue(track: TrackRef, u = 1): DownloadJob {
  // Già in coda o in lavorazione: riusa il job esistente
  const active = [...jobs.values()].find(
    (j) => j.track.videoId === track.videoId && !['done', 'error'].includes(j.status));
  if (active) return active;
  // Già in libreria con file presente: completa subito senza riscaricare
  const existing = findByVideoId(track.videoId);
  if (existing && existsSync(existing.filePath)) {
    // Job sintetico "done": niente emit (evita il toast "Scaricato" spurio) e niente riga in Download
    return { id: randomUUID(), track, status: 'done', percent: 100, filePath: existing.filePath };
  }
  const job: DownloadJob = { id: randomUUID(), track, status: 'queued', percent: 0, userId: u };
  jobs.set(job.id, job);
  queue.push(job.id);
  emit(job);
  pump();
  return job;
}

function pump(): void {
  while (queue.length && active < MAX_PARALLEL) {
    const id = queue.shift()!;
    const job = jobs.get(id);
    if (!job) continue;
    active++;
    runJob(job)
      .catch((e) => {
        job.status = 'error';
        job.error = e instanceof Error ? e.message : String(e);
        report('download', { message: job.error, artist: job.track.artist, title: job.track.title, videoId: job.track.videoId });
        emit(job);
      })
      .finally(() => { active--; pump(); });
  }
}

function setStatus(job: DownloadJob, status: DownloadStatus, percent?: number): void {
  if (job.status === status && percent !== undefined && percent === job.percent) return; // evita flood IPC
  job.status = status;
  if (percent !== undefined) job.percent = percent;
  emit(job);
}

async function runJob(job: DownloadJob): Promise<void> {
  const { track } = job;
  const s = getSettings();
  const tmp = join(tmpdir(), 'masterhype');
  mkdirSync(tmp, { recursive: true });

  let rawFile: string | undefined;
  let coverFile: string | undefined;
  let outPath: string | undefined;
  try {
    // 1) Download bestaudio via yt-dlp (audio ufficiale, no watermark/voiceover dei video).
    //    Le tracce Audius arrivano dall'endpoint stream (redirect al file): yt-dlp
    //    lo gestisce col generic extractor.
    setStatus(job, 'downloading', 0);
    const srcUrl = track.videoId.startsWith('audius:')
      ? audiusStreamUrl(track.videoId.slice(7))
      : `https://music.youtube.com/watch?v=${track.videoId}`;
    try {
      await runYtDlp(srcUrl, tmp, job.id, (p) => setStatus(job, 'downloading', p));
    } catch {
      // Retry con client alternativo: certi videoId falliscono col client default
      // (inutile per Audius, che non ha extractor-args youtube)
      if (track.videoId.startsWith('audius:')) throw new Error('Download Audius non riuscito');
      await runYtDlp(srcUrl, tmp, job.id, (p) => setStatus(job, 'downloading', p),
        ['--extractor-args', 'youtube:player_client=android']);
    }
    rawFile = findOutput(tmp, job.id);
    if (!rawFile) throw new Error('Download non riuscito: file non trovato');

    // 2) Copertina
    if (track.thumbnail) {
      coverFile = join(tmp, `${job.id}.jpg`);
      try {
        const res = await fetch(track.thumbnail, { signal: AbortSignal.timeout(15000) });
        if (res.ok) writeFileSync(coverFile, Buffer.from(await res.arrayBuffer()));
        else coverFile = undefined;
      } catch {
        coverFile = undefined;
      }
    }

    // 3) Conversione: pulizia + loudness + MP3 320 + tag + cover
    setStatus(job, 'converting', 60);
    mkdirSync(s.libraryDir, { recursive: true });
    const base = sanitize(`${track.artist} - ${track.title}`) || job.id;
    const existing = findByVideoId(track.videoId);
    outPath = existing?.filePath ?? join(s.libraryDir, `${base}.mp3`);
    let n = 1;
    // claimedPaths: due job paralleli con lo stesso nome non devono sovrascriversi
    while (!existing && (existsSync(outPath) || claimedPaths.has(outPath)))
      outPath = join(s.libraryDir, `${base} (${++n}).mp3`);
    claimedPaths.add(outPath);

    const filters: string[] = [];
    if (s.trimSilence) {
      // taglia silenzi/intro vuoti tipici dei video — OFF di default: il trim
      // è DISTRUTTIVO (cotto nel file, taglia intro voluti); i gap dei CD
      // audio li gestisce il burning, non il file.
      filters.push('silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08');
      filters.push('areverse');
      filters.push('silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08');
      filters.push('areverse');
    }
    // Normalizzazione SENZA distruggere il segnale: si misura l'input_i del
    // sorgente, il guadagno va nei tag ReplayGain/R128 (letti dai player
    // esterni) e nella tabella loudness (l'app lo applica a runtime su
    // <audio>.volume, come già per gli stream). Il loudnorm non si cuoce più
    // nel file: niente doppia compressione psicoacustica, file = originale.
    let lufs: number | null = null;
    if (s.normalizeAudio) lufs = await measureLufs(rawFile);

    const args = ['-y', '-i', rawFile];
    if (coverFile) args.push('-i', coverFile, '-map', '0:a', '-map', '1:v', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic');
    if (filters.length) args.push('-af', filters.join(','));
    args.push(
      '-c:a', 'libmp3lame', '-b:a', `${s.audioQuality}k`,
      '-id3v2_version', '3',
      '-metadata', `title=${track.title}`,
      '-metadata', `artist=${track.artist}`,
    );
    if (track.album) args.push('-metadata', `album=${track.album}`);
    if (lufs != null) {
      storeLoudness(track.videoId, lufs);
      // Tag per i player esterni: replaygain_track_gain = dB per arrivare al
      // riferimento -18 LUFS (89 dB SPL), r128_track_gain = Q7.8 verso -23.
      args.push('-metadata', `replaygain_track_gain=${(-18 - lufs).toFixed(2)} dB`);
      args.push('-metadata', `r128_track_gain=${Math.round((-23 - lufs) * 256)}`);
    }
    args.push(outPath);

    await execP(ffmpegPath(), args);

    // 4) Registra in libreria: durata reale via ffprobe, copertina in userData/covers
    setStatus(job, 'tagging', 95);
    let durationS = track.durationS;
    try {
      const out = await execOut(ffprobePath(), ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]);
      const d = parseFloat(out.trim());
      if (Number.isFinite(d)) durationS = Math.round(d);
    } catch { /* durata dal metadata */ }

    let coverPath: string | undefined;
    if (coverFile && existsSync(coverFile)) {
      const cdir = join(app.getPath('userData'), 'covers');
      mkdirSync(cdir, { recursive: true });
      coverPath = join(cdir, `${track.videoId}.jpg`);
      try { copyFileSync(coverFile, coverPath); } catch { coverPath = undefined; }
    }

    const saved = addTrack({
      videoId: track.videoId, title: track.title, artist: track.artist,
      album: track.album, durationS, filePath: outPath, coverPath,
    });
    recordEvent(saved.id, track.artist, 'download', undefined, job.userId ?? 1);

    // tag genere per il profilo gusti (se Last.fm configurata)
    const ju = job.userId ?? 1;
    void lastfmArtistTags(track.artist).then((tags) => {
      if (!tags.length) return;
      getDb().prepare('UPDATE tracks SET genre=? WHERE id=?').run(tags[0], saved.id);
      for (const t of tags.slice(0, 3)) bumpTaste('tag', t, 0.5, ju);
    }).catch(() => {});

    job.filePath = outPath;
    job.percent = 100;
    setStatus(job, 'done', 100);
  } finally {
    if (outPath) claimedPaths.delete(outPath);
    // Pulizia temp: sorgente scaricato e copertina non servono più
    for (const f of [rawFile, coverFile]) {
      if (f && existsSync(f)) try { unlinkSync(f); } catch { /* in uso: resta */ }
    }
    // Anche eventuali .part rimasti da download interrotti
    try {
      for (const f of readdirSync(tmp)) {
        if (f.startsWith(job.id)) try { unlinkSync(join(tmp, f)); } catch { /* ignora */ }
      }
    } catch { /* ignora */ }
  }
}

function findOutput(dir: string, id: string): string | undefined {
  const f = readdirSync(dir).find((x) => x.startsWith(id) && !x.endsWith('.jpg') && !x.endsWith('.part'));
  return f ? join(dir, f) : undefined;
}

function runYtDlp(url: string, dir: string, id: string, onPct: (p: number) => void, extra: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffDir = dirname(ffmpegPath());
    const args = ['-f', 'bestaudio/best', '--no-playlist', '--newline', '--progress', ...extra];
    if (ffDir !== '.') args.push('--ffmpeg-location', ffDir);
    args.push('-o', join(dir, `${id}.%(ext)s`), url);
    const proc = spawn(ytDlpPath(), args, { windowsHide: true });
    // Timeout: un download stallato non deve tenere uno slot occupato per
    // sempre (2 slot paralleli → un hang bloccava metà della coda)
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 15 * 60_000);
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(String(d));
      if (m) onPct(Math.min(58, Math.round(parseFloat(m[1]) * 0.58)));
    });
    proc.on('close', (code) => { clearTimeout(killer); code === 0 ? resolve() : reject(new Error(`yt-dlp exit ${code}: ${cleanErr(err).slice(0, 300)}`)); });
    proc.on('error', (e) => { clearTimeout(killer); reject(new Error(`yt-dlp non avviato: ${e.message}`)); });
  });
}

function execOut(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (e, so) => (e ? reject(e) : resolve(so)));
  });
}

function execP(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 300_000 }, (e, _so, se) => {
      if (e) reject(new Error(`${cmd}: ${se?.slice(-400) || e.message}`));
      else resolve();
    });
  });
}

// ---- Import file locali (drag&drop) ----
const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.m4a', '.ogg', '.opus', '.aac', '.wma']);

async function probeAudio(p: string): Promise<{ durationS?: number; title?: string; artist?: string; album?: string }> {
  try {
    const out = await execOut(ffprobePath(), [
      '-v', 'quiet', '-show_entries', 'format=duration:format_tags=title,artist,album', '-of', 'json', p,
    ]);
    const j = JSON.parse(out);
    const tags = j.format?.tags ?? {};
    const pick = (k: string) => tags[k] ?? tags[k.toUpperCase()] ?? tags[k.charAt(0).toUpperCase() + k.slice(1)];
    const d = parseFloat(j.format?.duration);
    return {
      durationS: Number.isFinite(d) ? Math.round(d) : undefined,
      title: pick('title'), artist: pick('artist'), album: pick('album'),
    };
  } catch {
    return {};
  }
}

// Async + 3 probe in parallelo: non blocca il main process su drop di molti file
export async function importFiles(paths: string[], u = 1): Promise<number> {
  let n = 0;
  const lib = getSettings().libraryDir;
  await mapLimit(paths, 3, async (p) => {
    const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
    if (!AUDIO_EXT.has(ext)) return;
    const meta = await probeAudio(p);
    const t = importLocalFile(p, lib, () => meta);
    if (t) { recordEvent(t.id, t.artist, 'download', undefined, u); n++; }
  });
  return n;
}

// ---- Anteprima stream ----
const urlCache = new Map<string, { url: string; exp: number }>();
const videoCache = new Map<string, { url: string; exp: number }>();
// Le cache URL non devono crescere all'infinito in sessioni lunghe
function cacheSet(m: Map<string, { url: string; exp: number }>, k: string, v: { url: string; exp: number }): void {
  if (m.size >= 500) m.delete(m.keys().next().value!); // eviction FIFO
  m.set(k, v);
}

// Alcune tracce rispondono solo con certi client/formati (age-gate, formati
// EJS mancanti, throttling): scaletta di tentativi prima di arrendersi.
const STREAM_TRIES: string[][] = [
  ['-f', 'bestaudio/best'],
  ['-f', 'bestaudio/best', '--extractor-args', 'youtube:player_client=android'],
  ['-f', 'best', '--extractor-args', 'youtube:player_client=tv_embedded'],
];

// stderr di yt-dlp è rumoroso (warning EJS, deprecation): tieni solo gli ERROR
const cleanErr = (se?: string) =>
  (se ?? '').split('\n').filter((l) => /error|fail|unavailable|forbidden/i.test(l)).join(' ').slice(0, 200)
  || se?.slice(-200) || '';

function probeStream(videoId: string, args: string[], host = 'music.youtube.com'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(ytDlpPath(), [...args, '-g', `https://${host}/watch?v=${videoId}`],
      { windowsHide: true, timeout: 30000 }, (e, so, se) => {
        const u = so.trim().split('\n')[0];
        if (e || !u.startsWith('http')) reject(new Error(cleanErr(se) || 'stream url non disponibile'));
        else resolve(u);
      });
  });
}

export async function streamUrl(videoId: string): Promise<string> {
  const hit = urlCache.get(videoId);
  if (hit && hit.exp > Date.now()) return hit.url;
  // Tracce Audius: l'endpoint /stream risponde 302 verso il file audio —
  // verifichiamo che esista davvero e restituiamo l'endpoint (il player
  // e ffmpeg seguono il redirect da soli).
  if (videoId.startsWith('audius:')) {
    const u = audiusStreamUrl(videoId.slice(7));
    const res = await fetch(u, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (![200, 301, 302, 303, 307, 308].includes(res.status))
      throw new Error(`audius stream ${res.status}`);
    cacheSet(urlCache, videoId, { url: u, exp: Date.now() + 5 * 3600_000 });
    return u;
  }
  let lastErr = 'stream url non disponibile';
  for (const args of STREAM_TRIES) {
    try {
      const url = await probeStream(videoId, args);
      cacheSet(urlCache, videoId, { url, exp: Date.now() + 5 * 3600_000 });
      return url;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  throw new Error(lastErr);
}

// Stream video SOLO VIDEO ≤720p per la vista Now Playing — gira muto
// (l'audio resta al <audio> di PlayerBar), quindi i formati video-only DASH
// vanno benissimo e non serve un file muxed.
export async function videoUrl(videoId: string, maxH = 720): Promise<string> {
  if (videoId.startsWith('audius:')) throw new Error('Audius non ha video'); // niente report: non è un errore
  // Qualità: 720 (default, leggero) o 1080 (HD, vista a tutto schermo)
  const h = maxH >= 1080 ? 1080 : 720;
  const ck = `${videoId}@${h}`;
  const hit = videoCache.get(ck);
  if (hit && hit.exp > Date.now()) return hit.url;
  let lastErr = 'video non disponibile';
  for (const fmt of [`bestvideo[height<=${h}][ext=mp4]/bestvideo[height<=${h}]/best[vcodec!=none]`, 'bestvideo/best[vcodec!=none]']) {
    try {
      const url = await probeStream(videoId, ['-f', fmt], 'www.youtube.com');
      cacheSet(videoCache, ck, { url, exp: Date.now() + 5 * 3600_000 });
      return url;
    } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
  }
  report('video', { videoId, message: lastErr });
  throw new Error(lastErr);
}

// ---- Auto-riparazione degli stream ----
// Un videoId può fallire per vari motivi: video rimosso/privato, blocco
// regionale, age-gate, rate-limit di yt-dlp. Invece di arrendersi:
// 1) si marca il videoId come difettoso (non verrà più riprovato né
//    riproposto in ricerca);
// 2) si cerca lo stesso brano con "artista titolo" e si provano le
//    alternative fino a trovare uno stream che risponde;
// 3) tutto viene registrato in telemetria — la diagnostica mostra dove
//    concentrare gli sforzi.

const HEAL_CANDIDATES = 4;

async function healStream(videoId: string, artist: string, title: string, cause?: string): Promise<{ url: string; videoId: string }> {
  const alts = (await searchSongs(`${artist} ${title}`.trim()).catch(() => []))
    .filter((t) => t.videoId !== videoId && !isBadStream(t.videoId))
    .slice(0, HEAL_CANDIDATES);
  for (const alt of alts) {
    try {
      const url = await streamUrl(alt.videoId);
      report('play', { artist, title, videoId: alt.videoId, healed: true,
        message: `riparato: ${videoId} → ${alt.videoId}${cause ? ` (${cause})` : ''}` });
      return { url, videoId: alt.videoId };
    } catch { markBadStream(alt.videoId, alt.artist, alt.title); }
  }
  // Ultima spiaggia: Audius (catalogo alternativo legale). Solo con match
  // stretto artista+titolo — meglio fallire che suonare il brano sbagliato.
  for (const m of await audiusSearch(`${artist} ${title}`).catch(() => [])) {
    if (!audiusMatch(m.artist, m.title, artist, title)) continue;
    try {
      const url = await streamUrl(`audius:${m.id}`); // valida che lo stream esista
      report('play', { artist, title, videoId: `audius:${m.id}`, healed: true,
        message: `riparato via Audius: ${videoId} → ${m.id}${cause ? ` (${cause})` : ''}` });
      return { url, videoId: `audius:${m.id}` };
    } catch { markBadStream(`audius:${m.id}`, artist, title); }
  }
  throw new Error(cause || 'stream non risolvibile');
}

// Risolve l'URL audio per un brano, auto-riparandolo se lo stream è difettoso.
export async function playStream(videoId: string, artist: string, title: string): Promise<{ url: string; videoId: string; healed: boolean }> {
  const done = (url: string, vid: string, healed: boolean) => {
    analyzeLoudness(vid, url); // in background: misura per la normalizzazione volume
    return { url, videoId: vid, healed };
  };
  if (isBadStream(videoId)) {
    const h = await healStream(videoId, artist, title, 'stream già noto difettoso');
    return done(h.url, h.videoId, true);
  }
  try {
    return done(await streamUrl(videoId), videoId, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    markBadStream(videoId, artist, title);
    report('play', { message: msg, artist, title, videoId });
    const h = await healStream(videoId, artist, title, msg);
    return done(h.url, h.videoId, true);
  }
}

// Segnalato dal renderer quando un URL risolto muore in fase di play (403 ecc.)
export function noteStreamDead(videoId: string, artist?: string, title?: string): void {
  urlCache.delete(videoId);
  markBadStream(videoId, artist, title);
  report('stream-dead', { artist, title, videoId, message: 'URL risolto ma errore in riproduzione' });
}

// ---- Normalizzazione volume in anteprima ----
// NIENTE loudnorm cotto nel file: il download conserva il segnale com'è e la
// misura input_i (LUFS integrato) va nella tabella loudness + nei tag
// ReplayGain/R128 — il renderer applica il guadagno a runtime via
// <audio>.volume. La misura è persistente: una traccia si misura una volta sola.

const lufsMem = new Map<string, number>();
const lufsInflight = new Set<string>();

export function loudnessOf(videoId: string): number | null {
  const m = lufsMem.get(videoId);
  if (m !== undefined) return m;
  try {
    const r = getDb().prepare('SELECT lufs FROM loudness WHERE video_id=?').get(videoId) as { lufs: number } | undefined;
    if (r) { lufsMem.set(videoId, r.lufs); return r.lufs; }
  } catch { /* tabella non ancora pronta */ }
  return null;
}

function storeLoudness(videoId: string, lufs: number): void {
  lufsMem.set(videoId, lufs);
  try {
    getDb().prepare('INSERT OR REPLACE INTO loudness (video_id,lufs,ts) VALUES (?,?,?)')
      .run(videoId, lufs, Date.now());
  } catch { /* ignora */ }
}

// Misura input_i (LUFS integrato) di un file/URL via ffmpeg loudnorm in
// sola analisi. null se la misura non è utile (errore, silenzio, timeout).
function measureLufs(input: string, sampleS = 0): Promise<number | null> {
  return new Promise((resolve) => {
    const args = ['-nostats', '-i', input];
    // 60s di campione bastano per una stima decente dell'integrato (stream)
    if (sampleS > 0) args.push('-t', String(sampleS));
    args.push('-af', 'loudnorm=print_format=json', '-f', 'null', '-');
    const proc = spawn(ffmpegPath(), args, { windowsHide: true });
    let se = '';
    proc.stderr.on('data', (d) => { se += String(d); if (se.length > 200_000) se = se.slice(-100_000); });
    const kill = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 90_000);
    const done = () => {
      clearTimeout(kill);
      const m = /"input_i"\s*:\s*"(-?[\d.]+)"/.exec(se);
      const lufs = m ? parseFloat(m[1]) : NaN;
      resolve(Number.isFinite(lufs) && lufs > -70 ? lufs : null); // -inf/silenzio: non utile
    };
    proc.on('error', () => { clearTimeout(kill); resolve(null); });
    proc.on('close', done);
  });
}

function analyzeLoudness(videoId: string, url: string): void {
  if (lufsInflight.has(videoId) || loudnessOf(videoId) != null) return;
  lufsInflight.add(videoId);
  void measureLufs(url, 60)
    .then((lufs) => { if (lufs != null) storeLoudness(videoId, lufs); })
    .finally(() => lufsInflight.delete(videoId));
}
