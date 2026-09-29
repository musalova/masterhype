import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync, statSync, createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { app } from 'electron';
import { handlers } from './handlers';
import { getSettings } from './settings';
import { getTrack } from './services/library';
import { userExists } from './services/users';
import * as devices from './services/devices';
import { report } from './services/telemetry';
import { serveUpdateRoutes } from './update';
import { sanitizeRemoteSettings, safeUploadName } from './remoteGuards';
import { feedUrl } from './services/appUpdate';
import { openPairingWindow, pairingOpenLeft, tryPair, mintPairCode, PAIR_CODE_TTL_MS } from './pairing';
import { startDiscovery, stopDiscovery } from './discovery';
import { IPC } from '../shared/types';

// Server LAN: rende MasterHype disponibile su telefono/tablet nella stessa
// rete Wi-Fi. Il PC resta la "casa" — yt-dlp, ffmpeg, libreria, gusti e
// preferenze vivono qui; il telefono è un client della stessa app.
//
//   GET  /              → la UI React (stessa del desktop)
//   POST /api/call      → {c: canale IPC, a: args} → stessa mappa di ipc.ts
//   GET  /api/events    → SSE: eventi download/burn verso i client
//   GET  /api/info      → handshake pairing
//   GET  /media/audio/N → file MP3 della libreria (con Range per seek)
//   GET  /media/cover/N → copertine
//   GET  /api/prefs     → preferenze condivise ; PUT /api/prefs {k,v}
//
// Sicurezza: solo rete locale + token di pairing su ogni richiesta
// (/api/*, /media/*). I file statici della UI sono liberi (contengono solo codice).

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.json': 'application/json', '.map': 'application/json',
};

// Client SSE → profilo: null = token condiviso del PC (admin, vede tutti i
// broadcast), numero = profilo legato al device, -1 = device non associato
// (solo broadcast senza `u`: niente dati personali prima del claim).
const sseClients = new Map<ServerResponse, number | null>();
let server: Server | null = null;

