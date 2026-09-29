// one-off: chi chiamava toggle() dopo play? stack trace del colpevole
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
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 500);
  return r.result?.result?.value;
};

console.log(await ev(`(async()=>{
  const S=window.__app;
  const orig=S.getState().toggle;
  const hits=[];
  S.setState({ toggle: ()=>{ hits.push(new Error('toggle').stack.split('\\n').slice(1,6).join(' | ')); orig(); } });
  const s=S.getState();
  const t=s.library.find(x=>x.filePath) ?? s.library[0];
  s.play(t, s.library.filter(x=>x.filePath).slice(0,15), 0);
  await new Promise(r=>setTimeout(r,6000));
  S.setState({ toggle: orig });
  return {hits, playing:S.getState().player.playing};
})()`));
ws.close();
