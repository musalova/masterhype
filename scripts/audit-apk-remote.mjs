// Audit dell'APK in modalità CONNESSA al PC (scenario d'uso principale:
// il telefono è un client del server di casa). Punta la conf dell'app a un
// PC raggiungibile e verifica OGNI funzione che il desktop offre.
//
// Uso:  node scripts/audit-apk-remote.mjs --base http://10.0.2.2:48484 --token <tok>
//   --base    indirizzo del PC visto dal device (emulatore: 10.0.2.2; telefono: IP LAN)
//   --token   token di pairing del PC (Impostazioni → Telefono)
//   --no-setconf  non tocca la conf (usa quella già nell'app)
import { execSync } from 'child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, ignoreErr = false) => {
  try { return execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (ignoreErr) return ''; throw e; }
};
const ADB = process.env.ADB ?? 'adb';
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const BASE = arg('--base') ?? 'http://10.0.2.2:48484';
const TOKEN = arg('--token');

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
await sleep(500);

const pages = await (await fetch('http://127.0.0.1:9229/json')).json().catch(() => null);
const page = pages?.find((p) => p.type === 'page' && (p.url.includes('localhost') || p.url.includes('capacitor')));
if (!page) { console.log('FAIL: WebView non debuggabile', pages?.map((p) => p.url)); process.exit(1); }
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
  return JSON.stringify(r.result).slice(0, 500);
};
const waitFor = async (e, tries = 30) => {
  for (let i = 0; i < tries; i++) { const v = await ev(e).catch(() => null); if (v) return v; await sleep(1000); }
  return null;
};
await send('Runtime.enable', {}); await send('Page.enable', {});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(` ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); cond ? pass++ : fail++; };

// ---------- conf verso il PC reale ----------
if (TOKEN && !args.includes('--no-setconf')) {
  await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'${BASE}', token:'${TOKEN}', user:Number(arg('--user') ?? 1)}))`);
  await send('Page.navigate', { url: page.url });
}
const ready = await waitFor(`!!window.__app`, 25);
check('app pronta', !!ready);
await sleep(4000); // probe + SSE + hydrate prefs

console.log('conf:', await ev(`localStorage.getItem('mh-remote-conf')`));
check('piattaforma nativa', await ev(`window.Capacitor?.isNativePlatform?.()`));
check('PC online (no banner offline)', await ev(`window.__online?.() ?? !document.body.innerText.includes('non raggiungibile')`));

// ---------- API: specchio completo di quello che usa la UI ----------
const api = async (expr) => ev(`(async()=>{ try { return await (${expr}); } catch(e){ return 'ERR: '+(e?.message||e); } })()`);

console.log('\n== API via server PC ==');
const settings = await api(`__mhApi().settings.get()`);
check('settings.get', settings && typeof settings === 'object' && !String(settings).startsWith?.('ERR'), JSON.stringify(settings).slice(0, 80));

const users = await api(`__mhApi().users.list()`);
check('users.list', Array.isArray(users) && users.length > 0, JSON.stringify(users).slice(0, 80));

const lib = await api(`__mhApi().library.list()`);
check('library.list', Array.isArray(lib), `${Array.isArray(lib) ? lib.length + ' brani' : JSON.stringify(lib).slice(0, 80)}`);

const search = await api(`__mhApi().yt.search('vasco rossi', false)`);
check('yt.search', search && Array.isArray(search.songs) && search.songs.length > 0,
  `${search?.songs?.length ?? JSON.stringify(search).slice(0, 60)} brani`);

const upnext = await api(`__mhApi().yt.upNext('dQw4w9WgXcQ')`);
check('yt.upNext', Array.isArray(upnext) && upnext.length > 0, `${Array.isArray(upnext) ? upnext.length : JSON.stringify(upnext).slice(0, 60)}`);

const charts = await api(`__mhApi().yt.charts('IT')`);
check('yt.charts', Array.isArray(charts) && charts.length > 0, `${Array.isArray(charts) ? charts.length : JSON.stringify(charts).slice(0, 60)}`);

const lyrics = await api(`__mhApi().yt.lyrics('Rick Astley','Never Gonna Give You Up', 213)`);
check('yt.lyrics', lyrics && lyrics.found === true, JSON.stringify(lyrics).slice(0, 80));

const stream = await api(`__mhApi().yt.playStream('dQw4w9WgXcQ','Rick Astley','Never Gonna Give You Up')`);
check('yt.playStream', stream && typeof stream.url === 'string' && stream.url.startsWith('http'),
  stream?.url ? 'url ok' : JSON.stringify(stream).slice(0, 80));

const pls = await api(`__mhApi().playlists.list()`);
check('playlists.list', Array.isArray(pls), `${Array.isArray(pls) ? pls.length : JSON.stringify(pls).slice(0, 60)}`);

const rl = await api(`__mhApi().library.remoteLikes()`);
check('library.remoteLikes', rl && typeof rl === 'object', JSON.stringify(rl).slice(0, 60));

