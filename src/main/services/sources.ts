import { createHash, randomBytes } from 'node:crypto';
import { getSettings, setSettings } from '../settings';
import { getDb } from '../db';
import { normText, normTag } from '../../shared/taste';

// Aggregatore fonti gratuite: Deezer (no key), Last.fm (key gratis), Spotify (credenziali dev).
// Ogni metodo restituisce [] se la fonte non è configurata/raggiungibile.

const DEEZER = 'https://api.deezer.com';
const LASTFM = 'https://ws.audioscrobbler.com/2.0';
const SPOTIFY = 'https://api.spotify.com/v1';

async function j<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------- Deezer (zero configurazione) ----------

interface DeezerArtist { id: number; name: string; nb_fan?: number }
interface DeezerTrack { id: number; title: string; artist: { name: string }; duration: number; album?: { cover_medium?: string } }

// Cache in-sessione: i suggerimenti interrogano Deezer molte volte per gli stessi artisti.
const artistCache = new Map<string, DeezerArtist | null>();
const topCache = new Map<string, { title: string; artist: string }[]>();
const relatedCache = new Map<string, string[]>();

// Scelta dell'artista Deezer: data[0] cieco prendeva omonimi/tribute
// ("Nirvana" → "Nirvana (UK)", la band anni '60). Si preferisce il match sul
// nome (norm: "AC/DC"↔"acdc"), a parità il più seguito (nb_fan); fallback
// al primo risultato come prima.
export function pickDeezerArtist(list: DeezerArtist[], query: string): DeezerArtist | null {
  const want = normText(query);
  const score = (a: DeezerArtist): number => {
    const n = normText(a.name);
    if (!want || !n) return 0;
    if (n === want) return 2;
    if (n.includes(want) || want.includes(n)) return 1;
    return 0;
  };
  return [...list]
    .sort((x, y) => (score(y) - score(x)) || (y.nb_fan ?? 0) - (x.nb_fan ?? 0))[0] ?? null;
}

export async function deezerSearchArtist(name: string): Promise<DeezerArtist | null> {
  const k = name.toLowerCase();
  if (artistCache.has(k)) return artistCache.get(k) ?? null;
  const r = await j<{ data?: DeezerArtist[] }>(`${DEEZER}/search/artist?q=${encodeURIComponent(name)}&limit=5`);
  if (r === null) return null; // errore di rete: non cachare, ritenta la prossima volta
  const a = pickDeezerArtist(r.data ?? [], name);
  artistCache.set(k, a);
  return a;
}

export async function deezerRelatedArtists(name: string): Promise<string[]> {
  const k = name.toLowerCase();
  if (relatedCache.has(k)) return relatedCache.get(k)!;
  const a = await deezerSearchArtist(name);
  if (!a) return [];
  const r = await j<{ data?: DeezerArtist[] }>(`${DEEZER}/artist/${a.id}/related?limit=20`);
  const out = (r?.data ?? []).map((x) => x.name);
  relatedCache.set(k, out);
  return out;
}

export async function deezerChart(): Promise<{ title: string; artist: string; rank: number; cover?: string }[]> {
  const r = await j<{ data?: DeezerTrack[] }>(`${DEEZER}/chart/0/tracks?limit=50`);
  return (r?.data ?? []).map((t, i) => ({
    title: t.title, artist: t.artist.name, rank: i + 1, cover: t.album?.cover_medium,
  }));
}

export async function deezerArtistTop(name: string): Promise<{ title: string; artist: string }[]> {
  const k = name.toLowerCase();
  if (topCache.has(k)) return topCache.get(k)!;
  const a = await deezerSearchArtist(name);
  if (!a) return [];
  const r = await j<{ data?: DeezerTrack[] }>(`${DEEZER}/artist/${a.id}/top?limit=15`);
  const out = (r?.data ?? []).map((t) => ({ title: t.title, artist: t.artist.name }));
  topCache.set(k, out);
  return out;
}

