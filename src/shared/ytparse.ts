import type { TrackRef, AlbumRef, ArtistRef, PlaylistRef, TopResult, SearchResult } from './types';

// Parsing difensivo delle risposte InnerTube (YouTube Music). Condiviso tra
// main (ytmusic.ts) e renderer (direct.ts): gli item cambiano forma tra
// versioni e client, quindi niente tipi stretti — estrazione best-effort.

export function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  // Text/Author/Run di youtubei.js: .text, .name, oppure runs[]. MAI toString()
  // di un oggetto generico: finiva "[object Object]" nel nome artista.
  const t = v as { text?: unknown; name?: unknown; runs?: { text?: unknown }[] };
  if (typeof t.text === 'string') return t.text;
  if (typeof t.name === 'string') return t.name;
  if (Array.isArray(t.runs)) return t.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  const s = String(v);
  return s.startsWith('[object') ? '' : s;
}

// Primo run con un endpoint del tipo richiesto (ARTIST, ALBUM…) dentro un Text
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function runWithType(node: any, kind: string): string {
  const runs: any[] = node?.runs ?? (Array.isArray(node) ? node : []);
  const r = runs.find((x) =>
    String(x?.endpoint?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? '')
      .includes(kind));
  return r?.text ? String(r.text).trim() : '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function artistFromColumns(item: any): string {
  for (const col of item.flex_columns ?? []) {
    const a = runWithType(col?.title, 'ARTIST');
    if (a) return a;
  }
  // fallback: testo della 2a colonna prima di "•" (es. "Artista • 3:24")
  const col = text(item.flex_columns?.[1]?.title).split('•')[0]?.trim() ?? '';
  return META_WORD.test(col) || /^\d+:\d+/.test(col) ? '' : col;
}

// Nel nuovo layout YT Music le colonne dei metadati sono UNITE in un'unica
// stringa "Artista • Album • 4:53": estrai il run col tipo richiesto.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function albumFromColumns(item: any): string {
  for (const col of item.flex_columns ?? []) {
    const a = runWithType(col?.title, 'ALBUM');
    if (a) return a;
  }
  return '';
}

// Parole "tipo entità" che appaiono nei metadati: non sono mai un artista/album.
const META_WORD = /^(brano|video|song|album|singol|ep|playlist|artista|profilo|podcast|puntata|episodio|canzone|track|artist|profile|podcast|episode)$/i;
// Metriche social nel sottotitolo: "89 iscritti", "13,3 Mln ascoltatori mensili"…
const METRIC_WORD = /iscritt|subscriber|ascoltator|listener|riproduzion|visualizzazion|views|plays|brani|songs|tracce|tracks/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function thumbOf(item: any): string | undefined {
  // MusicTwoRowItem/headers: array diretto; altri: { contents: [...] }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any[] = Array.isArray(item?.thumbnail) ? item.thumbnail : (item?.thumbnail?.contents ?? []);
  if (!c.length) return undefined;
  return c.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a)).url;
}

