import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { spawn } from 'child_process';
const ROOT = 'out/renderer';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const srv = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  try { const p = join(ROOT, u === '/' ? 'index.html' : u); const b = await readFile(p); res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(join(ROOT, 'index.html'))); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--remote-debugging-port=9236', `--user-data-dir=${process.env.TEMP}\\mh-dbg-${Date.now()}`, '--no-first-run', '--disable-web-security', BASE], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pages;
for (let i = 0; i < 30 && !pages?.length; i++) { await sleep(500); try { pages = (await (await fetch('http://127.0.0.1:9236/json')).json()).filter((p) => p.type === 'page' && p.url.startsWith(BASE)); } catch {} }
const ws = new WebSocket(pages[0].webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.type + ' ' + d.params.args.map((a) => a.value ?? a.description).join(' ')); if (d.method === 'Runtime.exceptionThrown') logs.push('EXC ' + d.params.exceptionDetails.exception?.description); };
const send = (mth, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mth, params: p })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description; };
await send('Runtime.enable', {}); await send('Page.enable', {});
const reload = async () => { await send('Page.navigate', { url: BASE }); for (let t = 0; t < 15000; t += 200) { if (await ev('!!window.__app')) break; await sleep(200); } await sleep(1500); };
await sleep(2500);
await ev(`localStorage.setItem('mh-standalone','1'); localStorage.setItem('mh-standalone-era','1')`);
await reload();
console.log(await ev(`(async () => { const api = window.__mhApi(); const p = await api.playlists.create('DBG drain', 'lista'); return p.id; })()`));
await ev(`__mhRemote.saveRemoteConf('http://127.0.0.1:48499', 'TESTUPD1', 1)`);
await reload();
for (let i = 0; i < 6; i++) {
  console.log(i, await ev(`JSON.stringify({ on: __mhRemote.isOnline(), q: localStorage.getItem('mh-pending-pl:u1'), map: localStorage.getItem('mh-pl-idmap:u1'), toasts: __app.getState().toasts.map(t => t.text) })`));
  await sleep(2000);
}
console.log('create diretto:', await ev(`window.__mhApi().playlists.create('DBG diretto','lista').then(p => JSON.stringify(p)).catch(e => 'ERR ' + e.message)`));
console.log(logs.slice(-20).join('\n'));
chrome.kill(); srv.close(); process.exit(0);