// ---- Catalogo per-genere Deezer (zero chiave) ----
// Senza Last.fm i semi 'tag'/'tagtracks' delle stazioni restavano vuoti: qui
// /genre dà la mappa id↔nome (cache di sessione), poi /genre/{id}/artists e
// /chart/{id}/tracks danno i top reali del genere. Copre i generi-umbrella;
// per tag senza genere Deezer corrispondente (sottogeneri/mood/decenni)
// restituisce vuoto — il motore ricade su query+upNext come sempre.
let dzGenresP: Promise<Map<string, number>> | null = null;
function deezerGenreMap(): Promise<Map<string, number>> {
  dzGenresP ??= (async () => {
    const r = await j<{ data?: { id: number; name: string }[] }>(`${DEEZER}/genre`);
    const m = new Map<string, number>();
    for (const g of r?.data ?? []) if (g.id > 0) m.set(normTag(g.name), g.id);
    return m;
  })();
  return dzGenresP;
}
// Tag nostri → nomi genere Deezer dove normTag da solo non basta
// ("hip hop"→"Rap/Hip Hop", "lo-fi"→catalogo rap/jazz: Deezer non ha lofi).
const DEEZER_TAG_ALIAS: Record<string, string[]> = {
  'hip hop': ['rap hip hop'], rap: ['rap hip hop'], trap: ['rap hip hop'], drill: ['rap hip hop'],
  'italian hip hop': ['rap hip hop', 'italian pop'], 'italian trap': ['rap hip hop', 'italian pop'],
  rnb: ['r b', 'soul funk'], soul: ['soul funk', 'r b'], funk: ['soul funk', 'dance'],
  motown: ['soul funk'], gospel: ['gospel', 'soul funk'],
  edm: ['dance', 'electro'], electronic: ['electro', 'dance'], techno: ['electro'],
  house: ['dance'], 'deep house': ['dance', 'electro'], 'minimal techno': ['electro'],
  'drum and bass': ['electro'], dnb: ['electro'], jungle: ['electro'],
  synthwave: ['electro', 'pop'], retrowave: ['electro'], synthpop: ['electro', 'pop'],
  'dance pop': ['dance', 'pop'], electropop: ['electro', 'pop'], club: ['dance'],
  'k-pop': ['k pop', 'asian music', 'pop'], kpop: ['k pop', 'pop'], 'korean pop': ['k pop'],
  afrobeats: ['african music', 'pop'], afrobeat: ['african music'], afropop: ['african music'],
  'bossa nova': ['brazilian music', 'jazz'], samba: ['brazilian music'], mpb: ['brazilian music'],
  brazilian: ['brazilian music'],
  italian: ['italian pop', 'pop'], 'italian pop': ['italian pop', 'pop'], 'pop italiano': ['italian pop'],
  'italian indie': ['indie', 'italian pop'], 'indie pop': ['indie', 'pop'],
  'singer-songwriter': ['folk', 'pop'], cantautori: ['italian pop', 'folk'],
  neomelodica: ['italian pop'], napoletana: ['italian pop'],
  'classic rock': ['rock'], 'hard rock': ['rock', 'metal'], 'heavy metal': ['metal'],
  'thrash metal': ['metal'], 'alternative rock': ['alternative', 'rock'],
  'indie rock': ['indie', 'alternative'], indie: ['indie', 'alternative'],
  'punk rock': ['punk'], 'hardcore punk': ['punk'], 'pop punk': ['punk'], 'skate punk': ['punk'],
  emo: ['punk', 'alternative'], 'post-hardcore': ['punk'],
  grunge: ['alternative', 'rock'], 'new wave': ['alternative'], 'post-punk': ['alternative'],
  'smooth jazz': ['jazz'], bebop: ['jazz'], swing: ['jazz'],
  'blues rock': ['blues', 'rock'], 'delta blues': ['blues'],
  americana: ['country', 'folk'], 'country rock': ['country'],
  dub: ['reggae'], ska: ['reggae'], 'roots reggae': ['reggae'],
  orchestral: ['classical'], opera: ['classical'], symphony: ['classical'],
  soundtrack: ['classical'], score: ['classical'], 'film score': ['classical'],
  reggaeton: ['latin music', 'pop'], latin: ['latin music'], 'latin pop': ['latin music'],
  'lo-fi': ['rap hip hop', 'jazz'], chillhop: ['rap hip hop', 'jazz'], downtempo: ['electro'],
  '80s': ['pop'], '90s': ['pop'], '70s': ['pop'], '2000s': ['pop'], '2010s': ['pop'],
};
async function deezerGenreId(tag: string): Promise<number | null> {
  const m = await deezerGenreMap();
  const t = normTag(tag);
  if (m.has(t)) return m.get(t)!;
  for (const alt of DEEZER_TAG_ALIAS[t] ?? []) { const id = m.get(alt); if (id) return id; }
  for (const [n, id] of m) if (t.length > 2 && n.length > 2 && (t.includes(n) || n.includes(t))) return id;
  return null;
}
interface DzTagCatalog { artists: string[]; tracks: { title: string; artist: string }[] }
const dzTagCache = new Map<string, DzTagCatalog>();
export async function deezerTagCatalog(tag: string): Promise<DzTagCatalog> {
  const k = normTag(tag);
  const hit = dzTagCache.get(k);
  if (hit) return hit;
  const id = await deezerGenreId(tag);
  const out: DzTagCatalog = { artists: [], tracks: [] };
  if (id != null) {
    const [a, tr] = await Promise.all([
      j<{ data?: DeezerArtist[] }>(`${DEEZER}/genre/${id}/artists?limit=25`),
      j<{ data?: DeezerTrack[] }>(`${DEEZER}/chart/${id}/tracks?limit=40`),
    ]);
    out.artists = (a?.data ?? []).map((x) => x.name).filter(Boolean);
    out.tracks = (tr?.data ?? []).map((x) => ({ title: x.title, artist: x.artist?.name ?? '' })).filter((x) => x.title && x.artist);
  }
  dzTagCache.set(k, out);
  return out;
}
// Top artisti/tracce di un tag di catalogo: Last.fm se la chiave c'è,
// il catalogo Deezer per-genere altrimenti (o se Last.fm risponde vuoto —
// stessa copertura zero-config che il gate iTunes/MB già dà ai filtri).
export async function tagTopArtists(tag: string): Promise<string[]> {
  const lf = await lastfmTagTopArtists(tag).catch(() => [] as string[]);
  if (lf.length) return lf;
  return (await deezerTagCatalog(tag).catch(() => null))?.artists ?? [];
}
export async function tagTopTracks(tag: string): Promise<{ title: string; artist: string }[]> {
  const lf = await lastfmTagTopTracks(tag).catch(() => [] as { title: string; artist: string }[]);
  if (lf.length) return lf;
  return (await deezerTagCatalog(tag).catch(() => null))?.tracks ?? [];
}

