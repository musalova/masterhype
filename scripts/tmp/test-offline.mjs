// Test offline UX del client remoto: stato connessione, banner, retry.
// Uso: node scripts/test-offline.mjs   (Chrome CDP su :9223 con pagina :48484 aperta)
const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
const page = list.find((t) => t.type === 'page' && t.url.includes('48484') && !t.url.includes('sw.js'));
if (!page) { console.log('FAIL: nessuna pagina :48484 tra i target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const ev = (expr) => new Promise((res, rej) => {
  const i = ++id;
  const to = setTimeout(() => rej(new Error('timeout eval')), 8000);
  const h = (m) => {
    const d = JSON.parse(m.data);
    if (d.id === i) { clearTimeout(to); ws.removeEventListener('message', h); res(d.result?.result?.value ?? d.result?.exceptionDetails?.exception?.description); }
  };
  ws.addEventListener('message', h);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
ws.onerror = () => { console.log('FAIL: ws'); process.exit(1); };
await new Promise((r) => { ws.onopen = r; });
await new Promise((r) => setTimeout(r, 6000)); // boot + hydrate
console.log('library:', await ev('window.__app ? window.__app.getState().library.length : "no store"'));
console.log('online flag:', await ev('(await import("/src/remote.ts")).catch(()=>"mod?")'));
console.log('banner:', await ev('document.body.innerText.includes("non raggiungibile")'));
process.exit(0);
