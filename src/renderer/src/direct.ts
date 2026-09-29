import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { Innertube } from 'youtubei.js';
import type { SearchResult, TrackRef, LyricsResult, PlayStreamResult, ArtistPage } from '../../shared/types';
import { collect, flattenShelves, toTrack, toAlbum, toArtist, toPlaylist, dedupe, text, thumbOf, audiusMatch, finalizeSearch, applySearchFilters, rankArtists, searchSuggestions, collectVideoFallback, isEmptyPageError, parseHealth } from '../../shared/ytparse';
import { enqueueIssue, noteClientSample, drainFieldDiag } from './fieldDiag';

// Modalità autonoma del telefono: quando il PC è spento/irraggiungibile ma il
// telefono ha internet, l'app parla DIRETTAMENTE con YouTube (ricerca, stream,
// radio, testi) — stessa esperienza Spotify. youtubei.js risolve il build
// "browser" e viene caricato lazy: chunk separato scaricato solo al primo uso
// (poi il service worker lo tiene in cache).
//
// CORS: le API Innertube e googlevideo non rispondono con ACAO — in un browser
// fetch() verso di loro fallisce. Nell'APK Android le richieste passano da
// CapacitorHttp (HTTP nativo OkHttp): il CORS non esiste a quel livello.
// In un browser normale la modalità autonoma è degradata: playback <audio>
// funziona (il media non richiede CORS), ma ricerca/download diretti no —
// il server del PC resta la via primaria.

export async function mhFetch(input: string | Request | URL, init?: RequestInit): Promise<Response> {
  // IMPORTANTE: youtubei.js passa un Request (o URL) e mette `body` in init
  // SENZA method — il metodo vive nel Request. Serve estrarre tutto.
  if (!Capacitor.isNativePlatform()) return fetch(input as RequestInfo, init);
  const isReq = typeof Request !== 'undefined' && input instanceof Request;
  const url = isReq ? (input as Request).url
    : typeof input === 'string' ? input : String(input); // URL → href
  const method = (init?.method ?? (isReq ? (input as Request).method : 'GET')).toUpperCase();
  const headers: Record<string, string> = {
    ...(isReq ? Object.fromEntries((input as Request).headers.entries()) : {}),
    ...(init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
  };
  // youtubei.js dichiara "accept-encoding: gzip, deflate", ma con un header
  // esplicito lo stack nativo non decomprime: togliendolo OkHttp riaggiunge
  // gzip da sé e lo srotola in trasparenza (altrimenti arriva compresso).
  delete headers['accept-encoding'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any = init?.body;
  if (data == null && isReq && method !== 'GET' && method !== 'HEAD') {
    data = await (input as Request).clone().text().catch(() => undefined);
  }
  if (data instanceof Uint8Array) data = data.buffer; // corpi protobuf
  (window as unknown as { __mhFetchLast?: string }).__mhFetchLast = `${method} ${url.slice(0, 120)}`;
  const r = await CapacitorHttp.request({
    url,
    method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    headers,
    data,
    responseType: 'arraybuffer',
    connectTimeout: 15_000,
    // Generoso: questo percorso porta anche i download-sul-telefono (MP3 interi
    // su rete mobile lenta). Le chiamate API rispondono in ms comunque.
    readTimeout: 300_000,
  });
  // responseType 'arraybuffer' NON garantisce base64 (HttpRequestHandler.readData):
  // Content-Type JSON → data è già un oggetto parsato; errore HTTP (≥400)
  // non-JSON → data è testo grezzo dall'errorStream. Solo il resto è base64.
  const ct = String(
    Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? ''
  );
  const enc = new TextEncoder();
  let body: BodyInit | null = null;
  if (typeof r.data === 'string') {
    if (ct.includes('application/json') || r.status >= 400) {
      body = enc.encode(r.data);
    } else {
      try {
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        body = bytes.buffer;
      } catch {
        body = enc.encode(r.data); // stringa non-base64 imprevista: testo grezzo
      }
    }
  } else if (r.data != null) {
    body = enc.encode(JSON.stringify(r.data));
  }
  // Response richiede status 200-599: su errore trasporto Capacitor può dare 0
  const status = r.status >= 200 && r.status < 600 ? r.status : 599;
  // 204/205/304 vietano il body (anche vuoto): generate_204 ci passa di qui
  if (status === 204 || status === 205 || status === 304) body = null;
  return new Response(body, { status, headers: r.headers });
}

type Yt = Innertube;
let ytP: Promise<Yt> | null = null;

function client(): Promise<Yt> {
  ytP ??= (async () => {
    // web.bundle = build single-file: il dist multi-file crea circular import
    // che Rollup appiattisce con ordine errato (TDZ "TabbedFeed" nel chunk).
    const { Innertube, Platform } = await import('youtubei.js/web.bundle');
    // Decipher player (n-throttling): la build web di youtubei.js non ha un
    // eval interno — gira nel realm eval-capable di po.html (potoken.ts).
    // data.output = script estratto dal player + chiamata process() finale
    // che restituisce { sig, n }.
    const { poFrame } = await import('./potoken');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Platform as any).shim.eval = async (data: any) => {
      const iw = await poFrame();
      if (!iw) return undefined;
      // output termina con `return process(...)`: serve un contesto funzione
      return (iw as unknown as { eval: (s: string) => unknown }).eval(
        `(function(){\n${String(data?.output ?? '')}\n})()`
      );
    };
    return Innertube.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: (input: any, init?: any) => mhFetch(input, init),
      // Sessione reale (sw.js_data): visitorData emesso da YouTube — quello
      // locale viene rifiutato da googlevideo per il GVS PoToken (&pot=).
      // Se il fetch fallisce youtubei.js ricade comunque sulla sessione locale.
      generate_session_locally: false, retrieve_player: true, lang: 'it', location: 'IT',
    });
  })();
  // Se la creazione fallisce (rete giù proprio in quel momento) riprova la prossima volta
  ytP.catch(() => { ytP = null; });
  return ytP;
}

