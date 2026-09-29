// Probe finale: replica esatta della nuova search() (musicSearchSafe + empty-page)
import { Innertube } from 'youtubei.js';
import { collect, collectVideoFallback, finalizeSearch, applySearchFilters, rankArtists, isEmptyPageError } from '../../src/shared/ytparse';
import type { SearchResult } from '../../src/shared/types';

const yt = await Innertube.create({ retrieve_player: false, location: 'IT', lang: 'it' });

async function musicSearchSafe(query: string) {
  try { return { res: await yt.music.search(query) as any, isMusic: true }; }
  catch {
    try { return { res: await yt.search(query) as any, isMusic: false }; }
    catch (e2) {
      if (isEmptyPageError(e2)) return { res: null, isMusic: false };
      throw e2;
    }
  }
}

async function fullSearch(query: string, expand: boolean): Promise<SearchResult> {
  const { res, isMusic } = await musicSearchSafe(query);
  const out: SearchResult = { songs: [], albums: [], artists: [], playlists: [] };
  if (res) { try { isMusic ? collect(res, out) : collectVideoFallback(res, out); } catch { } finalizeSearch(res, out, query); }
  if (expand && isMusic && res) {
    try { await applySearchFilters(res, out); } catch { }
    out.artists = rankArtists(out.artists);
  }
  out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
  out.songs = out.songs.slice(0, 60);
  out.albums = out.albums.slice(0, 20); out.artists = out.artists.slice(0, 12); out.playlists = out.playlists.slice(0, 12);
  return out;
}

for (const q of process.argv.slice(2)) {
  try {
    const r = await fullSearch(q, true);
    const noDur = r.songs.filter((s) => !s.durationS).length;
    console.log(`\n=== ${q}: songs=${r.songs.length}(noDur=${noDur}) albums=${r.albums.length} artists=${r.artists.length} pl=${r.playlists.length} top=${r.topResult?.kind}:${r.topResult?.title} corr=${r.correctedQuery ?? '-'}`);
    for (const s of r.songs.slice(0, 6)) console.log('   S', s.source[0].toUpperCase(), s.artist, '-', s.title, '|', s.durationS, '|', s.album ?? '-');
    console.log('   ARTISTS:', r.artists.map((a) => `${a.name}${a.subscribers ? ' (' + a.subscribers + ')' : ''}`).join(' | '));
  } catch (e: any) {
    console.log(`\n=== ${q}: THREW ${e.message}`);
  }
}
