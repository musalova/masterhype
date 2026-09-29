const list = await (await fetch('http://localhost:9222/json')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const ev = (expr) => new Promise((res) => {
  const i = ++id;
  pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
});
await new Promise((r) => { ws.onopen = r; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(2500);

// Verifica: Albachiara era in libreria? (spiega il test precedente)
const r0 = await ev(`(async () => {
  const s = window.__app.getState();
  const alb = s.library.find(t => /albachiara/i.test(t.title));
  return { inLib: !!alb, liked: alb?.liked, libSize: s.library.length,
    remoteLikedKeys: Object.keys(s.remoteLiked) };
})()`);
console.log('LIB CHECK:', JSON.stringify(r0.result.result.value));

// Like remoto su brano SICURAMENTE non in libreria
const r1 = await ev(`(async () => {
  const s = window.__app.getState();
  const res = await window.masterhype.yt.search('subsonica tutti i miei sbagli');
  const t = res.songs.find(x => !s.library.some(l => l.videoId === x.videoId));
  s.toggleLike(t);
  await new Promise(r => setTimeout(r, 400));
  const remote = await window.masterhype.library.remoteLikes();
  const st = window.__app.getState();
  return { videoId: t.videoId, likedInState: !!st.remoteLiked[t.videoId],
    remoteHasIt: remote.some(r => r.videoId === t.videoId), remoteCount: remote.length };
})()`);
console.log('LIKE REMOTO VERO:', JSON.stringify(r1.result.result.value));

// Evento skip remoto → peso artista giù?
const r2 = await ev(`(async () => {
  const s = window.__app.getState();
  await window.masterhype.library.remoteEvent('test artist xyz', 'play');
  await window.masterhype.library.remoteEvent('test artist xyz', 'skip');
  return 'ok';
})()`);
console.log('REMOTE EVENT:', JSON.stringify(r2.result.result.value));

// Stazione per-te: verifica interleave artisti
const r3 = await ev(`(async () => {
  await window.__app.getState().startStation('per-te');
  const st = window.__app.getState();
  return { queueLen: st.player.queue.length,
    artists: st.player.queue.slice(0, 10).map(t => t.artist),
    maxConsec: (() => { let m = 1, c = 1; const q = st.player.queue;
      for (let i = 1; i < q.length; i++) { if (q[i].artist === q[i-1].artist) { c++; m = Math.max(m, c); } else c = 1; } return m; })() };
})()`);
console.log('PER-TE INTERLEAVED:', JSON.stringify(r3.result.result.value));

// Stazione novità
const r4 = await ev(`(async () => {
  await window.__app.getState().startStation('novita-te');
  const st = window.__app.getState();
  return { queueLen: st.player.queue.length, first3: st.player.queue.slice(0,3).map(t=>t.artist+' - '+t.title) };
})()`);
console.log('NOVITA:', JSON.stringify(r4.result.result.value));

// Screenshot stazioni
await ev(`window.__app.getState().nav('stations')`);
await sleep(600);
const shot = await new Promise((res) => {
  const i = ++id; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Page.captureScreenshot', params: { format: 'png' } }));
});
const fs = await import('fs');
fs.writeFileSync('stations.png', Buffer.from(shot.result.result.data, 'base64'));
console.log('screenshot salvato');
ws.close();
process.exit(0);
