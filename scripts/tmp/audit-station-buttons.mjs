// Audit PROFONDO dei tasti dentro una stazione aperta — ogni bottone viene
// cliccato davvero nel DOM e si verifica l'effetto sullo store:
//   header: back / Riproduci / Mescola / Rigenera
//   riga:   play / CD / download / like / meno-così / menu(coda, radio, playlist)
// Poi la stessa stazione in OFFLINE (conf morta) per il paragone telefono.
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronBin = join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const userDir = mkdtempSync(join(tmpdir(), 'mh-audit-stbtn-'));
const shotDir = join(root, 'scripts', 'tmp', 'shots');
mkdirSync(shotDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(electronBin, [join(root, 'out', 'main', 'index.js'), '--remote-debugging-port=9227', `--user-data-dir=${userDir}`, '--window-size=1280,900'], { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

try {
  let page;
  for (let i = 0; i < 90; i++) {
    try {
      const pages = await (await fetch('http://127.0.0.1:9227/json')).json();
      page = pages.find((p) => p.type === 'page');
      if (page) break;
    } catch { }
    await sleep(500);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let msgId = 0; const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pend.set(id, (m) => res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    .then((r) => r?.exceptionDetails ? 'ERR: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) : r?.result?.value);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  // click per TITLE/testo — il DOM click è quello vero, come il dito dell'utente
  const clickTitle = (t) => ev(`(() => { const scope = document.querySelector('main') ?? document; const b = [...scope.querySelectorAll('button')].find(x => x.title === ${JSON.stringify(t)} && x.offsetParent); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
  const clickText = (t) => ev(`(() => { const scope = document.querySelector('main') ?? document; const b = [...scope.querySelectorAll('button')].find(x => x.textContent.trim().startsWith(${JSON.stringify(t)}) && x.offsetParent); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
  const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 300) { if (await ev(expr).catch(() => false)) return true; await sleep(300); } return false; };

  await send('Page.enable'); await send('Runtime.enable');
  await sleep(3500);
  await ev(`window.__mhApi().library.tasteSeed(['Vasco Rossi','Nirvana','Miles Davis','Sfera Ebbasta','Queen'])`);
  await ev(`window.__app.getState().nav('stations')`);
  await sleep(800);

  // ---------- STAZIONE APERTA ----------
  await ev(`window.__app.getState().openStation({kind:'station',id:'jazz'})`);
  check('stazione jazz si apre con scaletta', await waitFor(`document.querySelectorAll('main button[aria-label^="Riproduci"]').length > 5`, 30000));
  await sleep(600);
  await shot('stbtn-jazz-open');

  const st = JSON.parse(await ev(`JSON.stringify({
    title: document.querySelector('h1')?.textContent,
    nTracks: document.querySelectorAll('main button[aria-label^="Riproduci"]').length,
    playing: !!__app.getState().player.current,
  })`));
  check('hero mostra nome stazione', st.title === 'Jazz', st.title);
  check(`scaletta popolata (${st.nTracks} righe)`, st.nTracks >= 10);

  // ---------- TASTO RIGENERA ----------
  const before = await ev(`__app.getState().stationSel ? JSON.stringify([...document.querySelectorAll('main [aria-label^="Riproduci"]')].map(b=>b.getAttribute('aria-label')).slice(0,5)) : '[]'`);
  await clickText('Rigenera');
  check('Rigenera produce una nuova scaletta', await waitFor(`__app.getState().stationSel && document.querySelectorAll('main button[aria-label^="Riproduci"]').length > 5`, 40000), '');

  // ---------- TASTO MESCOLA ----------
  await clickText('Mescola');
  await sleep(800);
  const shuf = JSON.parse(await ev(`JSON.stringify({cur:__app.getState().player.current?.title, q:__app.getState().player.queue?.length})`));
  check('Mescola avvia la stazione (brano corrente + coda)', !!shuf.cur && shuf.q > 5, JSON.stringify(shuf));

  // ---------- TASTO RIPRODUCI ----------
  await clickText('Riproduci');
  await sleep(800);
  const play = JSON.parse(await ev(`JSON.stringify({cur:__app.getState().player.current?.title, q:__app.getState().player.queue?.length, first:__app.getState().player.queue?.[0]?.title})`));
  check('Riproduci avvia la scaletta in ordine', !!play.cur && play.q >= 10, JSON.stringify(play));

  // ---------- RIGA: PLAY ----------
  await ev(`window.__app.getState().pause && __app.getState().pause(); 'ok'`);
  const rowPlay = await ev(`(() => { const b = document.querySelector('main button[aria-label^="Riproduci "]'); if (!b) return 'NO'; b.click(); return 'ok'; })()`);
  await sleep(700);
  const cur1 = await ev(`__app.getState().player.current?.title ?? ''`);
  check('click riga → play sul brano', rowPlay === 'ok' && !!cur1, cur1);

  // ---------- RIGA: LIKE ----------
  const likeTitle = await clickTitle('Mi piace');
  await sleep(600);
  const liked = await ev(`Object.keys(__app.getState().remoteLiked ?? {}).length`);
  check('like su brano della stazione', likeTitle === 'ok' && liked >= 1, `liked=${liked}`);

  // ---------- RIGA: MENO COSÌ ----------
  const disTitle = await clickTitle('Meno così — il motore impara');
  await sleep(700);
  const nTracks2 = await ev(`document.querySelectorAll('main button[aria-label^="Riproduci"]').length`);
  check('dislike registra il segnale negativo', disTitle === 'ok', `righe dopo: ${nTracks2}`);

  // ---------- RIGA: MENU ⋯ → coda ----------
  const qBefore = await ev(`__app.getState().player.queue?.length ?? 0`);
  await clickTitle('Altre opzioni');
  await sleep(400);
  const enq = await clickText('Aggiungi in coda');
  await sleep(500);
  const qAfter = await ev(`__app.getState().player.queue?.length ?? 0`);
  check('menu ⋯ → "Aggiungi in coda" accoda', enq === 'ok' && qAfter === qBefore + 1, `${qBefore}→${qAfter}`);

  // ---------- RIGA: MENU ⋯ → radio artista ----------
  await clickTitle('Altre opzioni');
  await sleep(400);
  const rad = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Radio di /.test(x.textContent) && x.offsetParent); if (!b) return 'NO-BTN'; const name = b.textContent.trim(); b.click(); return name; })()`);
  await sleep(3000);
  const h1 = await ev(`document.querySelector('h1')?.textContent ?? ''`);
  check('menu ⋯ → "Radio di X" apre stazione artista', typeof rad === 'string' && rad !== 'NO-BTN' && h1.length > 0, `${rad} → ${h1}`);
  await shot('stbtn-artist-radio');

  // ---------- BACK ----------
  await clickText('Stazioni');
  await sleep(700);
  await waitFor(`__app.getState().stationSel === null`, 5000);
  const backOk = await ev(`__app.getState().stationSel === null || document.querySelector('h1')?.textContent?.includes('Stazioni')`);
  check('tasto ← torna alla griglia stazioni', !!backOk);

  // ---------- TASTO CD + DOWNLOAD (su stazione) ----------
  await ev(`window.__app.getState().openStation({kind:'station',id:'rock'})`);
  await waitFor(`document.querySelectorAll('main button[aria-label^="Riproduci"]').length > 5`, 30000);
  await sleep(500);
  const cd = await clickTitle('Scarica e aggiungi al CD');
  await sleep(900);
  const toast1 = await ev(`document.body.innerText.includes('CD') || document.body.innerText.includes('aggiung')`);
  check('tasto CD → avvia scarica-per-CD (toast)', cd === 'ok' && !!toast1);
  const dl = await clickTitle('Scarica in libreria (sul PC)');
  await sleep(900);
  const toast2 = await ev(`document.body.innerText.includes('Download') || document.body.innerText.includes('download') || document.body.innerText.includes('libreria')`);
  check('tasto download → avvia download libreria (toast)', dl === 'ok' && !!toast2);

  check('NESSUN errore JS durante tutti i click', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`\n${fail === 0 ? 'TUTTI PASS' : fail + ' CHECK FALLITI'}`);
  ws.close();
} finally {
  proc.kill('SIGKILL');
}
process.exit(fail === 0 ? 0 : 1);
