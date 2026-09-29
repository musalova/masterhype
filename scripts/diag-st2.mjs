import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9223'], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page;
    } catch { }
    await sleep(500);
  }
  throw new Error('CDP non raggiungibile');
}
const page = await waitCdp();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let msgId = 0; const pend = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '));
};
ws.send(JSON.stringify({ id: ++msgId, method: 'Runtime.enable' }));
const ev = (expr) => new Promise((res) => {
  const id = ++msgId;
  pend.set(id, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description ?? JSON.stringify(m.result?.result)));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});

await sleep(3000);
await ev(`window.__app.getState().nav('stations')`);
await sleep(500);
await ev(`window.__app.getState().openStation({kind:'station', id:'classifiche'})`);
await sleep(2500);
console.log('sel:', await ev(`JSON.stringify(window.__app.getState().stationSel)`));
console.log('screen:', await ev(`window.__app.getState().screen`));
console.log('main innerText:', await ev(`document.querySelector('main')?.innerText?.slice(0,400) ?? document.body.innerText.slice(0,400)`));
console.log('Riproduci?', await ev(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Riproduci'))`));
console.log('ERRORS:', JSON.stringify(errors.slice(0, 6), null, 1));
ws.close(); proc.kill('SIGKILL'); process.exit(0);
