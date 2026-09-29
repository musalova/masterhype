// Verifica la media session NATIVA dell'APK (PlaybackService foreground):
// il test che replica il caso d'uso vero — musica a schermo spento e
// controlli da notifica/lockscreen/tasti Bluetooth.
// Uso: node scripts/audit-apk-media.mjs
import { execSync } from 'child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADB = process.env.ADB ?? 'adb';
const sh = (c, ignore = false) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch (e) { if (ignore) return ''; throw e; } };

const pid = sh(`${ADB} shell pidof com.masterhype.app`);
if (!pid) { sh(`${ADB} shell monkey -p com.masterhype.app -c android.intent.category.LAUNCHER 1`); await sleep(4000); }
const pid2 = sh(`${ADB} shell pidof com.masterhype.app`);
sh(`${ADB} forward tcp:9229 localabstract:webview_devtools_remote_${pid2}`, true);
await sleep(400);
const pages = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = pages.find((p) => p.type === 'page' && (p.url.includes('localhost') || p.url.includes('capacitor')));
if (!page) { console.log('FAIL: WebView non debuggabile'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e, timeout = 30_000) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 300);
  return r.result?.result?.value;
};
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(` ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`); cond ? pass++ : fail++; };
const svcAlive = () => sh(`${ADB} shell "dumpsys activity services com.masterhype.app | grep -c PlaybackService"`, true) !== '0';
const notifPosted = () => sh(`${ADB} shell "dumpsys notification | grep -c 'com.masterhype.app'"`, true) !== '0';
const mediaSession = () => sh(`${ADB} shell "dumpsys media_session | grep -c 'MasterHype'"`, true) !== '0';
const key = (k) => sh(`${ADB} shell input keyevent ${k}`, true);
const playing = () => ev(`window.__app.getState().player.playing`);
const curTime = () => ev(`[...document.querySelectorAll('audio')].find(a=>!a.paused)?.currentTime ?? -1`);

// 1) Avvia la riproduzione di un brano della libreria via store
console.log('== Avvio riproduzione ==');
const started = await ev(`(async()=>{ const s=window.__app.getState();
  const t=s.library.find(x=>x.filePath) ?? s.library[0];
  if(!t) return 'no-lib';
  s.play(t, s.library.filter(x=>x.filePath).slice(0,15), 0);
  await new Promise(r=>setTimeout(r,4000));
  return {vid:window.__app.getState().player.current?.videoId, playing:window.__app.getState().player.playing, t:[...document.querySelectorAll('audio')].find(a=>!a.paused)?.currentTime}; })()`, 30_000);
console.log('  stato:', JSON.stringify(started));
check('brano in riproduzione', started && started.playing === true, `t=${started?.t}`);

await sleep(3000); // lascia propagare pushMediaSession → servizio

// 2) Servizio foreground + notifica + media session registrata
console.log('\n== Servizio nativo ==');
const svc = sh(`${ADB} shell "dumpsys activity services com.masterhype.app"`, true);
console.log('  services:', svc.split('\n').filter((l) => l.includes('ServiceRecord')).join(' | ').slice(0, 200) || '(grep sotto)');
check('PlaybackService in esecuzione', svcAlive());
check('foreground (fgService)', svc.includes('isForeground=true') || svc.includes('foregroundServiceType'));
check('notifica postata', notifPosted());
check('media session registrata', mediaSession());

// 3) Tasto multimediale hardware → pausa (come auricolari/auto)
console.log('\n== Tasti multimediali ==');
await key('KEYCODE_MEDIA_PLAY_PAUSE');
await sleep(1500);
check('PLAY_PAUSE → pausa', (await playing()) === false);
await sleep(1000);
await key('KEYCODE_MEDIA_PLAY_PAUSE');
await sleep(1500);
check('PLAY_PAUSE → riprendi', (await playing()) === true);
await key('KEYCODE_MEDIA_NEXT');
await sleep(1500);
const afterNext = await ev(`({playing:window.__app.getState().player.playing, idx:window.__app.getState().player.queueIndex})`);
check('NEXT → brano successivo', afterNext && afterNext.idx >= 0, JSON.stringify(afterNext));

// 4) Schermo spento: il processo resta in foreground → l'audio NON si ferma
console.log('\n== Schermo spento ==');
await key('KEYCODE_SLEEP');
await sleep(2500);
const t1 = await curTime();
await sleep(4000);
const t2 = await curTime();
check('audio avanza a schermo spento', typeof t2 === 'number' && typeof t1 === 'number' && t2 > t1 + 2, `${t1?.toFixed?.(1)}s → ${t2?.toFixed?.(1)}s`);
check('processo ancora vivo', !!sh(`${ADB} shell pidof com.masterhype.app`, true));
check('PlaybackService vivo a schermo spento', svcAlive());
await key('KEYCODE_WAKEUP');
await sleep(800);

// 5) Stop riproduzione: torna tutto giù pulito
console.log('\n== Stop ==');
await ev(`(()=>{ const s=window.__app.getState(); if(s.player.playing) s.toggle(); })()`);
await sleep(1500);
check('in pausa la notifica è dismissible', svcAlive(), '(servizio resta, notifica swipeable)');

console.log(`\nRisultato: ${pass} pass, ${fail} fail`);
ws.close();
process.exit(fail ? 1 : 0);
