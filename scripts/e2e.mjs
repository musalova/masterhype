// Smoke test E2E: avvia Electron con CDP, visita TUTTE le schermate,
// verifica che renderizzino contenuto e che la console sia pulita.
// Uso: node scripts/e2e.mjs   (richiede `npm run build` già fatto)

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // con questa env Electron gira come Node
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9223'], { env });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page;
    } catch { /* non ancora su */ }
    await sleep(500);
  }
  throw new Error('CDP non raggiungibile — Electron non è partito?');
}

const page = await waitCdp();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (d.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    errors.push('console.error: ' + JSON.stringify(d.params.args.map((a) => a.value ?? a.description ?? '')).slice(0, 200));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable', {});
await sleep(2500); // boot + splash + primo render

const SCREENS = [
  ['home', 'Home|BUON|pomeriggio|sera|notte'],
  ['stations', 'stazion'],
  ['search', 'Cerca'],
  ['library', 'Libreria|brani'],
  ['playlists', 'playlist|Playlist'],
  ['cd', 'CD Builder|Masterizza'],
  ['trends', 'Trend'],
  ['assistant', 'Assistente|vibe|tracklist'],
  ['downloads', 'Download|Scaricat'],
  ['settings', 'Impostazioni|Libreria'],
];

let fail = 0;
for (const [screen, re] of SCREENS) {
  await ev(`window.__app.getState().nav('${screen}')`);
  await sleep(1200);
  const body = await ev('document.body.innerText.slice(0, 4000)');
  const ok = new RegExp(re, 'i').test(body ?? '');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${screen}`);
  if (!ok) fail++;
}

// Verifica player: al boot non deve suonare da solo (coda ripristinata = pausa)
const playing = await ev('window.__app.getState().player.playing');
const audioPlaying = await ev('[...document.querySelectorAll("audio")].some(a => !a.paused)');
if (playing === false && audioPlaying === false) console.log('PASS  no-autoplay');
else { console.log(`FAIL  no-autoplay (store=${playing}, audio=${audioPlaying})`); fail++; }

if (errors.length) { console.log(`\n${errors.length} errori console:`); errors.slice(0, 8).forEach((e) => console.log('  ' + e)); fail++; }

console.log(fail === 0 ? '\nE2E: tutto verde' : `\nE2E: ${fail} problemi`);
ws.close();
proc.kill('SIGTERM');
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 800);
