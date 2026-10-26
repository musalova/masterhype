// Screenshot delle schermate via CDP — uso: node scripts/tmp/shots.mjs [w h out]
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const [W, H] = [+(process.argv[2] ?? 1365), +(process.argv[3] ?? 900)];
const out = process.argv[4] ?? join(process.env.TEMP, 'mh-shots');
const screens = (process.argv[5] ?? 'home,search,stations,library,playlists,cd,assistant,trends,downloads,settings').split(',');
mkdirSync(out, { recursive: true });

const page = (await (await fetch('http://127.0.0.1:9222/json')).json()).find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const send = (method, params) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); }).then((x) => x.result);
const ev = (e) => send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then((x) => x?.result?.value);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: W < 768 });
await ev(`localStorage.setItem('mh-pref-onboarded','true'); localStorage.setItem('mh-seen-version','99.9.9')`);
await ev(`document.querySelectorAll('[class*="system-cards"] button,[class*="WhatsNew"] button').forEach(b=>b.click())`);
for (const s of screens) {
  await ev(`window.__app.getState().nav('${s}')`);
  await sleep(1100);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(out, `${s}-${W}x${H}.png`), Buffer.from(data, 'base64'));
  console.log('shot', s);
}
ws.close(); process.exit(0);
