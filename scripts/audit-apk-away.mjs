// Audit "fuori casa": l'APK deve funzionare sulla connessione del telefono
// senza il PC di casa. Scenario reale:
//   A) PC irraggiungibile + internet OK (4G): boot, banner, ricerca diretta,
//      riproduzione via store, download SUL TELEFONO di un brano cercato.
//   B) Rete tagliata (wifi+data off): il brano scaricato sul telefono suona
//      dal blob IndexedDB — ascolto offline vero.
// Ripristina conf e rete in finally.
// Uso: ADB=<path> node scripts/audit-apk-away.mjs
import { execSync } from 'child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, ignoreErr = false) => {
  try { return execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (ignoreErr) return ''; throw e; }
};
const ADB = process.env.ADB ?? 'adb';
const devs = sh(`${ADB} devices`).split('\n').slice(1).map((l) => l.split('\t'))
  .filter(([id, st]) => id && st === 'device');
if (!devs.length) { console.log('FAIL: nessun device'); process.exit(1); }
const A = `${ADB} -s ${devs[0][0]}`;

sh(`${A} shell monkey -p com.masterhype.app -c android.intent.category.LAUNCHER 1`, true);
await sleep(2500);
let pid = '';
for (let i = 0; i < 15 && !pid; i++) { pid = sh(`${A} shell pidof com.masterhype.app`, true); if (!pid) await sleep(1000); }
if (!pid) { console.log('FAIL: app non parte'); process.exit(1); }
sh(`${A} forward tcp:9229 localabstract:webview_devtools_remote_${pid}`, true);

const pages = await (await fetch('http://127.0.0.1:9229/json')).json().catch(() => null);
const page = pages?.find((p) => p.type === 'page' && (p.url.includes('localhost') || p.url.includes('capacitor')));
if (!page) { console.log('FAIL: WebView non debuggabile'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (mth, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mth, params: p })); });
const ev = async (e, timeout = 60_000) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout });
  const v = r.result?.result;
  if (v && v.value !== undefined) return v.value;
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return JSON.stringify(r.result).slice(0, 400);
};
const waitFor = async (e, tries = 40) => {
  for (let i = 0; i < tries; i++) { const v = await ev(e).catch(() => null); if (v) return v; await sleep(1000); }
  return null;
};
await send('Runtime.enable', {}); await send('Page.enable', {});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(` ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); cond ? pass++ : fail++; };

const confBackup = await ev(`localStorage.getItem('mh-remote-conf')`);
let netOff = false;

try {
  // ===== A) PC morto, rete OK (come il 4G fuori casa) =====
  console.log('== A) PC morto + rete telefono (4G fuori casa) ==');
  await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://192.0.2.1:48484',token:'dead',alts:['http://192.0.2.2:48484','http://192.0.2.3:48484']}))`);
  const t0 = Date.now();
  await send('Page.navigate', { url: page.url });
  const ready = await waitFor(`!!window.__app`, 30);
  check('app pronta con PC morto', !!ready, `${Date.now() - t0}ms dal reload`);

  // attesa probe (5s×addr) → stato offline certo
  const offAt = await waitFor(`document.body.innerText.includes('non raggiungibile') || document.body.innerText.includes('Nessuna rete') || window.__app?.getState?.().online === false`, 25);
  check('stato offline rilevato', !!offAt, `${Date.now() - t0}ms dal reload`);
  console.log('  online:', await ev(`window.__app?.getState?.().online`));

  // ricerca diretta di un artista (senza PC)
  const srch = await ev(`__mhApi().yt.search('radiohead', false).then(r=>({n:r.songs.length,v:r.songs[0]?.videoId,t:r.songs[0]?.title})).catch(e=>'ERR '+e.message)`, 30_000);
  check('ricerca artista diretta', typeof srch === 'object' && srch.n > 0, JSON.stringify(srch));

  // play via store: la catena srcOf → playStream → direct deve risolvere
  if (srch?.v) {
    const p = await ev(`(async()=>{ const s=window.__app.getState(); const r=await __mhApi().yt.search('radiohead',false); const t=r.songs[0]; s.play(t,[t],0,false); await new Promise(r=>setTimeout(r,6000)); const st=window.__app.getState().player; const a=[...document.querySelectorAll('audio')].find(x=>x.src); return {playing:st.playing, vid:st.current?.videoId, src:(a?.src||'').slice(0,40), ct:a?.currentTime}; })().catch(e=>'ERR '+e.message)`, 30_000);
    check('brano cercato in riproduzione', typeof p === 'object' && p.playing === true && p.ct > 0.5, JSON.stringify(p));
  }

  // download sul telefono col PC morto → stream diretto → IndexedDB
  if (srch?.v) {
    const dl = await ev(`(async()=>{ const r=await __mhApi().yt.search('radiohead',false); const t=r.songs[0]; await window.__app.getState().downloadToPhone(t); const s=window.__app.getState(); return {dl:[...s.phoneIds].length, phoneOnly:s.library.filter(x=>x.phoneOnly).length}; })().catch(e=>'ERR '+e.message)`, 120_000);
    check('download sul telefono (PC morto)', typeof dl === 'object' && dl.dl > 0, JSON.stringify(dl));
  }

  // ===== B) Rete tagliata: il brano scaricato deve suonare dal blob =====
  console.log('\n== B) Aereo/zero rete: ascolto brano sul telefono ==');
  sh(`${A} shell svc wifi disable`, true); sh(`${A} shell svc data disable`, true);
  netOff = true;
  await sleep(2500);
  const off = await ev(`(async()=>{ const s=window.__app.getState(); const t=s.library.find(x=>s.phoneIds.has(x.id)); if(!t) return 'NESSUN BRANO SUL TELEFONO'; s.play(t,[t],0,false); await new Promise(r=>setTimeout(r,7000)); const st=window.__app.getState().player; const els=[...document.querySelectorAll('audio')]; const a=els.find(x=>x.dataset.vid===st.current?.videoId)||els.find(x=>!x.paused)||els.find(x=>x.src); return {playing:st.playing, ct:a?.currentTime, local:(a?.src||'').startsWith('blob:')||(a?.src||'').includes('__phone'), err:a?.error?.code}; })().catch(e=>'ERR '+e.message)`, 30_000);
  check('brano scaricato suona SENZA rete', typeof off === 'object' && off.playing === true && off.ct > 0.3, JSON.stringify(off));
} finally {
  if (netOff) { sh(`${A} shell svc wifi enable`, true); sh(`${A} shell svc data enable`, true); }
  if (confBackup) await ev(`localStorage.setItem('mh-remote-conf', ${JSON.stringify(JSON.stringify(confBackup))})`);
  ws.close();
}
console.log(`\nRisultato: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
