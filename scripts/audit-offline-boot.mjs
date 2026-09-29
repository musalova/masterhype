// Test boot con PC morto: serve out/renderer, Chrome con conf su porta morta.
// Verifica: app pronta in fretta, banner offline, call() fail-fast, ytCall diretto.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { spawn, execSync } from 'child_process';

const ROOT = 'out/renderer';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(b);
  } catch {
    const b = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(b);
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

const prof = `${process.env.TEMP}\\mh-offline-boot-${Date.now()}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=9233`, `--user-data-dir=${prof}`, '--no-first-run',
  '--disable-web-security', '--disable-features=Translate', `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let pages;
  for (let i = 0; i < 20 && !pages; i++) {
    await sleep(500);
    try { pages = await (await fetch('http://127.0.0.1:9233/json')).json(); } catch {}
  }
  const page = pages?.find((p) => p.type === 'page' && p.url.includes(String(PORT)));
  if (!page) { console.log('FAIL: chrome page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (mth, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mth, params: p })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    const v = r.result?.result;
    if (v && v.value !== undefined) return v.value;
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return JSON.stringify(r.result).slice(0, 400);
  };
  await send('Runtime.enable', {}); await send('Page.enable', {});

  // Conf morta + cache libreria finta, poi reload con timing
  await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://127.0.0.1:9', token:'dead'}));
           localStorage.setItem('mh-lib-cache', JSON.stringify([{id:1,videoId:'abc',title:'Test Brano',artist:'Test',duration:200,thumbnail:''}]));
           localStorage.setItem('mh-was-online','0'); 'ok'`);
  const t0 = Date.now();
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  // poll finché __app pronto
  let ready = null, ms = 0;
  for (; ms < 15000; ms += 200) {
    if (await ev(`!!window.__app`).catch(() => false)) { ready = Date.now() - t0; break; }
    await sleep(200);
  }
  console.log('boot ready:', ready != null ? ready + 'ms' : 'TIMEOUT');
  await sleep(2500); // probe fallisce (5s timeout... base :9 rifiuta subito)
  console.log(await ev(`JSON.stringify({
    banner: document.body.innerText.includes('non raggiungibile') || document.body.innerText.includes('Nessuna rete'),
    lib: __app.getState().library.length,
    online: (await0=>0, 0)
  })`));
  // call() deve fail-fast 'offline', non appendersi
  const t1 = Date.now();
  const cf = await ev(`__mhApi().settings.get().then(()=> 'OK?!').catch(e=>e.message)`);
  console.log('call() offline →', cf, `(${Date.now() - t1}ms)`);
  // ytCall: playStream deve andare diretto (ricerca youtube live — richiede rete)
  const t2 = Date.now();
  const st = await ev(`__mhApi().yt.playStream('dQw4w9WgXcQ','Rick Astley','Never Gonna Give You Up').then(r=>({ok:!!r.url, host:new URL(r.url).host.slice(0,30)})).catch(e=>'ERR '+e.message)`);
  console.log('playStream diretto →', JSON.stringify(st), `(${Date.now() - t2}ms)`);
  const sr = await ev(`__mhApi().yt.search('vasco rossi', false).then(r=>({n:r.songs.length, t:r.songs[0]?.title})).catch(e=>'ERR '+e.message)`);
  console.log('search diretta →', JSON.stringify(sr));
  // Selftest in-app (stesso codice che gira nell'APK): in browser i test
  // YouTube diretti falliranno per CORS — atteso e informativo.
  console.log('\nselftest:');
  const rows = await ev(`window.__selftest ? __selftest().then(r=>r.rows.map(x=>({n:x.name,ok:x.ok,ms:x.ms,d:String(x.detail).slice(0,90)}))) : 'NO __selftest'`);
  if (Array.isArray(rows)) for (const r of rows) console.log(`  ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'INFO'}  ${r.n} (${r.ms}ms) — ${r.d}`);
  else console.log('  ', rows);
} finally {
  chrome.kill();
  try { execSync(`taskkill /F /IM chrome.exe /FI "WINDOWTITLE eq *9233*" 2>nul`); } catch {}
  srv.close();
}
