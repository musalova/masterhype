// Audit CDP: coda ripristinata IN PAUSA con sorgenti morte — non deve
// auto-riprodurre né saltare la coda a raffica di toast (bug "ghost play").
// Profilo isolato, yt:playStream stubbato via wrap di ipcMain.handle:
//  - tracce con id+filePath finti → media:// risponde 404 (percorso onErr)
//  - tracce con solo videoId      → playStream rifiuta (percorso .catch di srcOf)
//  - videoId 'ok-vid'             → file:// wav vero (percorso sano)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'mh-ghostplay-'));
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  libraryDir: join(profile, 'music'), remoteEnabled: false,
  autostart: false, autoUpdateTools: false, autoUpdateApp: false,
}));
// WAV minimo valido: PCM16 mono 8kHz, 0.3s di silenzio
const wavPath = join(profile, 'ok.wav');
{
  const rate = 8000, n = Math.floor(rate * 0.3);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  writeFileSync(wavPath, b);
}
const okUrl = pathToFileURL(wavPath).toString();
const entry = join(profile, 'ghost-main.cjs');
writeFileSync(entry, `
const { app, ipcMain } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (channel === 'yt:playStream') {
    if (args[1] === 'ok-vid') return { url: ${JSON.stringify(okUrl)}, videoId: 'ok-vid', healed: false };
    throw new Error('stub: stream non disponibile');
  }
  return handler(...args);
});
require(${JSON.stringify(join(root, 'out', 'main', 'index.js'))});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  [entry, '--remote-debugging-port=9238', `--user-data-dir=${profile}`], { env, stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws, seq = 0, failures = 0;
const pending = new Map();
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, m => { clearTimeout(timeout); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expression, timeout = 12000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await ev(expression)) return true; await sleep(120); }
  return false;
};
const seedQueue = (queue, index = 0) => ev(
  `localStorage.setItem('mh-pref-queue', ${JSON.stringify(JSON.stringify({ queue, index, radio: false }))})`
);
const armToastCount = () => ev(`(() => { window.__errToasts = [];
  const seen = new Set();
  window.__app.subscribe(s => { for (const t of s.toasts) if (t.kind === 'err' && !seen.has(t.id)) { seen.add(t.id); window.__errToasts.push(t.text); } });
  return true; })()`);
const errToasts = () => ev(`(window.__errToasts || []).join(' | ')`);
const audioState = `(() => { const s = window.__app.getState();
  return JSON.stringify({ playing: s.player.playing, idx: s.player.queueIndex,
    vid: s.player.current?.videoId, paused: [...document.querySelectorAll('audio')].map(a => a.paused) }); })()`;

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:9238/json')).json()).find(p => p.type === 'page'); } catch {}
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('Electron non raggiungibile');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await send('Page.enable');
  await waitFor(`!!window.__app`);

  // ---- Fase A: boot con coda in pausa, primo brano file morto (percorso onErr) ----
  await seedQueue([
    { videoId: 'dead-file-1', id: 999001, filePath: 'C:\\nonexistent\\a.mp3', artist: 'A1', title: 'T1' },
    { videoId: 'dead-stream-2', artist: 'A2', title: 'T2' },
    { videoId: 'dead-file-3', id: 999003, filePath: 'C:\\nonexistent\\c.mp3', artist: 'A3', title: 'T3' },
  ]);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`!!window.__app && window.__app.getState().player.current?.videoId === 'dead-file-1'`);
  await armToastCount();
  await sleep(5000);
  let st = JSON.parse(await ev(audioState));
  check('A: restored queue stays paused', st.playing === false);
  check('A: queue does not auto-advance', st.idx === 0 && st.vid === 'dead-file-1', `idx=${st.idx} vid=${st.vid}`);
  check('A: audio elements all paused', st.paused.every(Boolean));
  check('A: at most one error toast', await ev(`window.__errToasts.length <= 1`), await errToasts());

  // ---- Fase B: Play esplicito su brano morto → retry + cascata col freno ----
  await ev(`window.__app.getState().toggle()`);
  check('B: explicit play turns playing on', await waitFor(`window.__app.getState().player.playing === true`, 3000));
  // cascata: T1(404) → T2(playStream rifiuta) → T3(404) → freno al 3° errore → pausa
  check('B: cascade advances with user intent then brake stops it',
    await waitFor(`window.__app.getState().player.current?.videoId === 'dead-file-3' && !window.__app.getState().player.playing`, 15000));
  st = JSON.parse(await ev(audioState));
  check('B: ended paused on last track', st.playing === false && st.idx === 2 && st.vid === 'dead-file-3', `idx=${st.idx} vid=${st.vid}`);
  check('B: brake toast shown', await ev(`window.__errToasts.some(t => t.includes('Riproduzione in pausa'))`), await errToasts());

  // ---- Fase E: pausa nella finestra dello skip armato → niente next; Play riprende ----
  await seedQueue([
    { videoId: 'dead-file-1', id: 999001, filePath: 'C:\\nonexistent\\a.mp3', artist: 'A1', title: 'T1' },
    { videoId: 'dead-stream-2', artist: 'A2', title: 'T2' },
    { videoId: 'dead-file-3', id: 999003, filePath: 'C:\\nonexistent\\c.mp3', artist: 'A3', title: 'T3' },
  ]);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`!!window.__app && window.__app.getState().player.current?.videoId === 'dead-file-1'`);
  await armToastCount();
  await sleep(4000); // primo fallimento da pausato: marcato
  await ev(`window.__app.getState().toggle()`); // Play → retry → errore → skip armato a 800ms
  await sleep(300);
  await ev(`window.__app.getState().toggle()`); // pausa dentro la finestra: lo skip deve annullarsi
  await sleep(1500);
  st = JSON.parse(await ev(audioState));
  check('E: pause inside skip window cancels the advance', st.playing === false && st.idx === 0 && st.vid === 'dead-file-1', `idx=${st.idx} vid=${st.vid}`);
  await ev(`window.__app.getState().toggle()`); // Play esplicito: il retry riprende la cascata col freno
  check('E: play after cancelled skip resumes cascade and brakes',
    await waitFor(`!window.__app.getState().player.playing && window.__app.getState().player.queueIndex >= 1`, 15000),
    await errToasts());

  // ---- Fase C: coda sana in pausa → niente autoplay; Play suona davvero ----
  await seedQueue([{ videoId: 'ok-vid', artist: 'OK', title: 'OkTrack' }]);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`!!window.__app && window.__app.getState().player.current?.videoId === 'ok-vid'`);
  await armToastCount();
  await sleep(3500);
  st = JSON.parse(await ev(audioState));
  check('C: healthy restored queue does not autoplay', st.playing === false && st.paused.every(Boolean));
  await ev(`window.__app.getState().toggle()`);
  const played = await waitFor(`[...document.querySelectorAll('audio')].some(a => !a.paused)`, 5000);
  if (!played) console.log('  diag:', await ev(`JSON.stringify([...document.querySelectorAll('audio')].map(a => ({ src: a.src.slice(0, 60), err: a.error?.code, net: a.networkState, rs: a.readyState, paused: a.paused, vid: a.dataset.vid })))`));
  check('C: explicit play actually plays', played);

  // ---- Fase D: boot in pausa, sorgente che rifiuta in srcOf (percorso .catch) ----
  await seedQueue([
    { videoId: 'dead-stream-1', artist: 'D1', title: 'D1' },
    { videoId: 'dead-stream-2', artist: 'D2', title: 'D2' },
  ]);
  await send('Page.reload', { ignoreCache: true });
  await waitFor(`!!window.__app && window.__app.getState().player.current?.videoId === 'dead-stream-1'`);
  await armToastCount();
  await sleep(4000);
  st = JSON.parse(await ev(audioState));
  check('D: srcOf rejection while paused keeps queue put', st.playing === false && st.idx === 0 && st.vid === 'dead-stream-1', `idx=${st.idx} vid=${st.vid}`);
  check('D: at most one error toast', await ev(`window.__errToasts.length <= 1`), await errToasts());
  // Play esplicito sul brano morto in .catch: retry → cascata → freno
  await ev(`window.__app.getState().toggle()`);
  check('D: play on failed track retries then brakes',
    await waitFor(`!window.__app.getState().player.playing`, 15000)
    && await ev(`window.__app.getState().player.queueIndex === 1 || window.__errToasts.some(t => t.includes('Riproduzione in pausa'))`), await errToasts());
} finally { ws?.close(); proc.kill(); }
process.exitCode = failures ? 1 : 0;
