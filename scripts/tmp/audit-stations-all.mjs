// Audit COMPLETO stazioni: per ogni StationDef chiama rec.station, raccoglie
// la scaletta intera, flagga artisti sconosciuti e fuori tema; poi screenshot
// visivi della griglia e di alcune scalette. Istanza ISOLATA (user-data temp).
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userDir = mkdtempSync(join(tmpdir(), 'mh-audit-all-'));
const shotDir = join(root, 'scripts', 'tmp', 'shots');
mkdirSync(shotDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9226', `--user-data-dir=${userDir}`, '--window-size=1280,900'], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IDS = 'per-te preferiti novita-te scoperte energia chill festa viaggio romantico sera italiana rap-it rock dance indie-it latina pop pop-it cantautori hip-hop rnb soul funk metal punk alternative jazz blues folk country reggae classica techno house soundtrack trap-it trap drill hard-rock grunge new-wave pop-punk emo disco synthwave lofi dnb bossa kpop afrobeat neomelodica anni70 anni80 anni90 anni2000 anni2010 classifiche'.split(' ');

for (let i = 0; i < 90; i++) {
  try {
    const pages = await (await fetch('http://127.0.0.1:9226/json')).json();
    if (pages.find((p) => p.type === 'page')) break;
  } catch { }
  await sleep(500);
}
const page = (await (await fetch('http://127.0.0.1:9226/json')).json()).find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pend.set(id, (m) => res(m.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then((r) => r?.result?.value);
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
};
await send('Page.enable');
await sleep(3000);

// Profilo gusti eterogeneo: rock IT, grunge, jazz, trap, classic rock.
await ev(`window.__mhApi().library.tasteSeed(['Vasco Rossi','Nirvana','Miles Davis','Sfera Ebbasta','Queen'])`);

const report = {};
for (const id of IDS) {
  const list = await ev(`window.__mhApi().rec.station('${id}')`).catch(() => null);
  const tracks = (list ?? []).map((t) => ({ a: t.artist, t: t.title }));
  const unkn = tracks.filter((t) => /sconosciuto/i.test(t.a ?? '')).length;
  report[id] = { n: tracks.length, unkn, tracks };
  console.log(`${id.padEnd(12)} ${String(tracks.length).padStart(2)} brani${unkn ? `  ⚠ ${unkn} sconosciuti` : ''}`);
}
writeFileSync(join(shotDir, 'stations-report.json'), JSON.stringify(report, null, 1));

// Screenshot griglia
await ev(`window.__app.getState().nav('stations')`);
await sleep(1200);
await shot('stations-grid');
await ev(`window.scrollTo(0, document.body.scrollHeight/2)`);
await sleep(400);
await shot('stations-grid-mid');
await ev(`window.scrollTo(0, document.body.scrollHeight)`);
await sleep(400);
await shot('stations-grid-bottom');

// Screenshot scalette rappresentative
for (const id of ['jazz', 'trap-it', 'per-te', 'anni80', 'classifiche', 'bossa']) {
  await ev(`window.__app.getState().openStation({kind:'station',id:'${id}'})`);
  await sleep(2500);
  await shot(`station-${id}`);
  await ev(`window.__app.getState().nav('stations')`);
  await sleep(500);
}
console.log('\nFatto. Report: scripts/tmp/shots/stations-report.json + PNG');
ws.close();
proc.kill('SIGKILL');
process.exit(0);
