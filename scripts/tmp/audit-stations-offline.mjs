// Audit STAZIONI OFFLINE (telefono su 4G / PC morto): serve out/renderer in
// Chrome con conf puntata a porta morta. Gusti eterogenei seminati (jazz +
// trap + pop italiano) e libreria con tag genre → le stazioni devono restare
// coerenti SENZA il PC: niente artisti sconosciuti, niente preferiti fuori
// genere, tasti funzionanti (Riproduci/Rigenera/like/menu).
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = join(root, 'out', 'renderer');
const shotDir = join(root, 'scripts', 'tmp', 'shots');
mkdirSync(shotDir, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const srv = createServer(async (req, res) => {
  try {
    const p = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    const b = await readFile(p);
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(b);
  } catch {
    const b = await readFile(join(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(b);
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

const prof = `${process.env.TEMP}\\mh-stoff-${Date.now()}`;
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  `--remote-debugging-port=9237`, `--user-data-dir=${prof}`, '--no-first-run',
  '--disable-web-security', '--disable-features=Translate', BASE,
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) fail++; };

try {
  let page;
  for (let i = 0; i < 30 && !page; i++) {
    await sleep(500);
    try {
      const pages = await (await fetch('http://127.0.0.1:9237/json')).json();
      page = pages.find((p) => p.type === 'page' && p.url.includes(String(PORT)));
    } catch { }
  }
  if (!page) { console.log('FAIL: chrome page'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text);
  };
  const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    const v = r.result?.result;
    if (v && v.value !== undefined) return v.value;
    if (r.result?.exceptionDetails) return 'ERR: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return JSON.stringify(r.result).slice(0, 300);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r?.data) writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  };
  await send('Runtime.enable', {}); await send('Page.enable', {});
  const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 300) { if (await ev(expr).catch(() => false)) return true; await sleep(300); } return false; };

  // ---- Seed: pairato a PC morto + gusti eterogenei + libreria con genre ----
  await ev(`
    localStorage.setItem('mh-remote-conf', JSON.stringify({base:'http://127.0.0.1:9', token:'dead', user:1}));
    localStorage.setItem('mh-was-online','0');
    localStorage.setItem('mh-lib-cache:u1', JSON.stringify([
      {id:1,videoId:'jaz1',title:'So What',artist:'Miles Davis',duration:545,genre:'jazz',thumbnail:''},
      {id:2,videoId:'jaz2',title:'Waltz for Debby',artist:'Bill Evans',duration:480,genre:'jazz',thumbnail:''},
      {id:3,videoId:'pop1',title:'Albachiara',artist:'Vasco Rossi',duration:240,genre:'pop',thumbnail:''},
      {id:4,videoId:'trp1',title:'Cupido',artist:'Sfera Ebbasta',duration:180,genre:'trap',thumbnail:''}
    ]));
    localStorage.setItem('mh-taste-cache:u1:artist', JSON.stringify([
      {kind:'artist',value:'miles davis',weight:9},{kind:'artist',value:'vasco rossi',weight:11},
      {kind:'artist',value:'sfera ebbasta',weight:10},{kind:'artist',value:'nirvana',weight:8},
      {kind:'artist',value:'queen',weight:7}
    ]));
    localStorage.setItem('mh-taste-cache:u1:genre', JSON.stringify([
      {kind:'genre',value:'jazz',weight:6},{kind:'genre',value:'trap',weight:5},{kind:'genre',value:'pop',weight:4}
    ]));
    'seeded'`);

  // Boot con PC morto → app offline
  await send('Page.navigate', { url: BASE });
  check('boot a PC morto → app pronta', await waitFor(`!!window.__app`, 20000));
  check('modalità offline rilevata', await waitFor(`__mhRemote.isOnline() === false`, 25000));
  const banner = await ev(`document.body.innerText.includes('non raggiungibile') || document.body.innerText.includes('offline') || document.body.innerText.includes('PC')`);
  check('banner offline visibile (informato, non bloccante)', !!banner);
  await shot('stoff-boot');

  // Log dei fetch iTunes per diagnosticare il gate
  await ev(`window.__fetchLog=[]; const __f=window.fetch; window.fetch=(...a)=>{const u=String(a[0]?.url??a[0]); if(u.includes('itunes')){const p=__f(...a).then(async r=>{const cl=r.clone(); const body=(await cl.text().catch(()=>'')).slice(0,220); __fetchLog.push({u:decodeURIComponent(u).slice(-60), st:r.status, body}); return r;}).catch(e=>{__fetchLog.push({u:u.slice(-60), err:String(e)}); throw e;}); return p;} return __f(...a)}; 'ok'`);

  // ---- Stazioni offline: scaletta + coerenza genere ----
  const OFFGENRE = /vasco|sfera|nirvana|queen|ghali|drake|eminem/i;
  const JAZZISH = /miles|davis|coltrane|baker|fitzgerald|brubeck|evans|monk|mingus|hancock|peterson|cole|armstrong|corea|metheny|glasper|kamasi|jazz|bebop|swing|blue note|parker|holiday|simone|krall|buble|connick|stacey|diana|nina|ella|duke|ellington|basie|gillespie|jarrett|wynton|marsalis|getz|jobim|gilberto|bennett|sinatra|dean martin|nat king|nancy wilson|june christy|lena horne|julie london|blossom dearie|helen merrill|anita o'day|chris connor|carol sloane|jimmy smith|wes montgomery|grant green|kenny burrell|joe pass|barney kessel|herb ellis|stan getz|art pepper|zoot sims|sonny rollins|sonny stitt|lee morgan|freddie hubbard|donald byrd|blue mitchell|clifford brown|art blakey|horace silver|bobby timmons|cannonball|yusef lateef|john lewis|mjq|modern jazz|vince guaraldi|dave brubeck|paul desmond|gerry mulligan|chet|count basie|lionel hampton|gene krupa|buddy rich|lou rawls|bobby darin|tony bennett|perry como|andy williams|vic damone|jack jones|steve lawrence|eydie gorme|frank sinatra|sammy davis|nat king cole|dean martin|bing crosby|mel torme|johnny mathis|sarah vaughan|carmen mcrae|shirley horn|betty carter|abbey lincoln|nina simone|roberta gambarini|karrin allyson|jane monheit|stacey kent|silje nergaard|diana krall|norah jones|michael buble|harry connick|gregory porter|jose james|robert glasper|esperanza spalding|hiromi|michel camilo|chick corea|keith jarrett|bill evans|brad mehldau|fred hersch|kenny barron|hank jones|tommy flanagan|barry harris|red garland|wynton kelly|phineas newborn|ahmad jamal|ramsey lewis|les mccann|gene harris|monty alexander|oscar peterson|bud powell|thelonious monk|herbie nichols|andrew hill|cecil taylor|ornette coleman|don cherry|eric dolphy|charles mingus|charlie haden|scott lafaro|ron carter|dave holland|eddie gomez|niels|christian mcbride|esperanza|vijay iyer|jason moran|tigran hamasyan|shai maestro|avishai cohen|enrico pieranunzi|stefano bollani|paolo fresu|enrico rava|franco d'andrea|giovanni guidi|rita marcotulli|danilo rea|massimo urbani|pietro tonolo|francesco cafiso|rosario giuliani|claudio fasoli|fulvio sigurta|fabrizio bosso/i;
  for (const id of ['jazz', 'blues', 'dance']) {
    await ev(`window.__app.getState().openStation({kind:'station',id:'${id}'})`);
    // niente race: l'h1 deve essere la stazione giusta E le righe caricate
    const nameOk = await waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(id === 'jazz' ? 'Jazz' : id === 'blues' ? 'Blues' : 'Dance')}`, 15000);
    const ok = nameOk && await waitFor(`document.querySelectorAll('main button[aria-label^="Riproduci "]').length >= 5`, 90000);
    check(`[offline] ${id}: scaletta generata`, ok);
    if (!ok) {
      console.log('    DIAG:', await ev(`JSON.stringify({h1:document.querySelector('h1')?.textContent, main:(document.querySelector('main')?.innerText ?? 'NO-MAIN').slice(0,180), sel:__app.getState().stationSel?.id, screen:__app.getState().screen})`));
      continue;
    }
    await sleep(400);
    const rows = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('main button[aria-label^="Riproduci "]')].map(b => b.getAttribute('aria-label')))`));
    // riga completa: indice, titolo, artista, durata — slice più ampio
    const lines = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('main [aria-label^="Riproduci "]')].map(b => (b.closest('div[class*="group"]')?.innerText ?? '').split('\\n').slice(0,4).join(' | ')))`));
    const unkn = lines.filter((l) => /sconosciuto|unknown/i.test(l)).length;
    // Il leak si giudica sull'ARTISTA (campo 2 prima di '·'), non su titolo/album
    // — "Queen Of The Blues" è un album di Memphis Minnie, non la band Queen.
    const artistOf = (l) => (l.split(' | ')[2] ?? '').split(' ·')[0] ?? '';
    const leaks = lines.filter((l) => OFFGENRE.test(artistOf(l)));
    console.log(`    ${id}: ${rows.length} brani — ${lines.slice(0, 5).join(' · ')}`);
    check(`[offline] ${id}: zero artisti sconosciuti`, unkn === 0, `${unkn}`);
    check(`[offline] ${id}: preferiti fuori genere ASSENTI`, leaks.length === 0, leaks.slice(0, 3).join(' | '));
    if (leaks.length) {
      console.log('    itunesCache:', await ev(`localStorage.getItem('mh-itunes-genres:u1')`));
      // click sulla riga col leak → player.current rivela il vero campo artist
      console.log('    leak row:', await ev(`(() => {
        const rows = [...document.querySelectorAll('main [aria-label^="Riproduci "]')];
        for (const b of rows) {
          const line = (b.closest('div[class*="group"]')?.innerText ?? '').split('\\n').slice(0,4).join(' | ');
          const a = (line.split(' | ')[2] ?? '').split(' ·')[0] ?? '';
          if (/vasco|sfera|nirvana|queen|ghali|drake|eminem/i.test(a)) { b.click(); return a; }
        }
        return 'none';
      })()`));
      await sleep(800);
      console.log('    player.current:', await ev(`JSON.stringify({a:__app.getState().player.current?.artist, t:__app.getState().player.current?.title})`));
      console.log('    fetchLog:', await ev(`JSON.stringify((window.__fetchLog??[]).filter(x=>/queen/i.test(x.u??'')))`));
      console.log('    tasteCache:', await ev(`localStorage.getItem('mh-taste-cache:u1:artist')`));
    }
    if (id === 'jazz') {
      const jazzish = lines.filter((l) => JAZZISH.test(l)).length;
      check(`[offline] jazz: contenuto jazzistico dominante`, jazzish >= Math.ceil(lines.length * 0.4), `${jazzish}/${lines.length}`);
    }
    if (id === 'jazz') await shot('stoff-jazz');
  }

  // ---- Tasti offline ----
  await ev(`window.__app.getState().openStation({kind:'station',id:'jazz'})`);
  await waitFor(`document.querySelector('h1')?.textContent === 'Jazz'`, 15000);
  await waitFor(`document.querySelectorAll('main button[aria-label^="Riproduci "]').length >= 5`, 90000);
  await sleep(500);
  const cPlay = await ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => x.textContent.trim().startsWith('Riproduci') && x.offsetParent && !x.disabled); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
  await sleep(1000);
  const cur = await ev(`__app.getState().player.current?.title ?? ''`);
  check('[offline] tasto Riproduci → brano corrente + coda', cPlay === 'ok' && !!cur && (await ev(`__app.getState().player.queue?.length ?? 0`)) >= 5, `${cPlay} cur=${cur}`);

  const cLike = await ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => x.title === 'Mi piace' && x.offsetParent); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
  await sleep(700);
  const pendLk = await ev(`(localStorage.getItem('mh-pending-likes:u1') ?? '') + (localStorage.getItem('mh-pending-liblikes:u1') ?? '')`);
  const likedNow = await ev(`Object.keys(__app.getState().remoteLiked ?? {}).length + __app.getState().library.filter(x => x.liked).length`);
  check('[offline] like cachato in coda sync (drain alla riconnessione)', cLike === 'ok' && (likedNow >= 1 || /videoId|\d/.test(pendLk)), `btn=${cLike} liked=${likedNow} pend=${pendLk.slice(0, 60)}`);

  const cRg = await ev(`(() => { const b = [...document.querySelectorAll('main button')].find(x => x.textContent.trim().startsWith('Rigenera') && x.offsetParent); if (!b) return 'NO-BTN'; b.click(); return 'ok'; })()`);
  check('[offline] Rigenera ricrea la scaletta', cRg === 'ok' && await waitFor(`document.querySelector('h1')?.textContent === 'Jazz' && document.querySelectorAll('main button[aria-label^="Riproduci "]').length >= 5`, 90000), cRg);

  check('NESSUN errore JS in tutta la sessione offline', errors.length === 0, errors.slice(0, 2).join(' | '));
  console.log(`\n${fail === 0 ? 'TUTTI PASS' : fail + ' CHECK FALLITI'}`);
  ws.close();
} finally {
  chrome.kill(); srv.close();
}
process.exit(fail === 0 ? 0 : 1);
