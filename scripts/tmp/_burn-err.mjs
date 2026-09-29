// one-off: legge l'errore del boundary burn + console errors dalla WebView dell'app
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
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || '').slice(0, 600);
  return r.result?.result?.value;
};
await send('Runtime.enable', {});
// naviga a burn e leggi il testo del boundary
await ev(`window.__app.getState().nav('burn')`);
await new Promise((r) => setTimeout(r, 1500));
console.log('boundary text:', await ev(`document.querySelector('main')?.innerText?.slice(0,500)`));
// leggi la diagnostica del PC (renderer-crash)
console.log('diag stats:', await ev(`__mhApi().diag.stats().then(s=>JSON.stringify(s).slice(0,1500))`));
ws.close();
