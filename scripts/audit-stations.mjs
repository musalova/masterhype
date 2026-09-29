// Audit flusso stazioni list-first: click card → scaletta (NO autoplay) →
// play esplicito → radio. Uso: node scripts/audit-stations.mjs
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9223'], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); ok ? pass++ : fail++; };

async function waitCdp() {
  for (let i = 0; i < 60; i++) {
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
let msgId = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((res) => {
  const id = ++msgId;
  pend.set(id, (m) => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const hasPlayBtn = `[...document.querySelectorAll('button')].some(b => b.textContent.includes('Riproduci'))`;

// boot completo (hydrate prefs + primo render)
await sleep(4000);

// 1. Stazioni → grid con le card
await ev(`window.__app.getState().nav('stations')`);
await sleep(1200);
check('grid stazioni renderizza', await ev(`document.querySelectorAll('.poster').length > 3`));

// 2. Apre una stazione → vista lista, NESSUN autoplay
await ev(`window.__app.getState().openStation({kind:'station', id:'classifiche'})`);
let opened = false;
for (let i = 0; i < 20 && !opened; i++) { opened = await ev(hasPlayBtn); await sleep(500); }
check('dettaglio aperto (pulsante Riproduci)', opened);
check('NO autoplay all\'apertura', await ev(`window.__app.getState().player.playing === false`));
check('stationSel coerente', await ev(`window.__app.getState().stationSel?.id === 'classifiche'`));

// 3. Attendi la scaletta
let n = 0;
for (let i = 0; i < 50; i++) {
  n = await ev(`document.querySelectorAll('.group.flex.items-center').length`) || 0;
  if (n > 3) break;
  await sleep(1000);
}
check(`scaletta popolata (${n} righe)`, n > 3);
check('ancora niente autoplay dopo il load', await ev(`window.__app.getState().player.playing === false`));

// 4. Play esplicito → radio parte
await ev(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Riproduci'))?.click()`);
await sleep(600);
check('play esplicito avvia la radio', await ev(`window.__app.getState().player.playing === true`));
check('radio flag attivo (continuazione infinita)', await ev(`window.__app.getState().player.radio === true`));
check('coda = scaletta della stazione', await ev(`window.__app.getState().player.queue.length > 3`));

// 5. Back → grid di nuovo, la musica continua in background
await ev(`window.__app.getState().openStation(null)`);
await sleep(800);
check('back torna alla grid', await ev(`document.querySelectorAll('.poster').length > 3`));
check('la radio continua mentre navighi', await ev(`window.__app.getState().player.playing === true`));

// 6. Altra stazione: si apre senza toccare il player
await ev(`window.__app.getState().openStation({kind:'radio', radioKind:'genre', value:'pop'})`);
let opened2 = false;
for (let i = 0; i < 20 && !opened2; i++) { opened2 = await ev(hasPlayBtn); await sleep(500); }
check('radio di genere si apre come lista', opened2);
check('aprirla non interrompe la riproduzione', await ev(`window.__app.getState().player.playing === true`));

console.log(`\n${pass}/${pass + fail} PASS`);
ws.close();
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);
