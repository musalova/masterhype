import { Innertube, UniversalCache } from 'youtubei.js';
import type { TrackRef, SearchResult, ArtistPage } from '../../shared/types';
import { text, thumbOf, toTrack, toAlbum, toArtist, toPlaylist, collect, flattenShelves, dedupe, finalizeSearch, applySearchFilters, rankArtists, searchSuggestions, collectVideoFallback, isEmptyPageError, parseHealth } from '../../shared/ytparse';
import { getSettings } from '../settings';

// Client InnerTube per YouTube Music: cerca release audio ufficiali ("song"),
// non i video musicali -> audio pulito tipo Spotify.
let yt: Innertube | null = null;
let ytCountry = '';

export async function getClient(): Promise<Innertube> {
  const country = getSettings().country || 'IT';
  if (!yt || ytCountry !== country) {
    yt = await Innertube.create({
      cache: new UniversalCache(false),
      retrieve_player: false,
      location: country,
      lang: 'it',
    });
    ytCountry = country;
  }
  return yt;
}

// music.search può lanciare su risposte non standard (pagina senza contents,
// card/shelf nuove per query particolari, zero risultati): ripiego sulla
// ricerca YouTube generica — i brani arrivano lo stesso marcate 'youtube'.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function musicSearchSafe(client: Innertube, query: string): Promise<{ res: any; isMusic: boolean }> {
  try {
    return { res: await client.music.search(query), isMusic: true };
  } catch {
    try {
      return { res: await client.search(query), isMusic: false };
    } catch (e2) {
      // Pagina vuota (zero risultati) su entrambe: non è un errore di rete,
      // è una risposta vuota onesta → res null = risultato vuoto.
      if (isEmptyPageError(e2)) return { res: null, isMusic: false };
      throw e2;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectSafe(res: any, out: SearchResult, isMusic = true): void {
  // Il parser di una singola shelf non deve buttare giù tutta la ricerca:
  // collect è best-effort ma un tipo di card nuovo può lanciare a metà —
  // teniamo ciò che ha già raccolto. La risposta della ricerca generica
  // (fallback) non ha item_type: va raccolta come video, non come brani.
  try { isMusic ? collect(res, out) : collectVideoFallback(res, out); } catch { /* raccolta parziale */ }
}

// Ricerca "leggera": solo brani, senza espansione per categoria.
// Usata internamente per risolvere videoId nei suggerimenti (veloce).
export async function searchSongs(query: string): Promise<TrackRef[]> {
  const client = await getClient();
  const { res, isMusic } = await musicSearchSafe(client, query);
  const out = { songs: [] as TrackRef[], albums: [], artists: [], playlists: [] };
  if (res) collectSafe(res, out, isMusic);
  out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
  return out.songs;
}

export async function search(query: string, expand = true): Promise<SearchResult> {
  const client = await getClient();
  const { res, isMusic } = await musicSearchSafe(client, query);

  const out: SearchResult = { songs: [], albums: [], artists: [], playlists: [] };
  if (res) collectSafe(res, out, isMusic);

  // Canary anti-degrado: pagina piena (item con videoId estraibili) ma zero
  // risultati raccolti = parser incompatibile col layout Innertube corrente.
  // Ripiego sulla ricerca generica; se resta vuoto si marca `degraded` —
  // la UI dichiara il problema invece di mostrare "nessun risultato".
  if (res && isMusic && !out.songs.length && !out.albums.length && !out.artists.length && !out.playlists.length
      && parseHealth(res).playable > 0) {
    try {
      const res2 = await client.search(query);
      collectSafe(res2, out, false);
      if (!out.songs.length) out.degraded = true;
    } catch (e2) { if (!isEmptyPageError(e2)) throw e2; }
  }

  // Top result, promozione artista, "Forse cercavi…", ranking artisti
  if (res) finalizeSearch(res, out, query);

  if (!expand) {
    out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
    out.songs = out.songs.slice(0, 60);
    return out;
  }

  // Categorie complete: i filtri espandono ogni sezione (più album/artisti/brani).
  // Solo per ricerche YT Music: i chip della ricerca generica hanno altra semantica.
  if (isMusic) {
    try { await applySearchFilters(res, out); } catch { /* espansione opzionale */ }
    out.artists = rankArtists(out.artists); // ri-rank dopo l'arricchimento dei subscribers
  }

  // Audio pulito prima: le release "song" ufficiali davanti ai video
  out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
  out.songs = out.songs.slice(0, 60);
  out.albums = out.albums.slice(0, 20);
  out.artists = out.artists.slice(0, 12);
  out.playlists = out.playlists.slice(0, 12);
  return out;
}

// Pagina artista completa (discografia, top brani, correlati, playlist)
export async function artistPage(browseId: string): Promise<ArtistPage> {
  const client = await getClient();
  const artist = await client.music.getArtist(browseId);
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
      // top songs
      for (const i of contents) {
        const t = toTrack(i);
        if (t) page.topSongs.push(t);
      }
    } else if (kinds.has('artist') || title.includes('potrebbe') || title.includes('correlat') || title.includes('fans also')) {
      for (const i of contents) { const a = toArtist(i); if (a) page.related.push(a); }
    } else if (kinds.has('playlist') || title.includes('playlist') || title.includes('primo piano') || title.includes('featured')) {
      for (const i of contents) { const p = toPlaylist(i); if (p) page.playlists.push(p); }
    } else if (kinds.has('video') || title.includes('video') || title.includes('live') || title.includes('performance')) {
      for (const i of contents) { const t = toTrack(i, 'youtube'); if (t) page.videos.push(t); }
    } else {
      // carousel di album/singoli
      const isSingle = title.includes('singol') || title.includes('single') || title.includes('ep');
      for (const i of contents) {
        const a = toAlbum(i);
        if (a) (isSingle ? page.singles : page.albums).push(a);
      }
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

// Tracce di una playlist YT Music / community
export async function playlistTracks(browseId: string): Promise<TrackRef[]> {
  const client = await getClient();
  const id = browseId.replace(/^VL/, '');
  const pl = await client.music.getPlaylist(id);
  return dedupe(flattenShelves(pl).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t));
}

// Brani correlati a un seed: cuore delle "alternative coerenti".
export async function upNext(videoId: string): Promise<TrackRef[]> {
  const client = await getClient();
  try {
    const feed = await client.music.getUpNext(videoId, true);
    const tracks = flattenShelves(feed).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t);
    if (tracks.length) return dedupe(tracks);
  } catch { /* fallback sotto */ }
  const feed = await client.music.getUpNext(videoId);
  return dedupe(flattenShelves(feed).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t));
}

export async function charts(_country: string): Promise<TrackRef[]> {
  const client = await getClient();
  // youtubei.js v18: niente più getTrending -> feed Explore (classifiche/novità)
  const explore = await client.music.getExplore();
  return dedupe(flattenShelves(explore).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t)).slice(0, 60);
}

export async function albumTracks(browseId: string): Promise<TrackRef[]> {
  const client = await getClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const album: any = await client.music.getAlbum(browseId);
  // Le tracce album non portano artista/cover: li ereditano dall'header
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

export async function artistTop(browseId: string): Promise<TrackRef[]> {
  const client = await getClient();
  const artist = await client.music.getArtist(browseId);
  return dedupe(flattenShelves(artist).map((i) => toTrack(i)).filter((t): t is TrackRef => !!t)).slice(0, 20);
}

export async function suggestions(query: string): Promise<string[]> {
  const client = await getClient();
  try {
    // getSearchSuggestions torna SEZIONI, non item: l'estrazione vera è
    // in searchSuggestions (contents[].suggestion / endpoint.payload.query)
    return searchSuggestions(await client.music.getSearchSuggestions(query));
  } catch {
    return [];
  }
}
