import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';
await enableLogs();
console.log('state:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {len:p.queue.length,cur:p.current?.title,playing:p.playing}})()`)));
// il bottone esiste?
console.log('npbtn:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].filter(b=>/testo|Video/i.test(b.title||'')).map(b=>({t:b.title,dis:b.disabled}))`)));
// audio state
console.log('audio:', JSON.stringify(await ev(`[...document.querySelectorAll('audio')].map(a=>({src:!!a.src,paused:a.paused,t:+a.currentTime.toFixed(1)}))`)));
// forza apertura NowPlaying clickando la cover
await ev(`[...document.querySelectorAll('button')].find(b=>b.title==='Apri video e testo')?.click()`);
await sleep(1200);
console.log('npOpen?', JSON.stringify(await ev(`!!document.querySelector('.fixed.left-56')`)));
console.log('tabs2:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].map(b=>b.textContent?.trim()).filter(t=>t==='Testo'||t==='In coda')`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,6)));
close();
