// Audit delle feature Spotify-like: deep-link "Brani che ti piacciono", mix di
// genere, sidebar "La tua libreria", enqueue, sleep timer, hero artista, tile
// Sfoglia in Cerca. Uso: node scripts/audit-spotify.mjs
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

// Attesa store pronto
for (let i = 0; i < 40; i++) { if (await ev(`!!window.__app`)) break; await sleep(500); }
await sleep(2500);

// ── Sidebar: "La tua libreria" ────────────────────────────────────────────────
const sideTxt = await ev(`document.body.innerText`);
check('sidebar "La tua libreria"', /la tua libreria/i.test(String(sideTxt)));
check('sidebar "Brani che ti piacciono"', String(sideTxt).includes('Brani che ti piacciono'));

// ── Deep-link: openAutoList('liked') → schermata playlists con lista aperta ──
await ev(`window.__app.getState().openAutoList('liked')`);
await sleep(3500);
const plScreen = await ev(`window.__app.getState().screen`);
check('openAutoList → schermata playlists', plScreen === 'playlists');
const plBody = await ev(`document.body.innerText`);
check('lista "Brani che ti piacciono" aperta', String(plBody).includes('Brani che ti piacciono'));
const likedRows = await ev(`document.querySelectorAll('.group.flex.items-center').length`);
check(`scaletta liked popolata (${likedRows} righe)`, likedRows > 0);
check('nessun autoplay dalla lista liked', await ev(`!window.__app.getState().player.playing`));

// ── Mix di genere via openAutoList('genre:...') ──────────────────────────────
const mixTag = await ev(`(async () => { const t = await window.__mhApi().library.taste('tag'); return (t[0] && t[0].value) || 'pop'; })()`);
await ev(`window.__app.getState().openAutoList('genre:${mixTag || 'pop'}')`);
await sleep(4500);
const plBody2 = await ev(`document.body.innerText`);
check(`mix di genere aperto (Mix ${mixTag})`, String(plBody2).includes('Mix'));
const mixRows = await ev(`document.querySelectorAll('.group.flex.items-center').length`);
check(`scaletta mix popolata (${mixRows} righe)`, mixRows > 0);

// ── openPlaylistById (deep-link sidebar) ──────────────────────────────────────
const firstPl = await ev(`(async () => { const p = await window.__mhApi().playlists.list(); return p[0] ? p[0].id : null; })()`);
if (firstPl != null) {
  await ev(`window.__app.getState().openPlaylistById(${firstPl})`);
  await sleep(1500);
  check('openPlaylistById → playlists', await ev(`window.__app.getState().screen`) === 'playlists');
} else check('openPlaylistById (nessuna playlist nel DB — skip)', true);

// ── enqueue: aggiungi in coda senza interrompere ─────────────────────────────
await ev(`window.__app.getState().enqueue({ videoId: 'dQw4w9WgXcQ', artist: 'Rick Astley', title: 'Never Gonna Give You Up' })`);
await sleep(400);
const qLen = await ev(`window.__app.getState().player.queue.length`);
check(`enqueue aggiunge alla coda (${qLen})`, qLen > 0);

// ── Sleep timer ──────────────────────────────────────────────────────────────
await ev(`window.__app.getState().setSleepTimer(5)`);
await sleep(300);
check('sleep timer impostato', await ev(`window.__app.getState().sleepAt != null`));
await ev(`window.__app.getState().setSleepTimer(null)`);
check('sleep timer disattivato', await ev(`window.__app.getState().sleepAt == null && !window.__app.getState().sleepEndOfTrack`));
await ev(`window.__app.getState().setSleepTimer('end')`);
check('sleep "a fine brano"', await ev(`window.__app.getState().sleepEndOfTrack === true`));
await ev(`window.__app.getState().setSleepTimer(null)`);

// ── Cerca vuota: tile "Sfoglia tutto" ────────────────────────────────────────
await ev(`window.__app.getState().nav('search')`);
await sleep(1500);
const searchTxt = await ev(`document.body.innerText`);
check('tile "Sfoglia tutto" in Cerca', String(searchTxt).includes('Sfoglia tutto'));

// Click su una tile → apre la stazione come lista (no autoplay)
const clicked = await ev(`(() => {
  const btns = [...document.querySelectorAll('button')].filter(b => b.closest('section')?.innerText?.includes('Sfoglia tutto'));
  const t = btns.find(b => b.className.includes('bg-gradient-to-br') && b.textContent.trim().length > 3 && b.textContent.trim().length < 40);
  if (!t) return null; t.click(); return t.textContent.trim();
})()`);
await sleep(2500);
check(`tile click → stazione come lista (${clicked})`, await ev(`window.__app.getState().screen`) === 'stations' && await ev(`window.__app.getState().stationSel != null`));
check('tile click: nessun autoplay', await ev(`!window.__app.getState().player.playing`));

// ── Radio persistita: default ON ─────────────────────────────────────────────
check('radio default ON (autoplay Spotify)', await ev(`window.__app.getState().player.radio === true`));

// ── Errori console ────────────────────────────────────────────────────────────
const errs = await ev(`window.__errs ? window.__errs.length : 0`);
console.log(`\n${pass}/${pass + fail} PASS`);
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);
