// Test client remoto end-to-end: si attacca a un Chrome avviato con
// --remote-debugging-port=9223 sull'URL LAN del PC (nessun preload →
// window.masterhype assente → vera modalità remota, come su telefono).
//
// Uso:
//   1) electron out/main/index.js --remote-debugging-port=9222   (server PC)
//   2) chrome --remote-debugging-port=9223 --user-data-dir=%TEMP%\mh-chrome ^
//        "http://127.0.0.1:48484/?token=<token>"
//   3) node scripts/test-remote.mjs
import { readFileSync, writeFileSync } from 'fs';

const token = JSON.parse(readFileSync(process.env.APPDATA + '/Electron/settings.json', 'utf-8')).remoteToken;

// Trova la pagina servita dal PC tra i target Chrome
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('48484'));
if (!page) { console.error('FAIL: nessuna pagina :48484 tra i target Chrome'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
};
const send = (m, p) => new Promise((r) => {
  const i = ++id; pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); cond ? pass++ : fail++; };

await new Promise((r) => setTimeout(r, 4000)); // boot + hydrate prefs

check('nessun preload (masterhype assente)', (await ev(`!!window.masterhype`)) === false);
check('conf remota salvata da ?token=', !!(await ev(`localStorage.getItem('mh-remote-conf')`)));
check('app montata (no ConnectGate)', await ev(`!!window.__app && !!document.querySelector('main')`));

const st = await ev(`(async () => { const s = window.__app.getState(); await s.loadLibrary(); await s.loadRemoteLikes();
  const s2 = window.__app.getState();
  return { lib: s2.library.length, likes: Object.keys(s2.remoteLiked).length,
           thumb: s2.library.find(t => t.thumbnail)?.thumbnail || 'none' }; })()`);
check('libreria via HTTP', st && st.lib > 0, `(${st?.lib} brani)`);
check('like remoti via HTTP', st && st.likes >= 0, `(${st?.likes})`);
check('cover riscritte media://→http', st && st.thumb.startsWith('http'), `→ ${String(st?.thumb).slice(0, 60)}`);

// playStream via HTTP + heal
const stream = await ev(`(async () => {
  const t = window.__app.getState().library.find(t => t.videoId && !String(t.videoId).startsWith('audius:'));
  if (!t) return { skip: 'nessun videoId' };
  try { const r = await window.__app.getState().playStream
    ? null : null; } catch {}
  return { vid: t.videoId, title: t.title }; })()`);
// chiama l'API remota direttamente (streamUrl risolve via PC)
const su = await ev(`(async () => {
  const t = window.__app.getState().library.find(t => t.videoId && !String(t.videoId).startsWith('audius:'));
  if (!t) return null;
  const conf = JSON.parse(localStorage.getItem('mh-remote-conf'));
  const res = await fetch(conf.base + '/api/call', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MH-Token': conf.token },
    body: JSON.stringify({ c: 'yt:streamUrl', a: [t.videoId] }) });
  return (await res.json()).r; })()`);
check('stream risolto via HTTP', typeof su === 'string' && su.startsWith('http'), `→ ${String(su).slice(0, 50)}`);

// media audio endpoint con Range
const media = await ev(`(async () => {
  const t = window.__app.getState().library.find(t => t.filePath);
  if (!t) return null;
  const conf = JSON.parse(localStorage.getItem('mh-remote-conf'));
  const r = await fetch(conf.base + '/media/audio/' + t.id + '?token=' + conf.token,
    { headers: { Range: 'bytes=0-1023' } });
  return { status: r.status, len: (await r.arrayBuffer()).byteLength }; })()`);
check('audio endpoint Range 206', media && media.status === 206 && media.len === 1024, JSON.stringify(media || {}));

// preferenze condivise: scrittura da "telefono" → lettura lato server
const pref = await ev(`(async () => {
  const conf = JSON.parse(localStorage.getItem('mh-remote-conf'));
  await fetch(conf.base + '/api/prefs', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-MH-Token': conf.token },
    body: JSON.stringify({ k: 'mh-pref-e2e', v: 'dal-telefono' }) });
  const r = await fetch(conf.base + '/api/prefs', { headers: { 'X-MH-Token': conf.token } });
  return (await r.json())['mh-pref-e2e']; })()`);
check('pref condivisa round-trip', pref === 'dal-telefono');

// SSE events connessi?
check('EventSource aperto', await ev(`(async () => {
  const conf = JSON.parse(localStorage.getItem('mh-remote-conf'));
  const r = await fetch(conf.base + '/api/events?token=' + conf.token,
    { headers: { 'X-MH-Token': conf.token } }).catch(() => null);
  if (!r) return false; r.body.cancel(); return r.status === 200; })()`));

// Screenshot della UI remota
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) { writeFileSync('remote-ui.png', Buffer.from(shot.result.data, 'base64')); console.log('screenshot → remote-ui.png'); }

console.log(`\n${pass} pass, ${fail} fail`);
ws.close();
process.exit(fail ? 1 : 0);