// ---------- Last.fm ----------

export async function lastfmTestKey(key: string): Promise<boolean> {
  const r = await j<{ chart?: unknown }>(`${LASTFM}/?method=chart.gettopartists&api_key=${key}&format=json&limit=1`);
  return !!r;
}

export async function lastfmSimilarArtists(name: string): Promise<string[]> {
  const key = getSettings().lastfmApiKey;
  if (!key) return [];
  const r = await j<{ similarartists?: { artist?: { name: string }[] } }>(
    `${LASTFM}/?method=artist.getsimilar&artist=${encodeURIComponent(name)}&api_key=${key}&format=json&limit=20`);
  return (r?.similarartists?.artist ?? []).map((a) => a.name);
}

export async function lastfmSimilarTracks(artist: string, track: string): Promise<{ title: string; artist: string }[]> {
  const key = getSettings().lastfmApiKey;
  if (!key) return [];
  const r = await j<{ similartracks?: { track?: { name: string; artist: { name: string } }[] } }>(
    `${LASTFM}/?method=track.getsimilar&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(track)}&api_key=${key}&format=json&limit=20`);
  return (r?.similartracks?.track ?? []).map((t) => ({ title: t.name, artist: t.artist.name }));
}

const TAG_CACHE_MS = 7 * 24 * 3600_000; // anche i risultati vuoti: evita refetch ripetuti

function parseTags(json: string): string[] {
  try { const t = JSON.parse(json); return Array.isArray(t) ? t : []; } catch { return []; }
}