// Precarica chunk + sessione in idle: il primo play dopo la caduta del PC
// non deve pagare l'inizializzazione (download player JS + decifratore).
export function warmup(): void {
  void client().catch(() => {});
}

// ---------- Stream audio ----------

// YouTube sta "gating" gli URL videoplayback dei client senza PoToken: il server
// risponde 200/206 solo per i primi ~1MB, ogni range a offset >0 dà 403 —
// l'<audio> ci si pianta a 0s e i download falliscono. Un URL si scopre gated
// solo provandolo: probe sull'ULTIMO byte (se passa, l'intero file è servibile).
async function probeStreamUrl(u: string): Promise<boolean> {
  const dbg = ((window as unknown as { __ytDbg: Record<string, unknown> }).__ytDbg ??= {}) as { probes?: unknown[] };
  const host = () => { try { return new URL(u).host.slice(-20); } catch { return '?'; } };
  try {
    let clen = Number(new URL(u).searchParams.get('clen'));
    if (!(clen > 2)) {
      // clen assente: la dimensione si ricava dal Content-Range di una probe
      // minima. ATTENZIONE: un URL gated risponde 206 anche a bytes=0-0 (il
      // primo ~1MB è sempre servito) — va sempre provato l'ULTIMO byte.
      const h = await mhFetch(u, { headers: { Range: 'bytes=0-0' } });
      (dbg.probes ??= []).push({ s: h.status, host: host(), pre: 1 });
      if (h.status !== 206) return false; // 403, 200 (range ignorato), 5xx: non verificabile
      const m = /\/(\d+)\s*$/.exec(h.headers.get('content-range') ?? '');
      clen = m ? +m[1] : 0;
      if (!(clen > 2)) return false; // dimensione ignota → non verificabile → scartato
    }
    const r = await mhFetch(u, { headers: { Range: `bytes=${clen - 1}-${clen - 1}` } });
    (dbg.probes ??= []).push({ s: r.status, host: host() });
    return r.status === 206 || r.status === 200;
  } catch { return false; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function formatUrl(yt: Yt, f: any): Promise<string | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let u: unknown = f.url;
  // decipher() è ASYNC e vuole il player della sessione: chiamarlo in sync
  // restituirebbe una Promise truthy scambiata per URL (bug latente: oggi i
  // client ANDROID/IOS mandano url in chiaro, ma se un giorno mandano solo
  // signature_cipher questo codice deve già funzionare).
  if (typeof u !== 'string' || !u) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = f.decipher as ((p?: unknown) => Promise<string>) | undefined;
    if (d) u = await d.call(f, yt.session.player).catch((e) => {
      const w = window as unknown as { __ytDbg: Record<string, unknown> };
      (w.__ytDbg ??= {}).decipherErr = String(e instanceof Error ? e.message : e).slice(0, 200);
      return undefined;
    });
  }
  return typeof u === 'string' && u.startsWith('http') ? u : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatPool(info: any, wantVideo: boolean, maxH?: number): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fmts: any[] = [...(info?.streaming_data?.adaptive_formats ?? []), ...(info?.streaming_data?.formats ?? [])];
  if (wantVideo) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prog = fmts.filter((f: any) => f.has_video && f.has_audio).sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));
    // maxH: preferisci il formato più alto che non supera il limite; se
    // nessuno rientra (es. solo 1080p disponibile) si prende comunque il migliore.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const capped = maxH ? prog.filter((f: any) => (f.height ?? 0) <= maxH) : prog;
    return capped.length ? capped : prog;
  }
  return fmts.filter((f: any) => f.has_audio && !f.has_video)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => {
      // AAC/M4A prima di Opus/WebM: alcune WebView Android non decodificano
      // Opus (MEDIA_ELEMENT_SRC_NOT_SUPPORTED sul blob scaricato).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mp4 = (f: any) => (String(f.mime_type ?? '').includes('mp4') ? 0 : 1);
      return mp4(a) - mp4(b) || (b.bitrate ?? 0) - (a.bitrate ?? 0);
    });
}

