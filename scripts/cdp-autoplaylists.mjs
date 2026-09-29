// Test live: playlist autogenerate + quick tiles + pannello playlist
import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';

await enableLogs();

// 1) autoplaylist IPC: mix / top / scoperte / nuove
const auto = await ev(`(async () => {
  const out = {};
  for (const id of ['mix','top','scoperte','nuove']) {
    try { const ts = await window.masterhype.rec.autoplaylist(id); out[id] = ts.length; }
    catch (e) { out[id] = 'ERR ' + e.message; }
  }
  return out;
})()`);
console.log('autoplaylists:', JSON.stringify(auto));

// 2) dedup artista|titolo normalizzato nel mix
const dedup = await ev(`(async () => {
  const ts = await window.masterhype.rec.autoplaylist('mix');
  const keys = ts.map((t) => (t.artist + '|' + t.title).toLowerCase().replace(/[^a-z0-9|]/g, ''));
  return { n: ts.length, uniq: new Set(keys).size };
})()`);
console.log('mix dedup:', JSON.stringify(dedup));

// 3) UI: naviga a playlists, conta card "Fatte per te"
await ev(`window.__app.getState().nav('playlists')`);
await sleep(1200);
const ui = await ev(`[...document.querySelectorAll('button')]
  .filter((b) => /Il tuo mix|Scoperte per te|più ascoltate|Nuove uscite|Mix /.test(b.textContent))
  .map((b) => b.textContent.trim().slice(0, 24))`);
console.log('auto cards:', JSON.stringify(ui));

// click "Il tuo mix" → pannello virtuale
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Il tuo mix');
  if (b) b.click();
  return !!b;
})()`);
await sleep(12000); // generazione mix (rete)
const mixPanel = await ev(`(() => {
  const rows = document.querySelectorAll('[class*="divide-y"] > *').length;
  const playBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Riproduci'));
  const rigBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Rigenera'));
  const saveBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Salva playlist'));
  return { rows, playBtn: !!playBtn, rigBtn: !!rigBtn, saveBtn: !!saveBtn };
})()`);
console.log('mix panel:', JSON.stringify(mixPanel));

// 4) Home: quick tiles
await ev(`window.__app.getState().nav('home')`);
await sleep(1500);
const tiles = await ev(`[...document.querySelectorAll('button')]
  .filter((b) => /Il tuo mix|più ascoltate|Scoperte per te|Nuove uscite|La tua stazione|Novità per te/.test(b.textContent)).length`);
console.log('quick tiles:', tiles);

// 5) play da tile "Le tue più ascoltate"
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Le tue più ascoltate');
  if (b) b.click();
  return !!b;
})()`);
await sleep(4000);
const st = await ev(`(() => { const s = window.__app.getState(); return { cur: s.player.current?.title, q: s.player.queue.length, playing: s.player.playing }; })()`);
console.log('after tile play:', JSON.stringify(st));

console.log('logs:', JSON.stringify(getLogs().filter((l) => l.startsWith('error')).slice(0, 5)));
close();
process.exit(0);