export async function lastfmArtistTags(name: string): Promise<string[]> {
  const cached = getDb().prepare('SELECT tags, fetched_at FROM artist_tags WHERE artist=?').get(name.toLowerCase()) as { tags: string; fetched_at: number } | undefined;
  if (cached && Date.now() - cached.fetched_at < TAG_CACHE_MS) return parseTags(cached.tags);
  const key = getSettings().lastfmApiKey;
  if (!key) return cached ? parseTags(cached.tags) : [];
  const r = await j<{ toptags?: { tag?: { name: string }[] } }>(
    `${LASTFM}/?method=artist.gettoptags&artist=${encodeURIComponent(name)}&api_key=${key}&format=json`);
  const tags = (r?.toptags?.tag ?? []).map((t) => t.name.toLowerCase()).slice(0, 8);
  getDb().prepare('INSERT OR REPLACE INTO artist_tags (artist,tags,fetched_at) VALUES (?,?,?)')
    .run(name.toLowerCase(), JSON.stringify(tags), Date.now());
  return tags;
}

export async function lastfmTagTopArtists(tag: string): Promise<string[]> {
  const key = getSettings().lastfmApiKey;
  if (!key) return [];
  const r = await j<{ topartists?: { artist?: { name: string }[] } }>(
    `${LASTFM}/?method=tag.gettopartists&tag=${encodeURIComponent(tag)}&api_key=${key}&format=json&limit=25`);
  return (r?.topartists?.artist ?? []).map((a) => a.name);
}

export async function lastfmTagTopTracks(tag: string): Promise<{ title: string; artist: string }[]> {
  const key = getSettings().lastfmApiKey;
  if (!key) return [];
  const r = await j<{ tracks?: { track?: { name: string; artist: { name: string } }[] } }>(
    `${LASTFM}/?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&api_key=${key}&format=json&limit=30`);
  return (r?.tracks?.track ?? []).map((t) => ({ title: t.name, artist: t.artist.name }));
}

export async function lastfmChart(): Promise<{ title: string; artist: string; rank: number }[]> {
  const key = getSettings().lastfmApiKey;
  if (!key) return [];
  const r = await j<{ tracks?: { track?: { name: string; artist: { name: string } }[] } }>(
    `${LASTFM}/?method=chart.gettoptracks&api_key=${key}&format=json&limit=50`);
  return (r?.tracks?.track ?? []).map((t, i) => ({ title: t.name, artist: t.artist.name, rank: i + 1 }));
}

// ---------- Audius: catalogo alternativo legale, zero chiave ----------
// Usato come ultima spiaggia dell'auto-riparazione: quando YouTube non ha uno
// stream valido per un brano, Audius può averlo (catalogo più piccolo/indie,
// per questo serve il match stretto artista+titolo in downloader.healStream).

const AUDIUS = 'https://discoveryprovider.audius.co/v1';

export interface AudiusTrack { id: string; title: string; artist: string; durationS: number; artwork?: string }

export async function audiusSearch(query: string): Promise<AudiusTrack[]> {
  const r = await j<{ data?: { id: string; title: string; duration: number; user?: { name?: string }; artwork?: Record<string, string> }[] }>(
    `${AUDIUS}/tracks/search?query=${encodeURIComponent(query)}&limit=10&app_name=MasterHype`);
  return (r?.data ?? []).filter((t) => t.id && t.title).map((t) => ({
    id: t.id, title: t.title, artist: t.user?.name ?? '',
    durationS: t.duration, artwork: t.artwork?.['480x480'] ?? t.artwork?.['1000x1000'],
  }));
}

// Endpoint che 302-redirige al file audio vero: <audio> e yt-dlp seguono il redirect
export const audiusStreamUrl = (id: string) => `${AUDIUS}/tracks/${id}/stream?app_name=MasterHype`;

// ---------- LRCLIB: testi gratis, nessuna chiave ----------

export interface LyricsResult {
  found: boolean;
  synced?: { t: number; text: string }[]; // LRC parsato: secondi → riga
  plain?: string;
}

// Parsing LRC: [mm:ss.xx] testo — più timestamp per riga possibili
export function parseLrc(lrc: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() });
  }
  return out.sort((a, b) => a.t - b.t);
}

