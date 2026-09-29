// Test modalità autonoma sull'APK reale (emulatore): WebView CDP su :9229.
// Conf morta → offline → diretto (CapacitorHttp nativo: niente CORS).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pages = await (await fetch('http://127.0.0.1:9229/json')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes('localhost'));
if (!page) { console.log('FAIL: pagina non trovata'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pend = new Map();
const logs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
    logs.push(JSON.stringify(d.params.args.map((a) => a.value ?? a.description ?? '').slice(0, 3)));
};
const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  const v = r.result?.result;
  if (v && v.value !== undefined) return v.value;
  if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return JSON.stringify(r.result).slice(0, 500);
};
const evRetry = async (e, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const v = await ev(e).catch(() => null);
    if (v != null && v !== '') return v;
    await sleep(1000);
  }
  return null;
};
await send('Runtime.enable', {});
await send('Page.enable', {});

console.log('== stato iniziale ==');
console.log(await ev(`JSON.stringify({app: !!window.__app, api: !!window.__mhApi, native: window.Capacitor?.isNativePlatform?.(), conf: (localStorage.getItem('mh-remote-conf')||'').slice(0,90)})`));

console.log('== forzo conf morta → modalità autonoma ==');
await ev(`localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://127.0.0.1:9', token:'dead'}))`);
await send('Page.navigate', { url: page.url });
const st = await evRetry(`window.__app ? JSON.stringify({app:true, lib: __app.getState().library.length, phone:[...__app.getState().phoneIds]}) : ''`);
console.log(st);
await sleep(4000);
console.log('banner:', await ev(`document.body.innerText.slice(0, 100)`));

console.log('== directSearch su APK (CapacitorHttp nativo) ==');
const s = await ev(`__mhApi().yt.search('vasco rossi', false).then(r => ({songs: r.songs.length, first: r.songs[0]?.title, vid: r.songs[0]?.videoId})).catch(e => 'ERR '+e.message)`);
console.log(s);
const vid = (typeof s === 'string' && s.startsWith('{')) ? JSON.parse(s).vid : s?.vid;

if (vid) {
  console.log('== playStream diretto ==');
  console.log(await ev(`__mhApi().yt.playStream('${vid}').then(r => r.url.slice(0,80)).catch(e => 'ERR '+e.message)`));
  console.log('== play() → sorgente audio ==');
  await ev(`__app.getState().play({videoId:'${vid}',title:'Brava',artist:'Vasco Rossi'}).catch(e=>'ERR '+e.message)`);
  await sleep(5000);
  console.log(await ev(`(() => { const a=[...document.querySelectorAll('audio')].find(x=>x.src); return JSON.stringify({src: a?.src?.slice(0,70), ready: a?.readyState, err: a?.error?.code, paused: a?.paused, cur: __app.getState().player.current?.title}); })()`));
  console.log('== downloadToPhone su brano non-libreria (diretto, CapacitorHttp) ==');
  console.log(await ev(`__app.getState().downloadToPhone({videoId:'${vid}',title:'Brava',artist:'Vasco Rossi'}).then(() => 'ok').catch(e => 'ERR '+e.message)`));
  console.log(await ev(`JSON.stringify({phone: [...__app.getState().phoneIds], rows: __app.getState().library.filter(t=>t.phoneOnly).map(t=>t.id+':'+t.title)})`));
  console.log('== play del brano scaricato (blob offline) ==');
  const row = await ev(`__app.getState().library.find(t=>t.phoneOnly)?.id`);
  if (row != null) {
    await ev(`(() => { const t = __app.getState().library.find(x=>x.id===${row}); return __app.getState().play(t).catch(e=>'ERR '+e.message); })()`);
    await sleep(3000);
    console.log(await ev(`(() => { const a=[...document.querySelectorAll('audio')].find(x=>x.src); return JSON.stringify({src: a?.src?.slice(0,60), ready: a?.readyState}); })()`));
  }
}

console.log('== console errors ==');
console.log(logs.slice(0, 10).join('\n') || '(nessuno)');
ws.close();
process.exit(0);