// Eventi main→client remoti (download progress, burn progress…)
export function remoteBroadcast(channel: string, payload: unknown): void {
  if (!sseClients.size) return;
  let line: string;
  try { line = `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`; }
  catch { return; } // payload non serializzabile: meglio perdere l'evento che crashare
  // Broadcast per-profilo (prefs:event {k,v,u} porta il profilo): un device
  // legato a un altro profilo non deve nemmeno RICEVERE il dato — il filtro
  // client-side bastava a non applicarlo, non a non leggerlo.
  const pu = (payload as { u?: unknown } | null)?.u;
  for (const [res, uid] of sseClients) {
    if (uid != null && typeof pu === 'number' && pu !== uid) continue;
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

const isLanIp = (ip: string) =>
  ip.startsWith('192.168.') || ip.startsWith('10.') ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
// Tailscale usa il range CGNAT 100.64/10: telefono collegato alla stessa
// tailnet raggiunge il PC da QUALSIASI rete (fuori casa, 4G, altra Wi-Fi)
const isTailscaleIp = (ip: string) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);

function allAddresses(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  return ips;
}

export function lanAddress(): string {
  // Preferisci le reti LAN classiche (192.168/10/172.16-31): su PC con VPN o
  // Tailscale il primo IPv4 non-interno potrebbe non essere raggiungibile
  // dal telefono in Wi-Fi.
  const ips = allAddresses();
  return ips.find(isLanIp) ?? ips[0] ?? '127.0.0.1';
}

// Tutti gli indirizzi del PC (il client filtra da solo quello che sta già
// usando): se escludessimo il LAN "principale", dopo un failover su Tailscale
// il telefono non potrebbe più tornare sull'indirizzo di casa.
// Ordine: LAN prima (probe veloce a casa), poi Tailscale, poi il resto.
export function altAddresses(port: number): string[] {
  const score = (ip: string) => (isLanIp(ip) ? 2 : isTailscaleIp(ip) ? 1 : 0);
  return allAddresses()
    .sort((a, b) => score(b) - score(a))
    .map((ip) => `http://${ip}:${port}`);
}

export function remoteInfo(): { enabled: boolean; ip: string; port: number; token: string; alts: string[] } {
  const s = getSettings();
  const port = s.remotePort ?? 48484;
  return { enabled: !!s.remoteEnabled, ip: lanAddress(), port, token: s.remoteToken ?? '', alts: altAddresses(port) };
}

// Credenziale di una richiesta remota. Due livelli:
//   · admin  — il codice di pairing condiviso (settings.remoteToken): vive sul
//     PC (Impostazioni → Telefono, QR) e non lascia mai il server; chi lo
//     presenta è il proprietario e vede tutti i profili (incl. i device già
//     pairati prima dei token per-device, che conservano questo token).
//   · device — token per-dispositivo mintato da /pair o device:register,
//     legato a UN profilo nella tabella devices: il profilo della richiesta
//     è il binding, NON l'header X-MH-User. userId null = pairato ma non
//     ancora associato (può solo elencare i profili e fare claim).
interface Auth {
  admin: boolean;
  deviceId?: number;
  userId: number | null;
}

function authed(req: IncomingMessage): Auth | null {
  const token = req.headers['x-mh-token'] ??
    new URL(req.url ?? '/', 'http://x').searchParams.get('token');
  if (typeof token !== 'string' || !token) return null;
  const shared = getSettings().remoteToken;
  if (shared && token === shared) return { admin: true, userId: null };
  const d = devices.deviceByToken(token);
  return d ? { admin: false, deviceId: d.id, userId: d.userId } : null;
}

// Rate-limit banale sui fallimenti di autenticazione: il token è ~48bit (scan
// impossibile), ma un 401 gratuito e infinito non deve esistere — un IP che
// sbaglia in sequenza (device con token revocato in loop, brute-force) viene
// strozzato a 30 fallimenti/minuto → 429.
const authFails = new Map<string, { n: number; reset: number }>();
function authThrottled(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '?';
  const now = Date.now();
  const e = authFails.get(ip);
  if (e && now < e.reset) return ++e.n > 30;
  authFails.set(ip, { n: 1, reset: now + 60_000 });
  if (authFails.size > 500) authFails.clear(); // tetto memoria su flood multi-IP
  return false;
}

// Profilo dichiarato dal client via X-MH-User (o ?user= per SSE/EventSource):
// vale SOLO per il token condiviso admin — con un device token il profilo è
// il binding del dispositivo e l'header viene ignorato. Header assente →
// profilo legacy 1; id inesistente/non numerico → null → 401.
function reqUser(req: IncomingMessage): number | null {
  const raw = req.headers['x-mh-user'] ??
    new URL(req.url ?? '/', 'http://x').searchParams.get('user');
  if (raw == null || raw === '') return 1;
  const id = parseInt(String(raw), 10);
  if (!Number.isFinite(id)) return null;
  return userExists(id) ? id : null;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body ?? null);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(data);
}

function rendererDir(): string {
  return join(__dirname, '..', 'renderer');
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://x');
  let p: string;
  try { p = decodeURIComponent(u.pathname); } catch { p = u.pathname; } // % malformed → SPA fallback
  if (p === '/' || p === '') p = '/index.html';
  // Anti-traversal: normalizza e verifica che resti DENTRO la dir renderer
  // (il separatore finale impedisce match su directory sorelle "renderer-evil")
  const root = normalize(rendererDir());
  const file = normalize(join(root, p));
  if (!(file === root || file.startsWith(root + '\\') || file.startsWith(root + '/')) || !existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback: qualsiasi path ignoto serve l'app
    const idx = join(rendererDir(), 'index.html');
    if (existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      const s = createReadStream(idx);
      res.on('close', () => { try { s.destroy(); } catch { /* */ } });
      s.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
      s.pipe(res);
      return;
    }
    res.writeHead(404); res.end('not found');
    return;
  }
  // Asset hashati (assets/*.js): immutabili, cache aggressiva → caricamento
  // sul telefono molto più veloce anche su Wi-Fi lenta.
  // Stream, non readFileSync: le letture sincrone bloccano l'event loop —
  // sotto carico (UI + media + SSE insieme) congelavano tutto il server.
  const immutable = /[/\\]assets[/\\]/.test(file);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Content-Length': statSync(file).size,
  });
  const s = createReadStream(file);
  res.on('close', () => { try { s.destroy(); } catch { /* */ } });
  s.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  s.pipe(res);
}

