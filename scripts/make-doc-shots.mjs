// Rigenera gli screenshot docs/screenshots/ con la UI corrente:
//  - phone-pairing.png: ConnectGate reale via Chrome headless sul server remoto
//    dell'istanza isolata (stessa UI del client telefono)
//  - phone-home.png / phone-stations.png: finestra Electron a viewport mobile
// Profilo REALE clonato (dati veri) + remotePort patchata a 48485 (48484 è
// dell'istanza installata). L'istanza muore con lo script.
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const outDir = join(root, 'docs', 'screenshots');
const PORT = 48485;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const udd = mkdtempSync(join(tmpdir(), 'mh-shots-'));
cpSync(join(process.env.APPDATA, 'MasterHype'), udd, { recursive: true });
const sPath = join(udd, 'settings.json');
const s = JSON.parse(readFileSync(sPath, 'utf8'));
s.remotePort = PORT;
s.remoteEnabled = true;
writeFileSync(sPath, JSON.stringify(s, null, 2));
const token = s.remoteToken;
if (!token) throw new Error('remoteToken assente nel profilo clonato');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9223', `--user-data-dir=${udd}`], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// attende server remoto: basta UNA risposta HTTP qualsiasi (401 = su, ECONNREFUSED = giù)
let remoteUp = false;
for (let i = 0; i < 90 && !remoteUp; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/api/info`); remoteUp = true; } catch {}
  await sleep(500);
}
if (!remoteUp) throw new Error('server remoto isolato mai su');

// 1) ConnectGate via Chrome headless (client remoto senza token)
const r = spawnSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=390,844', '--virtual-time-budget=12000',
  `--screenshot=${join(outDir, 'phone-pairing.png')}`,
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'pipe' });
console.log('phone-pairing:', r.status === 0 ? 'ok' : 'FALLITO ' + r.stderr?.toString().slice(0, 200));

// 2-3) app autenticata nella finestra Electron a viewport mobile
let page = null;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch('http://127.0.0.1:9223/json')).json()).find((p) => p.type === 'page'); } catch {}
  if (!page) await sleep(500);
}
if (!page) throw new Error('CDP mai su');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(1500);
const shot = async (name) => {
  const d = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, name), Buffer.from(d.result.data, 'base64'));
  console.log(name, 'salvato');
};
// chiudi la card "Novità" (mostra la versione del binario dev, non quella app)
await ev(`[...document.querySelectorAll('button')].find(b => /Perfetto/i.test(b.textContent))?.click()`);
await sleep(500);
for (const [nav, file] of [['home', 'phone-home.png'], ['stations', 'phone-stations.png']]) {
  await ev(`window.__app?.getState().nav('${nav}')`);
  await sleep(1600);
  await shot(file);
}
ws.close();
proc.kill('SIGTERM');
console.log('fatto');
setTimeout(() => process.exit(0), 500);
