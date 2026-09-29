import { createHash, randomBytes } from 'node:crypto';
import { getSettings, setSettings } from '../settings';
import { getDb } from '../db';

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

export async function deezerSearchArtist(name: string): Promise<DeezerArtist | null> {
  const k = name.toLowerCase();
  if (artistCache.has(k)) return artistCache.get(k) ?? null;
  const r = await j<{ data?: DeezerArtist[] }>(`${DEEZER}/search/artist?q=${encodeURIComponent(name)}&limit=3`);
  if (r === null) return null; // errore di rete: non cachare, ritenta la prossima volta
  const a = r.data?.[0] ?? null;
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
    const cleanTitle = title.replace(/\s*[\(\[][^)\]]*[\)\]]/g, '').trim();
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