// Il client WEB ormai esige il PoToken su molte richieste: cascata di client
// + PoToken BotGuard (potoken.ts) se disponibile. Per ogni client si provano
// più formati e ogni URL viene VALIDATO con la probe anti-gating — il primo
// URL realmente riproducibile vince, non il primo risolto.
// `deadline` = budget complessivo: su rete scarsa una cascata completa può
// durare minuti (10 client × getBasicInfo + fino a 3 probe ciascuno) — meglio
// dichiarare fallimento e passare al brano dopo che restare muti a caricare.
async function streamUrl(videoId: string, wantVideo = false, maxH?: number, deadline = Date.now() + 60_000): Promise<string> {
  // Tracce Audius (id 'audius:<id>' prodotti dall'auto-riparazione): endpoint
  // diretto, 302 al file audio — come sul PC (downloader.streamUrl).
  if (videoId.startsWith('audius:')) {
    if (wantVideo) throw new Error('Audius non ha video');
    return audiusStreamUrl(videoId.slice(7));
  }
  const yt = await client();
  // PoToken (come yt-dlp): player request → content-bound mint(videoId);
  // parametro &pot= degli URL googlevideo → GVS session-bound mint del
  // VISITOR ID (l'id di 11 char dentro il visitorData protobuf, non il
  // protobuf intero).
  streamEvt('phase', 'resolve');
  const { poMinter } = await import('./potoken');
  const minter = await poMinter().catch(() => null);
  // BotGuard morto → modalità degradata: lo dice la UI, non solo __ytDbg.
  // Recuperato → il chip sparisce da solo.
  const dead = !minter;
  if (dead !== potDead) { potDead = dead; streamEvt('warn', dead ? 'potoken' : ''); }
  const vd = yt.session.context.client.visitorData;
  let vid = '';
  try {
    const { ProtoUtils } = await import('youtubei.js/web.bundle');
    vid = String((ProtoUtils.decodeVisitorData(String(vd ?? '')) as { id?: string })?.id ?? '').replace(/\0+$/, '');
  } catch { /* senza visitor id il GVS token non si minta */ }
  const gTok = minter && vid ? await minter.mint(vid).catch(() => null) : null;
  const vTok = minter ? await minter.mint(videoId).catch(() => null) : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (vTok) (yt.session as any).po_token = vTok;
  const stamp = (u: string) =>
    gTok ? `${u.replace(/&pot=[^&]*/, '')}&pot=${encodeURIComponent(gTok)}` : u;
  const ydbg = (k: string, v: unknown) => {
    const w = window as unknown as { __ytDbg: Record<string, unknown> };
    (w.__ytDbg ??= {})[k] = v;
  };
  ydbg('minter', !!minter); ydbg('gTok', !!gTok); ydbg('vTok', !!vTok);
  ydbg('vd', `${String(vd ?? '').slice(0, 10)}|${vid}`);
  let last: unknown;
  // Senza minter i formati gated sono la norma: se i primi 2 client escono
  // TUTTI con probe fallite, gli altri 8 faranno lo stesso — ogni tentativo
  // è una raffica di richieste Google (throttle su IP condivisi/CGNAT) e
  // secondi di attesa muta. Taglio corto → si va alla riparazione.
  let gatedRuns = 0;
  // TV_SIMPLY (TVHTML5_SIMPLY) è il client che oggi produce URL non gated
  // (206 sull'ultimo byte senza PoToken); il resto è ripiego.
  for (const c of ['TV_SIMPLY', 'ANDROID_VR', 'IOS', 'MWEB', 'TV', 'WEB', 'ANDROID', 'YTMUSIC_ANDROID', 'TV_EMBEDDED', 'WEB_EMBEDDED'] as const) {
    if (Date.now() > deadline) break; // budget finito: meglio errore che hang
    const tc = performance.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info: any = await yt.getBasicInfo(videoId, { client: c as any, ...(vTok ? { po_token: vTok } : {}) });
      let probed = 0;
      const pool = formatPool(info, wantVideo, maxH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mimes = pool.slice(0, 4).map((f: any) => String(f.mime_type ?? '?').replace(/;.*$/, '').replace('audio/', '').replace('video/', '')).join(',');
      for (const f of pool.slice(0, 4)) {
        if (probed >= 3 || Date.now() > deadline) break; // ogni probe è una request: tetto per client
        const u = await formatUrl(yt, f);
        if (!u) continue;
        probed++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (await probeStreamUrl(stamp(u))) {
          ydbg('picked', `${c}|${(f as any).mime_type}`);
          noteClientSample(c, performance.now() - tc, true);
          cascadeOk();
          return stamp(u);
        }
      }
      ydbg(c, `fmts:${pool.length} [${mimes}] probed:${probed}`);
      noteClientSample(c, performance.now() - tc, false);
      if (dead && probed > 0 && ++gatedRuns >= 2) { ydbg('gatedBail', c); break; }
    } catch (e) {
      last = e;
      noteClientSample(c, performance.now() - tc, false);
      ydbg(c, String(e instanceof Error ? e.message : e).slice(0, 120));
    }
  }
  cascadeRough();
  throw last instanceof Error ? last : new Error('stream non disponibile');
}

