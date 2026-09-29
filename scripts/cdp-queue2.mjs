import { ev, sleep, close } from './cdp-test.mjs';
// riproduci un brano vero dalla coda ripristinata
await ev(`(()=>{const p=window.__app.getState().player;window.__app.getState().play(p.queue[p.queueIndex], p.queue, p.queueIndex)})()`);
await sleep(3500);
// apri pannello coda
await ev(`[...document.querySelectorAll('button')].find(b=>b.title==='In coda')?.click()`);
await sleep(700);
const info = await ev(`(()=>{
  const d=[...document.querySelectorAll('div')].find(x=>x.textContent?.startsWith('In coda ·'));
  if(!d) return {found:false};
  const panel=d.closest('.absolute')||d.parentElement?.parentElement;
  const r=panel?.getBoundingClientRect();
  const cs=panel?getComputedStyle(panel):null;
  return {found:true, rect:r?{x:+r.x.toFixed(0),y:+r.y.toFixed(0),w:+r.width.toFixed(0),h:+r.height.toFixed(0)}:null,
    z:cs?.zIndex, pos:cs?.position, vis:cs?.visibility, op:cs?.opacity, clip:cs?.overflow, disp:cs?.display};
})()`);
console.log('panel:', JSON.stringify(info));
const wh = await ev(`({w:innerWidth,h:innerHeight})`);
console.log('win:', JSON.stringify(wh));
close();
