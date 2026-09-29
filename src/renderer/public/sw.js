// Service worker minimo: consente "Aggiungi a schermata Home" e tiene in cache
// la shell dell'app. API e media vanno SEMPRE in rete (il PC è la fonte).
// index.html è NETWORK-FIRST: se restasse cache-first un aggiornamento
// dell'app servirebbe per sempre la vecchia shell con asset hashati spariti.
const CACHE = 'mh-shell-v4';

// ---- Proxy /__pc/* verso il PC pairato ----
// Media (<audio>/<img>) ed EventSource non possono portare header custom: il
// client chiama URL same-origin /__pc/… e QUI si inoltra al PC aggiungendo
// X-MH-Token. Il token non finisce mai in una URL (cronologia, log proxy,
// Referer) — prima era ?token= in chiaro su ogni media. Le credenziali
// arrivano via postMessage dalla pagina e persistono in IndexedDB: il SW può
// essere ucciso e rilanciato senza perdere il pairing.
let pcAuth = null; // {base, token}
let pcAuthP = null;

function swDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('mh-sw', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function loadPcAuth() {
  if (pcAuth) return Promise.resolve(pcAuth);
  if (!pcAuthP) {
    pcAuthP = swDb().then((db) => new Promise((res) => {
      const q = db.transaction('kv', 'readonly').objectStore('kv').get('pc');
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    })).then((v) => { pcAuth = v; return v; }).catch(() => null);
  }
  return pcAuthP;
}
function savePcAuth(v) {
  pcAuth = v;
  swDb().then((db) => {
    const tx = db.transaction('kv', 'readwrite');
    if (v) tx.objectStore('kv').put(v, 'pc'); else tx.objectStore('kv').delete('pc');
  }).catch(() => {});
}

self.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.t === 'mh-pc-auth' && m.base && m.token) savePcAuth({ base: m.base, token: m.token });
  else if (m?.t === 'mh-pc-clear') savePcAuth(null);
});

// /__pc/<path> → <pcBase>/<path> con il token in HEADER. Range inoltrato (seek
// audio), risposta passata così com'è (streaming: SSE e media non si bufferano).
async function proxyPc(req, u) {
  const auth = await loadPcAuth();
  if (!auth) return new Response('PC non configurato', { status: 503 });
  const path = u.pathname.slice('/__pc'.length) + u.search;
  const headers = new Headers();
  for (const h of ['range', 'accept']) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  headers.set('X-MH-Token', auth.token);
  try {
    return await fetch(auth.base + path, { method: req.method, headers });
  } catch {
    return new Response('PC irraggiungibile', { status: 502 });
  }
}

// Brani scaricati sul telefono (IndexedDB 'mh-phone'): serviti via HTTP perché
// <audio> demuxa i file frammentati (DASH/fMP4 — l'audio mp4 di YouTube oggi
// arriva così) SOLO via HTTP(S) — da blob: dà MEDIA_ELEMENT_SRC_NOT_SUPPORTED.
const PHONE_DB = 'mh-phone';
const PHONE_STORE = 'tracks';
const phoneCache = new Map(); // id -> entry (pochi brani: memoria contenuta)

function phoneDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(PHONE_DB);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function phoneEntry(id) {
  if (phoneCache.has(id)) return phoneCache.get(id);
  const db = await phoneDb();
  const e = await new Promise((res) => {
    const q = db.transaction(PHONE_STORE, 'readonly').objectStore(PHONE_STORE).get(id);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(undefined);
  });
  if (e) {
    if (phoneCache.size > 3) phoneCache.delete(phoneCache.keys().next().value);
    phoneCache.set(id, e);
  }
  return e;
}
async function servePhoneAudio(u, req) {
  const id = Number(u.pathname.slice('/__phone/'.length));
  try {
    const en = await phoneEntry(id);
    const blob = en && en.blob;
    if (!blob || !blob.size) return new Response('not found', { status: 404 });
    const type = blob.type || 'application/octet-stream';
    const range = req.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? Math.min(parseInt(m[2], 10), blob.size - 1) : blob.size - 1;
      if (!m[1] && m[2]) { start = Math.max(0, blob.size - parseInt(m[2], 10)); end = blob.size - 1; }
      if (start >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
      const part = blob.slice(start, end + 1);
      return new Response(part, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(part.size),
          'Content-Range': `bytes ${start}-${end}/${blob.size}`,
          'Accept-Ranges': 'bytes',
        },
      });
    }
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' },
    });
  } catch {
    return new Response('err', { status: 500 });
  }
}

self.addEventListener('install', (e) => {
  // addAll tollerante: un asset mancante non deve impedire l'installazione del SW
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/manifest.webmanifest'])).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith('/__pc/')) { e.respondWith(proxyPc(e.request, u)); return; }
  if (u.pathname.startsWith('/__phone/')) { e.respondWith(servePhoneAudio(u, e.request)); return; }
  // API, media e stream esterni: sempre live, mai in cache
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/media/') || u.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;

  // Navigazioni: prima la rete (shell sempre fresca), poi la cache se offline
  if (e.request.mode === 'navigate' || u.pathname === '/' || u.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); }
        return res;
      }).catch(() => caches.match('/index.html')),
    );
    return;
  }

  // Asset hashati e font: cache-first (sono immutabili). MISS+offline → 504
  // onesto: rispondere index.html a un .js produce un errore di modulo opaco
  // ("Unexpected token <") invece di un fallimento diagnostico.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && (u.pathname.endsWith('.js') || u.pathname.endsWith('.css') || u.pathname.endsWith('.woff2'))) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => new Response('offline', { status: 504 }))),
  );
});
