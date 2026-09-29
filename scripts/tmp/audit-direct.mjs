// Test modalità autonoma: renderer servito staticamente + conf su porta morta
// → il client deve cadere in fallback diretto (YouTube dal telefono).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = 'out/renderer';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const srv = createServer(async (req, res) => {
  const p = join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try {
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => srv.listen(8899, r));

const CHROME = process.env.CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const chrome = spawn(CHROME, [
  '--remote-debugging-port=9223', `--user-data-dir=${process.env.TEMP ?? 'C:\\Temp'}\\mh-chrome-test`, '--no-first-run',
  '--disable-web-security', // simula il percorso nativo: il test verifica la LOGICA Innertube, non CORS
  '--autoplay-policy=no-user-gesture-required', 'http://127.0.0.1:8899/',
], { shell: false, detached: true, stdio: 'ignore' });
chrome.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page, ws, id = 0;
const pend = new Map();
const logs = [];
for (let i = 0; i < 30 && !page; i++) {
  await sleep(500);
  try {
    const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
    page = pages.find((p) => p.type === 'page' && p.url.includes('127.0.0.1:8899'));
  } catch { /* chrome non ancora su */ }
}
if (!page) { console.log('FAIL: pagina non trovata'); process.exit(1); }
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    logs.push(JSON.stringify(d.params.args.map((a) => a.value ?? a.description ?? '').slice(0, 3)));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  const v = r.result?.result;
  if (v && v.value !== undefined) return v.value;
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return JSON.stringify(r.result).slice(0, 400);
};
await send('Runtime.enable', {});

// Conf su porta morta: tutte le call remote falliscono → offline → diretto
await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://127.0.0.1:9', token:'dead'}))`);
await send('Page.enable', {});
await send('Page.reload', {});
await sleep(4000);

console.log('== stato ==');
console.log(await ev(`JSON.stringify({app: !!window.__app, api: !!window.__mhApi, conf: localStorage.getItem('mh-remote-conf')})`));
await sleep(3000); // SSE/call falliscono → online=false

console.log('== online flag ==');
console.log(await ev(`window.__app ? __app.getState().library.length : 'no store'`));

console.log('== directSearch ==');
const s = await ev(`__mhApi().yt.search('vasco rossi', false).then(r => ({songs: r.songs.length, first: r.songs[0]?.title, artist: r.songs[0]?.artist, vid: r.songs[0]?.videoId})).catch(e => 'ERR '+e.message)`);
console.log(s);

if (typeof s === 'object' || (typeof s === 'string' && s.includes('songs'))) {
  const vid = typeof s === 'object' ? s.vid : JSON.parse(s).vid;
  console.log('== directPlayStream ==');
  console.log(await ev(`__mhApi().yt.playStream('${vid}').then(r => r.url.slice(0,90)).catch(e => 'ERR '+e.message)`));
  console.log('== directUpNext ==');
  console.log(await ev(`__mhApi().yt.upNext('${vid}').then(r => r.length + ' -> ' + (r[0]?.title ?? '')).catch(e => 'ERR '+e.message)`));
  console.log('== directSuggestions ==');
  console.log(await ev(`__mhApi().yt.suggestions('vasco').catch(e => 'ERR '+e.message)`));
}
console.log('== directLyrics ==');
console.log(await ev(`__mhApi().yt.lyrics('Queen','Bohemian Rhapsody',354).then(r => ({found: r.found, synced: r.synced?.length, plain: r.plain?.slice(0,40)})).catch(e => 'ERR '+e.message)`));
console.log('== console errors ==');
console.log(logs.slice(0, 8).join('\n') || '(nessuno)');
ws.close(); srv.close();
process.exit(0);
