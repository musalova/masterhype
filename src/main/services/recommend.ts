import { upNext, searchSongs, charts } from './ytmusic';
import { deezerRelatedArtists, deezerArtistTop, deezerChart, lastfmSimilarArtists, lastfmSimilarTracks, lastfmArtistTags, lastfmTagTopArtists, lastfmTagTopTracks, spotifyConnected, spotifyNewReleases } from './sources';
import { tasteProfile, listTracks, remoteLikes, negativeTracks, recentlyPlayed } from './library';
import { contextBoosts, cooccurring, trackAffinity } from './engine';
import { getSettings } from '../settings';
import { getDb } from '../db';
import { mapLimit } from './util';
import type { TrackRef, SuggestedTrack, AssistantRequest, AssistantResult } from '../../shared/types';
import { STATIONS } from '../../shared/types';
import { normText as norm, normTag, trackKey as key, baseTitleOf as baseTitle, trackBaseKey as baseKey } from '../../shared/taste';
import { parsePrompt } from './promptParse';
export { parsePrompt };

// Motore raccomandazione offline: aggrega candidati da più fonti e li pesa
// contro il profilo gusti memorizzato (artisti/generi/tag).

interface Candidate {
  key: string; // "artista|titolo" normalizzato
  title: string;
  artist: string;
  videoId?: string;
  thumbnail?: string;
  durationS?: number;
  sources: Set<string>;
  sim?: number;   // forza di similarità col seme (rank combinato delle fonti)
  rank?: number;  // posizione nella fonte originale (chart/query), 0-based
}

// Normalizzatori e chiavi brano: fonte unica in shared/taste.ts — il renderer
// (localData/offlineRec) usa le STESSE funzioni, la parità è strutturale.

// taste_profile memorizza il valore solo in lowercase, ma i lookup usano
// norm()/normTag(): senza normalizzazione "AC/DC" o "Måneskin" non trovavano
// MAI il loro peso — il segnale gusto spariva (e i blocchi venivano aggirati).
// Le collisioni (stesso artista scritto in due forme) si sommano.
const tasteMap = (rows: { value: string; weight: number }[], n: (s: string) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = n(r.value);
    if (k) m.set(k, (m.get(k) ?? 0) + r.weight);
  }
  return m;
};

function addCand(map: Map<string, Candidate>, title: string, artist: string, source: string, extra?: Partial<Candidate>): void {
  if (!title || !artist) return;
  const k = key(artist, title);
  const c = map.get(k);
  if (c) {
    c.sources.add(source);
    if ((extra?.sim ?? 0) > (c.sim ?? 0)) c.sim = extra!.sim;
    if (extra?.rank != null && (c.rank == null || extra.rank < c.rank)) c.rank = extra.rank;
  } else map.set(k, { key: k, title, artist, sources: new Set([source]), ...extra });
}

async function candidatesFromArtist(artist: string, map: Map<string, Candidate>): Promise<void> {
  // Simili via Deezer + Last.fm
  const [dz, lf] = await Promise.all([deezerRelatedArtists(artist), lastfmSimilarArtists(artist)]);
  const similar = [...new Set([...dz, ...lf])].slice(0, 10);
  await mapLimit(similar, 5, async (sim) => {
    const tops = await deezerArtistTop(sim);
    for (const t of tops.slice(0, 5)) addCand(map, t.title, t.artist, 'deezer');
  });
}

// Il primo risultato YT deve essere dell'artista giusto: evita cover/live di altri
// ("La Mia Storia Tra Le Dita" di Grignani risolta come video di Bocelli).
function artistMatches(expected: string, found: string): boolean {
  const e = norm(expected); const f = norm(found);
  if (!e || !f) return false;
  return f.includes(e) || e.includes(f) || f.split(' ').some((w) => w.length > 3 && e.includes(w));
}

// ---- Contesto gusti condiviso: UNA lettura DB per ogni generazione ----
// Prima ogni funzione rifaceva le stesse query (tasteProfile ×3, negativeTracks,
// recenti, affinity) — ora un solo snapshot per stazione/radio.
interface TasteCtx {
  artistW: Map<string, number>;   // artista norm → peso decaduto (negativo = bloccato)
  tagW: Map<string, number>;      // tag Last.fm → peso
  genreW: Map<string, number>;    // genere ID3 → peso
  blocked: string[];              // artisti a peso < 0 (match fuzzy, non esatto)
  negKeys: Set<string>;           // baseKey di brani skippati di proposito
  recentKeys: Set<string>;        // baseKey degli ultimi ~30 play (anti-ripetizione)
  affinity: Map<string, number>;  // key completa → saldo brano decaduto
  known: Set<string>;             // artisti con peso > 0
  ctx: Map<string, number>;       // boost orario/giorno 0..1
  maxA: number;
  maxT: number;
  maxG: number;
}

function tasteCtx(u: number): TasteCtx {
  const artistW = tasteMap(tasteProfile(u, 'artist'), norm);
  const tagW = tasteMap(tasteProfile(u, 'tag'), normTag);
  const genreW = tasteMap(tasteProfile(u, 'genre'), normTag);
  return {
    artistW, tagW, genreW,
    blocked: [...artistW].filter(([, w]) => w < 0).map(([a]) => a),
    negKeys: new Set(negativeTracks(u).map((t) => baseKey(t.artist, t.title))),
    recentKeys: new Set(recentlyPlayed(30, u).map((t) => baseKey(t.artist, t.title))),
    affinity: trackAffinity(u),
    known: new Set([...artistW].filter(([, w]) => w > 0).map(([a]) => a)),
    ctx: contextBoosts(u),
    maxA: Math.max(1, ...[...artistW.values()].map((w) => Math.max(0, w))),
    maxT: Math.max(1, ...[...tagW.values()].map((w) => Math.abs(w))),
    maxG: Math.max(1, ...[...genreW.values()].map((w) => Math.abs(w))),
  };
}

