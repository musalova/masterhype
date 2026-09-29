// Audit PARITÀ telefono ↔ desktop (v0.4): serve out/renderer in Chrome come
// client remoto e verifica via CDP che, SENZA PC, il telefono abbia le stesse
// funzioni del desktop — e che al pairing tutto arrivi al PC.
//   1) standalone: playlist local-first (crea, aggiungi qualsiasi brano,
//      rinomina, sposta, togli) visibili subito e dopo reload
//   2) gusti/recenti/statistiche dai segnali locali
//   3) backup del dispositivo esportabile/reimportabile (niente token)
//   4) UI: niente "CD" né download-sul-PC in standalone, Assistente in nav,
//      Download mostra la memoria del telefono, Impostazioni con I tuoi dati
//   5) [opz.] pairing a un PC vero (MH_PC=http://127.0.0.1:48499 MH_TOKEN=…):
//      drain → la playlist creata offline nasce sul PC con id vero
// Uso: npm run build && node scripts/audit-parity.mjs
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { spawn } from 'child_process';

const ROOT = 'out/renderer';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = createServer(async (req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  try {
    const p = join(ROOT, u === '/' ? 'index.html' : u);
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    res.end(b);
  } catch {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(await readFile(join(ROOT, 'index.html')));
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
const prof = `${process.env.TEMP}\\mh-parity-${Date.now()}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--remote-debugging-port=9235', `--user-data-dir=${prof}`, '--no-first-run', '--disable-web-security', BASE,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
let wsRef = null;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

try {
  let pages;
  for (let i = 0; i < 30 && !pages?.length; i++) { await sleep(500); try { pages = (await (await fetch('http://127.0.0.1:9235/json')).json()).filter((p) => p.type === 'page' && p.url.startsWith(BASE)); } catch {} }
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  wsRef = ws;
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (mth, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: mth, params: p })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    const v = r.result?.result;
    if (v && v.value !== undefined) return v.value;
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return null;
  };
  await send('Runtime.enable', {}); await send('Page.enable', {});
  const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr).catch(() => false)) return true; await sleep(200); } return false; };
  const reload = async () => { await send('Page.navigate', { url: BASE }); await waitFor('!!window.__app'); await sleep(1500); };
  const text = () => ev('document.body.innerText');

  await sleep(2500);
  await ev(`localStorage.setItem('mh-standalone','1'); localStorage.setItem('mh-standalone-era','1')`);
  await reload();
  check('standalone attivo', await ev('__mhRemote.isStandalone() && !__mhRemote.isOnline()'));

  // ---- 1) Playlist local-first ----
  const pl = JSON.parse(await ev(`(async () => {
    const api = window.__mhApi();
    const p = await api.playlists.create('Viaggio offline', 'lista');
    await api.playlists.addRef(p.id, { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', source: 'ytmusic' });
    await api.playlists.addRef(p.id, { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', source: 'ytmusic' });
    await api.playlists.rename(p.id, 'Viaggio 2026');
    const l1 = await api.playlists.list();
    const cur = l1.find(x => x.id === p.id);
    await api.playlists.move(p.id, cur.tracks[1].id, -1);
    const l2 = await api.playlists.list();
    return JSON.stringify({ id: p.id, name: l2.find(x => x.id === p.id)?.name, order: l2.find(x => x.id === p.id)?.tracks.map(t => t.artist) });
  })()`));
  check('create offline → id temporaneo negativo', pl.id < 0, String(pl.id));
  check('rename offline visibile', pl.name === 'Viaggio 2026', pl.name);
  check('addRef + move offline visibili', JSON.stringify(pl.order) === JSON.stringify(['Queen', 'Rick Astley']), JSON.stringify(pl.order));
  await reload();
  const afterReload = JSON.parse(await ev(`window.__mhApi().playlists.list().then(l => JSON.stringify(l.map(p => [p.name, p.tracks.length])))`));
  check('playlist sopravvive al riavvio', afterReload.some(([n, c]) => n === 'Viaggio 2026' && c === 2), JSON.stringify(afterReload));
  const rm = await ev(`(async () => { const api = window.__mhApi(); const l = await api.playlists.list(); const p = l.find(x => x.name === 'Viaggio 2026'); await api.playlists.removeTrack(p.id, p.tracks[0].id); return (await api.playlists.list()).find(x => x.id === p.id).tracks.length; })()`);
  check('togli brano offline', rm === 1, String(rm));
  const tmp = await ev(`(async () => { const api = window.__mhApi(); const p = await api.playlists.create('Da buttare', 'lista'); await api.playlists.remove(p.id); const q = JSON.parse(localStorage.getItem('mh-pending-pl:u1')); return JSON.stringify({ gone: !(await api.playlists.list()).some(x => x.name === 'Da buttare'), compact: !q.some(o => o.args[0] === 'Da buttare') }); })()`);
  check('crea+elimina offline → compattato via dalla coda', JSON.parse(tmp).gone && JSON.parse(tmp).compact, tmp);

  // ---- 2) Gusti / recenti / statistiche ----
  await ev(`(() => { const s = __app.getState(); const t = { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', source: 'ytmusic' }; s.recordRemote(t, 'play'); s.recordRemote(t, 'play'); s.toggleLike(t); })()`);
  await sleep(300);
  const taste = await ev(`window.__mhApi().library.taste('artist').then(r => r[0]?.value)`);
  check('gusti locali dai segnali', taste === 'queen', String(taste));
  const recent = await ev(`window.__mhApi().library.recent(5).then(r => r.map(t => t.videoId).join(','))`);
  check('ascoltati di recente senza PC', String(recent).startsWith('fJ9rUzIMcZQ'), String(recent));
  const stats = JSON.parse(await ev(`window.__mhApi().library.stats().then(JSON.stringify)`));
  check('statistiche locali (playlist + top artisti)', stats.playlistCount >= 1 && stats.topArtists[0]?.artist === 'queen', JSON.stringify(stats).slice(0, 120));

  // ---- 3) Backup dispositivo ----
  // In browser il file va nei download di Chrome (nell'APK: plugin Files → Download/MasterHype)
  const exp = await ev(`window.__mhApi().backup.export().then(String).catch(e => 'ERR ' + e.message)`);
  check('backup esportato sul dispositivo', /^masterhype-backup-\d{4}-\d{2}-\d{2}\.json$/.test(exp), exp);
  const imp = await ev(`(async () => {
    const dev = { app: 'masterhype-device', version: 1, exportedAt: 1, user: 1, keys: { 'mh-pref-test-import': '"ok"' } };
    const r = await window.__mhApi().backup.import({ app: 'masterhype-bundle', version: 1, profile: null, device: dev });
    return JSON.stringify({ r, v: localStorage.getItem('mh-pref-test-import') });
  })()`);
  check('backup reimportato (dati dispositivo)', JSON.parse(imp).v === '"ok"', imp);

  // ---- 4) UI ----
  await ev(`__app.getState().nav('search')`); await sleep(600);
  const nav = await text();
  check('nav: "Assistente" al posto di "CD" senza PC', /Assistente/.test(nav) && !/\nCD\n/.test(nav));
  await ev(`__app.getState().nav('playlists')`); await sleep(1200);
  check('schermata Playlist mostra la playlist offline', (await text()).includes('Viaggio 2026'));
  await ev(`__app.getState().nav('downloads')`); await sleep(800);
  check('Download: sezione "Sul telefono"', /sul telefono/i.test(await text()));
  await ev(`__app.getState().nav('settings')`); await sleep(1200);
  const st = await text();
  check('Impostazioni senza PC: backup + import file + report', /Backup/.test(st) && /Importa file audio/.test(st) && /Report diagnostica/.test(st));
  check('Impostazioni senza PC: profilo gusti visibile', /queen/i.test(st));

  // ---- 5) Pairing a un PC vero (opzionale) → drain ----
  const PC = process.env.MH_PC, TOKEN = process.env.MH_TOKEN;
  if (PC && TOKEN) {
    // Niente download VERI sul PC di test: si svuota la playlist (la
    // compattazione annulla gli addRef) → al PC arriva create+rename.
    await ev(`(async () => { const api = window.__mhApi(); const p = (await api.playlists.list()).find(x => x.name === 'Viaggio 2026'); for (const t of p.tracks) await api.playlists.removeTrack(p.id, t.id); })()`);
    await ev(`__mhRemote.saveRemoteConf(${JSON.stringify(PC)}, ${JSON.stringify(TOKEN)}, 1)`);
    await reload();
    await waitFor('__mhRemote.isOnline()', 15000);
    await sleep(6000); // drain al primo connect
    const onPc = await (await fetch(`${PC}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MH-Token': TOKEN }, body: JSON.stringify({ c: 'pl:list', a: [] }) })).json();
    const got = (onPc.r ?? []).find((p) => p.name === 'Viaggio 2026');
    check('drain: playlist offline creata sul PC con id vero', !!got && got.id > 0, got ? `id ${got.id}` : 'assente');
    const q = JSON.parse(await ev(`localStorage.getItem('mh-pending-pl:u1') || '[]'`));
    check('coda playlist svuotata (o solo download in attesa)', q.every((o) => o.op === 'addRef'), JSON.stringify(q).slice(0, 160));
    if (got) await fetch(`${PC}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MH-Token': TOKEN }, body: JSON.stringify({ c: 'pl:delete', a: [got.id] }) });
  } else console.log('SKIP  pairing/drain (imposta MH_PC e MH_TOKEN per provarlo)');
} catch (e) {
  console.log('FAIL  eccezione:', e?.message ?? e); fail++;
} finally {
  try { wsRef?.close(); } catch { /* */ }
  chrome.kill(); srv.close();
  console.log(fail ? `\n${fail} FAIL` : '\nTUTTI PASS');
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
