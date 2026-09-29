import { ev, enableLogs, getLogs, sleep, close } from '../cdp-test.mjs';
await enableLogs();
const st = await ev(`(()=>{const p=window.__app.getState().player;return {len:p.queue.length,cur:p.current?.title,playing:p.playing}})()`);
console.log('state:', JSON.stringify(st));
const btn = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.title==='In coda');if(!b)return 'nobtn';const r=b.getBoundingClientRect();b.click();return {x:r.x,y:r.y}})()`);
console.log('btn:', JSON.stringify(btn));
await sleep(800);
console.log('panel2:', JSON.stringify(await ev(`(()=>{
  const els=[...document.querySelectorAll('*')].filter(x=>x.children.length===0&&/^In coda ·/.test(x.textContent||''));
  return els.map(x=>{const p=x.closest('div[class*=absolute]');const r=p?.getBoundingClientRect();return {txt:x.textContent,rect:r?{x:+r.x|0,y:+r.y|0,w:+r.width|0,h:+r.height|0}:null}});
})()`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
