// Verifica COMPLETA dell'APK su dispositivo reale (USB) o emulatore.
// Uso:  node scripts/audit-apk-full.mjs [--install] [--dead-conf] [--keep-conf]
//   --install   installa release\MasterHype-Android.apk come aggiornamento
//   --dead-conf forza conf verso PC morto → testa la modalità autonoma
// Requisiti: adb nel PATH (o ANDROID_HOME), device con USB debug / emulatore up.
//
// Il cuore del test è __selftest(): gira DENTRO l'app su codice vero
// (CapacitorHttp nativo, IndexedDB, <audio>, youtubei.js) — niente mock.
import { execSync } from 'child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c, ignoreErr = false) => {
  try { return execSync(c, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (ignoreErr) return ''; throw e; }
};
const ADB = process.env.ADB ?? 'adb';
const args = process.argv.slice(2);

// ---------- device ----------
const devs = sh(`${ADB} devices`).split('\n').slice(1).map((l) => l.split('\t'))
  .filter(([id, st]) => id && st === 'device');
if (!devs.length) { console.log('FAIL: nessun device/emulatore. Collega il telefono (USB debug) o avvia l\'emulatore.'); process.exit(1); }
const DEV = devs[0][0];
console.log(`device: ${DEV}${devs.length > 1 ? ` (uso il primo di ${devs.length})` : ''}`);
const A = `${ADB} -s ${DEV}`;

// ---------- install (update: conserva dati e pairing) ----------
if (args.includes('--install')) {
  console.log('installo APK (update, dati conservati)…');
  console.log(sh(`${A} install -r release\\MasterHype-Android.apk`));
}
const pkgOk = sh(`${A} shell pm list packages com.masterhype.app`, true).includes('com.masterhype.app');
if (!pkgOk) { console.log('FAIL: app non installata — rilancia con --install'); process.exit(1); }

// ---------- launch + devtools forward ----------
sh(`${A} shell monkey -p com.masterhype.app -c android.intent.category.LAUNCHER 1`, true);
await sleep(2500);
let pid = '';
for (let i = 0; i < 15 && !pid; i++) { pid = sh(`${A} shell pidof com.masterhype.app`, true); if (!pid) await sleep(1000); }
if (!pid) { console.log('FAIL: app non parte'); process.exit(1); }
console.log(`app avviata (pid ${pid})`);
sh(`${A} forward tcp:9229 localabstract:webview_devtools_remote_${pid}`, true);

// ---------- CDP ----------
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
  return JSON.stringify(r.result).slice(0, 400);
};
const waitFor = async (e, tries = 40) => {
  for (let i = 0; i < tries; i++) { const v = await ev(e).catch(() => null); if (v) return v; await sleep(1000); }
  return null;
};
await send('Runtime.enable', {}); await send('Page.enable', {});

const saveConf = await ev(`localStorage.getItem('mh-remote-conf')`);
console.log('conf salvata:', saveConf ? saveConf.slice(0, 70) : '(nessuna)');
console.log('piattaforma:', await ev(`window.Capacitor?.isNativePlatform?.() ? 'APK nativa' : 'browser'`));

// ---------- Scenario 1: boot con PC morto ----------
if (args.includes('--dead-conf') || saveConf) {
  console.log('\n== SCENARIO: PC morto (conf verso host irraggiungibile) ==');
  if (args.includes('--dead-conf')) {
    await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://192.0.2.1:48484', token:'dead', alts:['http://192.0.2.2:48484']}))`);
  } else {
    // PC reale spento? forzo comunque una conf morta per il test, la ripristino dopo
    await ev(`window.__confBackup = localStorage.getItem('mh-remote-conf');
             localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://192.0.2.1:48484', token:'dead'}))`);
  }
  await ev(`localStorage.setItem('mh-lib-cache', localStorage.getItem('mh-lib-cache') || '[]')`);
  const t0 = Date.now();
  await send('Page.navigate', { url: page.url });
  const ready = await waitFor(`!!window.__app`, 25);
  const bootMs = ready ? 'misuro…' : 'TIMEOUT';
  // tempo reale: timestamp navigazione→ready
  console.log(`  app pronta: ${ready ? 'OK' : 'FAIL'} (${Date.now() - t0}ms dal reload)`);
  await sleep(6500); // probe 5s + margine → banner deve apparire
  console.log('  banner offline:', await ev(`document.body.innerText.includes('non raggiungibile') || document.body.innerText.includes('Nessuna rete')`));
  console.log('  call() fail-fast:', await ev(`__mhApi().settings.get().then(()=> 'NO').catch(e=>e.message)`));

  console.log('\n== SCENARIO: modalità autonoma (YouTube diretto, CapacitorHttp nativo) ==');
  console.log('  ricerca:', JSON.stringify(await ev(`__mhApi().yt.search('vasco rossi', false).then(r=>({n:r.songs.length,t:r.songs[0]?.title})).catch(e=>'ERR '+e.message)`)));
  const st = await ev(`__mhApi().yt.playStream('dQw4w9WgXcQ','Rick Astley','Never Gonna Give You Up').then(r=>({ok:!!r.url,host:new URL(r.url).host.slice(0,25)})).catch(e=>'ERR '+e.message)`);
  console.log('  stream url:', JSON.stringify(st));
  // riproduzione reale: <audio> + currentTime che avanza
  console.log('  audio reale:', await ev(`(async()=>{ const s=await __mhApi().yt.playStream('dQw4w9WgXcQ'); const a=new Audio(); a.src=s.url; a.muted=true; await new Promise((res,rej)=>{a.oncanplay=res;a.onerror=()=>rej(new Error('audio err '+a.error?.code));setTimeout(()=>rej(new Error('timeout 15s')),15000)}); try{await a.play()}catch(e){} await new Promise(r=>setTimeout(r,2500)); const t=a.currentTime; a.pause();a.src=''; return 'currentTime='+t.toFixed(2)+'s dur='+(isFinite(a.duration)?Math.round(a.duration):'?'); })()`, 40_000));
}

// ---------- Scenario 2: selftest completo (codice vero dell'app) ----------
console.log('\n== SELFTEST in-app ==');
const rep = await ev(`window.__selftest ? __selftest().then(r=>r.rows.map(x=>({n:x.name,ok:x.ok,ms:x.ms,d:x.detail}))) : 'NO __selftest'`, 120_000);
if (Array.isArray(rep)) {
  for (const r of rep) console.log(`  ${r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'INFO'}  ${r.name} (${r.ms}ms) — ${r.d}`);
  const fails = rep.filter((r) => r.ok === false);
  console.log(`\nRisultato: ${rep.length - fails.length}/${rep.length} ok${fails.length ? ` — FALLITI: ${fails.map((f) => f.n).join(', ')}` : ''}`);
} else console.log('  ', rep);

// ---------- ripristino conf ----------
if (!args.includes('--keep-conf') && !args.includes('--dead-conf')) {
  await ev(`window.__confBackup && localStorage.setItem('mh-remote-conf', window.__confBackup)`);
}
ws.close();
console.log('\nDone. Per test offline vero: adb shell svc wifi disable / svc data disable (o modalità aereo), poi riproduci un brano "sul telefono".');
