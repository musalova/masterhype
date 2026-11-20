import { STATIONS } from '../../shared/types';
import type { AssistantRequest, AssistantResult, LibraryTrack, RemoteLike, SuggestedTrack, TrackRef, TrendItem } from '../../shared/types';
import { myUserId, isStandalone } from './remote';
import { localTaste, mergeTaste, localSkipKeys, trackBaseKey } from './localData';
import { normText, trackKey, junkTrack } from '../../shared/taste';

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

// Tag Last.fm che non sono generi veri: mai proporli come mix/radio.
// Unica fonte — Home, Stazioni e Playlist filtravano ciascuna la sua copia.
export const JUNK_TAGS = new Set([
  'seen live', 'favorites', 'favourite', 'favorite', 'love', 'hate', 'my favorite',
  'male vocalists', 'female vocalists', 'all', 'misc', 'other', 'various',
]);
// Filtra una lista di tag/generi: fuori la spazzatura e i duplicati
// case-insensitive ("Pop" e "pop" non devono apparire due volte).
export function cleanTags(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = normText(v);
    if (!k || JUNK_TAGS.has(k) || seen.has(k)) continue;
    seen.add(k); out.push(v);
  }
  return out;
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
  const rows = tasteRowsOffline('artist');
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
    .filter((x) => normText(x.artist) !== 'sconosciuto' && !junkTrack(x.artist, x.title, x.durationS)
      && !blockedLocal(t, x.artist) && !t.neg.has(trackBaseKey(x.artist, x.title)))
    .map((x, i) => ({ x, s: ((t.w.get(normText(x.artist)) ?? 0) / t.max) * 1.2 + (1 - i / n) * 0.3 }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.x);
}

// ---- Profilo gusti completo, usabile a PC spento ----
// mergeTaste = ultima copia del PC (cache mh-taste-cache per kind) + segnali
// raccolti offline nel frattempo. Senza copia PC (mai pairato / standalone
// puro) si ricostruisce tutto da libreria+segnali locali. I suggerimenti
// autonomi usano SEMPRE questa vista — non solo la libreria cachata.
type TasteRow = { kind: string; value: string; weight: number };
export function tasteRowsOffline(kind: 'artist' | 'tag' | 'genre'): TasteRow[] {
  const read = (k: string): TasteRow[] => {
    try {
      const s = localStorage.getItem(`mh-taste-cache:u${myUserId()}:${k}`);
      const j = s ? JSON.parse(s) : null;
      return Array.isArray(j) ? j as TasteRow[] : [];
    } catch { return []; }
  };
  const base = [...read(kind), ...read('all')].filter((r) => r?.kind === kind);
  const merged = mergeTaste(base, kind).filter((r) => r.kind === kind);
  return merged.length ? merged : localTaste(kind);
}

// Artisti del profilo che matchano il prefisso digitato — stessa regola del
// server (handlers[searchSuggest]): prefisso sul nome o su una parola, i più
// amati prima. Funziona senza rete → i suggerimenti non spariscono MAI.
export function localSuggestArtists(q: string, limit = 3): string[] {
  const nq = normText(q.trim());
  if (!nq) return [];
  return tasteRowsOffline('artist')
    .filter((r) => { const v = normText(r.value); return r.weight > 0 && (v.startsWith(nq) || v.split(' ').some((w) => w.startsWith(nq))); })
    .slice(0, limit)
    .map((r) => normText(r.value).replace(/\b\p{L}/gu, (c) => c.toUpperCase()));
}

// Autocomplete completo lato telefono: i TUOI artisti prima dei suggerimenti
// YouTube (che da soli tirano fuori nomi sconosciuti). La parte locale non
// può fallire → esiste sempre qualcosa da proporre.
export async function localSuggestions(q: string): Promise<string[]> {
  const mine = localSuggestArtists(q);
  let yt: string[] = [];
  try { const { directSuggestions } = await import('./direct'); yt = await directSuggestions(q); } catch { /* */ }
  const nq = normText(q.trim());
  const seen = new Set(yt.map((s) => normText(s)));
  return [...mine.filter((m) => !seen.has(normText(m)) && normText(m) !== nq), ...yt].slice(0, 10);
}

