// Screenshot del renderer via CDP con emulazione device opzionale.
// Uso: node scripts/cdp-shot.mjs out.png [width height] [jsExpr]
import { writeFileSync } from 'node:fs';
const [out = 'shot.png', w, h, expr] = process.argv.slice(2);
const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (w && h) await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 2, mobile: true });
else { await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }); await send('Emulation.clearDeviceMetricsOverride'); }
if (expr) { await send('Runtime.evaluate', { expression: expr, awaitPromise: true }); }
await sleep(1800);
const r = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(r.result.data, 'base64'));
console.log('saved', out);
ws.close(); process.exit(0);
