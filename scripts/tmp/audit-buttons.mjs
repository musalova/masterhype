// Audit tasti: naviga ogni schermata del dev-server (CDP :9222), enumera i
// bottoni visibili, clicca quelli non distruttivi e raccoglie errori JS.
// Uso: node scripts/tmp/audit-buttons.mjs
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = await (await fetch(`${CDP}/json`)).json();
const page = pages.find((p) => p.type === 'page');
if (!page) { console.error('nessuna pagina CDP'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown')
    errors.push('EXCEPTION: ' + (d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text ?? '').slice(0, 250));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    errors.push('console.error: ' + JSON.stringify(d.params.args.map((a) => a.value ?? a.description ?? '')).slice(0, 250));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e, t = 15000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }),
    sleep(t).then(() => ({ result: { exceptionDetails: { exception: { description: `TIMEOUT ${t}ms` } } } })),
  ]);
  if (r.result?.exceptionDetails) errors.push('EV: ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 200));
  return r.result?.result?.value;
};

await send('Runtime.enable', {});
await send('Page.enable', {});
await send('Page.reload', { ignoreCache: true }); // build fresco da file://
await sleep(4500);

await ev(`window.__unhandled=[];addEventListener('unhandledrejection',e=>__unhandled.push(String(e.reason).slice(0,200)))`);

// Parole che indicano azioni distruttive: non le clicco live.
const DESTRUCTIVE = /elimin|rimuov|cancell|revoc|reset|svuota|masterizz|burn|espelli|scolleg|disassocia|termina|format/i;
const SCREENS = ['home', 'stations', 'search', 'library', 'playlists', 'cd', 'trends', 'assistant', 'downloads', 'settings'];

const report = {};
for (const screen of SCREENS) {
  await ev(`window.__app.getState().nav('${screen}')`);
  await sleep(1400);
  const btns = await ev(`[...document.querySelectorAll('button')].map((b,i)=>{
    const r=b.getBoundingClientRect();
    const cs=getComputedStyle(b);
    return {i,text:(b.innerText||b.title||b.getAttribute('aria-label')||'').trim().replace(/\\n/g,' ').slice(0,60),
      dis:b.disabled, vis:r.width>2&&r.height>2&&cs.visibility!=='hidden'&&cs.display!=='none'};
  })`, 8000);
  const list = (btns ?? []).filter((b) => b.vis);
  report[screen] = { total: list.length, clicked: 0, noResp: [], skipped: [] };
  for (const b of list) {
    if (b.dis) { report[screen].skipped.push('disabled: ' + (b.text || '?')); continue; }
    if (DESTRUCTIVE.test(b.text)) { report[screen].skipped.push('destructive: ' + (b.text || '?')); continue; }
    const hit = await ev(`(()=>{const bs=[...document.querySelectorAll('button')];const t=${JSON.stringify(b.text)};const m=bs.filter(x=>{const r=x.getBoundingClientRect();return r.width>2&&r.height>2}).find(x=>((x.innerText||x.title||x.getAttribute('aria-label')||'').trim().replace(/\\n/g,' ').slice(0,60))===t);if(!m)return 0;m.click();return 1})()`, 4000);
    if (hit === 1) report[screen].clicked++; else report[screen].noResp.push(b.text || '?');
    await sleep(240);
  }
}

// ---- flussi mirati ----
const flows = {};
await ev(`window.__app.getState().nav('search')`);
await sleep(1200);
flows.suggest = await ev(`(async()=>{try{const r=await window.__mhApi.yt.suggest('vasco');return {n:r.length,first:r.slice(0,3)}}catch(e){return 'ERR '+e}})()`);
flows.search = await ev(`(async()=>{try{const r=await window.__mhApi.search.query('vasco rossi');return {songs:r.songs?.length??-1,first:r.songs?.[0]?.title}}catch(e){return 'ERR '+e}})()`, 50000);
flows.tasteArtist = await ev(`(async()=>{try{const r=await window.__mhApi.library.taste('artist');return {n:r.length,top:r.slice(0,3).map(x=>x.value)}}catch(e){return 'ERR '+e}})()`);
flows.playLib = await ev(`(async()=>{try{const s=window.__app.getState();const t=s.library.find(x=>x.filePath);if(!t)return 'no-lib-track';s.play(t,[t],0);await new Promise(r=>setTimeout(r,1800));const p=window.__app.getState().player;return {cur:!!p.current,playing:p.playing}}catch(e){return 'ERR '+e}})()`, 25000);
// stop player dopo il test
await ev(`window.__app.getState().pause?.()`);

const unhandled = await ev('window.__unhandled ?? []');

console.log('=== BOTTONI PER SCHERMATA ===');
let totC = 0, totB = 0;
for (const [s, r] of Object.entries(report)) {
  totC += r.clicked; totB += r.total;
  console.log(`${s.padEnd(10)} ${r.clicked}/${r.total} cliccati · ${r.skipped.length} saltati` + (r.noResp.length ? ' · NON TROVATI: ' + r.noResp.join('|') : ''));
  for (const sk of r.skipped.slice(0, 8)) console.log('   - ' + sk);
}
console.log(`\nTOTALE: ${totC}/${totB} bottoni cliccati`);
console.log('\n=== FLUSSI ===');
console.log(JSON.stringify(flows, null, 1).slice(0, 1500));
console.log('\n=== ERRORI CONSOLE (' + errors.length + ') ===');
errors.slice(0, 25).forEach((e) => console.log('  ' + e));
console.log('unhandled:', JSON.stringify(unhandled ?? []));
ws.close();
process.exit(0);