export async function fetchLyrics(artist: string, title: string, durationS?: number): Promise<LyricsResult> {
  const base = new URLSearchParams({ artist_name: artist, track_name: title });
  type Row = { syncedLyrics?: string | null; plainLyrics?: string | null };
  const has = (r: Row | null | undefined): r is Row => !!(r?.syncedLyrics || r?.plainLyrics);
  const UA = { 'User-Agent': 'MasterHype/0.1 (https://github.com/masterhype)' }; // richiesto da LRCLIB
  // 1) match esatto con durata (se nota) — 2) senza durata — 3) ricerca libera
  let r = durationS
    ? await j<Row>(`https://lrclib.net/api/get?${base}&duration=${Math.round(durationS)}`, UA)
    : null;
  if (!has(r)) r = await j<Row>(`https://lrclib.net/api/get?${base}`, UA);
  if (!has(r)) {
    // Tolgo "(feat. X)", "(Remastered)", "[Live]" ecc: riducono il match
    const cleanTitle = title.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
    for (const q of [`${artist} ${title}`, `${artist} ${cleanTitle}`]) {
      if (!q.trim() || has(r)) break;
      const s = await j<Row[]>(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, UA);
      r = (s ?? []).find((x) => x.syncedLyrics || x.plainLyrics) ?? null;
    }
  }
  if (!r) return { found: false };
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics).filter((l) => l.text) : undefined;
  if (synced?.length) return { found: true, synced };
  if (r.plainLyrics) return { found: true, plain: r.plainLyrics.trim() };
  return { found: false };
}

// ---------- Spotify (Client Credentials + PKCE per top/artists utente) ----------

let spotifyToken: { token: string; exp: number } | null = null;
let spotifyUserToken: { access: string; refresh: string; exp: number } | null = null;

async function spotifyAppToken(): Promise<string | null> {
  const s = getSettings();
  if (!s.spotifyClientId || !s.spotifyClientSecret) return null;
  if (spotifyToken && spotifyToken.exp > Date.now()) return spotifyToken.token;
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${s.spotifyClientId}&client_secret=${s.spotifyClientSecret}`,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const r = (await res.json()) as { access_token: string; expires_in: number };
    spotifyToken = { token: r.access_token, exp: Date.now() + r.expires_in * 1000 - 60_000 };
    return spotifyToken.token;
  } catch {
    return null;
  }
}

async function spotifyGet<T>(path: string, userToken = false): Promise<T | null> {
  let token: string | null;
  if (userToken) {
    await refreshSpotifyUserToken();
    token = spotifyUserToken?.access ?? null;
  } else {
    token = await spotifyAppToken();
  }
  if (!token) return null;
  return j<T>(`${SPOTIFY}${path}`, { Authorization: `Bearer ${token}` });
}

export async function spotifyNewReleases(): Promise<{ title: string; artist: string }[]> {
  const r = await spotifyGet<{ albums?: { items?: { name: string; artists: { name: string }[] }[] } }>(
    '/browse/new-releases?limit=30');
  return (r?.albums?.items ?? []).map((a) => ({ title: a.name, artist: a.artists[0]?.name ?? '' }));
}

export async function spotifyArtistTop(name: string): Promise<{ title: string; artist: string }[]> {
  const s = await spotifyGet<{ artists?: { items?: { id: string; name: string }[] } }>(
    `/search?q=${encodeURIComponent(name)}&type=artist&limit=1`);
  const id = s?.artists?.items?.[0]?.id;
  if (!id) return [];
  const r = await spotifyGet<{ tracks?: { name: string; artists: { name: string }[] }[] }>(
    `/artists/${id}/top-tracks`);
  return (r?.tracks ?? []).map((t) => ({ title: t.name, artist: t.artists[0]?.name ?? '' }));
}

// OAuth PKCE (dev mode: fino a 25 utenti whitelisted, ok per uso personale).
let pkceVerifier = '';
let pkceState = '';

export function spotifyAuthUrl(port: number): string | null {
  const s = getSettings();
  if (!s.spotifyClientId) return null;
  pkceVerifier = cryptoRandom().slice(0, 64);
  pkceState = cryptoRandom().slice(0, 24);
  const s256 = createHash('sha256').update(pkceVerifier, 'utf-8').digest('base64url');
  const params = new URLSearchParams({
    client_id: s.spotifyClientId,
    response_type: 'code',
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    scope: 'user-top-read',
    state: pkceState,
    code_challenge_method: 'S256',
    code_challenge: s256,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function cryptoRandom(): string {
  return randomBytes(48).toString('base64url');
}

export async function spotifyExchangeCode(code: string, state: string, port: number): Promise<boolean> {
  if (state !== pkceState) return false;
  const s = getSettings();
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: `http://127.0.0.1:${port}/callback`,
        client_id: s.spotifyClientId,
        code_verifier: pkceVerifier,
      }).toString(),
    });
    if (!res.ok) return false;
    const r = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    spotifyUserToken = { access: r.access_token, refresh: r.refresh_token, exp: Date.now() + r.expires_in * 1000 };
    setSettings({ spotifyRefreshToken: r.refresh_token, spotifyConnected: true });
    return true;
  } catch {
    return false;
  }
}

