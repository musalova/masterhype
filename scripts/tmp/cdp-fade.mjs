import { ev, enableLogs, getLogs, sleep } from '../cdp-test.mjs';
await enableLogs();

// Stato: coda ripristinata, in pausa. Metto play e poi skip manuale → deve sfumare
console.log('setup:', await ev(`(() => {
  const s = window.__app.getState().player;
  return { len: s.queue.length, idx: s.queueIndex, cur: s.current?.title, playing: s.playing, xf: s.crossfade };
})()`));

// avvia riproduzione
await ev(`window.__app.getState().toggle()`);
await sleep(2500);
console.log('playing:', await ev(`(() => { const a=document.querySelectorAll('audio'); return [...a].map(x=>({paused:x.paused, t:+x.currentTime.toFixed(1), v:+x.volume.toFixed(2)})) })()`));

// skip manuale → deve partire il fade: due audio che suonano insieme
await ev(`window.__app.getState().next()`);
await sleep(700);
console.log('mid-fade:', await ev(`(() => {
  const a=[...document.querySelectorAll('audio')];
  return { volumes: a.map(x=>+x.volume.toFixed(2)), bothPlaying: a.every(x=>!x.paused), cur: window.__app.getState().player.current?.title };
})()`));
await sleep(1500);
console.log('post-fade:', await ev(`(() => {
  const a=[...document.querySelectorAll('audio')];
  return { volumes: a.map(x=>+x.volume.toFixed(2)), paused: a.map(x=>x.paused), cur: window.__app.getState().player.current?.title };
})()`));

// doppio skip rapido: la seconda dissolvenza deve invalidare la prima senza incastrarsi
await ev(`window.__app.getState().next()`);
await sleep(400);
await ev(`window.__app.getState().next()`);
await sleep(2000);
console.log('rapid double-skip:', await ev(`(() => {
  const a=[...document.querySelectorAll('audio')];
  return { playing: a.filter(x=>!x.paused).length, cur: window.__app.getState().player.current?.title, idx: window.__app.getState().player.queueIndex };
})()`));

console.log('errors:', getLogs().filter(l=>l.startsWith('error')).slice(0,5));
process.exit(0);
