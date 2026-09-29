import { STATIONS } from '../../shared/types';
import type { AssistantRequest, AssistantResult, LibraryTrack, RemoteLike, SuggestedTrack, TrackRef, TrendItem } from '../../shared/types';
import { myUserId, isStandalone } from './remote';
import { localTaste, localSkipKeys, trackBaseKey } from './localData';
import { normText, trackKey } from '../../shared/taste';

// Approssimazioni locali delle funzioni "taste" che normalmente calcola il PC
// (suggest, autoplaylist, stazioni, radio, assistente, trends). Con il PC spento
// il telefono ricostruisce risultati ragionevoli da: cache dell'ultima scaletta
// generata dal PC, libreria/likes cachate e ricerca diretta su YouTube.
// Tutto è scope-ato per profilo come il resto dei dati locali.

// ---- cache "ultima scaletta buona" per-profilo (stazioni/autoplaylist) ----
const CK = (id: string) => `mh-auto-cache:u${myUserId()}:${id}`;

export function cachedAuto<T>(id: string): T | null {
  try {
    const raw = localStorage.getItem(CK(id));
    if (!raw) return null;
    return (JSON.parse(raw) as { v: T }).v ?? null;
  } catch { return null; }
}

export function cacheAuto(id: string, v: unknown): void {
  try {
    if (v == null || (Array.isArray(v) && !v.length)) return; // non avvelenare la cache con vuoti
    localStorage.setItem(CK(id), JSON.stringify({ at: Date.now(), v }));
  } catch {}
}

export function cachedTrends(): TrendItem[] | null {
  try {
    const raw = localStorage.getItem(`mh-trends-cache:u${myUserId()}`);
    return raw ? (JSON.parse(raw) as TrendItem[]) : null;
  } catch { return null; }
}
export function cacheTrends(items: TrendItem[]): void {
  try { if (items.length) localStorage.setItem(`mh-trends-cache:u${myUserId()}`, JSON.stringify(items)); } catch {}
}

// ---- helpers ----
const shuffle = <T,>(a: T[]): T[] => {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
};

const dedupe = (list: TrackRef[]): TrackRef[] => {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = t.videoId ?? trackKey(t.artist, t.title);
    if (!k || seen.has(k)) return false;
    seen.add(k); return true;
  });
};

const toRef = (t: LibraryTrack): TrackRef => ({
  videoId: t.videoId, title: t.title, artist: t.artist,
  durationS: t.durationS, thumbnail: t.thumbnail, source: 'ytmusic',
});

/** Brani piaciuti: libreria liked + like remoti non ancora in libreria */
export function likedTracks(library: LibraryTrack[], remoteLikes: RemoteLike[]): TrackRef[] {
  const owned = new Set(library.map((t) => t.videoId).filter(Boolean));
  return dedupe([
    ...library.filter((t) => t.liked).map(toRef),
    ...remoteLikes.filter((r) => !r.videoId || !owned.has(r.videoId))
      .map((r) => ({ ...r, source: 'ytmusic' as const })),
  ]);
}

const ownedVids = (library: LibraryTrack[]) => new Set(library.map((t) => t.videoId).filter(Boolean));

// ---- Gusti locali: stessa logica del TasteCtx del PC, fonti offline ----
// Pesi artista da localTaste (like/play negativi inclusi), artisti "bloccati"
// con match fuzzy (collaborazioni e alias non aggirano un dislike), brani
// skippati/nascosti su titolo base. Normalizzatori: shared/taste (parità PC).

interface LocalTaste { w: Map<string, number>; max: number; blocked: string[]; neg: Set<string> }
function tasteSnapshot(): LocalTaste {
  const rows = localTaste('artist');
  return {
    w: new Map(rows.map((r) => [normText(r.value), r.weight])),
    max: Math.max(1, ...rows.map((r) => Math.max(0, r.weight))),
    blocked: rows.filter((r) => r.weight < 0).map((r) => normText(r.value)),
    neg: localSkipKeys(),
  };
}
const blockedLocal = (t: LocalTaste, artist: string): boolean => {
  const a = normText(artist);
  return !!a && t.blocked.some((b) => b.length >= 3 && (a === b || a.includes(b) || b.includes(a)));
};

