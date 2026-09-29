// Helper: esegue una espressione JS nel renderer via CDP (porta 9223) e stampa il risultato.
// Uso: node scripts/cdp-nav.mjs "window.__app.getState().nav('home')"
const expr = process.argv[2] ?? 'location.href';
const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
const page = pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result?.exceptionDetails?.text ?? null)); ws.close(); process.exit(0); }
};
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
setTimeout(() => { console.log('timeout'); process.exit(1); }, 15000);
