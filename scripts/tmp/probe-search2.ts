// Probe v2: replica la NUOVA pipeline di search() (musicSearchSafe + collect +
// finalizeSearch + applySearchFilters + rankArtists) su risposte reali.
import { Innertube } from 'youtubei.js';
import { collect, finalizeSearch, applySearchFilters, rankArtists, searchSuggestions } from '../../src/shared/ytparse';
import type { SearchResult } from '../../src/shared/types';

const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['u2', 'anyma', 'one u2', 'vasco rosi'];

const yt = await Innertube.create({ retrieve_player: false, location: 'IT', lang: 'it' });

async function fullSearch(query: string, expand: boolean): Promise<SearchResult> {
  const out: SearchResult = { songs: [], albums: [], artists: [], playlists: [] };
  let res: any; let isMusic = true;
  try { res = await yt.music.search(query); } catch { isMusic = false; res = await yt.search(query); }
  try { collect(res, out); } catch { }
  finalizeSearch(res, out, query);
  if (expand && isMusic) {
    try { await applySearchFilters(res, out); } catch { }
    out.artists = rankArtists(out.artists);
  }
  out.songs.sort((a, b) => (a.source === 'ytmusic' ? 0 : 1) - (b.source === 'ytmusic' ? 0 : 1));
  out.songs = out.songs.slice(0, 60);
  out.albums = out.albums.slice(0, 20);
  out.artists = out.artists.slice(0, 12);
  out.playlists = out.playlists.slice(0, 12);
  return out;
}

for (const q of queries) {
  console.log('\n==========', q, '==========');
  const fast = await fullSearch(q, false);
  const noDur = fast.songs.filter((s) => !s.durationS).length;
  const unkArtist = fast.songs.filter((s) => s.artist === 'Sconosciuto').length;
  console.log(`FAST: songs=${fast.songs.length} (noDur=${noDur}, unkArtist=${unkArtist}) albums=${fast.albums.length} artists=${fast.artists.length} pl=${fast.playlists.length}`);
  for (const s of fast.songs.slice(0, 8)) console.log('  S', (s.source === 'ytmusic' ? 'M' : 'Y'), s.videoId, '|', s.artist, '-', s.title, '|', s.durationS, '| alb:', s.album);
  for (const a of fast.artists.slice(0, 10)) console.log('  A', a.name, '|', a.subscribers);
  console.log('  TOP:', JSON.stringify(fast.topResult));
  if (fast.correctedQuery) console.log('  corrected:', fast.correctedQuery);

  const full = await fullSearch(q, true);
  const noDur2 = full.songs.filter((s) => !s.durationS).length;
  const noAlb = full.songs.filter((s) => !s.album && s.source === 'ytmusic').length;
  console.log(`FULL: songs=${full.songs.length} (noDur=${noDur2}, ytmusicNoAlbum=${noAlb}) albums=${full.albums.length} artists=${full.artists.length} pl=${full.playlists.length}`);
  for (const s of full.songs.slice(0, 10)) console.log('  S', (s.source === 'ytmusic' ? 'M' : 'Y'), s.videoId, '|', s.artist, '-', s.title, '|', s.durationS, '| alb:', s.album);
  for (const a of full.artists.slice(0, 10)) console.log('  A', a.name, '|', a.subscribers);
  for (const a of full.albums.slice(0, 6)) console.log('  ALB', a.title, '|', a.artist, '|', a.year);
  for (const p of full.playlists.slice(0, 6)) console.log('  PL', p.title, '|', p.author);
}

// Suggerimenti reali
for (const q of ['anym', 'u2', 'vasc']) {
  try {
    const raw = await yt.music.getSearchSuggestions(q);
    console.log('SUGG', q, '→', searchSuggestions(raw));
  } catch (e: any) { console.log('SUGG', q, 'THREW', e.message); }
}