// PoToken (BotGuard nell'iframe po.html) è il single point of failure della
// cascata: se il minting muore (CSP, cross-realm, rotazione attestation)
// quasi tutti gli URL escono gated — lo stream suona ~1MB e muore, e
// l'utente vede solo "canzoni che si bloccano". Lo segnaliamo alla UI
// (chip ambrato nel player) invece di nasconderlo nella telemetria.
let potDead = false;
export function potTokenDown(): boolean { return potDead; }

// Progresso leggibile della cascata verso la UI: 'resolve' (probe client),
// 'heal' (riparazione sui candidati), 'audius' (ultima spiaggia). Senza
// questo il worst case di healing (~2 min) era uno spinner muto.
function streamEvt(kind: 'phase' | 'warn', detail = ''): void {
  try { window.dispatchEvent(new CustomEvent(`mh-stream-${kind}`, { detail })); } catch { /* */ }
}

// Degrado di cascata: conta le risoluzioni finite male DI FILA (cascata
// esaurita → heal/Audius o errore). Una risoluzione pulita resetta. A 3+ di
// fila il problema è sistemico (rotazione layout, throttle, PoToken), non il
// singolo brano → chip "stream a rischio" + issue che risale al PC.
let roughStreak = 0;
let lastCascadeWarn = 0;

function cascadeOk(): void {
  if (roughStreak) { roughStreak = 0; streamEvt('warn', potDead ? 'potoken' : ''); }
}