async function refreshSpotifyUserToken(): Promise<void> {
  // Ripristina il token salvato dopo un riavvio dell'app
  if (!spotifyUserToken) {
    const saved = getSettings().spotifyRefreshToken;
    if (saved) spotifyUserToken = { access: '', refresh: saved, exp: 0 };
  }
  if (!spotifyUserToken || spotifyUserToken.exp > Date.now()) return;
  const s = getSettings();
  try {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifyUserToken.refresh,
        client_id: s.spotifyClientId,
      }).toString(),
    });
    if (!res.ok) { spotifyUserToken = null; setSettings({ spotifyConnected: false }); return; }
    const r = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    spotifyUserToken = { ...spotifyUserToken, access: r.access_token, refresh: r.refresh_token ?? spotifyUserToken.refresh, exp: Date.now() + r.expires_in * 1000 };
    if (r.refresh_token) setSettings({ spotifyRefreshToken: r.refresh_token });
  } catch { /* token perso */ }
}

export async function spotifyConnected(): Promise<boolean> {
  if (spotifyUserToken?.access) return true;
  if (!getSettings().spotifyRefreshToken) return false;
  await refreshSpotifyUserToken();
  const ok = spotifyUserToken != null && spotifyUserToken.access !== '';
  if (ok !== getSettings().spotifyConnected) setSettings({ spotifyConnected: ok });
  return ok;
}

export async function spotifyImportTopArtists(): Promise<string[]> {
  const r = await spotifyGet<{ items?: { name: string; genres?: string[] }[] }>(
    '/me/top/artists?limit=30&time_range=medium_term', true);
  return (r?.items ?? []).map((a) => a.name);
}

// ---------- Generi artista senza chiavi: iTunes Search + MusicBrainz ----------
// Parità col gate del telefono (offlineRec.itunesGate): sul PC la verifica di
// genere dipendeva SOLO da Last.fm → senza api_key le stazioni di genere e i
// mood diventavano query nude (Guns N' Roses in "Italiana", hit Bollywood in
// "Festa", stock/AI in "Chill/Viaggio", baby-dance in "Novità").
// I positivi finiscono nella tabella artist_genres (cache lunga, i generi non
// cambiano); i negativi restano in memoria di sessione — un rate-limit non
// deve diventare "artista senza genere" per sempre.

const ITG_BLOCK_KEY = 'sys:itunes-blocked';
const ITG_BLOCK_MS = 10 * 60_000;
const itgMem = new Map<string, string | null>(); // normArtista → genere (anche negativi, solo sessione)
let itgActive = 0;                               // pool da 3: seriale puro metteva 30+s sulle stazioni
const itgWaiters: (() => void)[] = [];           // il breaker 4xx resta il guardiano del rate-limit
let itgBlockedUntil = -1;                        // -1 = non ancora letto da prefs

const itgAcquire = async (): Promise<void> => {
  if (itgActive < 3) { itgActive++; return; }
  await new Promise<void>((r) => itgWaiters.push(r));
  itgActive++;
};
const itgRelease = (): void => { itgActive--; itgWaiters.shift()?.(); };

const itgSerialize = async <T>(fn: () => Promise<T>): Promise<T> => {
  await itgAcquire();
  try { return await fn(); } finally { itgRelease(); }
};

const itgIsBlocked = (): boolean => {
  if (itgBlockedUntil < 0) {
    itgBlockedUntil = Number((getDb().prepare('SELECT v FROM prefs WHERE k=?')
      .get(ITG_BLOCK_KEY) as { v: string } | undefined)?.v ?? 0);
  }
  return Date.now() < itgBlockedUntil;
};

