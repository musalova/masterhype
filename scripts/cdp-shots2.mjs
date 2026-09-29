// Ri-shot delle schermate corrette
import { writeFileSync } from 'node:fs';
import { ev, sleep, close } from './cdp-test.mjs';

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
  writeFileSync(`fix-${name}.png`, Buffer.from(r.result.data, 'base64'));
  console.log('shot', name);
};

// trends — copertine Deezer ora visibili
await ev(`window.__app.getState().nav('trends')`);
await sleep(2000);
await shot('trends');
// search — focus sull'input per vedere il nuovo glow + chip gusti
await ev(`window.__app.getState().nav('search')`);
await sleep(1200);
await ev(`document.querySelector('main input')?.focus()`);
await sleep(400);
await shot('search');
// home hero fallback (se ancora fallback)
await ev(`window.__app.getState().nav('home')`);
await sleep(2000);
await shot('home');
ws.close(); close(); process.exit(0);
