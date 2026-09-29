import { ev, enableLogs, getLogs, sleep } from './cdp-test.mjs';
await enableLogs();

// 1. Pannello gusti in Impostazioni
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/impostazioni/i.test(x.textContent||'')); b?.click(); return !!b })()`);
await sleep(900);
console.log('taste panel:', await ev(`(() => {
  const t = document.body.innerText;
  return { has: t.includes('profilo gusti'), artisti: t.includes('Artisti che ami'), penalizzati: t.includes('penalizzati') };
})()`));

// 2. Preferiti: banner "scarica tutti" + queue mista
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^libreria$/i.test(x.textContent||'')); b?.click(); return !!b })()`);
await sleep(700);
await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/preferiti/i.test(x.textContent||'')); b?.click(); return !!b })()`);
await sleep(600);
console.log('preferiti:', await ev(`(() => ({
  banner: document.body.innerText.includes('solo in streaming'),
  scaricaTutti: !![...document.querySelectorAll('button')].find(x=>/scarica tutti/i.test(x.textContent||''))
}))()`));

// 3. Radio al next manuale a fine coda: simulo — store.__app esiste
console.log('radio-next:', await ev(`(async () => {
  const app = window.__app.getState();
  const q = app.player.queue;
  if (!q.length) return 'queue vuota';
  // porta la coda all'ultimo e attiva radio
  window.__app.setState(s => ({ player: { ...s.player, queueIndex: q.length - 1, current: q[q.length-1], radio: true, playing: true } }));
  window.__app.getState().next();
  await new Promise(r => setTimeout(r, 3000));
  const p = window.__app.getState().player;
  return { grew: p.queue.length > q.length, playing: p.playing, idx: p.queueIndex, len: p.queue.length };
})()`));

console.log('errors:', getLogs().filter(l => l.startsWith('error')).slice(0,5));
process.exit(0);