function durS(d: unknown): number | undefined {
  if (d == null) return undefined;
  if (typeof d === 'object' && 'seconds' in (d as object)) return (d as { seconds: number }).seconds;
  const m = /(?:(\d+):)?(\d+):(\d+)/.exec(text(d));
  if (!m) return undefined;
  return (parseInt(m[1] ?? '0') * 3600) + parseInt(m[2]) * 60 + parseInt(m[3]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function durFromColumns(item: any): number | undefined {
  const cols = [...(item.flex_columns ?? []), ...(item.fixed_columns ?? [])];
  // 1) colonna intera "m:ss" o "h:mm:ss" (layout classico con fixed_columns)
  for (const c of cols) {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(text(c?.title).trim());
    if (m) return (parseInt(m[1] ?? '0') * 3600) + parseInt(m[2]) * 60 + parseInt(m[3]);
  }
  // 2) durata a fine di una colonna unificata "Artista • Album • 4:53"
  //    (nuovo layout ricerca: la durata vive dentro la 2a colonna)
  for (const c of cols.slice(1)) {
    const m = /(?:•|\||-)\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s*$/.exec(text(c?.title).trim());
    if (m) return (parseInt(m[1] ?? '0') * 3600) + parseInt(m[2]) * 60 + parseInt(m[3]);
  }
  return undefined;
}

// I browseId (album MPREb_, canali UC_, playlist VL_/PL_/OLAK) NON sono videoId
// riproducibili: li scartiamo quando cerchiamo un brano da suonare.
const BROWSE_ID_RE = /^(MPREb|UC|VL|OLAK|RD|PL|FE)/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function videoIdOf(item: any): string | null {
  const cands = [
    item.endpoint?.payload?.videoId,
    item.overlay?.content?.endpoint?.payload?.videoId,
    item.play_navigation_endpoint?.payload?.videoId,
    item.flex_columns?.[0]?.title?.runs?.[0]?.endpoint?.payload?.videoId,
    item.video_id,
    item.id,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.length > 0 && !BROWSE_ID_RE.test(c)) return c;
  }
  return null;
}

// item_type che possono suonare; 'unknown' è ammesso solo se ha un videoId
// (youtubei.js non riconosce il tipo, ma sotto c'è comunque un video riproducibile)
const PLAYABLE = new Set(['song', 'video', 'episode']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTrack(item: any, source: TrackRef['source'] = 'ytmusic'): TrackRef | null {
  const id = videoIdOf(item);
  const type = item.item_type;
  if (type && !PLAYABLE.has(type) && !(type === 'unknown' && id)) return null;
  const title = text(item.title);
  if (!id || !title) return null;
  const authors = item.artists ?? item.authors ?? [];
  let artist = Array.isArray(authors) && authors.length
    ? authors.map((a: { name?: unknown }) => text(a.name)).filter(Boolean).join(', ')
    : text(item.long_byline_text ?? item.short_byline_text ?? item.author ?? item.artist)
      || artistFromColumns(item)
      || '';
  if (/^n\/?a$/i.test(artist.trim())) artist = '';
  return {
    videoId: id,
    title,
    artist: artist || 'Sconosciuto',
    album: text(item.album?.name ?? item.album) || albumFromColumns(item),
    durationS: durS(item.duration) ?? durFromColumns(item),
    thumbnail: thumbOf(item),
    source,
  };
}

export function flattenShelves(node: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if ('item_type' in o || (('id' in o || 'video_id' in o) && 'title' in o && ('artists' in o || 'authors' in o || 'author' in o))) {
      out.push(o);
      return;
    }
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && ('contents' in (v as object) || 'items' in (v as object))) walk(v);
    }
  };
  walk(node);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAlbum(item: any): AlbumRef | null {
  if (!item?.id) return null;
  const sub = text(item.subtitle ?? item.second_subtitle ?? item.flex_columns?.[1]?.title);
  const yearM = /(\d{4})/.exec(sub) ?? /(\d{4})/.exec(text(item.year));
  // Fallback testuale: "Album • U2 • 1998" → "U2". Mai accettare l'anno o la
  // parola-tipo come artista (un "1998" nel campo artista romperebbe ricerche future).
  let byText = sub.replace(/^[^•]*•\s*/, '').replace(/\s*•\s*\d{4}.*$/, '').trim();
  if (META_WORD.test(byText) || /^\d{4}$/.test(byText) || METRIC_WORD.test(byText)) byText = '';
  return {
    browseId: item.id,
    title: text(item.title),
    artist: (item.artists ?? item.authors ?? []).map((a: { name?: unknown }) => text(a.name)).filter(Boolean).join(', ')
      || runWithType(item.subtitle ?? item.second_subtitle, 'ARTIST')
      || artistFromColumns(item)
      || byText,
    year: yearM?.[1],
    thumbnail: thumbOf(item),
  };
}

