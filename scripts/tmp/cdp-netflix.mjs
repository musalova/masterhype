import { ev, enableLogs, getLogs, sleep, close } from '../cdp-test.mjs';
await enableLogs();
// vai in Home e attendi i dati
await ev(`window.__app.getState().nav('home')`);
await sleep(14000);
const ui = await ev(`(()=>({
  hero: !!document.querySelector('.hero'),
  heroBg: !!document.querySelector('.hero-bg'),
  shelves: document.querySelectorAll('.shelf').length,
  posters: document.querySelectorAll('.poster').length,
  arrows: document.querySelectorAll('.shelf-arrow').length,
  ranks: document.querySelectorAll('.rank-badge').length,
}))()`);
console.log('ui:', JSON.stringify(ui));
// screenshot
const shot = await (async()=>{
  const list=await (await fetch('http://127.0.0.1:9222/json')).json();
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0;const pend={};
  const send=(m,p={})=>new Promise(r=>{const i=++id;pend[i]=r;ws.send(JSON.stringify({id:i,method:m,params:p}))});
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pend[m.id]){pend[m.id](m.result);delete pend[m.id]}};
  await new Promise(r=>ws.onopen=r);
  const r=await send('Page.captureScreenshot',{format:'png'});
  ws.close();
  return r.data;
})();
const { writeFileSync } = await import('fs');
writeFileSync('shot-home.png', Buffer.from(shot,'base64'));
console.log('shot saved');
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
