// Audit "modalità senza PC" (standalone): serve out/renderer in Chrome e
// verifica via CDP il flusso completo —
//   1) boot fresco SENZA conf e SENZA flag → gate con "Continua senza PC"
//   2) enterStandalone → app diretta (niente gate), isOnline=false, no banner
//   3) like in standalone → cuore visibile; reload → ancora visibile (coda)
//   4) resyncWhen() = 'quando colleghi un PC'
//   5) saveRemoteConf(user≠1) → migrazione chiavi :u1→:u5 + flag rimosso
// Uso: node scripts/audit-standalone.mjs   (richiede `npm run build` prima)
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { spawn } from 'child_process';

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
const BASE = `http://127.0.0.1:${PORT}`;

const prof = `${process.env.TEMP}\\mh-standalone-${Date.now()}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=9234`, `--user-data-dir=${prof}`, '--no-first-run',
  '--disable-web-security', '--disable-features=Translate', BASE,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fail++;
};

try {
  let pages;
  for (let i = 0; i < 20 && !pages; i++) {
    await sleep(500);
    try { pages = await (await fetch('http://127.0.0.1:9234/json')).json(); } catch {}
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
  const waitFor = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await sleep(200); }
    return false;
  };
  const goto = async (url, expr) => {
    await send('Page.navigate', { url });
    return waitFor(expr);
  };

  // ---- 1) Boot freschissimo: niente conf, niente flag → GATE ----
  await sleep(3500); // splash + render
  const gateTxt = await ev(`document.body.innerText`);
  check('boot fresco → gate di pairing', /Collega questo dispositivo|Codice di pairing/i.test(gateTxt ?? ''));
  check('gate offre "Continua senza PC"', (gateTxt ?? '').includes('Continua senza PC'));

  // ---- 2) Entra in standalone → app diretta ----
  await ev(`localStorage.setItem('mh-standalone','1'); localStorage.setItem('mh-standalone-era','1'); 'ok'`);
  check('reload standalone → app (no gate)', await goto(BASE, `!!window.__app`), 'window.__app pronto');
  await sleep(2500);
  const st1 = await ev(`JSON.stringify({
    stand: __mhRemote.isStandalone(), conf: __mhRemote.hasRemoteConf(),
    online: __mhRemote.isOnline(), uid: __mhRemote.myUserId(),
    gate: document.body.innerText.includes('Codice di pairing'),
    banner: document.body.innerText.includes('non raggiungibile'),
    rw: __mhRemote.resyncWhen(),
  })`);
  const j1 = JSON.parse(st1);
  check('isStandalone() true / hasRemoteConf() false', j1.stand === true && j1.conf === false);
  check('isOnline() false (PC assente per definizione)', j1.online === false);
  check('profilo virtuale u1', j1.uid === 1);
  check('NESSUN gate né banner offline in standalone', j1.gate === false && j1.banner === false);
  check('resyncWhen = "quando colleghi un PC"', j1.rw === 'quando colleghi un PC', j1.rw);

  // ---- 3) Like in standalone: visibile subito E dopo reload (coda merged) ----
  const like = await ev(`__app.getState().toggleLike({videoId:'stVid1', title:'Brano Standalone', artist:'Artista Test', thumbnail:'', duration: 200});
    new Promise(r => setTimeout(() => {
      __app.getState().loadRemoteLikes().then(() => r(JSON.stringify({
        liked: __app.getState().remoteLiked['stVid1'] === true,
        list: __app.getState().remoteLikeList.some(x => x.videoId === 'stVid1'),
      })));
    }, 700))`);
  const jl = JSON.parse(like);
  check('like standalone → cuore acceso', jl.liked === true);
  check('like standalone → nella lista "Brani che ti piacciono"', jl.list === true);

  check('reload → standalone persiste', await goto(BASE, `!!window.__app`));
  await sleep(1800);
  await ev(`__app.getState().loadRemoteLikes(); 'ok'`); await sleep(600);
  const st2 = await ev(`JSON.stringify({
    liked: __app.getState().remoteLiked['stVid1'] === true,
    list: __app.getState().remoteLikeList.some(x => x.videoId === 'stVid1'),
    stand: __mhRemote.isStandalone(),
    gate: document.body.innerText.includes('Codice di pairing'),
  })`);
  const j2 = JSON.parse(st2);
  check('dopo restart: ancora standalone, niente gate', j2.stand === true && j2.gate === false);
  check('dopo restart: il like è ancora acceso', j2.liked === true);
  check('dopo restart: il like è ancora nella lista', j2.list === true);

  // ---- 4) Pairing differito: saveRemoteConf(user=5) migra i dati :u1 ----
  // Il percorso reale è exitStandalone ("Collega un PC") → gate → pair: il flag
  // di sessione è già via, la migrazione deve reggersi sul marcatore era.
  await ev(`localStorage.setItem('mh-phone-index:u1','[{"videoId":"stVid1"}]');
           localStorage.removeItem('mh-standalone'); 'ok'`);
  const mig = await ev(`__mhRemote.saveRemoteConf('http://127.0.0.1:9','tok-dead',5);
    JSON.stringify({
      flag: localStorage.getItem('mh-standalone'),
      era: localStorage.getItem('mh-standalone-era'),
      conf: JSON.parse(localStorage.getItem('mh-remote-conf') || 'null'),
      idx1: localStorage.getItem('mh-phone-index:u1'),
      idx5: localStorage.getItem('mh-phone-index:u5'),
      lk1: localStorage.getItem('mh-pending-likes:u1'),
      lk5: localStorage.getItem('mh-pending-likes:u5'),
      wasOnline: localStorage.getItem('mh-was-online'),
    })`);
  const jm = JSON.parse(mig);
  check('pairing rimuove flag standalone + era', jm.flag === null && jm.era === null);
  check('conf salvata col profilo scelto', jm.conf?.user === 5);
  check('dati :u1 migrati su :u5 (indice telefono)', jm.idx1 === null && jm.idx5 != null);
  check('coda like :u1 migrata su :u5 (drain al primo connect)', jm.lk1 === null && (jm.lk5 ?? '').includes('stVid1'));
  check('primo connect = riconnessione (drain code)', jm.wasOnline === '0');

  // Il boot pairato a PC morto NON deve ripartire standalone né bloccarsi:
  // entra in app offline (banner "PC non raggiungibile" atteso qui, PC morto)
  check('reload pairato (PC morto) → app offline', await goto(BASE, `!!window.__app`));
  await sleep(3000);
  const st3 = await ev(`JSON.stringify({
    stand: __mhRemote.isStandalone(), conf: __mhRemote.hasRemoteConf(),
    uid: __mhRemote.myUserId(), gate: document.body.innerText.includes('Codice di pairing'),
    rw: __mhRemote.resyncWhen(),
  })`);
  const j3 = JSON.parse(st3);
  check('pairato: standalone false, conf presente', j3.stand === false && j3.conf === true);
  check('profilo migrato = 5', j3.uid === 5);
  check('niente gate col pairing salvato', j3.gate === false);
  check('resyncWhen torna "alla riconnessione"', j3.rw === 'alla riconnessione', j3.rw);

  console.log(`\n${fail === 0 ? 'TUTTI PASS' : fail + ' CHECK FALLITI'}`);
} finally {
  chrome.kill();
  srv.close();
}
process.exit(fail === 0 ? 0 : 1);