/** arricchimento "consigliati": upNext su qualche seme preso dai preferiti/più ascoltati */
async function upNextPool(seeds: TrackRef[], n = 2): Promise<TrackRef[]> {
  return (await upNextTagged(seeds, n)).map((x) => x.t);
}

// Come upNextPool ma conserva l'artista del seme: serve per il "perché te lo
// propongo" dei suggerimenti (parità col `reason` del motore PC).
async function upNextTagged(seeds: TrackRef[], n = 2): Promise<{ t: TrackRef; from: string }[]> {
  const { directUpNext } = await import('./direct');
  const out: { t: TrackRef; from: string }[] = [];
  for (const s of shuffle(seeds).slice(0, n)) {
    if (!s.videoId) continue;
    try { for (const t of await directUpNext(s.videoId)) out.push({ t, from: s.artist ?? '' }); } catch {}
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

// ---- Pool di scoperta tarato sui gusti ----
// Prima il grosso della pool erano le classifiche globali: artisti mai visti
// in cima a ogni lista autonoma. Ora i semi sono i TUOI brani più amati —
// upNext dà correlati vicini ai gusti, le classifiche restano una quota
// minore (la novità vera serve ancora, ma non deve dominare).
async function tasteSeededPool(library: LibraryTrack[], remoteLikes: RemoteLike[], seedsN = 4, chartsN = 12): Promise<TrackRef[]> {
  const likes = likedTracks(library, remoteLikes);
  const top = [...library].sort((a, b) => b.playCount - a.playCount).map(toRef);
  const seeds = shuffle(likes.length ? likes : top).slice(0, seedsN);
  const [ups, charts] = await Promise.all([upNextPool(seeds, Math.max(2, seedsN - 1)), chartsPool()]);
  return [...ups, ...charts.slice(0, chartsN)];
}

// Tracce TUE nel genere richiesto (libreria cachata: il campo genre è
// valorizzato dai download/tag). Sono i semi dei mix/radio di genere —
// così "Radio rock" parte da ciò che ascolti davvero, non da "rock hits".
function genreSeedTracks(genre: string, library: LibraryTrack[]): LibraryTrack[] {
  const g = normText(genre);
  if (!g || g.length < 2) return [];
  return [...library]
    .filter((t) => {
      const tg = normText(t.genre ?? '');
      return !!tg && tg.length >= 2 && (tg === g || tg.includes(g) || g.includes(tg));
    })
    .sort((a, b) => (b.liked ? 5 : 0) + b.playCount - ((a.liked ? 5 : 0) + a.playCount));
}

// ---- Verifica genere via iTunes Search API (parità del gate Last.fm del PC) ----
// Senza gate un preferito off-genere (Queen) entrava in "blues": la query lo
// tirava su e niente controllava che il suo genere fosse davvero blues.
// L'API è pubblica con CORS → funziona sul telefono senza chiavi.
// [genre della stazione normalizzato] → regex dei primaryGenre iTunes ammessi.
const ITUNES_ACCEPT: [RegExp, RegExp][] = [
  [/^blues/, /\bblues/i],
  [/^jazz|bebop/, /jazz|bebop|swing|big band|dixieland|ragtime|vocal|bossa|torch|lounge|standards|easy listening/i],
  [/bossa/, /bossa|brazil|latin|jazz|mpb/i],
  [/metal/, /metal|thrash|doom|sludge|grind|death|hardcore/i],
  [/hip.?hop|rap|trap|drill/, /hip.?hop|rap|trap|drill|grime|urban/i],
  [/soul|funk/, /soul|r&b|rnb|funk|motown|gospel|neo|disco|quiet storm/i],
  [/r&b|rnb/, /soul|r&b|rnb|funk|motown|neo|quiet storm|urban/i],
  [/techno/, /techno|electronic|dance|house|minimal|acid/i],
  [/house/, /house|electronic|dance|techno|deep|acid|garage/i],
  [/drum|dnb/, /drum|bass|jungle|dubstep|electronic|dance|breakbeat/i],
  [/lo.?fi|chill/, /lo.?fi|chill|ambient|downtempo|electronic|instrumental|new age/i],
  [/disco|dance|synth|edm|club|eurodance/, /disco|dance|electronic|house|techno|euro|synth|edm|trance|club/i],
  [/country/, /country|americana|bluegrass|honky|western/i],
  [/folk/, /folk|americana|singer|acoustic|bluegrass|traditional|world|celtic|country/i],
  [/reggae|dancehall|ska/, /reggae|ska|dub|dancehall|rocksteady/i],
  [/soundtrack|colonne/, /soundtrack|score|classical|orchestr|film|original cast/i],
  [/classic/, /classical|opera|orchestr|baroque|chamber|symphon|choral|score|soundtrack|piano|violin/i],
  [/latin|reggaeton|urbano/, /latin|reggaeton|salsa|bachata|tropical|cumbia|merengue|urban|balada|mexican|tejano/i],
  [/k.?pop/, /k.?pop|korean|asia/i],
  [/afro/, /afro|african|world|highlife|soca/i],
  [/neomelodica/, /pop|italian|vocal|easy listening|world/i],
  [/cantautor/, /singer|pop|italian|folk|rock/i],
  [/italiana/, /italian|pop|vocal|singer|easy listening|world/i],
  [/rock|punk|grunge|emo|wave|indie|alternative|hard rock/, /rock|alternative|indie|punk|metal|grunge|emo|new wave|garage|surf|hardcore|post|britpop|glam|singer\/songwriter|pop/i],
  [/pop|vocal/, /pop|italian|vocal|easy listening|singer|europop|teen|adult contemporary|soft rock|italo|dance/i],
];

const itunesAccept = (stationGenre: string): RegExp | null => {
  const g = normText(stationGenre);
  for (const [re, acc] of ITUNES_ACCEPT) if (re.test(g)) return acc;
  return null;
};

const ITG_KEY = () => `mh-itunes-genres:u${myUserId()}`;
let itgMem: Map<string, string | null> | null = null;
const itgLoad = (): Map<string, string | null> => {
  if (itgMem) return itgMem;
  try { itgMem = new Map(Object.entries(JSON.parse(localStorage.getItem(ITG_KEY()) ?? '{}') as Record<string, string | null>)); }
  catch { itgMem = new Map(); }
  return itgMem;
};
const itgSave = () => {
  try {
    if (!itgMem?.size) return;
    // Si persistono solo i generi TROVATI: un lookup fallito per rate-limit non
    // deve diventare "artista senza genere" permanente — la sessione dopo riprova.
    const ok = [...itgMem].filter((e): e is [string, string] => e[1] != null).slice(-600);
    if (ok.length) localStorage.setItem(ITG_KEY(), JSON.stringify(Object.fromEntries(ok)));
  } catch { /* quota */ }
};

// primaryGenreName iTunes di un artista (cache + match esatto preferito al
// primo risultato, così "Queen" non diventa "Queensrÿche"). Un retry con
// piccolo backoff; un 403/429 marca il breaker — iTunes blocca l'IP sotto
// raffica e insistere peggiora solo.
const ITG_BLOCKED = '__itunes_blocked';
async function itunesGenreOf(artist: string): Promise<string | null> {
  const a = normText(artist);
  if (!a) return null;
  const c = itgLoad();
  if (c.has(a)) return c.get(a) ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, 350 + Math.random() * 300));
      const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(artist)}&entity=musicArtist&limit=3`);
      if (!r.ok) { c.set(ITG_BLOCKED, String(Date.now())); break; }
      const j = (await r.json()) as { results?: { artistName?: string; primaryGenreName?: string }[] };
      const res = j?.results ?? [];
      const pick = res.find((x) => normText(x.artistName ?? '') === a) ?? res[0];
      const g = pick?.primaryGenreName ? String(pick.primaryGenreName).toLowerCase() : null;
      c.set(a, g); itgSave();
      return g;
    } catch { /* riprova */ }
  }
  return null;
}

// Tag artista da MusicBrainz (fallback dei preferiti: servizio diverso, niente
// rate-limit condiviso con iTunes). Uniti in 'a|b|c' — gli stessi regex accept.
async function mbGenreOf(artist: string): Promise<string | null> {
  const a = normText(artist);
  if (!a) return null;
  const c = itgLoad();
  const k = `mb:${a}`;
  if (c.has(k)) return c.get(k) ?? null;
  try {
    const r = await fetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(`artist:"${artist}"`)}&fmt=json&limit=1`);
    if (!r.ok) return null;
    const j = (await r.json()) as { artists?: { name?: string; tags?: { name?: string }[] }[] };
    const art = (j?.artists ?? []).find((x) => normText(x.name ?? '') === a) ?? j?.artists?.[0];
    const tags = (art?.tags ?? []).map((t) => String(t.name ?? '').toLowerCase()).filter(Boolean);
    const g = tags.length ? tags.join('|') : null;
    c.set(k, g); itgSave();
    return g;
  } catch { return null; }
}