// /media/audio|cover/:id con supporto Range (necessario per seek audio HTML5)
function serveMedia(req: IncomingMessage, res: ServerResponse, kind: string, id: number): void {
  const t = Number.isFinite(id) ? getTrack(id) : undefined;
  const fp = kind === 'audio' ? t?.filePath : t?.coverPath;
  if (!fp || !existsSync(fp)) { res.writeHead(404); res.end(); return; }
  const size = statSync(fp).size;
  const type = kind === 'audio' ? 'audio/mpeg' : 'image/jpeg';
  const pipe = (start?: number, end?: number) => {
    const stream = createReadStream(fp, start != null ? { start, end } : undefined);
    // Il client abortisce lo stream a OGNI seek: senza destroy il file handle
    // resta aperto — su sessioni lunghe il PC accumulava fd zombie
    res.on('close', () => { try { stream.destroy(); } catch { /* */ } });
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end(); });
    stream.pipe(res);
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    // Suffix range "bytes=-N": gli ULTIMI N byte (non da 0 come prima)
    const start = range[1] ? parseInt(range[1], 10) : Math.max(0, size - parseInt(range[2] || '0', 10));
    const end = range[1] && range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes',
    });
    pipe(start, end);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
  pipe();
}

// ---- Auto-aggiornamento APK distribuito dal PC ----
// Il telefono pairato controlla /update/manifest.json: se il PC ha un APK più
// nuovo lo scarica via LAN e si aggiorna da solo — basta posare l'APK in una
// delle cartelle sorgente (release/ in dev, <userData>/apk, <exeDir>/apk).
// Scan a ogni richiesta: costa una stat per dir, e l'APK appena posato viene
// visto subito senza riavvio dell'app.
// L'installer porta con sé l'APK della stessa release (resources/apk): chi
// aggiorna l'EXE aggiorna in automatico anche i telefoni, senza build locali.
export function updateDirs(): string[] {
  const dirs = [join(app.getPath('userData'), 'apk'), join(dirname(app.getPath('exe')), 'apk')];
  if (app.isPackaged) dirs.push(join(process.resourcesPath, 'apk'));
  else dirs.push(join(app.getAppPath(), 'release'));
  return dirs;
}

function serveEvents(req: IncomingMessage, res: ServerResponse, uid: number | null): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(': ok\n\n');
  sseClients.set(res, uid);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 25_000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
}

// Canali /api/call raggiungibili da un device NON ancora associato a un
// profilo: servono al gate "Chi sei?" (lista, crea) e al claim stesso.
const BOOTSTRAP_CHANNELS: ReadonlySet<string> = new Set([IPC.usersList, IPC.usersCreate]);
// Canali che solo il codice condiviso del PC può chiamare da remoto: gestione
// dispositivi, amministrazione profili altrui, apertura della finestra di
// pairing (se un device potesse aprirla da solo, ri-legarsi a un altro
// profilo non richiederebbe più un'azione sul PC).
const ADMIN_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  IPC.deviceList, IPC.deviceRevoke, IPC.deviceRevokeAll, IPC.deviceSetUser, IPC.deviceRegister,
  IPC.usersRemove, IPC.usersRename, IPC.pairingOpen, IPC.pairingCode,
]);

