// Test CDP: like remoto + stazioni
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

// 1. Like remoto: cerca un brano, toggleLike, verifica remoteLiked + persistenza DB
const r1 = await ev(`(async () => {
  const s = window.__app.getState();
  const res = await window.masterhype.yt.search('vasco rossi albachiara');
  const t = res.songs[0];
  s.toggleLike(t);
  await new Promise(r => setTimeout(r, 400));
  const remote = await window.masterhype.library.remoteLikes();
  const st = window.__app.getState();
  return { videoId: t.videoId, likedInState: !!st.remoteLiked[t.videoId], remoteCount: remote.length,
    remoteHasIt: remote.some(r => r.videoId === t.videoId), title: t.title };
})()`);
console.log('LIKE REMOTO:', JSON.stringify(r1.result.result.value));

// 2. Unlike
const r2 = await ev(`(async () => {
  const s = window.__app.getState();
  const vid = Object.keys(s.remoteLiked)[0];
  s.toggleLike({ videoId: vid, title: 'x', artist: 'y', source: 'ytmusic' });
  await new Promise(r => setTimeout(r, 300));
  return { stillLiked: !!window.__app.getState().remoteLiked[vid], remoteCount: (await window.masterhype.library.remoteLikes()).length };
})()`);
console.log('UNLIKE:', JSON.stringify(r2.result.result.value));

// 3. Ri-like per testare la stazione "preferiti"
const r3 = await ev(`(async () => {
  const res = await window.masterhype.yt.search('calcutta del verde');
  const t = res.songs[0];
  window.__app.getState().toggleLike(t);
  await new Promise(r => setTimeout(r, 300));
  return { liked: Object.keys(window.__app.getState().remoteLiked) };
})()`);
console.log('RE-LIKE:', JSON.stringify(r3.result.result.value));

// 4. Stazione "preferiti": deve contenere i remote likes
const r4 = await ev(`(async () => {
  const s = window.__app.getState();
  await s.startStation('preferiti');
  const st = window.__app.getState();
  return { queueLen: st.player.queue.length, radio: st.player.radio, playing: st.player.playing,
    first: st.player.current?.artist + ' - ' + st.player.current?.title };
})()`);
console.log('STAZIONE PREFERITI:', JSON.stringify(r4.result.result.value));
await sleep(1500);

// 5. Stazione mood generica
const r5 = await ev(`(async () => {
  await window.__app.getState().startStation('anni90');
  const st = window.__app.getState();
  return { queueLen: st.player.queue.length, radio: st.player.radio, first: st.player.current?.artist + ' - ' + st.player.current?.title };
})()`);
console.log('STAZIONE ANNI90:', JSON.stringify(r5.result.result.value));

// 6. Stazione "per te" (usa profilo gusti)
const r6 = await ev(`(async () => {
  await window.__app.getState().startStation('per-te');
  const st = window.__app.getState();
  return { queueLen: st.player.queue.length, first: st.player.current?.artist + ' - ' + st.player.current?.title,
    artists: st.player.queue.slice(0, 8).map(t => t.artist) };
})()`);
console.log('STAZIONE PER-TE:', JSON.stringify(r6.result.result.value));

// 7. Nav + errori console
const r7 = await ev(`(() => {
  window.__app.getState().nav('stations');
  return document.title;
})()`);
await sleep(800);
const cards = await ev(`document.querySelectorAll('main section').length + '|' + document.querySelectorAll('main button').length`);
console.log('STATIONS UI:', JSON.stringify(cards.result.result.value));

// errori console
const errs = await ev(`window.__errs ?? 'none'`);
console.log('ERRORS:', JSON.stringify(errs.result.result.value));

ws.close();
process.exit(0);