// Filtra i candidati la cui etichetta iTunes smentisce il genere della stazione.
// I preferiti del profilo si verificano per primi: sono loro il vettore del
// leak (il "tilt" dei gusti) — un Queen in blues si becca qui. Artista non
// trovato/non classificato → resta (beneficio del dubbio). Se il gate stronca
// più della metà dei candidati il mapping è sospetto → meglio non svuotare.
async function itunesGate(genre: string, tracks: TrackRef[]): Promise<TrackRef[]> {
  const acc = itunesAccept(genre);
  if (!acc || !tracks.length) return tracks;
  const liked = new Set(tasteRowsOffline('artist').map((r) => normText(r.value)));
  const uniq = [...new Set(tracks.map((t) => t.artist).filter((a): a is string => !!a))];
  uniq.sort((a, b) => Number(liked.has(normText(b))) - Number(liked.has(normText(a))));
  const genres = new Map<string, string | null>();
  // Prima fonte, gratis e offline-pura: il tag genre della libreria cachata.
  // Un Queen posseduto (tag 'rock') in "blues" cade senza nemmeno la rete.
  try {
    const lib = JSON.parse(localStorage.getItem(`mh-lib-cache:u${myUserId()}`) ?? '[]') as LibraryTrack[];
    for (const t of lib) {
      const a = normText(t.artist ?? '');
      const g = normText(t.genre ?? '');
      if (a && g && !genres.has(a)) genres.set(a, g);
    }
  } catch { /* */ }
  const needLookup = uniq.filter((a) => !genres.has(normText(a)));
  // iTunes a raffica gentile + breaker: se l'IP viene bloccato si smette subito
  // (un 403 oggi non deve né martellare né compromettere i controlli futuri).
  const blocked = Number(itgLoad().get(ITG_BLOCKED) ?? 0);
  if (Date.now() - blocked > 10 * 60_000) {
    for (let i = 0; i < Math.min(needLookup.length, 36); i += 3) {
      if (i) await new Promise((r) => setTimeout(r, 160)); // pacing anti-429
      await Promise.all(needLookup.slice(i, i + 3).map((a) => itunesGenreOf(a).then((g) => genres.set(normText(a), g))));
      if (itgLoad().has(ITG_BLOCKED)) break;
    }
  }
  // Fallback MusicBrainz SOLO sui preferiti rimasti non verificati: sono loro
  // il vettore del leak — Queen in blues non può dipendere da un 403 di iTunes.
  const missing = needLookup.filter((a) => genres.get(normText(a)) == null && liked.has(normText(a))).slice(0, 8);
  for (const a of missing) {
    genres.set(normText(a), await mbGenreOf(a));
    await new Promise((r) => setTimeout(r, 850)); // MB: ~1 req/s
  }
  const kept = tracks.filter((t) => { const g = genres.get(normText(t.artist ?? '')); return g == null || acc.test(g); });
  return kept.length >= 8 || kept.length >= Math.ceil(tracks.length * 0.5) ? kept : tracks;
}