async function handleApi(req: IncomingMessage, res: ServerResponse, auth: Auth): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/info') {
    const port = getSettings().remotePort ?? 48484;
    // updateFeed: il telefono lo memorizza e, lontano dal PC (o in modalità
    // senza PC), continua a ricevere gli aggiornamenti dal feed pubblico.
    json(res, 200, { name: 'MasterHype', version: app.getVersion(), host: 'pc', alts: altAddresses(port), updateFeed: feedUrl() || undefined });
    return;
  }

  // Risoluzione del profilo per la richiesta:
  //   admin  → X-MH-User validato (legacy 1 se assente)
  //   device legato → il suo profilo; X-MH-User ignorato
  //   device da associare → claim implicito da X-MH-User (i client più
  //     vecchi non chiamano device:claim: il primo uso li lega al profilo
  //     che dichiarano — stesso livello di fiducia del claim esplicito)
  const implicitClaim = (): number | null => {
    const raw = req.headers['x-mh-user'] ?? url.searchParams.get('user');
    if (raw == null || raw === '') return null;
    const id = parseInt(String(raw), 10);
    if (!Number.isFinite(id) || !userExists(id)) return null;
    devices.bindDevice(auth.deviceId!, id);
    auth.userId = id;
    return id;
  };
  const uidFor = (bootstrap: boolean): number | null => {
    if (auth.admin) return reqUser(req);
    if (auth.userId != null) return auth.userId;
    return implicitClaim() ?? (bootstrap ? 1 : null);
  };

  if (url.pathname === '/api/prefs' && req.method === 'GET') {
    const u = uidFor(false);
    if (u == null) { json(res, 401, { e: 'profilo non valido' }); return; }
    json(res, 200, await (handlers['remote:prefs:get'] as (u: number) => unknown)(u));
    return;
  }
  if (url.pathname === '/api/prefs' && (req.method === 'PUT' || req.method === 'POST')) {
    const u = uidFor(false);
    if (u == null) { json(res, 401, { e: 'profilo non valido' }); return; }
    const body = await readBody(req);
    // Solo il namespace condiviso: un client autenticato non deve poter
    // scrivere chiavi arbitrarie nella tabella prefs
    if (body && typeof body.k === 'string' && body.k.startsWith('mh-pref-')) {
      (handlers['remote:prefs:set'] as (u: number, k: string, v: unknown) => unknown)(u, body.k, body.v);
      json(res, 200, { ok: true });
    } else json(res, 400, { e: 'chiave non valida' });
    return;
  }
  // Import di file audio dal telefono (parità col drag&drop del desktop):
  // corpo = byte grezzi del file, ?name= il nome originale. Il file passa da
  // userData/imports e poi entra in libreria con la stessa pipeline
  // dell'import desktop (copia in cartella libreria + ffprobe dei tag).
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    const u = uidFor(false);
    if (u == null) { json(res, 401, { e: 'profilo non valido' }); return; }
    const name = safeUploadName(url.searchParams.get('name'));
    if (!name) { json(res, 400, { e: 'file audio non valido' }); return; }
    const dir = join(app.getPath('userData'), 'imports');
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, name);
    const ok = await readBodyToFile(req, tmp, 400_000_000);
    if (!ok) { try { unlinkSync(tmp); } catch { /* */ } json(res, 413, { e: 'upload interrotto o troppo grande' }); return; }
    try {
      const n = await (handlers[IPC.libraryImport] as (u: number, p: string[]) => Promise<number>)(u, [tmp]);
      json(res, 200, { r: n });
    } catch (e) {
      json(res, 500, { e: e instanceof Error ? e.message : String(e) });
    } finally {
      try { unlinkSync(tmp); } catch { /* ancora aperto: resta, verrà sovrascritto */ }
    }
    return;
  }
  if (url.pathname === '/api/call' && req.method === 'POST') {
    const body = await readBody(req);
    const c = body?.c;
    // Canali che agiscono sul file system / desktop del PC: mai da remoto.
    // library:import con path arbitrari farebbe leggere file qualsiasi del PC
    // a ffprobe; shell:openPath aprirebbe finestre Explorer sul PC host.
    // appUpdateInstall riavvierebbe il PC-server sotto i piedi di tutti i client.
    const remoteDenied: ReadonlySet<string> = new Set([IPC.libraryImport, IPC.openFolder, IPC.appUpdateInstall]);
    if (c && remoteDenied.has(c)) { json(res, 403, { e: 'non consentito da remoto' }); return; }
    // Canali dispositivo: hanno bisogno del contesto auth (il device che
    // chiama), non solo di `u` — per questo non stanno nella mappa handlers.
    if (c === IPC.deviceWhoami) {
      json(res, 200, { r: { admin: auth.admin, user: auth.admin ? reqUser(req) : auth.userId } });
      return;
    }
    if (c === IPC.deviceRegister) {
      // Converte il codice condiviso (QR/manuale) in un token per dispositivo:
      // il telefono conserva SOLO questo — il codice admin non resta in giro.
      if (!auth.admin) { json(res, 403, { e: 'solo col codice del PC' }); return; }
      const name = typeof body?.a?.[0] === 'string' ? body.a[0] : undefined;
      const d = devices.mintDevice(name);
      json(res, 200, { r: { token: d.token } });
      return;
    }
    if (c === IPC.deviceClaim) {
      const target = Number(body?.a?.[0]);
      if (!Number.isFinite(target) || !userExists(target)) { json(res, 400, { e: 'profilo inesistente' }); return; }
      if (auth.admin) { json(res, 200, { r: { ok: true, admin: true } }); return; } // il codice PC non si lega
      if (auth.userId === target) { json(res, 200, { r: { ok: true } }); return; }
      // Cambio profilo di un device già legato: solo se il PC lo sta
      // autorizzando ORA (finestra "Accoppia telefono" aperta) — altrimenti
      // il binding non sarebbe un confine.
      if (auth.userId == null || pairingOpenLeft() > 0) {
        devices.bindDevice(auth.deviceId!, target);
        auth.userId = target;
        json(res, 200, { r: { ok: true } });
      } else {
        json(res, 403, { e: 'Sul PC apri Impostazioni → Telefono e premi «Accoppia telefono» per cambiare profilo' });
      }
      return;
    }
    const fn = typeof c === 'string' ? handlers[c] : undefined;
    if (!fn) { json(res, 404, { e: 'metodo sconosciuto' }); return; }
    if (ADMIN_ONLY_CHANNELS.has(c as string) && !auth.admin) { json(res, 403, { e: 'solo dal PC' }); return; }
    const u = uidFor(BOOTSTRAP_CHANNELS.has(c as string));
    if (u == null) { json(res, 401, { e: 'profilo non valido' }); return; }
    const args = Array.isArray(body?.a) ? [...body!.a] : [];
    // Impostazioni che toccano il PC fisico o la sua sicurezza: solo dal
    // desktop. updateUrl in mano a un client col token = il PC installerebbe
    // un EXE arbitrario; currentUser aggirerebbe users:setCurrent (desktop-only).
    if (c === IPC.settingsSet) args[0] = sanitizeRemoteSettings(args[0]);
    try {
      // `u` iniettato dal server: gli args del client non possono impersonare
      // un altro profilo — il primo argomento è sempre l'utente autenticato
      const out = await (fn as (...a: unknown[]) => unknown)(u, ...args);
      // Il client riconcilia il profilo salvato col binding reale del token
      // (un device legato a u2 che chiede u3 deve accorgersi che resta u2)
      if (!auth.admin) res.setHeader('X-MH-Bound-User', String(u));
      json(res, 200, { r: out ?? null });
    } catch (e) {
      json(res, 500, { e: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  json(res, 404, { e: 'not found' });
}

// Corpo della request → file, con tetto di dimensione. false = interrotto/oltre il limite.
function readBodyToFile(req: IncomingMessage, file: string, max: number): Promise<boolean> {
  return new Promise((resolve) => {
    const out = createWriteStream(file);
    let got = 0;
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; if (!ok) { req.unpipe(out); out.destroy(); } resolve(ok); };
    req.on('data', (d: Buffer) => { got += d.length; if (got > max) { finish(false); req.destroy(); } });
    req.on('error', () => finish(false));
    req.on('aborted', () => finish(false));
    out.on('error', () => finish(false));
    out.on('finish', () => finish(got > 0));
    req.pipe(out);
  });
}

function readBody(req: IncomingMessage): Promise<{ c?: string; a?: unknown[]; k?: string; v?: unknown; name?: string; code?: string } | null> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (d) => { data += d; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
    // Senza questo, un body >5MB distruggeva la req senza mai risolvere:
    // la promise restava appesa e la connessione diventava zombie
    req.on('close', () => resolve(null));
  });
}

