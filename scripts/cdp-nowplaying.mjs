// Test CDP della vista Now Playing: video muto + testo LRCLIB
import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';

await enableLogs();

// 1. Avvia un brano remoto (Vasco - Albachiara, videoId reale)
console.log('play:', await ev(`
  (async () => {
    const s = window.masterhype;
    const res = await s.yt.search('Albachiara Vasco Rossi');
    const t = res?.[0];
    if (!t) return 'no results';
    window.__t = t;
    // usa lo store zustand esposto? no — usa l'API diretta non possiamo. Simula click UI:
    return { title: t.title, artist: t.artist, videoId: t.videoId, dur: t.durationS };
  })()
`));

// 2. Suona il primo risultato cliccando la riga nella UI? Più semplice: store non è globale.
//    Uso la search UI? No — provo a chiamare play via DOM: vai su Cerca.
await ev(`(() => { document.querySelectorAll('button').forEach(b=>{}); return 1 })()`);

// Forzo il play dallo store via React internals non accessibili → uso l'approccio UI:
// naviga su Cerca, digita, clicca play sulla prima riga
await ev(`(() => {
  const btns = [...document.querySelectorAll('button')];
  const nav = btns.find(b => /cerca/i.test(b.textContent||''));
  nav?.click(); return !!nav;
})()`);
await sleep(800);
await ev(`(() => {
  const inp = document.querySelector('main input');
  if (!inp) return 'no input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(inp, 'Albachiara Vasco Rossi');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'typed';
})()`);
await sleep(2500);

// Click play sulla prima riga (bottone play della TrackRow)
console.log('row click:', await ev(`(() => {
  const rows = [...document.querySelectorAll('main .group')];
  const r = rows.find(x => x.textContent?.includes('Albachiara'));
  if (!r) return 'no row';
  r.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  const btn = r.querySelector('button');
  btn?.click();
  return 'clicked: ' + (btn?.title || '');
})()`));
await sleep(2500);
console.log('playing:', await ev(`document.querySelector('audio')?.src?.slice(0,40) + ' | paused=' + document.querySelector('audio')?.paused`));

// 3. Apri la vista Now Playing (bottone ChevronUp nel player)
console.log('np open:', await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('Video e testo'));
  b?.click(); return !!b;
})()`));
await sleep(4000);

// 4. Verifica: video element presente? muto? lyrics?
console.log('video:', await ev(`(() => {
  const v = document.querySelector('video');
  return v ? { src: v.src.slice(0, 50), muted: v.muted, paused: v.paused, t: v.currentTime } : 'no video el';
})()`));
console.log('lyrics:', await ev(`(() => {
  const col = [...document.querySelectorAll('div')].find(d => d.textContent === 'Testo');
  const box = document.querySelector('.w-\\\\[380px\\\\]') || document.querySelector('[class*="380px"]');
  const rows = document.querySelectorAll('video ~ * , .whitespace-pre-line');
  const np = document.querySelector('.fixed.left-56');
  return np ? np.textContent.slice(0, 200) : 'no panel';
})()`));

await sleep(3000);
console.log('video t after:', await ev(`(() => { const v=document.querySelector('video'); return v? {t:v.currentTime, paused:v.paused, muted:v.muted}:'none' })()`));
console.log('logs:', getLogs().slice(0, 8));
close();