// Pool "genere X": tuoi brani del genere + correlati upNext sui migliori +
// una quota di ricerca "${genre} hits" (o la query curata della stazione) per
// la scoperta. Se la libreria non copre il genere (tag senza file locali)
// resta solo la ricerca — tasteOrder comunque filtra e ordina sui gusti.
async function genrePool(genre: string, library: LibraryTrack[], query?: string): Promise<TrackRef[]> {
  const own = genreSeedTracks(genre, library).slice(0, 10).map(toRef);
  const hits = await searchPool(query ?? `${genre} hits`);
  // Semi upNext: i tuoi brani del genere, o — se la libreria non ne ha — i
  // risultati del genere stesso. MAI i like generici: seminare upNext dai
  // preferiti riempiva la stazione jazz di pezzi pop che ami.
  const seeds = own.length ? own : hits.slice(0, 4);
  const ups = await upNextPool(seeds, 3);
  return itunesGate(genre, [...own, ...ups, ...hits.slice(0, 15)]);
}

// ---- suggest (Home hero) ----
// Suggerimenti VERI anche senza PC: correlati upNext dei brani più amati
// (novità vicine ai gusti, mai già posseduti) + qualche certezza locale.
// Cache 30 min: su rete mobile ogni apertura di Home non deve ripagare
// N chiamate upNext.
const SUGG_LOCAL_TTL = 30 * 60_000;
export async function offlineSuggest(library: LibraryTrack[], remoteLikes: RemoteLike[]): Promise<SuggestedTrack[]> {
  try {
    const raw = localStorage.getItem(CK('sugg:local'));
    if (raw) {
      const c = JSON.parse(raw) as { at?: number; v?: SuggestedTrack[] };
      if (Date.now() - (c.at ?? 0) < SUGG_LOCAL_TTL && Array.isArray(c.v) && c.v.length) return c.v;
    }
  } catch { /* */ }
  const out: SuggestedTrack[] = [];
  const likes = likedTracks(library, remoteLikes);
  const owned = ownedVids(library);
  const seeds = shuffle(likes.length ? likes : [...library].sort((a, b) => b.playCount - a.playCount).map(toRef)).slice(0, 6);
  const tagged = await upNextTagged(seeds, 4).catch(() => [] as { t: TrackRef; from: string }[]);
  const fromOf = new Map(tagged.map((x) => [x.t, x.from]));
  for (const t of tasteOrder(tagged.map((x) => x.t))) {
    if (t.videoId && owned.has(t.videoId)) continue;
    const from = fromOf.get(t);
    out.push({ ...t, score: 1, reason: from ? `perché ascolti ${from}` : 'correlato ai tuoi preferiti', sources: ['direct'] });
  }
  // Se la rete non dà niente restano le certezze — la shelf non resta vuota.
  if (out.length < 4) {
    for (const t of shuffle([...library].sort((a, b) => b.playCount - a.playCount).slice(0, 8)))
      out.push({ ...toRef(t), score: 1, reason: `tra i tuoi più ascoltati (${t.playCount} play)`, sources: ['local'] });
    for (const t of shuffle(likes).slice(0, 8))
      out.push({ ...t, score: 1, reason: 'hai messo mi piace', sources: ['local'] });
  }
  const list = dedupe(out) as SuggestedTrack[];
  if (list.length) cacheAuto('sugg:local', list);
  return list;
}

