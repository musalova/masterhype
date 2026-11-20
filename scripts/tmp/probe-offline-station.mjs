// Probe: perché la stazione offline non si popola in Chrome.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(root, 'out', 'renderer');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(b);
  } catch { const b = await readFile(join(ROOT, 'index.html')); res.writeHead(200, { 'content-type': 'text/html' }); res.end(b); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const prof = `${process.env.TEMP}\\mh-probe-${Date.now()}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9238', `--user-data-dir=${prof}`, '--no-first-run',
  '--disable-web-security', '--disable-features=Translate', BASE], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let page;
  for (let i = 0; i < 30 && !page; i++) {
    await sleep(500);
    try { const ps = await (await fetch('http://127.0.0.1:9238/json')).json(); page = ps.find((p) => p.type === 'page' && p.url.includes(String(PORT))); } catch { }
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const logs = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args?.map(a => a.value ?? a.description ?? '').join(' '));
    else if (d.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text));
  };
  const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  await send('Runtime.enable', {}); await send('Page.enable', {});
  await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://127.0.0.1:9', token:'dead', user:1}));
           localStorage.setItem('mh-was-online','0');
           localStorage.setItem('mh-lib-cache:u1', JSON.stringify([
             {id:1,videoId:'jaz1',title:'So What',artist:'Miles Davis',duration:545,genre:'jazz',thumbnail:''},
             {id:2,videoId:'jaz2',title:'Waltz for Debby',artist:'Bill Evans',duration:480,genre:'jazz',thumbnail:''},
             {id:3,videoId:'pop1',title:'Albachiara',artist:'Vasco Rossi',duration:240,genre:'pop',thumbnail:''},
             {id:4,videoId:'trp1',title:'Cupido',artist:'Sfera Ebbasta',duration:180,genre:'trap',thumbnail:''}
           ]));
           localStorage.setItem('mh-taste-cache:u1:artist', JSON.stringify([
             {kind:'artist',value:'miles davis',weight:9},{kind:'artist',value:'vasco rossi',weight:11},
             {kind:'artist',value:'sfera ebbasta',weight:10},{kind:'artist',value:'nirvana',weight:8},
             {kind:'artist',value:'queen',weight:7}
           ]));
           localStorage.setItem('mh-taste-cache:u1:genre', JSON.stringify([
             {kind:'genre',value:'jazz',weight:6},{kind:'genre',value:'trap',weight:5},{kind:'genre',value:'pop',weight:4}
           ]));
           'ok'`);
  await send('Page.navigate', { url: BASE });
  for (let i = 0; i < 60; i++) { if (await ev(`!!window.__app`).catch(() => false)) break; await sleep(500); }
  await sleep(4000);
  console.log('online:', await ev(`__mhRemote.isOnline()`));
  console.log('stationSel pre:', await ev(`JSON.stringify(__app.getState().stationSel)`));
  await ev(`window.__app.getState().openStation({kind:'station',id:'jazz'}); 'opened'`);
  for (let t = 0; t < 150; t += 5) {
    await sleep(5000);
    const s = await ev(`JSON.stringify({
      sel: __app.getState().stationSel,
      h1: document.querySelector('h1')?.textContent,
      rows: document.querySelectorAll('main button[aria-label^="Riproduci"]').length,
      load: document.body.innerText.includes('Sintonizzo') || document.body.innerText.includes('Rinnovo'),
      empty: document.body.innerText.includes('Nessun brano') || document.body.innerText.includes('non disponibile'),
    })`);
    console.log(`t=${t + 5}s`, s);
    const j = JSON.parse(s);
    if (j.rows > 0 || j.empty) break;
  }
  console.log('\n--- console/errors ---');
  logs.slice(-20).forEach((l) => console.log(l.slice(0, 200)));
  ws.close();
} finally { chrome.kill(); srv.close(); }
process.exit(0);