function cascadeRough(): void {
  roughStreak++;
  if (roughStreak >= 3 && Date.now() - lastCascadeWarn > 15 * 60_000) {
    lastCascadeWarn = Date.now();
    streamEvt('warn', 'cascade');
    enqueueIssue('cascade-degraded', { message: `${roughStreak} risoluzioni stream fallite di fila (pot=${potDead ? 'morto' : 'ok'})` });
  }
}

export function directStream(videoId: string): Promise<string> {
  return streamUrl(videoId);
}

// ---------- Audius: ultima spiaggia (catalogo legale, stream non gated) ----------
// Replica il fallback del PC (downloader.healStream): match stretto obbligatorio.

const AUDIUS = 'https://discoveryprovider.audius.co/v1';

interface AudiusTrack { id: string; title: string; artist: string }

async function audiusSearch(query: string): Promise<AudiusTrack[]> {
  try {
    const r = await mhFetch(`${AUDIUS}/tracks/search?query=${encodeURIComponent(query)}&limit=10&app_name=MasterHype`);
    if (!r.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = await r.json() as { data?: any[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (j?.data ?? []).filter((t: any) => t.id && t.title)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => ({ id: String(t.id), title: String(t.title), artist: String(t.user?.name ?? '') }));
  } catch { return []; }
}

const audiusStreamUrl = (id: string) => `${AUDIUS}/tracks/${id}/stream?app_name=MasterHype`;

// Auto-riparazione anche in modalità autonoma (replica la logica del PC):
// 1) videoId → stream validato; 2) se gated/morto, candidati dalla ricerca;
// 3) ultima spiaggia Audius con match stretto artista+titolo.
// Budget complessivo 120s: senza tetto la cascata completa (cascata client +
// 5 candidati × stessa cascata) su rete scarsa poteva durare minuti.
export async function directPlayStream(videoId: string, artist?: string, title?: string): Promise<PlayStreamResult> {
  const deadline = Date.now() + 120_000;
  try {
    return { url: await streamUrl(videoId, false, undefined, deadline), videoId, healed: false };
  } catch (e) {
    if (!artist || !title || Date.now() > deadline) { streamEvt('phase', ''); throw e; }
    streamEvt('phase', 'heal'); // la cascata è fallita: si cercano alternative
    try {
      const res = await directSearch(`${artist} ${title}`, false); // solo brani: serve un videoId, non le categorie
      for (const c of res.songs.filter((s) => s.videoId && s.videoId !== videoId).slice(0, 5)) {
        if (Date.now() > deadline) break;
        try {
          const url = await streamUrl(c.videoId, false, undefined, deadline);
          // Il videoId originale è morto: il PC lo impara come bad_stream così
          // le prossime ricerche/riproduzioni lo saltano direttamente.
          enqueueIssue('stream-dead', { videoId, artist, title });
          void drainFieldDiag().catch(() => {});
          return { url, videoId: c.videoId, healed: true };
        } catch { /* candidato successivo */ }
      }
    } catch { /* niente da riparare */ }
    // Audius resta anche oltre la deadline: una sola request economica
    streamEvt('phase', 'audius');
    for (const m of await audiusSearch(`${artist} ${title}`)) {
      if (!audiusMatch(m.artist, m.title, artist, title)) continue;
      enqueueIssue('stream-dead', { videoId, artist, title });
      void drainFieldDiag().catch(() => {});
      return { url: audiusStreamUrl(m.id), videoId: `audius:${m.id}`, healed: true };
    }
    streamEvt('phase', '');
    throw e;
  }
}

export function directVideoUrl(videoId: string, maxH?: number): Promise<string> {
  return streamUrl(videoId, true, maxH);
}

// ---------- Ricerca / contenuti ----------

export async function directSearch(query: string, expand = true): Promise<SearchResult> {
  const yt = await client();
  const out: SearchResult = { songs: [], albums: [], artists: [], playlists: [] };
  const ydbg = (k: string, v: unknown) => {
    const w = window as unknown as { __ytDbg: Record<string, unknown> };
    (w.__ytDbg ??= {})[k] = v;
  };
  // Ripiego sulla ricerca YouTube generica (item 'youtube'): stessa parse
  // best-effort ma struttura diversa — un layout music.search rotto spesso
  // lascia funzionante il percorso generico.
  const genericFallback = async () => {
    try {
      const res = await yt.search(query);
      try { collectVideoFallback(res, out); } catch { /* parziale */ }
      return true;
    } catch (e2) {
      // Pagina vuota su entrambe = zero risultati onesto, non errore di rete
      if (isEmptyPageError(e2)) return true;
      throw e2;
    }
  };
  try {
    const res = await yt.music.search(query);
    // Il parser di una singola shelf non deve buttare giù tutta la ricerca:
    // collect è best-effort ma un tipo di card nuovo può lanciare a metà —
    // teniamo ciò che ha già raccolto e completiamo col ripiego sotto.
    try { collect(res, out); } catch { /* raccolta parziale: va bene così */ }
    // Canary anti-degrado: la pagina grezza conteneva item riproducibili ma
    // non è uscito nessun brano → parser incompatibile col layout corrente.
    // Ripiego generico; se resta vuoto lo dichiariamo (degraded), non è un
    // "nessun risultato" onesto.
    if (!out.songs.length && !out.albums.length && !out.artists.length && !out.playlists.length) {
      const h = parseHealth(res);
      ydbg('searchHealth', `${h.items} items, ${h.playable} playable`);
      if (h.playable > 0) {
        ydbg('searchDegraded', true);
        await genericFallback();
        if (!out.songs.length) out.degraded = true;
      }
    }
    // Top result, promozione artista, "Forse cercavi…", ranking artisti —
    // identici al percorso PC (condivisi in ytparse.finalizeSearch).
    finalizeSearch(res, out, query);
    // Espansione per categorie: le pagine filtrate arricchiscono gli item
    // base (durata/album mancanti nel nuovo layout) via merge in collect.
    if (expand) {
      try { await applySearchFilters(res, out); } catch { /* espansione opzionale */ }
      out.artists = rankArtists(out.artists);
    }
  } catch {
    // music.search può fallire su risposte non standard (card/shelf nuove per
    // query specifiche — es. artisti con card particolari): ripiego sulla
    // ricerca YouTube generica — i brani arrivano lo stesso, marcatura
    // 'youtube', e l'utente non vede un errore secco.
    await genericFallback();
  }
  out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
  out.songs = dedupe(out.songs).slice(0, 60);
  out.albums = out.albums.slice(0, 20);
  out.artists = out.artists.slice(0, 12);
  out.playlists = out.playlists.slice(0, 12);
  return out;
}

export async function directSuggestions(query: string): Promise<string[]> {
  try {
    const yt = await client();
    const s = await yt.music.getSearchSuggestions(query);
    return searchSuggestions(s);
  } catch { return []; }
}

export async function directUpNext(videoId: string): Promise<TrackRef[]> {
  const yt = await client();
  try {
    const feed = await yt.music.getUpNext(videoId, true);
    const tracks = flattenShelves(feed).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t);
    if (tracks.length) return dedupe(tracks);
  } catch { /* fallback sotto */ }
  const feed = await yt.music.getUpNext(videoId);
  return dedupe(flattenShelves(feed).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t));
}

