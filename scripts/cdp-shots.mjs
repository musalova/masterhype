// Screenshot di ogni schermata per l'audit visivo
import { writeFileSync } from 'node:fs';
import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';

await enableLogs();
const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let sid = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params) => new Promise((res) => { const i = ++sid; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable', {});
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`audit-${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};

const screens = ['home', 'stations', 'search', 'library', 'playlists', 'cd', 'trends', 'assistant', 'downloads', 'settings'];
for (const s of screens) {
  await ev(`window.__app.getState().nav('${s}')`);
  await sleep(s === 'home' ? 2500 : 1600);
  await shot(s);
}
// scroll home per vedere la parte bassa
await ev(`window.__app.getState().nav('home')`);
await sleep(800);
await ev(`document.querySelector('main .overflow-y-auto')?.scrollTo(0, 1400)`);
await sleep(700);
await shot('home-bottom');
console.log('errors:', JSON.stringify(getLogs().filter((l) => l.startsWith('error')).slice(0, 8)));
ws.close(); close(); process.exit(0);
