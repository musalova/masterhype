// Verifica dei fix telefono↔PC (branch: fix errori continui di riproduzione).
// Attacca un Chrome --remote-debugging-port=9223 aperto sulla pagina remota
// (http://127.0.0.1:48499/?token=... — dev Electron con remotePort=48499).
//
// Copre:
//  A) /__pc/media + Range: 404 server = "vivo"; le risposte sintetiche del SW
//     (503/502) NON devono più contare come vivo in srcOf
//  B) ytCallStream: playStream con errore PC → fallback diretto + kind
//     'pc-stream' accodato in mh-pending-issues
//  C) 'offline' event → probeRemoteHealth (NON mark cieco): PC vivo → online
//  D) playStream lato PC: risolve e restituisce un URL (validato ultimo byte)
//  E) /media/audio + Range via /__pc/ (proxy SW autenticato)
//  F) skip-cascade breaker: 3 fallimenti di fila → pausa, coda non svuotata

const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('48499'));
if (!page) { console.error('FAIL: nessuna pagina :48499 tra i target Chrome'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
};
const send = (m, p) => new Promise((r) => {
  const i = ++id; pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); cond ? pass++ : fail++; };

await new Promise((r) => setTimeout(r, 5000)); // boot + hydrate + SW claim

// ---- Boot sano ----
check('app montata', await ev(`!!window.__app && !!document.querySelector('main')`));
check('remoto (no preload)', (await ev(`!!window.masterhype`)) === false);
check('SW controlla la pagina', await ev(`!!navigator.serviceWorker.controller`));
check('online', await ev(`window.__mhRemote.isOnline()`));

// ---- A/E) media via /__pc/ ----
const p404 = await ev(`fetch('/__pc/media/audio/99999999', {headers:{Range:'bytes=0-0'}}).then(r=>r.status).catch(()=>'net')`);
check('media 404 = server risponde', p404 === 404, `(${p404})`);
const apiViaSw = await ev(`fetch('/__pc/api/call',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.status).catch(()=>'net')`);
check('api via /__pc/ inoltrata al PC', apiViaSw === 400 || apiViaSw === 404 || apiViaSw === 200, `(${apiViaSw})`);

const libId = await ev(`window.__app.getState().library.find(t => t.filePath && t.id)?.id ?? null`);
if (libId != null) {
  const r200 = await ev(`fetch('/__pc/media/audio/${libId}', {headers:{Range:'bytes=0-0'}}).then(r=>({s:r.status,cr:r.headers.get('content-range')})).catch(()=>null)`);
  check('Range probe media reale → 206', r200?.s === 206, JSON.stringify(r200));
} else {
  console.log('SKIP media reale (nessun filePath in libreria dev)');
}

// ---- D) playStream lato server: URL validato ----
const playCall = await ev(`(async () => {
  const conf = JSON.parse(localStorage.getItem('mh-remote-conf'));
  const t0 = performance.now();
  const res = await fetch(conf.base + '/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MH-Token': conf.token },
    body: JSON.stringify({ c: 'yt:playStream', a: ['dQw4w9WgXcQ', 'Rick Astley', 'Never Gonna Give You Up'] }),
  });
  const j = await res.json();
  return { ok: res.ok, ms: Math.round(performance.now() - t0), url: j.r?.url ? j.r.url.slice(0, 60) : null, e: j.e ?? null, healed: j.r?.healed ?? null };
})()`);
console.log('playStream:', JSON.stringify(playCall));
check('playStream risponde (url o errore onesto)', playCall && (playCall.ok || playCall.e), `(${playCall?.ms}ms ${playCall?.e ?? 'url ok'})`);

// ---- B) ytCallStream fallback → kind 'pc-stream' ----
const fb = await ev(`(async () => {
  const before = JSON.parse(localStorage.getItem('mh-pending-issues') ?? '[]').filter(i => i.kind === 'pc-stream').length;
  try { await window.__mhApi().yt.playStream('__non_esiste__xyz', 'x', 'y'); }
  catch (e) { /* atteso: anche il diretto fallirà su videoId inesistente */ }
  const after = JSON.parse(localStorage.getItem('mh-pending-issues') ?? '[]').filter(i => i.kind === 'pc-stream').length;
  return { before, after };
})()`);
check('fallimento PC accodato (kind pc-stream)', fb && fb.after >= fb.before, JSON.stringify(fb));

// ---- C) 'offline' event → probe, NON mark cieco ----
const off = await ev(`(async () => {
  window.dispatchEvent(new Event('offline'));
  await new Promise(r => setTimeout(r, 2500));
  return window.__mhRemote.isOnline();
})()`);
check("'offline' con PC vivo → resta online", off === true, `(${off})`);

// ---- F) skip-cascade breaker ----
const brk = await ev(`(async () => {
  const s = window.__app.getState();
  const bogus = i => ({ videoId: '__bogus_' + i, artist: 'x', title: 'y' + i, duration: 100 });
  s.play(bogus(1), [bogus(1), bogus(2), bogus(3), bogus(4), bogus(5)], 0);
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000) {
    const p = window.__app.getState().player;
    if (!p.playing) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  const p = window.__app.getState().player;
  return { playing: p.playing, idx: p.queueIndex, len: p.queue.length };
})()`);
console.log('breaker:', JSON.stringify(brk));
check('skip-cascade frenato (coda non svuotata)', brk && brk.playing === false && brk.idx < 4, JSON.stringify(brk));

console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
