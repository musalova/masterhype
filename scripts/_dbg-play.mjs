// one-off: debug perché player.playing torna false dopo play()
import { execSync } from 'child_process';
const ADB = process.env.ADB ?? 'adb';
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const pid = sh(`${ADB} shell pidof com.masterhype.app`);
sh(`${ADB} forward tcp:9229 localabstract:webview_devtools_remote_${pid}`);
await new Promise((r) => setTimeout(r, 400));
const pages = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e, t = 30_000) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, timeout: t });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 400);
  return r.result?.result?.value;
};

console.log(await ev(`(async()=>{
  const s=window.__app.getState();
  const t=s.library.find(x=>x.filePath) ?? s.library[0];
  if(!t) return 'no-lib';
  const log=[];
  // traccia ogni cambio di playing
  let last=s.player.playing;
  const unsub=window.__app.subscribe((st)=>{ if(st.player.playing!==last){last=st.player.playing;log.push('playing→'+last+' @'+Date.now());} });
  // intercetta anche gli eventi audio sull'elemento
  s.play(t, s.library.filter(x=>x.filePath).slice(0,15), 0);
  const a0=Date.now();
  await new Promise(r=>setTimeout(r,6000));
  const els=[...document.querySelectorAll('audio')].map(a=>({src:(a.src||'').slice(0,80),paused:a.paused,ct:a.currentTime,err:a.error?.code,rs:a.readyState,ns:a.networkState}));
  unsub();
  return {log, state:{playing:s.player.playing, cur:s.player.current?.videoId}, els};
})()`));
ws.close();
