import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';
await enableLogs();
// stato coda dopo ripristino
console.log('boot:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {len:p.queue.length,idx:p.queueIndex,cur:p.current?.title}})()`)));
// apri il pannello coda
await ev(`[...document.querySelectorAll('button')].find(b=>b.title==='In coda')?.click()`);
await sleep(600);
console.log('panel:', JSON.stringify(await ev(`(()=>{const d=[...document.querySelectorAll('div')].find(x=>x.textContent?.startsWith('In coda ·'));return {found:!!d, rows:document.querySelectorAll('img[loading=lazy]').length}})()`)));
// riproduci dalla Home se possibile
const played = await ev(`(()=>{const r=document.querySelector('main .group');if(r){r.querySelector('button')?.click();return 'clicked'}return 'norow'})()`);
console.log('play:', played);
await sleep(3000);
console.log('after:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {len:p.queue.length,idx:p.queueIndex,playing:p.playing}})()`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