export async function directCharts(): Promise<TrackRef[]> {
  const yt = await client();
  // youtubei.js v18: niente più getTrending → feed Explore (classifiche/novità)
  const explore = await yt.music.getExplore();
  return dedupe(flattenShelves(explore).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t)).slice(0, 60);
}

export async function directArtistTop(browseId: string): Promise<TrackRef[]> {
  const yt = await client();
  const artist = await yt.music.getArtist(browseId);
  return dedupe(flattenShelves(artist).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t)).slice(0, 20);
}

export async function directArtistPage(browseId: string): Promise<ArtistPage> {
  const yt = await client();
  const artist = await yt.music.getArtist(browseId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hdr = artist.header as any;
  const page: ArtistPage = {
    id: browseId,
    name: text(hdr?.title),
    thumbnail: thumbOf(hdr as { thumbnail?: { contents?: { url: string; width: number }[] } }),
    subscribers: text(hdr?.subscribers),
    description: text(hdr?.description).slice(0, 400) || undefined,
    topSongs: [], albums: [], singles: [], related: [], playlists: [], videos: [],
  };
  for (const sec of artist.sections ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = sec as any;
    const title = (text(s.title ?? s.header?.title) || '').toLowerCase();
    const contents = s.contents ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kinds = new Set(contents.map((c: any) => c.item_type));
    if (s.type === 'MusicShelf' || title.includes('bran')) {
      for (const i of contents) { const t = toTrack(i); if (t) page.topSongs.push(t); }
    } else if (kinds.has('artist') || title.includes('potrebbe') || title.includes('correlat') || title.includes('fans also')) {
      for (const i of contents) { const a = toArtist(i); if (a) page.related.push(a); }
    } else if (kinds.has('playlist') || title.includes('playlist') || title.includes('primo piano') || title.includes('featured')) {
      for (const i of contents) { const p = toPlaylist(i); if (p) page.playlists.push(p); }
    } else if (kinds.has('video') || title.includes('video') || title.includes('live') || title.includes('performance')) {
      for (const i of contents) { const t = toTrack(i, 'youtube'); if (t) page.videos.push(t); }
    } else {
      const isSingle = title.includes('singol') || title.includes('single') || title.includes('ep');
      for (const i of contents) { const a = toAlbum(i); if (a) (isSingle ? page.singles : page.albums).push(a); }
    }
  }
  page.topSongs = dedupe(page.topSongs).slice(0, 10);
  page.albums = page.albums.slice(0, 30);
  page.singles = page.singles.slice(0, 30);
  page.related = page.related.slice(0, 15);
  page.playlists = page.playlists.slice(0, 15);
  page.videos = dedupe(page.videos).slice(0, 15);
  return page;
}

export async function directAlbumTracks(browseId: string): Promise<TrackRef[]> {
  const yt = await client();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const album: any = await yt.music.getAlbum(browseId);
  const defArtist = text(album.header?.strapline_text_one) || text(album.header?.subtitle?.runs?.find?.(
    (r: { endpoint?: { payload?: { pageType?: string } } }) => r.endpoint?.payload?.pageType?.includes('ARTIST')
  ));
  const defThumb = thumbOf(album.header);
  const albumTitle = text(album.header?.title);
  return dedupe(
    flattenShelves(album)
      .map((i) => toTrack(i))
      .filter((t): t is TrackRef => !!t)
      .map((t) => ({
        ...t,
        artist: t.artist && t.artist !== 'Sconosciuto' ? t.artist : (defArtist || t.artist),
        album: t.album || albumTitle || undefined,
        thumbnail: t.thumbnail ?? defThumb,
      }))
  );
}

export async function directPlaylistTracks(browseId: string): Promise<TrackRef[]> {
  const yt = await client();
  const id = browseId.replace(/^VL/, '');
  const pl = await yt.music.getPlaylist(id);
  return dedupe(flattenShelves(pl).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t));
}

