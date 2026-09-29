import { ev, sleep, close } from './cdp-test.mjs';
await ev(`document.querySelectorAll('section')[2]?.scrollIntoView()`);
await sleep(800);
const shot = await (async()=>{
  const list=await (await fetch('http://127.0.0.1:9222/json')).json();
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0;const pend={};
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend[i]=r;ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pend[m.id]){pend[m.id](m.result);delete pend[m.id]}};
  await new Promise(r=>ws.onopen=r);
  const r=await send('Page.captureScreenshot',{format:'png'});
  ws.close();return r.data;
})();
const { writeFileSync } = await import('fs');
writeFileSync('shot-shelves.png', Buffer.from(shot,'base64'));
// hover simulato su un poster per vedere il veil
await ev(`(()=>{const p=document.querySelectorAll('.poster')[8];p?.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))})()`);
close();