// "Artista • 13,3 Mln ascoltatori mensili" → "13,3 Mln ascoltatori mensili"
// (il prefisso tipo-entità è ridondante nella card)
function stripKindPrefix(s: string): string {
  return s.replace(/^[^•]{1,30}•\s*/, '').trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toArtist(item: any): ArtistRef | null {
  if (!item?.id) return null;
  const name = text(item.title ?? item.name)
    || text(item.flex_columns?.[0]?.title) // MusicResponsiveListItem filtrata
    || '';
  if (!name) return null;
  return {
    browseId: item.id,
    name,
    subscribers: stripKindPrefix(text(item.subscribers ?? item.subtitle ?? item.flex_columns?.[1]?.title)),
    thumbnail: thumbOf(item),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPlaylist(item: any): PlaylistRef | null {
  const id = item?.id ?? item?.endpoint?.payload?.playlistId;
  if (!id) return null;
  return {
    id: String(id),
    title: text(item.title),
    author: text(item.author ?? item.artists?.[0]?.name ?? item.subtitle),
    thumbnail: thumbOf(item),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collect(res: any, out: { songs: TrackRef[]; albums: AlbumRef[]; artists: ArtistRef[]; playlists: PlaylistRef[] }): void {
  const songById = new Map(out.songs.map((s) => [s.videoId, s]));
  const albumById = new Map(out.albums.map((a) => [a.browseId, a]));
  const artistById = new Map(out.artists.map((a) => [a.browseId, a]));
  const plById = new Map(out.playlists.map((p) => [p.id, p]));
  for (const raw of flattenShelves(res)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const item = raw as any;
    const type = item.item_type ?? 'song';
    if (type === 'song' || type === 'video' || type === 'episode' || type === 'unknown') {
      // 'unknown' = renderer nuovo non mappato da youtubei.js: riproducibile
      // solo se porta un videoId (altrimenti toTrack lo scarta da solo)
      const t = toTrack(item, type === 'song' || type === 'episode' ? 'ytmusic' : 'youtube');
      if (!t) continue;
      const prev = songById.get(t.videoId);
      if (prev) {
        // Il duplicato può essere più ricco (pagina filtrata "Brani" porta
        // durata/album che il layout base non ha): arricchisci invece di scartare.
        if (!prev.durationS && t.durationS) prev.durationS = t.durationS;
        if (!prev.album && t.album) prev.album = t.album;
        if ((!prev.artist || prev.artist === 'Sconosciuto') && t.artist && t.artist !== 'Sconosciuto') prev.artist = t.artist;
        if (!prev.thumbnail && t.thumbnail) prev.thumbnail = t.thumbnail;
        if (prev.source !== 'ytmusic' && t.source === 'ytmusic') prev.source = 'ytmusic';
      } else { songById.set(t.videoId, t); out.songs.push(t); }
    } else if (type === 'album' || type === 'single' || type === 'ep') {
      const a = toAlbum(item);
      if (!a || !a.title) continue;
      const prev = albumById.get(a.browseId);
      if (prev) {
        if (!prev.artist && a.artist) prev.artist = a.artist;
        if (!prev.year && a.year) prev.year = a.year;
        if (!prev.thumbnail && a.thumbnail) prev.thumbnail = a.thumbnail;
      } else { albumById.set(a.browseId, a); out.albums.push(a); }
    } else if (type === 'artist') {
      const a = toArtist(item);
      if (!a) continue;
      const prev = artistById.get(a.browseId);
      if (prev) {
        if (!prev.subscribers && a.subscribers) prev.subscribers = a.subscribers;
        if (!prev.thumbnail && a.thumbnail) prev.thumbnail = a.thumbnail;
      } else { artistById.set(a.browseId, a); out.artists.push(a); }
    } else if (type === 'playlist') {
      const p = toPlaylist(item);
      if (!p || !p.title) continue;
      const prev = plById.get(p.id);
      if (prev) {
        if (!prev.author && p.author) prev.author = p.author;
        if (!prev.thumbnail && p.thumbnail) prev.thumbnail = p.thumbnail;
      } else { plById.set(p.id, p); out.playlists.push(p); }
    }
  }
}

// Sottotitolo card "Video • U2 • 198 Mln di visualizzazioni • 4:34":
// segmenti separati da '•' — tipo, artista, metriche, durata.
function subtitleMeta(subtitle: string): { artist?: string; durationS?: number } {
  const parts = subtitle.split('•').map((s) => s.trim()).filter(Boolean);
  let artist: string | undefined;
  let durationS: number | undefined;
  for (const p of parts.slice(1)) { // il primo segmento è il tipo ("Video"/"Brano")
    const d = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(p);
    if (d) { durationS = (parseInt(d[1] ?? '0') * 3600) + parseInt(d[2]) * 60 + parseInt(d[3]); continue; }
    if (!artist && !META_WORD.test(p) && !METRIC_WORD.test(p) && !/^\d{4}$/.test(p)) artist = p;
  }
  return { artist, durationS };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractTopResult(res: any): TopResult | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const card = res?.contents?.find((c: any) => c.type === 'MusicCardShelf' || c.is === 'MusicCardShelf' || c.title && c.on_tap);
  if (!card) return undefined;
  const browseId = card.on_tap?.payload?.browseId ?? card.id;
  const pageType = card.on_tap?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ?? '';
  const kind: TopResult['kind'] =
    pageType.includes('ARTIST') ? 'artist'
    : pageType.includes('ALBUM') ? 'album'
    : pageType.includes('PLAYLIST') ? 'playlist'
    : 'song';
  const vid = card.on_tap?.payload?.videoId ?? card.id;
  // Card "song" senza un vero videoId non è riproducibile: meglio niente card
  if (kind === 'song' && (!vid || BROWSE_ID_RE.test(String(vid)))) return undefined;
  const subtitle = text(card.subtitle);
  // Per brano/album il sottotitolo porta artista+durata utili alla riproduzione
  const meta = kind === 'song' || kind === 'album' ? subtitleMeta(subtitle) : {};
  return {
    kind,
    id: kind === 'song' ? vid : browseId,
    title: text(card.title),
    subtitle,
    thumbnail: thumbOf(card),
    ...meta,
  };
}

export function dedupe(tracks: TrackRef[]): TrackRef[] {
  const seen = new Set<string>();
  return tracks.filter((t) => (seen.has(t.videoId) ? false : (seen.add(t.videoId), true)));
}

// Anti-degrado silenzioso: il parsing è best-effort e un layout Innertube
// nuovo può produrre 0 brani su una pagina PIENA — indistinguibile da una
// ricerca onestamente vuota. `playable` conta gli item grezzi con videoId
// estraibile: playable > 0 con songs vuote = parser rotto, non "nessun
// risultato". Il chiamante riprova sul percorso generico e, se serve,
// marca SearchResult.degraded invece di mostrare un vuoto fasullo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseHealth(res: any): { items: number; playable: number } {
  const items = flattenShelves(res);
  let playable = 0;
  for (const i of items) if (videoIdOf(i)) playable++;
  return { items: items.length, playable };
}

// youtubei.js LANCIA su pagine senza contents/tab (zero risultati, layout
// sconosciuto): non è un errore di rete — è una pagina vuota onesta.
export function isEmptyPageError(e: unknown): boolean {
  return e instanceof Error && /did not contain|did not have|target tab|did not return/i.test(e.message);
}

// Ripiego sulla ricerca YouTube generica: gli item non hanno item_type —
// ogni video risolto diventa un brano marcato 'youtube' (condiviso PC↔telefono).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function collectVideoFallback(res: any, out: SearchResult): void {
  const seen = new Set(out.songs.map((s) => s.videoId));
  for (const i of flattenShelves(res)) {
    const t = toTrack(i, 'youtube');
    if (t && !seen.has(t.videoId)) { seen.add(t.videoId); out.songs.push(t); }
  }
}

// ---- Post-processing ricerca (condiviso PC↔telefono) ----

// "13,3 Mln ascoltatori mensili" = vera pagina artista YT Music; "89 iscritti"
// = canale omonimo — la ricerca li mescola (item_type 'artist' per entrambi),
// i canali vanno sotto i veri artisti e deduplicati per nome.
const LISTENER_RE = /ascoltator|listener/i;
export function rankArtists(list: ArtistRef[]): ArtistRef[] {
  const score = (a: ArtistRef) => Number(LISTENER_RE.test(a.subscribers ?? ''));
  const byName = new Map<string, ArtistRef>();
  for (const a of list) {
    const k = normTxt(a.name);
    const prev = byName.get(k);
    if (!prev || score(a) > score(prev)) byName.set(k, a);
  }
  return [...byName.values()].sort((x, y) => score(y) - score(x));
}

// Post-processing di una pagina di ricerca: top result, promozione artista,
// eredità contesto sui brani della card, "Forse cercavi…", ranking artisti.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function finalizeSearch(res: any, out: SearchResult, query: string): void {
  try {
    const top = extractTopResult(res);
    if (top?.id) out.topResult = top;
  } catch { /* top result opzionale */ }
  const top = out.topResult;
  if (top?.kind === 'artist') {
    const idx = out.artists.findIndex((a) => a.browseId === top.id);
    if (idx > 0) out.artists.unshift(out.artists.splice(idx, 1)[0]);
    else if (idx < 0) out.artists.unshift({ browseId: top.id, name: top.title, subscribers: stripKindPrefix(top.subtitle), thumbnail: top.thumbnail });
    // YT omette l'artista negli item sotto la card del top result: ereditano il contesto
    for (const s of out.songs) if (s.artist === 'Sconosciuto') s.artist = top.title;
    for (const a of out.albums) if (!a.artist) a.artist = top.title;
  } else if (top?.kind === 'album') {
    for (const s of out.songs) {
      if (!s.album) s.album = top.title;
      if (s.artist === 'Sconosciuto' && top.artist) s.artist = top.artist;
    }
  }
  // Correzione query ("Forse cercavi…")
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dym = (res.did_you_mean ?? res.showing_results_for) as any;
    const corrected = text(dym?.corrected_query ?? dym?.text ?? '');
    if (corrected && corrected.toLowerCase() !== query.toLowerCase()) out.correctedQuery = corrected;
  } catch { /* opzionale */ }
  out.artists = rankArtists(out.artists);
}

// Espansione per categorie: i chip filtro ("Brani", "Album", "Artisti",
// "Playlist …", "Video") caricano pagine complete — i duplicati arricchiscono
// gli item del layout base via merge in collect (durata/album/sottoscritti).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applySearchFilters(res: any, out: SearchResult): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chips: any[] = [];
  try {
    const raw = res.header?.chips;
    chips = Array.isArray(raw) ? raw : Array.from(raw ?? []);
  } catch { chips = []; }
  const wants = ['brani', 'album', 'artisti', 'video', 'playlist'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const targets = chips.filter((c: any) =>
    wants.some((w) => String(c?.text ?? '').toLowerCase().startsWith(w)) &&
    // "Profili"/"Puntate" non contengono musica riproducibile: mai seguirli
    !/profil|puntat|podcast/i.test(String(c?.text ?? ''))
  );
  const pages = await Promise.all(targets.map((chip) => res.applyFilter(chip).catch(() => null)));
  for (const p of pages) {
    if (!p) continue;
    try { collect(p, out); } catch { /* parziale: quello raccolto resta */ }
  }
}

// Suggerimenti di ricerca: la risposta è un ARRAY DI SEZIONI — le suggestion
// vere vivono in section.contents (suggestion.text / endpoint.payload.query).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function searchSuggestions(raw: any): string[] {
  const sections = Array.isArray(raw) ? raw : [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = sections.flatMap((s: any) => (Array.isArray(s?.contents) ? s.contents : [s]));
  const out: string[] = [];
  for (const x of items) {
    const q = text(x?.endpoint?.payload?.query) || text(x?.suggestion ?? x);
    if (q && !out.some((o) => normTxt(o) === normTxt(q))) out.push(q);
    if (out.length >= 8) break;
  }
  return out;
}

// Normalizzazione per il confronto artista/titolo usata nell'auto-riparazione
// degli stream (condivisa: downloader.ts sul PC, direct.ts sul telefono).
export const normTxt = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Match stretto per Audius: il catalogo è piccolo/indie e una risposta "quasi
// giusta" suonerebbe un brano sbagliato — peggio di un fallimento onesto.
export function audiusMatch(mArtist: string, mTitle: string, artist: string, title: string): boolean {
  const a = normTxt(artist), t = normTxt(title);
  const ma = normTxt(mArtist), mt = normTxt(mTitle);
  if (!a || !t || !mt) return false;
  const artistOk = !ma || ma.includes(a) || a.includes(ma); // uploader sconosciuto ok se il titolo è identico
  const titleOk = mt === t || (mt.length >= 8 && t.includes(mt)) || (t.length >= 8 && mt.includes(t));
  return artistOk && titleOk;
}
