// Utilità di test via Chrome DevTools Protocol sull'app Electron in esecuzione
// (avviata con --remote-debugging-port=9222). Uso: node scripts/cdp-test.mjs

const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes('masterhype') || p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let id = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Log.entryAdded') logs.push(d.params.entry.level + ': ' + d.params.entry.text);
  if (d.method === 'Runtime.consoleAPICalled' && (d.params.type === 'error' || d.params.type === 'warning'))
    logs.push(d.params.type + ': ' + JSON.stringify(d.params.args.map((a) => a.value ?? a.description ?? '').slice(0, 3)));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
export const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  const v = r.result?.result;
  if (v && v.value !== undefined) return v.value;
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return JSON.stringify(r.result);
};
export const enableLogs = async () => { await send('Log.enable', {}); await send('Runtime.enable', {}); };
export const getLogs = () => logs;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const close = () => ws.close();
