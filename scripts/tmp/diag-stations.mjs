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
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((res) => {
  const id = ++msgId;
  pend.set(id, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description ?? JSON.stringify(m.result)));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});

await sleep(3000);
console.log('screen:', await ev(`window.__app?.getState().screen`));
console.log('openStation fn:', await ev(`typeof window.__app?.getState().openStation`));
console.log('posters:', await ev(`document.querySelectorAll('.poster').length`));
console.log('h1:', await ev(`document.querySelector('h1')?.textContent`));
console.log('body text (200):', await ev(`document.body.innerText.slice(0, 300)`));
// nav manuale e ricontrollo
await ev(`window.__app.getState().nav('stations')`);
await sleep(1000);
console.log('screen dopo nav:', await ev(`window.__app.getState().screen`));
console.log('posters dopo nav:', await ev(`document.querySelectorAll('.poster').length`));
console.log('h1 dopo nav:', await ev(`document.querySelector('h1')?.textContent`));
// prova openStation
await ev(`window.__app.getState().openStation({kind:'station', id:'classifiche'})`);
await sleep(1500);
console.log('stationSel:', await ev(`JSON.stringify(window.__app.getState().stationSel)`));
console.log('Riproduci presente:', await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent.trim()).filter(t=>t).slice(0,12)`));
await sleep(20000);
console.log('righe dopo 20s:', await ev(`document.querySelectorAll('.group.flex.items-center').length`));
console.log('playing:', await ev(`window.__app.getState().player.playing`));
ws.close(); proc.kill('SIGKILL'); process.exit(0);
