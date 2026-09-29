import { ev, enableLogs, getLogs, sleep, close } from '../cdp-test.mjs';
await enableLogs();
// riparti dal brano in coda
await ev(`(()=>{const p=window.__app.getState().player;window.__app.getState().play(p.queue[p.queueIndex]||p.queue[0], p.queue, p.queueIndex>=0?p.queueIndex:0)})()`);
await sleep(4000);
// apri NowPlaying
await ev(`[...document.querySelectorAll('button')].find(b=>b.title==='Apri video e testo')?.click()`);
await sleep(2500);
// stato tab + lista coda
console.log('tabs:', JSON.stringify(await ev(`[...document.querySelectorAll('button')].filter(b=>/^(Testo|In coda)$/.test(b.textContent?.trim()||'')).map(b=>b.textContent.trim())`)));
// click tab coda
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()==='In coda')?.click()`);
await sleep(600);
console.log('queueRows:', JSON.stringify(await ev(`(()=>{
  const list=[...document.querySelectorAll('img')].length;
  const cur=document.querySelector('.bg-accent\/10');
  return {imgs:list, hasCur:!!cur, curTxt:cur?.textContent?.slice(0,50)};
})()`)));
// salta a un brano dalla coda (3° elemento)
await ev(`(()=>{const rows=[...document.querySelectorAll('.group.flex.items-center.gap-2\\.5')];rows[5]?.click();return rows.length})()`);
await sleep(2500);
console.log('afterJump:', JSON.stringify(await ev(`(()=>{const p=window.__app.getState().player;return {idx:p.queueIndex,cur:p.current?.title,playing:p.playing}})()`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
