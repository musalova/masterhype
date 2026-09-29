// Verifica visiva: forme geometriche ambientali non devono disturbare i contenuti.
import { writeFileSync } from 'node:fs';
import { ev, sleep, close } from '../cdp-test.mjs';

const pages = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name + '.png', Buffer.from(r.result.data, 'base64'));
};

await send('Page.enable', {});
await sleep(2500);

for (const [screen, name] of [['home', 'shapes-home'], ['library', 'shapes-library'], ['cd', 'shapes-cd']]) {
  await ev(`window.__app.getState().nav('${screen}')`);
  await sleep(1400);
  await shot(name);
  console.log('shot', name);
}
close();
ws.close();
process.exit(0);