// ---- autoplaylist ----
export async function offlineAutoplaylist(id: string, library: LibraryTrack[], remoteLikes: RemoteLike[]): Promise<TrackRef[]> {
  const likes = likedTracks(library, remoteLikes);
  const top = [...library].sort((a, b) => b.playCount - a.playCount).map(toRef);
  const owned = ownedVids(library);

  const fresh = async (minus = true): Promise<TrackRef[]> => {
    const pool = await tasteSeededPool(library, remoteLikes);
    return minus ? pool.filter((t) => !t.videoId || !owned.has(t.videoId)) : pool;
  };

  let list: TrackRef[] = [];
  if (id === 'liked') list = shuffle(likes);
  else if (id === 'top') list = top;
  else if (id === 'mix') list = tasteOrder([...likes, ...top.slice(0, 15), ...(await fresh(false)).slice(0, 10)]);
  // Scoperte/novità: pool tarata sui gusti e ORDINATA — prima usciva in ordine
  // grezzo (le classifiche dominavano → artisti sconosciuti in testa).
  else if (id === 'scoperte' || id === 'nuove') list = tasteOrder(await fresh(true));
  else if (id.startsWith('genre:')) list = tasteOrder(await genrePool(id.slice(6), library));
  else if (id.startsWith('artist:')) list = tasteOrder(dedupe([...await searchPool(id.slice(7)), ...await upNextPool(likes, 1)]));
  return dedupe(list).slice(0, 50);
}

