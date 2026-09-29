import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';
await enableLogs();
// niente autoplay al boot: audio deve restare in pausa
await sleep(2000);
console.log('bootNoAutoplay:', JSON.stringify(await ev(`[...document.querySelectorAll('audio')].map(a=>a.paused)`)));
// apri NowPlaying e vai su In coda
await ev(`[...document.querySelectorAll('button')].find(b=>b.title==='Apri video e testo')?.click()`);
await sleep(800);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='In coda')?.click()`);
await sleep(700);
console.log('queueUI:', JSON.stringify(await ev(`(()=>{
  const rows=document.querySelectorAll('.fixed .group').length;
  const radio=document.body.textContent.includes('Radio infinita');
  return {rows, radio};
})()`)));
// click su un brano della coda → salto diretto
await ev(`(()=>{const rows=[...document.querySelectorAll('.fixed .group')];rows[6]?.click();return rows.length})()`);
await sleep(3500);
console.log('afterJump:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {idx:p.queueIndex,cur:p.current?.title,playing:p.playing}})()`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