// Filtra + riordina col gusto locale: i negativi escono, gli artisti amati
// salgono (il rank della fonte resta un segnale secondario).
function tasteOrder(list: TrackRef[]): TrackRef[] {
  const t = tasteSnapshot();
  const n = Math.max(1, list.length);
  return dedupe(list)
    .filter((x) => !blockedLocal(t, x.artist) && !t.neg.has(trackBaseKey(x.artist, x.title)))
    .map((x, i) => ({ x, s: ((t.w.get(normText(x.artist)) ?? 0) / t.max) * 1.2 + (1 - i / n) * 0.3 }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.x);
}

/** arricchimento "consigliati": upNext su qualche seme preso dai preferiti/più ascoltati */
async function upNextPool(seeds: TrackRef[], n = 2): Promise<TrackRef[]> {
  const { directUpNext } = await import('./direct');
  const out: TrackRef[] = [];
  for (const s of shuffle(seeds).slice(0, n)) {
    if (!s.videoId) continue;
    try { out.push(...(await directUpNext(s.videoId))); } catch {}
  }
  return out;
}

async function searchPool(query: string): Promise<TrackRef[]> {
  const { directSearch } = await import('./direct');
  try { return (await directSearch(query, false)).songs; } catch { return []; }
}

async function chartsPool(): Promise<TrackRef[]> {
  const { directCharts } = await import('./direct');
  try { return await directCharts(); } catch { return []; }
}

// ---- suggest (Home hero) ----
export function offlineSuggest(library: LibraryTrack[], remoteLikes: RemoteLike[]): SuggestedTrack[] {
  const out: SuggestedTrack[] = [];
  const push = (t: TrackRef, reason: string) => out.push({ ...t, score: 1, reason, sources: ['local'] });
  for (const t of shuffle([...library].sort((a, b) => b.playCount - a.playCount).slice(0, 8)))
    push(toRef(t), `tra i tuoi più ascoltati (${t.playCount} play)`);
  for (const t of shuffle(likedTracks(library, remoteLikes)).slice(0, 8))
    push(t, 'hai messo mi piace');
  return dedupe(out) as SuggestedTrack[];
}

// ---- autoplaylist ----
export async function offlineAutoplaylist(id: string, library: LibraryTrack[], remoteLikes: RemoteLike[]): Promise<TrackRef[]> {
  const likes = likedTracks(library, remoteLikes);
  const top = [...library].sort((a, b) => b.playCount - a.playCount).map(toRef);
  const owned = ownedVids(library);

  const fresh = async (minus = true): Promise<TrackRef[]> => {
    const pool = [...await chartsPool(), ...await upNextPool(likes.length ? likes : top, 3)];
    return minus ? pool.filter((t) => !t.videoId || !owned.has(t.videoId)) : pool;
  };

  let list: TrackRef[] = [];
  if (id === 'liked') list = shuffle(likes);
  else if (id === 'top') list = top;
  else if (id === 'mix') list = shuffle([...likes, ...top.slice(0, 15), ...(await fresh(false)).slice(0, 10)]);
  else if (id === 'scoperte' || id === 'nuove') list = await fresh(true);
  else if (id.startsWith('genre:')) list = tasteOrder(await searchPool(`${id.slice(6)} hits`));
  else if (id.startsWith('artist:')) list = dedupe([...await searchPool(id.slice(7)), ...await upNextPool(likes, 1)]);
  return dedupe(list).slice(0, 50);
}

// ---- stazioni / radio ----
export async function offlineStation(id: string, library: LibraryTrack[], remoteLikes: RemoteLike[]): Promise<TrackRef[]> {
  const def = STATIONS.find((s) => s.id === id);
  if (def?.query) return tasteOrder(await searchPool(def.query)).slice(0, 40);

  // stazioni personali: equivalenti locali
  const likes = likedTracks(library, remoteLikes);
  const top = [...library].sort((a, b) => b.playCount - a.playCount).map(toRef);
  const owned = ownedVids(library);
  let list: TrackRef[] = [];
  if (id === 'preferiti') list = shuffle(likes);
  else if (id === 'classifiche') list = await chartsPool();
  else if (id === 'per-te') list = shuffle([...likes.slice(0, 20), ...await upNextPool(likes.length ? likes : top, 3)]);
  else { // 'novita-te' | 'scoperte' | id sconosciuti: novità + correlati ai gusti
    const pool = [...await chartsPool(), ...await upNextPool(likes.length ? likes : top, 3)];
    list = pool.filter((t) => !t.videoId || !owned.has(t.videoId));
  }
  // Il filtro/ordine sui gusti locali replica il TasteCtx del PC:
  // artisti dislikati fuori, brani skippati fuori, artisti amati in testa.
  return tasteOrder(list).slice(0, 40);
}

export async function offlineRadio(kind: 'artist' | 'genre', value: string): Promise<TrackRef[]> {
  if (kind === 'genre') return tasteOrder(await searchPool(`${value} hits`)).slice(0, 40);
  const found = await searchPool(value);
  const v = normText(value);
  // Il seed tiene ~1/3 della scaletta (parità col PC), interlacciato coi
  // correlati ordinati sui gusti locali.
  const seed = found.filter((t) => { const a = normText(t.artist ?? ''); return a === v || a.includes(v) || v.includes(a); });
  const rest = tasteOrder(dedupe([...(await upNextPool(seed.length ? seed : found, 1)), ...found]))
    .filter((t) => !seed.some((s) => s.videoId === t.videoId));
  const out: TrackRef[] = [];
  let ri = 0;
  while (out.length < 40 && (seed.length || ri < rest.length)) {
    if (seed.length && (out.length === 0 || out.length % 3 === 2)) out.push(seed.shift()!);
    else if (ri < rest.length) out.push(rest[ri++]);
    else if (seed.length) out.push(seed.shift()!);
    else break;
  }
  return dedupe(out);
}

// Continuazione radio col PC spento: upNext diretto filtrato sui gusti
// locali, con ancora al seme della stazione (stesso contratto di rec:next).
export async function offlineContinue(videoId: string, artist: string, ctx?: string): Promise<TrackRef[]> {
  const { directUpNext } = await import('./direct');
  const ups = await directUpNext(videoId).catch(() => [] as TrackRef[]);
  if (!ups.length) return [];
  const ordered = tasteOrder(ups);
  const seedArtist = ctx?.startsWith('radio:artist:') ? normText(ctx.slice(13)) : '';
  if (!seedArtist) return ordered.slice(0, 15);
  // Il seme resta presente durante la continuazione (salgono i suoi brani)
  return ordered
    .map((x) => ({ x, boost: artist && normText(x.artist) === seedArtist ? 1 : 0 }))
    .sort((a, b) => b.boost - a.boost)
    .map((y) => y.x)
    .slice(0, 15);
}

// ---- assistente ----
export async function offlineAssistant(req: AssistantRequest): Promise<AssistantResult> {
  const q = req.prompt?.trim() || req.vibe || 'top hits';
  const pool = dedupe(await searchPool(q));
  const tracks: SuggestedTrack[] = [];
  const capS = req.targetMinutes > 0 ? req.targetMinutes * 60 : Infinity;
  let totalS = 0;
  for (const t of pool) {
    const d = t.durationS ?? 210;
    if (totalS + d > capS || tracks.length >= 30) break;
    totalS += d;
    tracks.push({ ...t, score: 1, reason: isStandalone() ? 'ricerca diretta sul telefono' : 'PC offline — ricerca diretta', sources: ['direct'] });
  }
  return {
    tracks,
    alternates: pool.slice(tracks.length, tracks.length + 10)
      .map((t): SuggestedTrack => ({ ...t, score: 1, reason: 'ricambio', sources: ['direct'] })),
    totalMinutes: Math.round(totalS / 60),
    explanation: isStandalone()
      ? 'Tracklist generata con ricerca diretta sul telefono — il motore dei gusti arriva col PC.'
      : 'PC offline: tracklist generata con ricerca diretta su YouTube — niente motore dei gusti finché il PC non torna.',
  };
}

// ---- trends ----
export async function offlineTrends(): Promise<TrendItem[]> {
  return (await chartsPool()).slice(0, 40).map((t, i): TrendItem => ({
    title: t.title, artist: t.artist ?? '', rank: i + 1,
    sources: ['ytmusic'], niche: false, videoId: t.videoId, thumbnail: t.thumbnail,
  }));
}