// ---- stazioni / radio ----
export async function offlineStation(id: string, library: LibraryTrack[], remoteLikes: RemoteLike[]): Promise<TrackRef[]> {
  const def = STATIONS.find((s) => s.id === id);
  // Stazione di genere: i tuoi brani di quel genere + correlati + catalogo,
  // non solo la query nuda (parità col seed Last.fm del PC).
  if (def?.genre) return tasteOrder(await genrePool(def.genre, library, def.query)).slice(0, 40);
  if (def?.query) return tasteOrder(await searchPool(def.query)).slice(0, 40);

  // stazioni personali: equivalenti locali
  const likes = likedTracks(library, remoteLikes);
  const top = [...library].sort((a, b) => b.playCount - a.playCount).map(toRef);
  const owned = ownedVids(library);
  let list: TrackRef[];
  if (id === 'preferiti') list = shuffle(likes);
  else if (id === 'classifiche') list = await chartsPool();
  else if (id === 'per-te') list = shuffle([...likes.slice(0, 20), ...await upNextPool(likes.length ? likes : top, 4)]);
  else { // 'novita-te' | 'scoperte' | id sconosciuti: novità + correlati ai gusti
    const pool = await tasteSeededPool(library, remoteLikes);
    list = pool.filter((t) => !t.videoId || !owned.has(t.videoId));
  }
  // Il filtro/ordine sui gusti locali replica il TasteCtx del PC:
  // artisti dislikati fuori, brani skippati fuori, artisti amati in testa.
  return tasteOrder(list).slice(0, 40);
}

export async function offlineRadio(kind: 'artist' | 'genre', value: string, library: LibraryTrack[] = []): Promise<TrackRef[]> {
  // Genere: i semi sono i TUOI brani di quel genere (era "${genre} hits" nudo —
  // tirava fuori roba generica e artisti sconosciuti).
  if (kind === 'genre') return tasteOrder(await genrePool(value, library)).slice(0, 40);
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
  // Contesto di genere: la continuazione non deve derivare — lo stesso gate
  // iTunes della scaletta (era il buco per cui "blues" scivolava nel rock).
  const genreCtx = ctx?.startsWith('radio:genre:') ? ctx.slice(12)
    : ctx?.startsWith('station:') ? STATIONS.find((s) => s.id === ctx.slice(8))?.genre ?? ''
    : '';
  const seedArtist = ctx?.startsWith('radio:artist:') ? normText(ctx.slice(13)) : '';
  if (!seedArtist) {
    const gated = genreCtx ? await itunesGate(genreCtx, ordered) : ordered;
    return gated.slice(0, 15);
  }
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
