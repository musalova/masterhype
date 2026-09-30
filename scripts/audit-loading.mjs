import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'mh-loading-'));
const output = process.env.MH_AUDIT_OUT || join(root, 'release', 'visual-audit');
mkdirSync(output, { recursive: true });
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ libraryDir: join(profile, 'music'), remoteEnabled: false, autostart: false, autoUpdateTools: false, autoUpdateApp: false }));
const entry = join(profile, 'loading-main.cjs');
writeFileSync(entry, `
const { app, ipcMain } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  const ms = { 'remote:prefs:get': 3000, 'lib:list': 2400, 'yt:search': 9500, 'rec:station': 2200 }[channel];
  if (ms) await new Promise(r => setTimeout(r, ms));
  if (channel === 'yt:search') return { songs: [{ videoId: 'loading-test', artist: 'Test', title: 'Risposta tardiva di prova', source: 'ytmusic' }], artists: [], albums: [], playlists: [] };
  if (channel === 'rec:station') return [];
  return handler(...args);
});
require(${JSON.stringify(join(root, 'out', 'main', 'index.js'))});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [entry, '--remote-debugging-port=9237', `--user-data-dir=${profile}`], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws, seq = 0, failures = 0;
const pending = new Map();
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, message => { clearTimeout(timeout); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};
const waitFor = async (expression, timeout = 12000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await ev(expression)) return true; await sleep(100); }
  return false;
};
const screenshot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(r.data, 'base64'));
};
const input = async value => {
  await ev(`(() => { const input = document.querySelector('main form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
};

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch('http://127.0.0.1:9237/json')).json()).find(p => p.type === 'page'); } catch {}
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('Electron non raggiungibile');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await send('Page.enable');
  await sleep(1100);
  check('slow boot keeps splash visible beyond 900ms', await ev(`!!document.getElementById('splash') && !document.getElementById('splash').classList.contains('out')`));
  check('boot announces its actual stage', await ev(`document.getElementById('boot-status')?.textContent.includes('preferenze')`));
  await screenshot('loading-boot-desktop');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot('loading-boot-phone');
  check('splash leaves after React mounts', await waitFor(`!!document.querySelector('main') && !document.getElementById('splash')`));
  await ev(`window.__app.getState().nav('library'); [...document.querySelectorAll('.system-cards button')].find(el => el.textContent.trim() === 'Perfetto')?.click()`);
  check('library shows a labelled loading state', await waitFor(`!!document.querySelector('main [data-loading]')`, 1500));
  await screenshot('loading-library-phone');
  check('library loading resolves', await waitFor(`!document.querySelector('main [data-loading]')`));
  await ev(`window.__app.getState().nav('search')`);
  await waitFor(`!!document.querySelector('main form input')`);
  await input('U2');
  check('search shows query-specific feedback', await waitFor(`document.querySelector('.loading-detail')?.textContent === 'U2'`));
  await screenshot('loading-search-phone');
  check('long waits get a clear explanation', await waitFor(`!!document.querySelector('.loading-patience')`, 9000));
  await screenshot('loading-search-slow-phone');
  await ev(`document.querySelector('.loading-cancel').click()`);
  check('cancel immediately restores navigation', await waitFor(`!document.querySelector('main [data-loading]')`, 500));
  await sleep(1800);
  check('cancelled result does not reappear', await ev(`!document.querySelector('main').textContent.includes('Risposta tardiva di prova')`));
  await input('Anyma');
  await waitFor(`document.querySelector('.loading-detail')?.textContent === 'Anyma'`);
  await ev(`document.querySelector('[aria-label="Cancella ricerca"]').click()`);
  check('clearing search also clears the loading state', await waitFor(`!document.querySelector('main [data-loading]')`, 500));
  await sleep(9700);
  check('cleared query cannot restore stale results', await ev(`!document.querySelector('main').textContent.includes('Risposta tardiva di prova')`));
  await ev(`window.__app.getState().openStation({ kind: 'station', id: 'per-te' })`);
  check('station announces preparation', await waitFor(`document.querySelector('.loading-label')?.textContent.includes('stazione')`));
  await screenshot('loading-station-phone');
  check('completed empty station is not an endless loader', await waitFor(`document.querySelector('main').textContent.includes('Nessun brano ora')`));
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: ['*App-*.js'] });
  await send('Page.reload', { ignoreCache: true });
  check('failed UI chunk keeps a recoverable splash', await waitFor(`document.getElementById('splash')?.dataset.state === 'error'`));
  check('recovery link is visible without app code', await ev(`getComputedStyle(document.querySelector('.boot-help')).visibility === 'visible'`));
  await screenshot('loading-boot-error-phone');
  await send('Network.setBlockedURLs', { urls: [] });
  await ev(`document.querySelector('.boot-retry').click()`);
  check('recovery link restarts successfully', await waitFor(`!!document.querySelector('main') && !document.getElementById('splash')`));
  check('no autoplay introduced', await ev(`!window.__app.getState().player.playing && [...document.querySelectorAll('audio')].every(a => a.paused)`));
  console.log(`Screenshots: ${output}`);
} finally { ws?.close(); proc.kill(); }
process.exitCode = failures ? 1 : 0;
