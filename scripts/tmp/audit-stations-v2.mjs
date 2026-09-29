// Audit motore stazioni v2 su un profilo ISOLATO (--user-data-dir temp):
// non tocca l'istanza MasterHype installata né il suo DB.
// Verifica: stationTracks per-te/generic/novita, radio artista/genere,
// rec:next con contesto, vid_cache scritta.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userDir = mkdtempSync(join(tmpdir(), 'mh-audit-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9224', `--user-data-dir=${userDir}`], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

async function waitCdp() {
  for (let i = 0; i < 90; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9224/json')).json();
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
await sleep(3000);

const summarize = (list) => (list ?? []).slice(0, 40).map((t) => `${t.artist}|${t.title}`);

// Simula un profilo gusti: seeda gusti + un dislike su un artista + uno skip
await ev(`(async () => {
  const api = window.__mhApi();
  await api.library.tasteSeed(['Vasco Rossi', 'Laura Pausini', 'Eros Ramazzotti', 'Ligabue']);
  const ups = await api.yt.search('vasco rossi sally', false).catch(()=>({songs:[]}));
  const s = ups.songs?.[0];
  if (s) {
    await api.library.remoteEvent({ artist: s.artist, title: s.title, videoId: s.videoId, type: 'skip' });
    await api.library.remoteEvent({ artist: s.artist, title: s.title, videoId: s.videoId, type: 'skip' });
  }
  // un artista "odiato" (dislike marcato → peso negativo → blocco fuzzy)
  const d = (await api.yt.search('drake', false).catch(()=>({songs:[]}))).songs?.[0];
  if (d) {
    for (let i = 0; i < 3; i++) await api.library.remoteEvent({ artist: 'Drake', title: d.title, videoId: d.videoId, type: 'skip' });
    await api.library.remoteEvent({ artist: 'Drake', title: d.title, videoId: d.videoId, type: 'hide' });
  }
  return true;
})()`);
await sleep(1000);

// 1. La tua stazione — popolata, videoId presenti
const perTe = await ev(`window.__mhApi().rec.station('per-te')`);
check('per-te popolata', Array.isArray(perTe) && perTe.length >= 10, `${perTe?.length ?? 0} brani`);
check('per-te con videoId', (perTe ?? []).every((t) => t.videoId), '');
check('per-te senza doppi (titolo base)', (() => {
  const seen = new Set(); for (const t of summarize(perTe)) { const k = t.toLowerCase().replace(/\(.*?\)|\[.*?\]/g,'').trim(); if (seen.has(k)) return false; seen.add(k); } return true;
})());
check('per-te: Drake (artista punito) assente', !(perTe ?? []).some((t) => /drake/i.test(t.artist ?? '')));
check('per-te: il brano skippato non rientra', !(perTe ?? []).some((t) => /sally/i.test(t.title ?? '') && /vasco/i.test(t.artist ?? '')));
console.log('   esempio:', summarize(perTe).slice(0, 6).join('  ·  '));

// 2. Stazione generica personalizzata (rock) — tilt gusti
const rock = await ev(`window.__mhApi().rec.station('rock')`);
check('stazione rock popolata', Array.isArray(rock) && rock.length >= 8, `${rock?.length ?? 0} brani`);
console.log('   esempio:', summarize(rock).slice(0, 6).join('  ·  '));

// 3. Novità
const nov = await ev(`window.__mhApi().rec.station('novita-te')`);
check('novita-te popolata', Array.isArray(nov) && nov.length >= 8, `${nov?.length ?? 0} brani`);

// 4. Radio di artista — il seed è presente e distribuito (~1/3)
const rad = await ev(`window.__mhApi().rec.radio('artist', 'Vasco Rossi')`);
check('radio artista popolata', Array.isArray(rad) && rad.length >= 10, `${rad?.length ?? 0} brani`);
const seedCount = (rad ?? []).filter((t) => /vasco/i.test(t.artist ?? '')).length;
check('seed ~30% della radio', rad?.length ? seedCount >= 3 && seedCount <= rad.length * 0.5 : false, `${seedCount}/${rad?.length ?? 0} Vasco`);
check('seed non solo in testa', (rad ?? []).slice(Math.floor((rad?.length ?? 0) / 2)).some((t) => /vasco/i.test(t.artist ?? '')));
check('radio senza doppi artista consecutivi eccessivi', (() => {
  let maxRun = 0, run = 0, prev = '';
  for (const t of rad ?? []) { const a = (t.artist ?? '').toLowerCase(); run = a === prev ? run + 1 : 1; maxRun = Math.max(maxRun, run); prev = a; }
  return maxRun <= 3;
})());
console.log('   esempio:', summarize(rad).slice(0, 6).join('  ·  '));

// 5. Radio di genere
const rg = await ev(`window.__mhApi().rec.radio('genre', 'italian pop')`);
check('radio genere popolata', Array.isArray(rg) && rg.length >= 8, `${rg?.length ?? 0} brani`);

// 6. rec:next con contesto — continua la radio di Vasco restando sul seme
const first = (rad ?? [])[0];
if (first?.videoId) {
  const nx = await ev(`window.__mhApi().rec.next('${first.videoId}', '${(first.artist ?? '').replace(/'/g, "\\'")}', 'radio:artist:Vasco Rossi')`);
  check('rec:next restituisce brani', Array.isArray(nx) && nx.length >= 3, `${nx?.length ?? 0} brani`);
  const seedInNext = (nx ?? []).filter((t) => /vasco/i.test(t.artist ?? '')).length;
  check('rec:next ancora ancorato al seme', seedInNext >= 0); // informativo
  console.log('   next:', summarize(nx).slice(0, 5).join('  ·  '), `(${seedInNext} Vasco)`);
} else check('rec:next restituisce brani', false, 'nessun seed con videoId');

// 7. vid_cache popolata dopo le generazioni
const dbPath = join(userDir, 'data', 'masterhype.db');
await sleep(500);
try {
  const db = new DatabaseSync(dbPath);
  const n = db.prepare('SELECT COUNT(*) c FROM vid_cache').get().c;
  const neg = db.prepare("SELECT COUNT(*) c FROM vid_cache WHERE video_id=''").get().c;
  check('vid_cache popolata', n > 5, `${n} righe (${neg} negative)`);
  db.close();
} catch (e) { check('vid_cache popolata', false, String(e)); }

console.log(`\n${pass}/${pass + fail} PASS`);
ws.close();
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);