const sugg = await api(`__mhApi().rec.suggest()`);
check('rec.suggest', sugg && typeof sugg === 'object', JSON.stringify(sugg).slice(0, 80));

const trends = await api(`__mhApi().rec.trends()`);
check('rec.trends', trends && typeof trends === 'object', JSON.stringify(trends).slice(0, 80));

const station = await api(`__mhApi().rec.station('foryou')`);
check('rec.station(foryou)', Array.isArray(station), `${Array.isArray(station) ? station.length : JSON.stringify(station).slice(0, 80)}`);

const radio = await api(`__mhApi().rec.radio('genre','pop')`);
check('rec.radio(genre)', Array.isArray(radio), `${Array.isArray(radio) ? radio.length : JSON.stringify(radio).slice(0, 80)}`);

const ap = await api(`__mhApi().rec.autoplaylist('top')`);
check('rec.autoplaylist(top)', Array.isArray(ap), `${Array.isArray(ap) ? ap.length : JSON.stringify(ap).slice(0, 80)}`);

const dl = await api(`__mhApi().downloads.list()`);
check('downloads.list', Array.isArray(dl), `${Array.isArray(dl) ? dl.length : JSON.stringify(dl).slice(0, 60)}`);

const prefs = await api(`__mhApi().prefs.getAll()`);
check('prefs.getAll', prefs && typeof prefs === 'object', JSON.stringify(prefs).slice(0, 60));

await api(`__mhApi().prefs.set('mh-pref-apk-audit', {t:Date.now()})`);
const prefRb = await api(`__mhApi().prefs.getAll().then(p=>p['mh-pref-apk-audit'])`);
check('prefs.set round-trip', prefRb && typeof prefRb === 'object' && prefRb.t > 0);

const spotify = await api(`__mhApi().spotify.status()`);
check('spotify.status', typeof spotify === 'boolean', String(spotify));

const info = await api(`__mhApi().remote.info()`);
check('remote.info', info && info.enabled === true, JSON.stringify(info).slice(0, 80));

// media endpoint (copertina+audio via HTTP) — come fa la UI
if (Array.isArray(lib) && lib.length) {
  const t = lib.find((x) => x.filePath) ?? lib[0];
  const media = await ev(`(async()=>{ const conf=JSON.parse(localStorage.getItem('mh-remote-conf'));
    const r=await fetch(conf.base+'/media/audio/'+${t.id}+'?token='+conf.token,{headers:{Range:'bytes=0-2047'}});
    return {status:r.status, n:(await r.arrayBuffer()).byteLength}; })()`);
  check('media/audio Range 206', media && media.status === 206 && media.n === 2048, JSON.stringify(media));
  const cover = await ev(`(async()=>{ const conf=JSON.parse(localStorage.getItem('mh-remote-conf'));
    const r=await fetch(conf.base+'/media/cover/'+${t.id}+'?token='+conf.token);
    return r.status; })()`);
  check('media/cover', cover === 200 || cover === 404, String(cover));
}

// ---------- riproduzione reale di un brano della LIBRERIA (percorso PC) ----------
if (stream?.url) {
  const audio = await ev(`(async()=>{ const a=new Audio(); a.src=${JSON.stringify(stream.url)}; a.muted=true;
    await new Promise((res,rej)=>{a.oncanplay=res;a.onerror=()=>rej(new Error('audio err '+a.error?.code));setTimeout(()=>rej(new Error('timeout 15s')),15000)});
    try{await a.play()}catch(e){} await new Promise(r=>setTimeout(r,2500));
    const t=a.currentTime; a.pause(); a.src=''; return 'currentTime='+t.toFixed(2); })()`, 40_000);
  check('audio googlevideo in <audio>', typeof audio === 'string' && audio.startsWith('currentTime=') && !audio.endsWith('=0.00'), String(audio));
}

// ---------- UI: le schermate si aprono e non sono vuote ----------
console.log('\n== UI: navigazione schermate ==');
for (const nav of ['home', 'search', 'library', 'stations', 'playlists', 'downloads', 'burn', 'settings']) {
  const r = await ev(`(async()=>{ const s=window.__app.getState(); s.nav('${nav}'); await new Promise(r=>setTimeout(r,900));
    const el=document.querySelector('main'); const txt=(el?.innerText||'').trim();
    return {len:txt.length, head:txt.slice(0,60)}; })()`);
  check(`schermata ${nav}`, r && r.len > 10, r ? `"${r.head.replace(/\n/g, ' | ')}…"` : 'vuota');
}

// ---------- errori console/renderer raccolti ----------
const errs = await ev(`window.__errs ?? []`);
if (Array.isArray(errs) && errs.length) console.log('\nerrori renderer:', JSON.stringify(errs).slice(0, 400));

console.log(`\nRisultato: ${pass} pass, ${fail} fail`);
ws.close();
process.exit(fail ? 1 : 0);
