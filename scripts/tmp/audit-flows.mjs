// Flussi API live sul dev-server (CDP :9222): suggest, search, taste,
// suggerimenti PC, stazioni, trends — con contenuto vero.
const CDP = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = await (await fetch(`${CDP}/json`)).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown')
    errors.push('EXC: ' + (d.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
};
const send = (me, pa) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
const ev = async (e, t = 30000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }),
    sleep(t).then(() => ({ result: { exceptionDetails: { exception: { description: 'TIMEOUT' } } } })),
  ]);
  return r.result?.exceptionDetails ? 'EXC ' + (r.result.exceptionDetails.exception?.description ?? '').slice(0, 150) : r.result?.result?.value;
};
await send('Runtime.enable', {});
const out = {};
out.suggest = await ev(`(async()=>{try{const r=await window.__mhApi().yt.suggest('vasco');return{n:r.length,first:r.slice(0,4)}}catch(e){return String(e)}})()`);
out.search = await ev(`(async()=>{try{const r=await window.__mhApi().search.query('vasco rossi');return{songs:r.songs?.length,first:(r.songs?.[0]?.title??'')+' | '+(r.songs?.[0]?.artist??'')}}catch(e){return String(e)}})()`, 60000);
out.tasteArtist = await ev(`(async()=>{try{const r=await window.__mhApi().library.taste('artist');return{n:r.length,top:r.slice(0,3).map(x=>x.value+'('+x.weight.toFixed(1)+')')}}catch(e){return String(e)}})()`);
out.suggestPC = await ev(`(async()=>{try{const r=await window.__mhApi().rec.suggest();return{n:r.length,first:r.slice(0,3).map(x=>x.title+' ~ '+x.reason)}}catch(e){return String(e)}})()`, 60000);
out.station = await ev(`(async()=>{try{const r=await window.__mhApi().rec.station('per-te');return{n:r.length,first:r.slice(0,3).map(x=>x.title+' - '+x.artist)}}catch(e){return String(e)}})()`, 60000);
out.trends = await ev(`(async()=>{try{const r=await window.__mhApi().rec.trends();return{n:r.length,first:r.slice(0,3).map(x=>x.title)}}catch(e){return String(e)}})()`, 60000);
out.playlists = await ev(`(async()=>{try{const r=await window.__mhApi().playlists.list();return{n:r.length}}catch(e){return String(e)}})()`);
out.recent = await ev(`(async()=>{try{const r=await window.__mhApi().library.recent(5);return{n:r.length}}catch(e){return String(e)}})()`);
console.log(JSON.stringify(out, null, 1));
if (errors.length) console.log('ERR:', errors.slice(0, 10));
ws.close();
process.exit(0);
