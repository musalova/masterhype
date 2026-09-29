import { ev, enableLogs, getLogs, sleep, close } from '../cdp-test.mjs';
await enableLogs();
await ev(`window.__app.getState().startStation('per-te').catch(()=>{})`);
await sleep(11000);
console.log('station:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {len:p.queue.length,idx:p.queueIndex,cur:p.current?.title,playing:p.playing,radio:p.radio}})()`)));
for (let k = 0; k < 3; k++) { await ev(`window.__app.getState().next()`); await sleep(800); }
await sleep(4000);
console.log('skips:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;const aud=[...document.querySelectorAll('audio')].map(a=>a.paused);return {len:p.queue.length,idx:p.queueIndex,cur:p.current?.title,playing:p.playing,audiosPlaying:aud.filter(x=>!x).length}})()`)));
console.log('lazyImgs:', JSON.stringify(await ev(`document.querySelectorAll('img[loading=lazy]').length`)));
console.log('logs:', JSON.stringify(getLogs().slice(0, 6)));
close();
