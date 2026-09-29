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

// 1. Restore coda: era attiva una stazione prima del riavvio?
const r0 = await ev(`(() => {
  const p = window.__app.getState().player;
  return { queueLen: p.queue.length, current: p.current?.title, playing: p.playing, radio: p.radio };
})()`);
console.log('QUEUE RESTORED:', JSON.stringify(r0.result.result.value));

// 2. Dislike: rimuove dalla coda + registra evento 'hide'
const r1 = await ev(`(async () => {
  const s = window.__app.getState();
  await s.startStation('anni80');
  const st = window.__app.getState();
  const t = st.player.queue[2];
  const before = st.player.queue.length;
  st.dislike(t);
  await new Promise(r => setTimeout(r, 400));
  const after = window.__app.getState().player.queue.length;
  const stillIn = window.__app.getState().player.queue.some(x => x.videoId === t.videoId);
  return { target: t.artist + ' - ' + t.title, before, after, stillIn };
})()`);
console.log('DISLIKE:', JSON.stringify(r1.result.result.value));

// 3. Evento 'hide' salvato con metadati? (check via una seconda chiamata esplicita)
const r2 = await ev(`(async () => {
  await window.masterhype.library.remoteEvent({ artist: 'Test Band', title: 'Test Song', videoId: 'zz9', type: 'skip' });
  await window.masterhype.library.remoteEvent({ artist: 'Test Band', title: 'Test Song', videoId: 'zz9', type: 'skip' });
  const recent = await window.masterhype.library.recent(10);
  return { recentLen: recent.length, recentSample: recent.slice(0,3).map(t => t.artist + ' - ' + t.title + (t.id ? ' [local]' : ' [remote]')) };
})()`);
console.log('RECENT (remote events with meta):', JSON.stringify(r2.result.result.value));

// 4. Stazione con filtro: dislike su un artista → stazione non lo ripropone
const r3 = await ev(`(async () => {
  const s = window.__app.getState();
  // dislike forte: hide ×3 su un artista di chart
  const res = await window.masterhype.yt.search('geolier');
  const t = res.songs[0];
  for (let i = 0; i < 3; i++) await window.masterhype.library.remoteEvent({ artist: 'Geolier', title: 'X' + i, videoId: 'gz' + i, type: 'hide' });
  await s.startStation('novita-te');
  const q = window.__app.getState().player.queue;
  return { queueLen: q.length, hasGeolier: q.some(x => /geolier/i.test(x.artist)) };
})()`);
console.log('STATION FILTER (Geolier hidden):', JSON.stringify(r3.result.result.value));

// 5. Libreria Preferiti mostra i like remoti
const r4 = await ev(`(async () => {
  window.__app.getState().nav('library');
  await new Promise(r => setTimeout(r, 500));
  const btns = [...document.querySelectorAll('button')];
  const pref = btns.find(b => /Preferiti/.test(b.textContent));
  pref?.click();
  await new Promise(r => setTimeout(r, 400));
  const rows = document.querySelectorAll('main .group.flex').length;
  const hearts = [...document.querySelectorAll('main button')].filter(b => b.title === 'Togli dai preferiti').length;
  return { rows, filledHearts: hearts };
})()`);
console.log('LIBRARY PREFERITI:', JSON.stringify(r4.result.result.value));

// 6. Gradiente stazioni renderizzato? (Tailwind dynamic class check)
const r5 = await ev(`(async () => {
  window.__app.getState().nav('stations');
  await new Promise(r => setTimeout(r, 600));
  const card = document.querySelector('main section > div > button');
  const bg = card ? getComputedStyle(card).backgroundImage : 'none';
  return { hasGradient: bg.includes('gradient'), bg: bg.slice(0, 80) };
})()`);
console.log('CARD GRADIENT:', JSON.stringify(r5.result.result.value));

ws.close();
process.exit(0);
