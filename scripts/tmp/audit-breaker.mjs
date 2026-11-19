// Re-test mirato: skip-cascade breaker (finestra lunga) + Range probe su file esistente.
const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('48499'));
if (!page) { console.error('no page'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const send = (m, p) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
let pass = 0, fail = 0;
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); c ? pass++ : fail++; };

// Range probe su file che ESISTE sul disco (dev library: Brava id=16)
const r206 = await ev(`fetch('/__pc/media/audio/16', {headers:{Range:'bytes=0-0'}}).then(r=>({s:r.status,cr:r.headers.get('content-range')})).catch(e=>({e:String(e)}))`);
check('Range probe media reale → 206', r206?.s === 206, JSON.stringify(r206));
const rfull = await ev(`fetch('/__pc/media/audio/16').then(r=>r.status).catch(()=>'net')`);
check('GET media intero → 200', rfull === 200, `(${rfull})`);

// Breaker: finestra 150s (ogni bogus ~25-45s)
const brk = await ev(`(async () => {
  const s = window.__app.getState();
  const bogus = i => ({ videoId: '__bogus_' + i, artist: 'x', title: 'y' + i, duration: 100 });
  const trace = [];
  s.play(bogus(1), [bogus(1), bogus(2), bogus(3), bogus(4), bogus(5)], 0);
  const t0 = Date.now();
  let lastIdx = -1;
  while (Date.now() - t0 < 150_000) {
    const p = window.__app.getState().player;
    if (p.queueIndex !== lastIdx) { trace.push({ t: Math.round((Date.now()-t0)/1000), idx: p.queueIndex }); lastIdx = p.queueIndex; }
    if (!p.playing) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const p = window.__app.getState().player;
  return { playing: p.playing, idx: p.queueIndex, len: p.queue.length, trace, elapsed: Math.round((Date.now()-t0)/1000) };
})()`);
console.log('breaker:', JSON.stringify(brk));
check('cascade fermato (paused, coda non svuotata)', brk && brk.playing === false && brk.idx <= 3, JSON.stringify(brk));

console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);