// ---------- Testi (LRCLIB pubblico, raggiungibile dal telefono) ----------

function parseLrc(lrc: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

export async function directLyrics(artist: string, title: string, durationS?: number): Promise<LyricsResult> {
  const base = new URLSearchParams({ artist_name: artist, track_name: title });
  type Row = { syncedLyrics?: string | null; plainLyrics?: string | null };
  const has = (r: Row | null | undefined): r is Row => !!(r?.syncedLyrics || r?.plainLyrics);
  const j = async <T>(url: string): Promise<T | null> => { try { const r = await fetch(url); return r.ok ? await r.json() as T : null; } catch { return null; } };
  let r = durationS ? await j<Row>(`https://lrclib.net/api/get?${base}&duration=${Math.round(durationS)}`) : null;
  if (!has(r)) r = await j<Row>(`https://lrclib.net/api/get?${base}`);
  if (!has(r)) {
    const cleanTitle = title.replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').trim();
    for (const q of [`${artist} ${title}`, `${artist} ${cleanTitle}`]) {
      if (!q.trim() || has(r)) break;
      const s = await j<Row[]>(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      r = (s ?? []).find((x) => x.syncedLyrics || x.plainLyrics) ?? null;
    }
  }
  if (!r) return { found: false };
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics).filter((l) => l.text) : undefined;
  if (synced?.length) return { found: true, synced };
  if (r.plainLyrics) return { found: true, plain: r.plainLyrics.trim() };
  return { found: false };
}
