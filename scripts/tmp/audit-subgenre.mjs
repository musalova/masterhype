// Audit rapido nuove stazioni genere/sottogenere: popolamento, zero 'Sconosciuto',
// pertinenza tematica. Istanza ISOLATA su user-data-dir temp.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userDir = mkdtempSync(join(tmpdir(), 'mh-audit-sub-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9225', `--user-data-dir=${userDir}`], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

for (let i = 0; i < 90; i++) {
  try {
    const pages = await (await fetch('http://127.0.0.1:9225/json')).json();
    if (pages.find((p) => p.type === 'page')) break;
  } catch { }
  await sleep(500);
}
const page = (await (await fetch('http://127.0.0.1:9225/json')).json()).find((p) => p.type === 'page');
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
// Gusti volutamente OFF-genere rispetto a jazz/blues: se il tilt è troppo
// permissivo questi preferiti entrano in scaletta (il bug segnalato).
await ev(`window.__mhApi().library.tasteSeed(['Vasco Rossi', 'Nirvana', 'Sfera Ebbasta', 'Drake'])`);
const OFF = /vasco|sfera|drake|nirvana/i;

for (const id of ['trap-it', 'grunge', 'bossa', 'jazz', 'blues', 'cantautori']) {
  const list = await ev(`window.__mhApi().rec.station('${id}')`);
  const n = list?.length ?? 0;
  const unkn = (list ?? []).filter((t) => /sconosciuto/i.test(t.artist ?? '')).length;
  const offGenre = (list ?? []).filter((t) => OFF.test(t.artist ?? ''));
  check(`${id}: popolata`, n >= 6, `${n} brani`);
  check(`${id}: zero artisti sconosciuti`, unkn === 0, `${unkn} sconosciuti`);
  // Nirvana nella stazione grunge è corretto (è il genere); altrove è bug.
  if (id !== 'grunge' && id !== 'trap-it')
    check(`${id}: niente preferiti fuori genere`, offGenre.length === 0, offGenre.map((t) => t.artist).join(',') || 'ok');
  console.log('   esempio:', (list ?? []).slice(0, 5).map((t) => `${t.artist}|${t.title}`).join('  ·  '));
}
console.log(`\n${pass}/${pass + fail} PASS`);
ws.close();
proc.kill('SIGKILL');
process.exit(fail ? 1 : 0);