// Artista bloccato: match FUZZY — "Jovanotti" blocca anche "Jovanotti feat. X"
// e "Lorenzo Jovanotti". Lo stesso criterio dell'esclusione dell'assistente:
// un match esatto lasciava passare le collaborazioni e gli alias.
function artistBlocked(t: TasteCtx, artist: string): boolean {
  const a = norm(artist);
  if (!a) return false;
  for (const b of t.blocked) {
    if (b.length < 3) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

// Affinità dei tag Last.fm di un artista col profilo: quota pesata dei tag
// coperti (i pesi negativi sottraggono — un artista taggato col genere che
// skippi scende). Il confronto è in forma normalizzata e i generi ID3 del
// profilo contano come segnale secondario — senza chiave Last.fm (o con tag
// radi) l'affinità non sparisce. -1..+1. La cache DB rende i fetch quasi gratis.
function tagAffinity(t: TasteCtx, tags: string[]): number {
  if (!tags.length) return 0;
  let s = 0;
  for (const x of tags) {
    const nx = normTag(x);
    s += (t.tagW.get(nx) ?? 0) + (t.genreW.get(nx) ?? 0) * 0.6;
  }
  return Math.max(-1, Math.min(1, s / (tags.length * Math.max(t.maxT, t.maxG * 0.6))));
}

// Saldo del brano (play/complete/like/skip decaduti): normalizzato -1..+1.
// Chiave completa, poi base: "Song (Live)" eredita il saldo di "Song".
function trackAff(t: TasteCtx, artist: string, title: string): number {
  const v = t.affinity.get(key(artist, title)) ?? t.affinity.get(baseKey(artist, title)) ?? 0;
  return Math.max(-1, Math.min(1, v / 4));
}

// Risolve i videoId mancanti via ricerca YT Music con CACHE persistente
// (tabella vid_cache): una stazione già generata non ripaga le ricerche.
// video_id='' = cache negativa (TTL corta): i brani che YT non risolve non
// vengono ri-cercati a ogni apertura.
const VID_TTL_MS = 14 * 86_400_000;
const VID_TTL_NEG_MS = 2 * 86_400_000;

async function resolveVideoIds(cands: Candidate[], limit: number): Promise<void> {
  const missing = cands.filter((c) => !c.videoId).slice(0, limit);
  if (!missing.length) return;
  const db = getDb();
  const now = Date.now();
  const sel = db.prepare('SELECT video_id, thumbnail, duration_s, fetched_at FROM vid_cache WHERE k=?');
  const ins = db.prepare('INSERT OR REPLACE INTO vid_cache (k,video_id,thumbnail,duration_s,fetched_at) VALUES (?,?,?,?,?)');
  const todo: Candidate[] = [];
  for (const c of missing) {
    const row = sel.get(c.key) as { video_id: string; thumbnail: string | null; duration_s: number | null; fetched_at: number } | undefined;
    if (row && now - row.fetched_at < (row.video_id ? VID_TTL_MS : VID_TTL_NEG_MS)) {
      if (row.video_id) { c.videoId = row.video_id; c.thumbnail ??= row.thumbnail ?? undefined; c.durationS ??= row.duration_s ?? undefined; }
      continue;
    }
    todo.push(c);
  }
  await mapLimit(todo, 4, async (c) => {
    try {
      const best = (await searchSongs(`${c.artist} ${c.title}`))[0];
      if (best && artistMatches(c.artist, best.artist)) {
        c.videoId = best.videoId; c.thumbnail = best.thumbnail; c.durationS = best.durationS;
      }
      ins.run(c.key, c.videoId ?? '', c.thumbnail ?? null, c.durationS ?? null, now);
    } catch { /* candidato senza videoId: verrà scartato */ }
  });
}

export async function suggest(u: number, limit = 25): Promise<SuggestedTrack[]> {
  const artists = tasteProfile(u, 'artist').slice(0, 6).map((r) => r.value);
  const lib = listTracks(u).filter((t) => t.liked).slice(0, 4);
  const remote = remoteLikes(u).slice(0, 4);
  const map = new Map<string, Candidate>();

  // Cold start: niente gusti E niente like (locali o remoti) -> propone le chart
  if (!artists.length && !lib.length && !remote.length) {
    const [ytChart, dzChart] = await Promise.all([
      charts(getSettings().country).catch(() => [] as TrackRef[]),
      deezerChart().catch(() => [] as { title: string; artist: string; rank: number; cover?: string }[]),
    ]);
    for (const t of ytChart) {
      addCand(map, t.title, t.artist, 'ytmusic', { videoId: t.videoId, thumbnail: t.thumbnail, durationS: t.durationS });
    }
    for (const t of dzChart) addCand(map, t.title, t.artist, 'deezer');
    const owned = new Set(listTracks(u).map((t) => baseKey(t.artist, t.title)));
    const cands = [...map.values()].filter((x) => !owned.has(baseKey(x.artist, x.title)));
    await resolveVideoIds(cands, limit * 2);
    const out: SuggestedTrack[] = [];
    for (const c of cands) {
      if (out.length >= limit) break;
      if (!c.videoId) continue;
      out.push({
        videoId: c.videoId, title: c.title, artist: c.artist, thumbnail: c.thumbnail, durationS: c.durationS,
        source: 'ytmusic', score: 0.5,
        reason: `in classifica su ${[...c.sources].map(s => s === 'ytmusic' ? 'YT Music' : s).join(' + ')}`,
        sources: [...c.sources],
      });
    }
    return out;
  }

  // I like remoti seedano come quelli locali: cuoricinare senza scaricare deve contare
  const seeds = [...lib.map((t) => ({ videoId: t.videoId, artist: t.artist, title: t.title })),
    ...remote.map((r) => ({ videoId: r.videoId, artist: r.artist, title: r.title }))].slice(0, 5);

  // 1) Correlati YouTube Music dai preferiti — locali E remoti (in parallelo)
  await mapLimit(seeds.filter((s) => s.videoId), 3, async (t) => {
    try {
      for (const r of await upNext(t.videoId)) {
        addCand(map, r.title, r.artist, 'ytmusic', { videoId: r.videoId, thumbnail: r.thumbnail, durationS: r.durationS });
      }
    } catch { /* seed fallito, continua */ }
  });

  // 2) Artisti simili (Deezer + Last.fm) dai top artisti del profilo (in parallelo)
  await mapLimit(artists.slice(0, 4), 3, (a) => candidatesFromArtist(a, map));

  // 3) Last.fm track.getSimilar sui preferiti (locali + remoti)
  await mapLimit(seeds.slice(0, 4), 3, async (t) => {
    for (const s of await lastfmSimilarTracks(t.artist, t.title)) {
      addCand(map, s.title, s.artist, 'lastfm');
    }
  });

  // Rimuovi ciò che è già in libreria e ciò che salti di proposito (skip > play).
  // Titolo BASE: un remaster/live non aggira né lo skip né l'ownership.
  const t = tasteCtx(u);
  const owned = new Set(listTracks(u).map((x) => baseKey(x.artist, x.title)));
  const cands = [...map.values()].filter((c) => !owned.has(baseKey(c.artist, c.title)) && !t.negKeys.has(baseKey(c.artist, c.title)));

  // Scoring: pesi artista possono essere negativi (skip/unlike) -> penalità
  const scored = await mapLimit(cands.slice(0, 60), 8, async (c) => {
    const w = t.artistW.get(norm(c.artist)) ?? 0;
    if (w < 0) return { c, score: -1, tags: [] as string[] }; // artista "disliked": sottozero
    const aAff = w / t.maxA;
    const tags = await lastfmArtistTags(c.artist);
    const gAff = tagAffinity(t, tags);
    const agreement = c.sources.size / 3;
    const novelty = t.artistW.has(norm(c.artist)) ? 0 : 0.6;
    const score = 0.45 * aAff + 0.25 * gAff + 0.15 * agreement + 0.15 * novelty;
    return { c, score, tags };
  });

  scored.sort((a, b) => b.score - a.score);

  // Risolvi videoId mancanti per i top candidati (in parallelo)
  const top = scored.filter((s) => s.score >= 0).slice(0, limit * 2);
  await resolveVideoIds(top.map((s) => s.c), limit * 2);

  const out: SuggestedTrack[] = [];
  for (const { c, score, tags } of top) {
    if (out.length >= limit) break;
    if (!c.videoId) continue;
    const srcList = [...c.sources];
    out.push({
      videoId: c.videoId, title: c.title, artist: c.artist,
      thumbnail: c.thumbnail, durationS: c.durationS,
      source: 'ytmusic', score, reason: buildReason(c, srcList, tags), sources: srcList,
    });
  }
  return out;
}

function buildReason(c: Candidate, sources: string[], tags: string[]): string {
  const parts: string[] = [];
  if (sources.includes('ytmusic')) parts.push('correlato ai tuoi preferiti');
  if (sources.includes('lastfm')) parts.push('simile secondo Last.fm');
  if (sources.includes('deezer')) parts.push('artista affine su Deezer');
  if (sources.length > 1) parts.push(`confermato da ${sources.length} fonti`);
  if (tags.length) parts.push(`tag: ${tags.slice(0, 2).join(', ')}`);
  return parts.length ? parts.join(' · ') : `perché ascolti ${c.artist}`;
}

// ---- Assistente: compila una tracklist per CD ----

const VIBE_TAGS: Record<string, string[]> = {
  energico: ['energetic', 'workout', 'rock', 'dance', 'edm', 'pump up', 'hard rock', 'metal'],
  chill: ['chill', 'relax', 'acoustic', 'ambient', 'lo-fi', 'mellow', 'chillout'],
  viaggio: ['road trip', 'driving', 'rock', 'indie', 'sing along', 'classic rock', 'singer-songwriter'],
  festa: ['party', 'dance', 'pop', 'edm', 'club', 'disco'],
  anni90: ['90s', 'pop', 'dance', 'eurodance', 'rock', 'italodance'],
  scoperte: [], // solo novità
  allenamento: ['workout', 'energetic', 'edm', 'pump up', 'hip hop', 'hard rock'],
  romantico: ['romantic', 'love songs', 'ballad', 'acoustic', 'soft rock', 'soul'],
  sera: ['night', 'chill', 'jazz', 'downtempo', 'mellow', 'ambient', 'trip-hop'],
  italiana: ['italian', 'italiana', 'cantautori', 'pop italiano', 'italian pop'],
  estate: ['summer', 'pop', 'reggaeton', 'latin', 'tropical', 'dance'],
};


export async function assistant(u: number, req: AssistantRequest): Promise<AssistantResult> {
  const pool = await suggest(u, 80);
  const owned = listTracks(u).filter((t) => t.liked || t.playCount > 1);

  // --- Interpreta il prompt libero ---
  const parsed = req.prompt?.trim() ? parsePrompt(req.prompt) : { extraTags: [], seeds: [], excluded: [] };
  const vibe = parsed.vibe ?? req.vibe;
  const seeds = [...(req.seedArtists ?? []), ...parsed.seeds].slice(0, 4);
  const excluded = new Set([...(req.excludeArtists ?? []), ...parsed.excluded].map(norm));
  const tags = [...new Set([...(VIBE_TAGS[vibe] ?? []), ...parsed.extraTags])];

  // --- Seed artisti: i loro top brani entrano in testa al pool ---
  const seedTracks: SuggestedTrack[] = [];
  await mapLimit(seeds, 3, async (a) => {
    try {
      for (const t of (await deezerArtistTop(a)).slice(0, 6)) {
        const isSeedArtist = norm(t.artist).includes(norm(a)) || norm(a).includes(norm(t.artist));
        seedTracks.push({
          videoId: '', title: t.title, artist: t.artist, source: 'ytmusic', score: isSeedArtist ? 2 : 1.3,
          reason: isSeedArtist ? `dal seed "${a}"` : `associato a ${a} su Deezer`, sources: ['seed'],
        });
      }
      // e i simili del seed arricchiscono il pool
      const map = new Map<string, Candidate>();
      await candidatesFromArtist(a, map);
      for (const c of map.values()) {
        pool.push({
          videoId: c.videoId ?? '', title: c.title, artist: c.artist,
          thumbnail: c.thumbnail, durationS: c.durationS, source: 'ytmusic',
          score: 1.2, reason: `artista affine a ${a}`, sources: [...c.sources],
        });
      }
    } catch { /* seed non risolto */ }
  });
  // Risolvi i videoId dei seed tracks (senza → scartati; artista verificato)
  await mapLimit(seedTracks, 4, async (t) => {
    try {
      const best = (await searchSongs(`${t.artist} ${t.title}`))[0];
      if (best && artistMatches(t.artist, best.artist)) {
        t.videoId = best.videoId; t.thumbnail = best.thumbnail; t.durationS = best.durationS;
      }
    } catch { /* resta senza */ }
  });
  // Ri-ordina il pool: i candidati arricchiti dai seed (score 1.2) devono salire
  if (seeds.length) pool.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // Esclusione robusta: "senza Jovanotti" blocca anche "Jovanotti feat. X" e "Lorenzo Jovanotti"
  const isExcluded = (a: string) => {
    const na = norm(a);
    if (!na) return false;
    for (const e of excluded) {
      if (!e || e.length < 3) continue;
      if (na === e || na.includes(e) || e.includes(na)) return true;
    }
    return false;
  };
  // I seed dell'utente hanno priorità assoluta: stanno in testa e bypassano il filtro vibe
  const seedOk = seedTracks.filter((t) => t.videoId && !isExcluded(t.artist));
  const poolOk = pool.filter((t) => t.videoId && !isExcluded(t.artist));

  // Filtra per vibe via tag artista: i coerenti col vibe vanno in testa,
  // gli altri restano come coda di riserva (mai svuotare la tracklist).
  const byVibe = async (cands: SuggestedTrack[]): Promise<SuggestedTrack[]> => {
    if (!tags.length) return cands;
    const match: SuggestedTrack[] = [];
    const rest: SuggestedTrack[] = [];
    await mapLimit(cands, 8, async (c) => {
      const t = await lastfmArtistTags(c.artist);
      (t.length && t.some((x) => tags.includes(x)) ? match : rest).push(c);
    });
    return [...match, ...rest];
  };

  const discovered = [...seedOk, ...(await byVibe(poolOk.filter((t) => t.source !== 'library')))];
  // Anche i preferiti rispettano la vibe: un CD "chill" non pesca i tuoi preferiti metal.
  // E i brani che salti sempre (skip > play) non entrano mai nella tracklist.
  const negKeys = new Set(negativeTracks(u).map((t) => baseKey(t.artist, t.title)));
  const familiar: SuggestedTrack[] = await byVibe(
    owned
      .filter((t) => !isExcluded(t.artist) && !negKeys.has(baseKey(t.artist, t.title)))
      .map((t) => ({
        videoId: t.videoId, title: t.title, artist: t.artist, durationS: t.durationS,
        thumbnail: t.thumbnail, source: 'library' as const, score: 1,
        reason: 'tra i tuoi preferiti', sources: ['libreria'],
      })));

  const targetS = req.targetMinutes > 0 ? req.targetMinutes * 60 : Infinity;
  const discoveryRatio = vibe === 'scoperte' ? Math.max(0.7, req.discoveryPct / 100) : req.discoveryPct / 100;

  const tracks: SuggestedTrack[] = [];
  const alternates: SuggestedTrack[] = [];
  let total = 0;
  const seen = new Set<string>();
  const artistCount = new Map<string, number>();
  const push = (t: SuggestedTrack) => {
    const dur = t.durationS ?? 210;
    const k = baseKey(t.artist, t.title); // base: "Song" e "Song (Live)" non entrano entrambe
    const a = norm(t.artist);
    if (seen.has(k)) return false;
    if ((artistCount.get(a) ?? 0) >= 3) { alternates.push(t); return false; }
    if (total + dur > targetS) { alternates.push(t); return false; }
    seen.add(k);
    artistCount.set(a, (artistCount.get(a) ?? 0) + 1);
    tracks.push(t); total += dur; return true;
  };

  const pick = () => {
    const wantNew = tracks.filter((t) => t.source !== 'library').length / Math.max(1, tracks.length) < discoveryRatio;
    const list = wantNew ? discovered : familiar;
    for (const t of list) if (push(t)) return;
    for (const t of wantNew ? familiar : discovered) if (push(t)) return;
  };
  for (let i = 0; i < 300 && (total < targetS - 60 || req.targetMinutes === 0) && (discovered.length || familiar.length); i++) {
    const before = tracks.length;
    pick();
    if (tracks.length === before) break; // pool esaurito
    if (req.targetMinutes === 0 && tracks.length >= 30) break;
  }
  // Ricambi: i candidati scartati per cap/minuti + il resto del pool non ancora visto
  for (const t of [...discovered, ...familiar]) {
    if (alternates.length >= 25) break;
    const k = baseKey(t.artist, t.title);
    if (!seen.has(k) && !alternates.some((a) => baseKey(a.artist, a.title) === k)) alternates.push(t);
  }

  const fam = tracks.filter((t) => t.source === 'library').length;
  const parts = [`${tracks.length} brani (~${Math.round(total / 60)} min)`];
  parts.push(fam ? `${fam} preferiti + ${tracks.length - fam} scoperte` : `${tracks.length} scoperte`);
  if (tags.length && vibe !== 'scoperte') parts.push(`vibe: ${vibe}`);
  if (seeds.length) parts.push(`partendo da ${seeds.join(', ')}`);
  if (excluded.size) parts.push(`senza ${[...excluded].join(', ')}`);
  const explanation = 'Ecco il tuo CD: ' + parts.join(' · ') + '.';

  return {
    tracks, alternates: alternates.slice(0, 25), totalMinutes: Math.round(total / 60), explanation,
    parsed: { seeds, excluded: [...excluded], extraTags: parsed.extraTags },
  };
}

// ---- Stazioni: una coda iniziale da cui parte la radio infinita ----
// Algoritmo v2: i candidati vengono SCORATI sui gusti (peso artista × contesto,
// tag Last.fm, affinità del brano, forza di similarità) PRIMA di pagare le
// ricerche YouTube; il filtro "cinico" è fuzzy (alias/featuring) e lavora sul
// titolo base (un remaster non aggira uno skip). Le scalette sono ordinate a
// finestre mescolate: varietà a ogni apertura senza perdere il ranking.

type LibraryTrackLike = { playCount?: number };

const shuffle = <T,>(arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Mescola a finestre di `win` su una lista GIÀ ordinata: il ranking resta a
// grandi blocchi, ma la scaletta non è mai identica tra due aperture.
const windowShuffle = <T,>(arr: T[], win = 5): T[] => {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += win) out.push(...shuffle(arr.slice(i, i + win)));
  return out;
};

// Round-robin sui bucket per-artista: nessun artista occupa due posizioni vicine.
const roundRobin = (buckets: Candidate[][]): Candidate[] => {
  const out: Candidate[] = [];
  for (let r = 0; ; r++) {
    let any = false;
    for (const b of buckets) if (b[r]) { out.push(b[r]); any = true; }
    if (!any) return out;
  }
};

// Dedup su titolo BASE: "Song" e "Song (Remastered 2011)" non occupano due slot.
const dedupBase = (list: Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = baseKey(c.artist, c.title);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const toRef = (t: { videoId?: string; title: string; artist: string; thumbnail?: string; durationS?: number }): TrackRef => ({
  videoId: t.videoId ?? '', title: t.title, artist: t.artist,
  thumbnail: t.thumbnail, durationS: t.durationS, source: 'ytmusic',
});

// Il candidato passa il filtro cinico? (versione su TasteCtx già caricato)
const candOk = (t: TasteCtx, c: Candidate): boolean =>
  !artistBlocked(t, c.artist) &&
  !t.negKeys.has(baseKey(c.artist, c.title)) &&
  !t.recentKeys.has(baseKey(c.artist, c.title));

// Filtro "cinico" comune: artisti che l'utente skippa/dislikka (match fuzzy —
// le collaborazioni non aggirano il blocco) e brani con saldo negativo non
// entrano in nessuna radio — tranne 'preferiti', dove il like esplicito vince.
// Ciò che hai suonato di recente esce, così ogni apertura propone novità.
function stationFilterCtx(list: TrackRef[], t: TasteCtx): TrackRef[] {
  return list.filter((x) =>
    !artistBlocked(t, x.artist) &&
    !t.negKeys.has(baseKey(x.artist, x.title)) &&
    !t.recentKeys.has(baseKey(x.artist, x.title)));
}
function stationFilter(list: TrackRef[], u: number): TrackRef[] {
  return stationFilterCtx(list, tasteCtx(u));
}

// Tag Last.fm per ogni artista candidato (una fetch per artista unico — la
// cache DB da 7 giorni rende quasi gratis le aperture successive).
async function artistTagsOf(artists: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  await mapLimit(artists.slice(0, 30), 6, async (a) => {
    out.set(a, await lastfmArtistTags(a).catch(() => []));
  });
  return out;
}

// "La tua stazione": top artisti (peso × contesto orario) + affini da TRE
// segnali — co-ascolti tuoi (segnale più forte), Deezer, Last.fm — rankati
// per forza e affinità coi tuoi tag. Un simile fuori dai tuoi generi non vale
// quanto uno che ci sta dentro: "vicino ai gusti", non "simile a caso".
async function stationForYou(u: number): Promise<TrackRef[]> {
  const t = tasteCtx(u);
  const weightOf = (a: string) => (t.artistW.get(norm(a)) ?? 0) * (1 + 0.6 * (t.ctx.get(norm(a)) ?? 0));
  const top = tasteProfile(u, 'artist').filter((r) => r.weight > 0.5)
    .sort((a, b) => weightOf(b.value) - weightOf(a.value)).slice(0, 6).map((r) => r.value);
  if (!top.length) {
    // Profilo ancora vuoto: i preferiti (locali + remoti) fanno da seme,
    // altrimenti "La tua stazione" nasceva deserta.
    const seen = new Set<string>();
    for (const a of [
      ...listTracks(u).filter((x) => x.liked).map((x) => x.artist),
      ...remoteLikes(u).map((x) => x.artist),
    ]) {
      const k = norm(a);
      if (k && !seen.has(k)) { seen.add(k); top.push(a); }
      if (top.length >= 6) break;
    }
  }
  const map = new Map<string, Candidate>();
  await mapLimit(top, 4, async (a) => {
    for (const tr of (await deezerArtistTop(a).catch(() => [])).slice(0, 5)) addCand(map, tr.title, tr.artist, 'seed');
    const co = cooccurring(u, a, 3);
    const [dz, lf] = await Promise.all([
      deezerRelatedArtists(a).catch(() => [] as string[]),
      lastfmSimilarArtists(a).catch(() => [] as string[]),
    ]);
    // Forza della similarità: posizione nella sua lista × peso della fonte.
    // `orig` conserva il nome originale: le API digeriscono meglio "AC/DC"
    // della forma normalizzata "ac dc".
    const ranked = new Map<string, number>();
    const orig = new Map<string, string>();
    const bump = (list: string[], w: number) => list.forEach((s, i) => {
      const k = norm(s);
      if (k) { ranked.set(k, (ranked.get(k) ?? 0) + w / (1 + i)); if (!orig.has(k)) orig.set(k, s); }
    });
    bump(co, 1.5); bump(dz, 1); bump(lf, 1);
    // I simili vengono scelti per forza E affinità coi gusti PRIMA di
    // espanderli: un artista affine al seme ma in un genere che l'utente
    // skippa non consuma slot né ricerche Deezer.
    const sims = [...ranked.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
    const simTags = await artistTagsOf(sims.map(([s]) => orig.get(s) ?? s));
    const picked = sims
      .map(([s, sc]) => {
        const name = orig.get(s) ?? s;
        return { s: name, sc, aff: tagAffinity(t, simTags.get(name) ?? []) };
      })
      .filter((x) => x.aff > -0.4)
      .sort((a, b) => (b.sc + b.aff * 2) - (a.sc + a.aff * 2))
      .slice(0, 6);
    await mapLimit(picked, 3, async ({ s, sc }) => {
      for (const tr of (await deezerArtistTop(s).catch(() => [])).slice(0, 3)) {
        addCand(map, tr.title, tr.artist, 'similar', { sim: sc });
      }
    });
  });
  const cands = [...map.values()].filter((c) => candOk(t, c));
  const tags = await artistTagsOf([...new Set(cands.map((c) => norm(c.artist)))]);
  const scored = cands.map((c) => {
    const a = norm(c.artist);
    const s =
      (c.sources.has('seed') ? 1.5 : 0) +
      Math.max(-1, (t.artistW.get(a) ?? 0) / t.maxA) * (1 + 0.6 * (t.ctx.get(a) ?? 0)) * 1.2 +
      tagAffinity(t, tags.get(a) ?? []) * 0.9 +
      Math.min(1, (c.sim ?? 0) / 3) * 0.5 +
      trackAff(t, c.artist, c.title) * 0.4;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored.filter((x) => x.s > -0.3).slice(0, 45);
  await resolveVideoIds(best.map((x) => x.c), 45);
  const playable = best.filter((x) => x.c.videoId);
  // Bucket per artista (cap 3): i familiari in testa per peso, l'esplorazione
  // entra ogni ~4 posizioni ma ordinata per score — gli affini più vicini ai
  // gusti hanno la precedenza, non l'estrazione casuale.
  const byArtist = new Map<string, Candidate[]>();
  for (const { c } of playable) {
    const a = norm(c.artist);
    const l = byArtist.get(a) ?? [];
    if (l.length < 3) { l.push(c); byArtist.set(a, l); }
  }
  const fam = windowShuffle(
    [...byArtist.values()].filter((b) => t.known.has(norm(b[0].artist)))
      .sort((a, b) => weightOf(b[0].artist) - weightOf(a[0].artist)), 3);
  const explore = windowShuffle(
    [...byArtist.values()].filter((b) => !t.known.has(norm(b[0].artist)))
      .sort((a, b) => {
        const sc = (x: Candidate) => Math.min(1, (x.sim ?? 0) / 3) + tagAffinity(t, tags.get(norm(x.artist)) ?? []);
        return sc(b[0]) - sc(a[0]);
      }), 3);
  const out: Candidate[] = [];
  const usedKeys = new Set<string>();
  const push = (c: Candidate | undefined) => {
    if (!c) return;
    const k = baseKey(c.artist, c.title);
    if (usedKeys.has(k)) return;
    usedKeys.add(k); out.push(c);
  };
  for (let round = 0; round < 3; round++) {
    let i = 0;
    for (const b of fam) {
      push(b[round]);
      if (++i % 4 === 0 && explore.length) push(explore.shift()![0]);
    }
    if (!fam.length) break;
  }
  for (const e of explore) for (const c of e) { if (out.length >= 36) break; push(c); }
  return out.slice(0, 32).map(toRef);
}

// "Novità per te": chart + nuove uscite ordinate per pertinenza ai gusti.
// Contano il rank nella chart, i tag Last.fm e — senza chiave — i co-ascolti
// coi tuoi artisti (mai più una scaletta quasi casuale come prima).
async function stationNovita(u: number): Promise<TrackRef[]> {
  const t = tasteCtx(u);
  const country = getSettings().country;
  const [ytChart, dzChart, spNew] = await Promise.all([
    charts(country).catch(() => [] as TrackRef[]),
    deezerChart().catch(() => [] as { title: string; artist: string; rank: number; cover?: string }[]),
    (await spotifyConnected().catch(() => false)) ? spotifyNewReleases().catch(() => [] as { title: string; artist: string }[]) : Promise.resolve([]),
  ]);
  const map = new Map<string, Candidate>();
  ytChart.forEach((tr, i) => addCand(map, tr.title, tr.artist, 'chart', { videoId: tr.videoId, thumbnail: tr.thumbnail, durationS: tr.durationS, rank: i }));
  dzChart.forEach((tr) => addCand(map, tr.title, tr.artist, 'chart', { rank: tr.rank }));
  spNew.forEach((tr, i) => addCand(map, tr.title, tr.artist, 'new', { rank: i }));
  const cands = [...map.values()].filter((c) => !artistBlocked(t, c.artist) && !t.negKeys.has(baseKey(c.artist, c.title)));
  // Rete di co-ascolto dei top artisti: affinità "tua" senza bisogno di Last.fm
  const coNet = new Set<string>();
  for (const a of [...t.known].slice(0, 10)) for (const o of cooccurring(u, a, 4)) coNet.add(o);
  const tags = await artistTagsOf([...new Set(cands.map((c) => norm(c.artist)))]);
  const scored = cands.map((c) => {
    const a = norm(c.artist);
    const w = t.artistW.get(a) ?? 0;
    let s = w > 0.5 ? 2 + Math.min(1, w / t.maxA) : 0;
    s += tagAffinity(t, tags.get(a) ?? []) * 1.4;
    if (coNet.has(a)) s += 0.8;
    if (c.sources.has('new')) s += 0.6;
    if (c.rank != null) s += Math.max(0, 45 - c.rank) / 100;
    s += trackAff(t, c.artist, c.title) * 0.4;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored.filter((x) => x.s > -0.5).slice(0, 40);
  await resolveVideoIds(best.map((x) => x.c), 40);
  return windowShuffle(dedupBase(best.filter((x) => x.c.videoId).map((x) => x.c)), 5).slice(0, 25).map(toRef);
}

// Tag Last.fm associati alle stazioni generiche: guidano il "tilt" —
// gli artisti del profilo coerenti col tema entrano nella scaletta.
const STATION_TAGS: Record<string, string[]> = {
  energia: VIBE_TAGS.energico,
  chill: VIBE_TAGS.chill,
  festa: VIBE_TAGS.festa,
  viaggio: VIBE_TAGS.viaggio,
  romantico: VIBE_TAGS.romantico,
  sera: VIBE_TAGS.sera,
  italiana: VIBE_TAGS.italiana,
  'rap-it': ['hip hop', 'rap', 'trap', 'italian hip hop'],
  rock: ['rock', 'classic rock', 'hard rock', 'alternative rock', 'indie rock'],
  dance: ['edm', 'dance', 'electronic', 'house', 'club'],
  'indie-it': ['indie', 'indie pop', 'italian indie', 'alternative'],
  latina: ['latin', 'reggaeton', 'latin pop'],
  anni70: ['70s'], anni80: ['80s'], anni90: ['90s'], anni2000: ['2000s'], anni2010: ['2010s'],
};

// Stazioni generiche (mood/genere/decennio): la query YT dà il catalogo di
// base, il profilo decide l'ordine — e gli artisti tuoi coerenti col tema
// entrano direttamente in scaletta. Stessa card, scaletta diversa per ogni
// utente: la stazione si avvicina ai gusti senza tradire il tema.
async function stationQuery(u: number, stationId: string, query: string): Promise<TrackRef[]> {
  const t = tasteCtx(u);
  const map = new Map<string, Candidate>();
  const res = await searchSongs(query).catch(() => [] as TrackRef[]);
  res.slice(0, 30).forEach((r, i) => addCand(map, r.title, r.artist, 'query', { videoId: r.videoId, thumbnail: r.thumbnail, durationS: r.durationS, rank: i }));
  const wantTags = STATION_TAGS[stationId];
  if (wantTags?.length) {
    // Artisti del profilo i cui tag collimano col tema → i loro top brani
    // entrano come 'tilt' (scoring + dedup li mescolano nel ranking).
    const prof = tasteProfile(u, 'artist').filter((r) => r.weight > 1).slice(0, 18).map((r) => r.value);
    const matched: string[] = [];
    await mapLimit(prof, 6, async (a) => {
      const at = await lastfmArtistTags(a).catch(() => [] as string[]);
      if (at.some((x) => wantTags.includes(x))) matched.push(a);
    });
    await mapLimit(shuffle(matched).slice(0, 4), 3, async (a) => {
      for (const tr of (await deezerArtistTop(a).catch(() => [])).slice(0, 2)) {
        addCand(map, tr.title, tr.artist, 'tilt');
      }
    });
  }
  const cands = [...map.values()].filter((c) => candOk(t, c));
  // Affinità coi gusti anche dentro il tema: a parità di query salgono gli
  // artisti nei generi che l'utente ama e scendono quelli che skippa.
  const tags = await artistTagsOf([...new Set(cands.map((c) => norm(c.artist)))]);
  const scored = cands.map((c) => {
    const a = norm(c.artist);
    const s = (c.rank != null ? 1 - c.rank / 30 : 0)
      + Math.max(-1, Math.min(1, (t.artistW.get(a) ?? 0) / t.maxA)) * 1.1
      + (c.sources.has('tilt') ? 0.9 : 0)
      + tagAffinity(t, tags.get(a) ?? []) * 0.7
      + trackAff(t, c.artist, c.title) * 0.4;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored.slice(0, 30);
  await resolveVideoIds(best.map((x) => x.c), 30);
  const byArtist = new Map<string, Candidate[]>();
  for (const { c } of best.filter((x) => x.c.videoId)) {
    const a = norm(c.artist);
    const l = byArtist.get(a) ?? [];
    if (l.length < 2) { l.push(c); byArtist.set(a, l); }
  }
  return dedupBase(roundRobin(windowShuffle([...byArtist.values()], 4))).slice(0, 20).map(toRef);
}

export async function stationTracks(u: number, stationId: string): Promise<TrackRef[]> {
  switch (stationId) {
    case 'preferiti': {
      // I like che ascolti fino in fondo salgono, quelli che ormai salti scendono:
      // ordine per affinità con rumore casuale (stessa radio, scaletta diversa).
      // Dedup su titolo base: like remoto e file locale della stessa canzone
      // (o remaster) non occupano due posizioni.
      const aff = trackAffinity(u);
      const seenB = new Set<string>();
      const all = [...listTracks(u).filter((t) => t.liked), ...remoteLikes(u).map((r) => toRef(r))]
        .map((t) => ({ t, s: (aff.get(key(t.artist, t.title)) ?? aff.get(baseKey(t.artist, t.title)) ?? 0) + Math.random() * 2 }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.t)
        .filter((t) => { const k = baseKey(t.artist, t.title); if (seenB.has(k)) return false; seenB.add(k); return true; });
      return all.length ? all : stationForYou(u);
    }
    case 'per-te': return stationForYou(u);
    case 'novita-te': return stationNovita(u);
    case 'scoperte': return stationFilter((await suggest(u, 30)).map(toRef), u);
    case 'classifiche': return stationFilter(await charts(getSettings().country).catch(() => [] as TrackRef[]), u);
    default: {
      const def = STATIONS.find((s) => s.id === stationId);
      if (!def?.query) return stationForYou(u);
      return stationQuery(u, def.id, def.query);
    }
  }
}

// Continuazione della radio infinita: upNext del brano corrente filtrato e
// riordinato sui gusti, con un'ancora al seme della stazione per non derivare
// verso il popolare. ctx: 'radio:artist:<nome>' | 'radio:genre:<tag>' | 'station:<id>'.
export async function stationContinue(u: number, videoId: string, artist: string, ctxStr?: string): Promise<TrackRef[]> {
  const ups = await upNext(videoId).catch(() => [] as TrackRef[]);
  if (!ups.length) return [];
  const t = tasteCtx(u);
  const fresh = stationFilterCtx(ups, t);
  let seedArtist = '';
  let wantTags: string[] = [];
  if (ctxStr?.startsWith('radio:artist:')) seedArtist = ctxStr.slice(13);
  else if (ctxStr?.startsWith('radio:genre:')) wantTags = [ctxStr.slice(12)];
  else if (ctxStr?.startsWith('station:')) {
    wantTags = STATION_TAGS[ctxStr.slice(8)] ?? [];
    // Stazione personale (senza tema fisso): l'ancora è il profilo stesso —
    // i tag che pesano di più nei gusti. Senza, la radio infinita deriva
    // verso il popolare a ogni continuazione.
    if (!wantTags.length) {
      wantTags = [...t.tagW.entries()]
        .filter(([, w]) => w > 0.5)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([x]) => x);
    }
  }
  const wantSet = new Set(wantTags.map(normTag));
  const tagMap = new Map<string, string[]>();
  if (wantSet.size) {
    const uniq = [...new Set(fresh.map((x) => norm(x.artist)))].slice(0, 15);
    await mapLimit(uniq, 6, async (a) => { tagMap.set(a, await lastfmArtistTags(a).catch(() => [])); });
  }
  const scored = fresh.map((c, i) => {
    const a = norm(c.artist);
    let s = Math.max(-1, Math.min(1, (t.artistW.get(a) ?? 0) / t.maxA)) * 1.1
      + trackAff(t, c.artist, c.title) * 0.5
      + (1 - i / Math.max(1, ups.length)) * 0.35; // il rank upNext resta un segnale
    if (seedArtist && artistMatches(seedArtist, c.artist)) s += 1.3;
    if (artistMatches(artist, c.artist)) s += 0.7; // resta vicino a ciò che suona
    if (wantSet.size) s += (tagMap.get(a) ?? []).some((x) => wantSet.has(normTag(x))) ? 0.9 : -0.35;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const out: TrackRef[] = [];
  const perArtist = new Map<string, number>();
  const used = new Set<string>();
  for (const { c } of windowShuffle(scored, 4)) {
    const a = norm(c.artist);
    const bk = baseKey(c.artist, c.title);
    if ((perArtist.get(a) ?? 0) >= 2 || used.has(bk)) continue;
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    used.add(bk);
    out.push(c);
    if (out.length >= 15) break;
  }
  return out;
}

// ---- Radio dinamiche: da un artista o da un genere/tag, generate al volo ----

// Composizione comune: scoring sui gusti, poi interlaccio. Il seed artista
// tiene ~1/3 della scaletta DISTRIBUITA (non solo in testa) — "Radio di X"
// senza X in coda non è una radio di X. I simili seguono la forza del segnale
// e l'affinità coi tuoi tag, con ordine a finestre mescolate.
async function finalizeRadio(map: Map<string, Candidate>, u: number, seedArtist?: string): Promise<TrackRef[]> {
  const t = tasteCtx(u);
  const cands = [...map.values()].filter((c) => candOk(t, c));
  const tags = await artistTagsOf([...new Set(cands.map((c) => norm(c.artist)))]);
  const seedN = seedArtist ? norm(seedArtist) : '';
  const scored = cands.map((c) => {
    const a = norm(c.artist);
    const isSeed = !!(seedN && artistMatches(seedN, c.artist));
    const s =
      (isSeed ? 2.2 : 0) +
      Math.min(1, (c.sim ?? 0) / 2.5) * 0.9 +
      Math.max(-1, Math.min(1, (t.artistW.get(a) ?? 0) / t.maxA)) * 1.0 +
      tagAffinity(t, tags.get(a) ?? []) * 0.7 +
      trackAff(t, c.artist, c.title) * 0.4;
    return { c, s, isSeed };
  }).sort((a, b) => b.s - a.s);
  const best = scored.slice(0, 60);
  await resolveVideoIds(best.map((x) => x.c), 60);
  const ok = best.filter((x) => x.c.videoId);
  const seedQ = dedupBase(shuffle(ok.filter((x) => x.isSeed).map((x) => x.c))).slice(0, 9);
  const byArtist = new Map<string, Candidate[]>();
  for (const x of ok.filter((x) => !x.isSeed)) {
    const a = norm(x.c.artist);
    const l = byArtist.get(a) ?? [];
    if (l.length < 3) { l.push(x.c); byArtist.set(a, l); }
  }
  // Bucket ordinati per score del miglior candidato, finestre mescolate
  const bucketScore = new Map<string, number>();
  for (const x of ok) bucketScore.set(x.c.key, x.s);
  const buckets = windowShuffle(
    [...byArtist.values()].sort((a, b) => (bucketScore.get(b[0].key) ?? 0) - (bucketScore.get(a[0].key) ?? 0)), 4);
  const restQ = dedupBase(roundRobin(buckets));
  // Seed distribuito ~1 ogni 3 posizioni: in testa e mai solo in testa.
  const out: Candidate[] = [];
  let ri = 0;
  while (out.length < 30 && (seedQ.length || ri < restQ.length)) {
    if (seedQ.length && (out.length === 0 || out.length % 3 === 2)) out.push(seedQ.shift()!);
    else if (ri < restQ.length) out.push(restQ[ri++]);
    else if (seedQ.length) out.push(seedQ.shift()!);
    else break;
  }
  return out.map(toRef);
}

// "Radio di X": i suoi top brani (~30% della scaletta) + i simili da
// Deezer + Last.fm + i tuoi co-ascolti, ordinati per forza e gusti.
export async function radioForArtist(u: number, name: string): Promise<TrackRef[]> {
  const map = new Map<string, Candidate>();
  for (const tr of (await deezerArtistTop(name).catch(() => [])).slice(0, 10)) {
    addCand(map, tr.title, tr.artist, 'seed');
  }
  const [dz, lf] = await Promise.all([
    deezerRelatedArtists(name).catch(() => [] as string[]),
    lastfmSimilarArtists(name).catch(() => [] as string[]),
  ]);
  const simRank = new Map<string, number>();
  const bump = (list: string[], w: number) => list.forEach((s, i) => {
    const k = norm(s);
    if (k) simRank.set(k, (simRank.get(k) ?? 0) + w / (1 + i));
  });
  bump(dz, 1); bump(lf, 1.2);
  // Chi ascolti insieme al seed sale di più: il segnale personale vince
  bump(cooccurring(u, name, 4), 1.5);
  const sims = [...simRank.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  await mapLimit(sims, 4, async ([s, sc]) => {
    for (const tr of (await deezerArtistTop(s).catch(() => [])).slice(0, 3)) {
      addCand(map, tr.title, tr.artist, 'similar', { sim: sc });
    }
  });
  const out = await finalizeRadio(map, u, name);
  if (out.length >= 5) return out;
  // Fallback: ricerca diretta se le fonti non hanno dato abbastanza
  const res = await searchSongs(`${name} best songs`).catch(() => [] as TrackRef[]);
  return stationFilter([...out, ...res.filter((r) => !out.some((o) => key(o.artist, o.title) === key(r.artist, r.title)))].slice(0, 30), u);
}

// "Radio <genere>": top artisti e top tracce del tag su Last.fm → top Deezer.
// Gli artisti del tag che hai già nei gusti (o co-ascoltati) prendono più slot:
// la radio resta di genere ma parla la tua lingua.
export async function radioForGenre(u: number, tag: string): Promise<TrackRef[]> {
  const t = tasteCtx(u);
  const map = new Map<string, Candidate>();
  const [artists, tracks] = await Promise.all([
    lastfmTagTopArtists(tag).catch(() => [] as string[]),
    lastfmTagTopTracks(tag).catch(() => [] as { title: string; artist: string }[]),
  ]);
  tracks.slice(0, 15).forEach((tr, i) => addCand(map, tr.title, tr.artist, 'tagtracks', { rank: i }));
  // Artisti del tag ordinati per (rilevanza nel tag + peso nei tuoi gusti)
  const ranked = artists.slice(0, 20)
    .map((a, i) => ({ a, s: 1 / (1 + i) + Math.max(0, (t.artistW.get(norm(a)) ?? 0) / t.maxA) }))
    .sort((x, y) => y.s - x.s).slice(0, 12);
  await mapLimit(ranked, 4, async ({ a, s }) => {
    for (const tr of (await deezerArtistTop(a).catch(() => [])).slice(0, 2)) {
      addCand(map, tr.title, tr.artist, 'tag', { sim: s });
    }
  });
  if (map.size < 10) {
    const res = await searchSongs(`${tag} hits`).catch(() => [] as TrackRef[]);
    for (const tr of res) addCand(map, tr.title, tr.artist, 'yt', { videoId: tr.videoId, thumbnail: tr.thumbnail, durationS: tr.durationS });
  }
  return finalizeRadio(map, u);
}

// ---- Playlist autogenerate (stile Spotify): non sono radio, sono scalette ----
// 'mix' = preferiti + simili interlacciati · 'scoperte' = solo novità sui gusti
// 'top' = le più ascoltate · 'nuove' = uscite recenti · 'liked' = Brani che ti piacciono
// 'artist:<nome>' = mix artista · 'genre:<tag>' = mix di genere (i "Daily Mix")
export async function autoPlaylist(u: number, id: string): Promise<TrackRef[]> {
  if (id.startsWith('artist:')) return radioForArtist(u, id.slice(7));
  if (id.startsWith('genre:')) return radioForGenre(u, id.slice(6));
  switch (id) {
    case 'liked': {
      // "Brani che ti piacciono": like locali (added_at DESC) + like remoti
      // (ts DESC), dedup artista|titolo — i più recenti in testa
      const local = listTracks(u).filter((t) => t.liked) as unknown as TrackRef[];
      const seen = new Set(local.map((t) => key(t.artist, t.title)));
      return [...local, ...remoteLikes(u).map(toRef).filter((r) => !seen.has(key(r.artist, r.title)))];
    }
    case 'top': {
      // "Le tue più ascoltate": affinità reale (play completi pesano più di
      // play interrotti, skip sottraggono) su locali E stream; fallback play_count.
      const aff = trackAffinity(u);
      const local = listTracks(u).filter((t) => t.playCount > 0 || aff.has(key(t.artist, t.title)));
      const seen = new Set(local.map((t) => key(t.artist, t.title)));
      const remote = remoteLikes(u).map(toRef).filter((r) => !seen.has(key(r.artist, r.title)));
      const streamed = recentlyPlayed(60, u).filter((r) => !r.filePath && !seen.has(key(r.artist, r.title)));
      const pool = [...(local as unknown as TrackRef[]), ...remote, ...streamed];
      const dedup = new Map<string, TrackRef>();
      for (const t of pool) if (!dedup.has(key(t.artist, t.title))) dedup.set(key(t.artist, t.title), t);
      return [...dedup.values()]
        .map((t) => ({ t, s: (aff.get(key(t.artist, t.title)) ?? 0) + ((t as LibraryTrackLike).playCount ?? 0) * 0.5 }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.t);
    }
    case 'scoperte': return stationFilter((await suggest(u, 30)).map(toRef), u);
    case 'nuove': return stationNovita(u);
    case 'mix':
    default: {
      // "Il tuo mix": i preferiti (locali+remoti) + affini, max 3 per artista
      const liked = shuffle([
        ...listTracks(u).filter((t) => t.liked).map((t) => t as unknown as TrackRef),
        ...remoteLikes(u).map(toRef),
      ]).slice(0, 14);
      const fresh = await stationForYou(u);
      const seen = new Set(liked.map((t) => key(t.artist, t.title)));
      const pool = stationFilter([...liked, ...fresh.filter((t) => !seen.has(key(t.artist, t.title)))], u);
      const byArtist = new Map<string, TrackRef[]>();
      for (const t of pool) {
        const a = norm(t.artist);
        const l = byArtist.get(a) ?? [];
        if (l.length < 3) { l.push(t); byArtist.set(a, l); }
      }
      const out: TrackRef[] = [];
      for (let r = 0; r < 3; r++) for (const b of byArtist.values()) if (b[r]) out.push(b[r]);
      return out.slice(0, 45);
    }
  }
}