const itgMarkBlocked = (): void => {
  itgBlockedUntil = Date.now() + ITG_BLOCK_MS;
  try {
    getDb().prepare('INSERT OR REPLACE INTO prefs (k,v) VALUES (?,?)').run(ITG_BLOCK_KEY, String(itgBlockedUntil));
  } catch { /* breaker solo in memoria */ }
};

const upsertArtistGenre = (artist: string, patch: { itunes?: string; mb?: string }): void => {
  try {
    getDb().prepare(`INSERT INTO artist_genres (artist, itunes, mb, fetched_at) VALUES (?,?,?,?)
      ON CONFLICT(artist) DO UPDATE SET
        itunes = COALESCE(excluded.itunes, itunes),
        mb = COALESCE(excluded.mb, mb),
        fetched_at = excluded.fetched_at`)
      .run(artist, patch.itunes ?? null, patch.mb ?? null, Date.now());
  } catch { /* cache best-effort */ }
};

// primaryGenreName iTunes — match norm esatto preferito al primo risultato
// ("Queen" non deve diventare "Queensrÿche"). 4xx = l'IP sta rafficando →
// breaker persistente 10 min: insistere peggiora e basta (vedi itunesGate).
export async function itunesArtistGenre(name: string): Promise<string | null> {
  const a = normText(name);
  if (!a) return null;
  if (itgMem.has(a)) return itgMem.get(a) ?? null;
  const row = getDb().prepare('SELECT itunes FROM artist_genres WHERE artist=?')
    .get(a) as { itunes: string | null } | undefined;
  if (row?.itunes) { itgMem.set(a, row.itunes); return row.itunes; }
  if (itgIsBlocked()) return null;
  return itgSerialize(async () => {
    try {
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=musicArtist&limit=3`,
        { signal: AbortSignal.timeout(10000) });
      if (!res.ok) { itgMarkBlocked(); return null; }
      const jr = await res.json() as { results?: { artistName?: string; primaryGenreName?: string }[] };
      const r = jr.results ?? [];
      const pick = r.find((x) => normText(x.artistName ?? '') === a) ?? r[0];
      const g = pick?.primaryGenreName ? String(pick.primaryGenreName).toLowerCase() : null;
      itgMem.set(a, g);
      if (g) upsertArtistGenre(a, { itunes: g });
      return g;
    } catch {
      return null;
    } finally {
      await new Promise((r) => setTimeout(r, 140)); // pacing anti-429 (come il telefono)
    }
  });
}

// Tag MusicBrainz — ~1 req/s imposto dal servizio (coda via attesa), User-Agent
// obbligatorio: senza risponde 403. Ultima spiaggia per gli artisti che iTunes
// non classifica — sono quelli il vettore del leak (vedi itunesGate telefono).
let mbNextAt = 0;
export async function mbArtistTags(name: string): Promise<string[]> {
  const a = normText(name);
  if (!a) return [];
  const row = getDb().prepare('SELECT mb FROM artist_genres WHERE artist=?')
    .get(a) as { mb: string | null } | undefined;
  if (row?.mb) return row.mb.split('|').filter(Boolean);
  const wait = mbNextAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  mbNextAt = Date.now() + 1100;
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=1`,
      { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'MasterHype/1.0 (github.com/musalova/masterhype)' } });
    if (!res.ok) return [];
    const jr = await res.json() as { artists?: { name?: string; tags?: { name?: string }[] }[] };
    const art = (jr.artists ?? []).find((x) => normText(x.name ?? '') === a) ?? jr.artists?.[0];
    const tags = (art?.tags ?? []).map((t) => String(t.name ?? '').toLowerCase()).filter(Boolean).slice(0, 8);
    if (tags.length) upsertArtistGenre(a, { mb: tags.join('|') });
    return tags;
  } catch {
    return [];
  }
}

// Tag/genere di un artista dalla migliore fonte disponibile: Last.fm se c'è
// la chiave, altrimenti iTunes primaryGenre, altrimenti tag MusicBrainz.
// È ciò che rende il gate di genere indipendente dalla chiave Last.fm.
export async function artistGenreTags(name: string): Promise<string[]> {
  const lf = await lastfmArtistTags(name).catch(() => [] as string[]);
  if (lf.length) return lf;
  const g = await itunesArtistGenre(name).catch(() => null);
  if (g) return [g];
  return mbArtistTags(name).catch(() => [] as string[]);
}