export function startRemoteServer(): void {
  const s = getSettings();
  if (!s.remoteEnabled || server) return;
  const port = s.remotePort ?? 48484;
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    try {
      // CORS: l'app Android/WebView ha origine http://localhost — serve il
      // cross-origin verso il PC. L'auth resta il token, quindi '*' è ok.
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Le pagine servite da qui caricano thumbnail esterne (i.ytimg.com):
      // niente Referer — la URL del documento può contenere il token di
      // pairing e comunque YouTube non deve sapere quale PC serve la UI.
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-MH-Token, X-MH-User',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }
      if (u.pathname === '/api/events') {
        const auth = authed(req);
        if (!auth) { if (authThrottled(req)) { json(res, 429, { e: 'troppi tentativi' }); } else { res.writeHead(401); res.end(); } return; }
        // Il profilo del client SSE decide quali broadcast per-utente riceve
        // (admin → tutti; device non associato → solo quelli senza `u`)
        serveEvents(req, res, auth.admin ? null : (auth.userId ?? -1));
        return;
      }
      const m = /^\/media\/(audio|cover)\/(\d+)$/.exec(u.pathname);
      if (m) {
        if (!authed(req)) { if (authThrottled(req)) { json(res, 429, { e: 'troppi tentativi' }); } else { res.writeHead(401); res.end(); } return; }
        serveMedia(req, res, m[1], parseInt(m[2], 10));
        return;
      }
      // Pairing guidato (UNICA route senza token): il telefono ha trovato il
      // PC via discovery UDP e chiede il codice. La consegna avviene SOLO
      // dentro la finestra aperta da "Accoppia telefono" (vedi pairing.ts) —
      // fuori è 403, così il telefono distingue "PC giusto, finestra chiusa"
      // da "host che non è MasterHype" (404/conn refused/captive portal).
      if (u.pathname === '/pair' && req.method === 'POST') {
        void readBody(req).then((body) => {
          const name = typeof body?.name === 'string' ? body.name.slice(0, 60) : undefined;
          // `code` = codice monouso dal QR (?pair=): autorizza da solo, si
          // consuma all'uso. Senza code vale solo la finestra «Accoppia».
          const code = typeof body?.code === 'string' ? body.code.slice(0, 80) : undefined;
          const r = tryPair(req.socket.remoteAddress ?? '?', name, getSettings().remoteToken ?? '', code);
          if (!r.ok) { json(res, r.reason === 'closed' ? 403 : 429, { e: 'pairing chiuso' }); return; }
          // NON si consegna più il codice condiviso: il device riceve un
          // token proprio (non ancora legato — il profilo si sceglie al gate
          // con device:claim). Il codice admin resta solo sul PC.
          const d = devices.mintDevice(name);
          json(res, 200, { t: d.token });
        });
        return;
      }
      // Auto-aggiornamento APK: PUBBLICO sulla LAN (il token è accettato ma
      // non richiesto). L'APK contiene solo codice dell'app — come la UI
      // statica servita qui sotto senza token — e così anche i telefoni in
      // modalità "senza PC" si aggiornano appena vedono un PC MasterHype
      // (discovery UDP) senza bisogno di pairing.
      if (u.pathname === '/update/manifest.json' || u.pathname === '/update/app.apk') {
        serveUpdateRoutes(updateDirs(), u.pathname, res);
        return;
      }
      if (u.pathname.startsWith('/api/')) {
        const auth = authed(req);
        if (!auth) {
          const throttled = authThrottled(req);
          json(res, throttled ? 429 : 401, { e: throttled ? 'troppi tentativi' : 'token mancante o errato' });
          return;
        }
        // /api/info è il probe di salute: NON valida il profilo — un client con
        // device non associato/profilo eliminato deve comunque scoprire che il
        // PC è vivo (poi le chiamate dati rispondono 401 → scelta profilo).
        // il try esterno è sync: un rejection async di handleApi cadrebbe fuori
        void handleApi(req, res, auth).catch(() => {
          try { if (!res.headersSent) json(res, 500, { e: 'errore interno' }); else res.end(); } catch { /* */ }
        });
        return;
      }
      serveStatic(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('error', (e) => {
    server = null; // porta occupata: il remoto si spegne, l'app resta
    report('generic', { message: `server remoto non avviato (${port}): ${e.message}` });
  });
  server.listen(port, '0.0.0.0');
  // il telefono trova il PC senza digitare l'indirizzo (broadcast UDP :48485)
  startDiscovery(
    () => getSettings().remotePort ?? 48484,
    (e) => report('generic', { message: `discovery UDP: ${e instanceof Error ? e.message : e}` }),
  );
}

export function stopRemoteServer(): void {
  stopDiscovery();
  try { server?.close(); } catch { /* */ }
  server = null;
  for (const res of sseClients.keys()) { try { res.end(); } catch { /* */ } }
  sseClients.clear();
}

// Riavvio quando l'utente cambia toggle/porta in Impostazioni
export function restartRemoteServer(): void {
  stopRemoteServer();
  startRemoteServer();
}

// Canale info per la UI di pairing in Impostazioni
export function registerRemoteInfoHandler(): void {
  handlers['remote:info'] = () => remoteInfo();
  // Finestra "Accoppia telefono": /pair consegna il token ai device che
  // chiedono mentre è aperta. Esposta anche via /api/call (un telefono già
  // pairato può aprirla per un nuovo device — ha già il token, stesso potere).
  handlers[IPC.pairingOpen] = () => ({ leftMs: openPairingWindow() });
  handlers[IPC.pairingStatus] = () => ({ leftMs: pairingOpenLeft() });
  // Codice monouso per il QR: il QR non trasporta più il codice condiviso —
  // una foto/copia del QR vale solo finché il codice non è riscattato/scaduto.
  handlers[IPC.pairingCode] = () => ({ code: mintPairCode(), leftMs: PAIR_CODE_TTL_MS });
}
