import { ev, sleep, close } from './cdp-test.mjs';

// Test ricerca completa: top result, categorie espanse, pagina artista
const r = await ev(`(async () => {
  const res = await window.masterhype.yt.search('vasco rossi');
  return {
    songs: res.songs.length,
    albums: res.albums.length,
    artists: res.artists.length,
    playlists: res.playlists.length,
    topResult: res.topResult,
    corrected: res.correctedQuery,
    sampleSong: res.songs[0]?.title + ' ~ ' + res.songs[0]?.artist,
    sampleAlbum: res.albums[0]?.title + ' ~ ' + res.albums[0]?.year,
    sampleArtist: res.artists[0]?.name,
    samplePl: res.playlists[0]?.title,
  };
})()`);
console.log('SEARCH:', JSON.stringify(r, null, 1));

// Pagina artista completa — uso il TOP RESULT (artista vero)
const ap = await ev(`(async () => {
  const res = await window.masterhype.yt.search('vasco rossi');
  const id = res.topResult?.id ?? res.artists[0]?.browseId;
  const p = await window.masterhype.yt.artistPage(id);
  return {
    name: p.name, subs: p.subscribers,
    topSongs: p.topSongs.length, albums: p.albums.length,
    singles: p.singles.length, related: p.related.length,
    playlists: p.playlists.length, videos: p.videos.length,
    firstSong: p.topSongs[0]?.title,
    firstAlbum: p.albums[0]?.title,
    albumYears: p.albums.slice(0,5).map(a => a.year),
    relatedNames: p.related.slice(0,4).map(x => x.name),
  };
})()`);
console.log('ARTIST PAGE:', JSON.stringify(ap, null, 1));

// Playlist tracks
const pt = await ev(`(async () => {
  const res = await window.masterhype.yt.search('vasco rossi');
  const p = res.playlists[0];
  if (!p) return { skip: 'no playlist' };
  const t = await window.masterhype.yt.playlistTracks(p.id);
  return { n: t.length, first: t[0]?.title + ' ~ ' + t[0]?.artist };
})()`);
console.log('PLAYLIST:', JSON.stringify(pt));

// Ricerca con errore di battitura → correctedQuery
const cq = await ev(`window.masterhype.yt.search('vasco rosi').then(r => ({ corrected: r.correctedQuery, songs: r.songs.length }))`);
console.log('TYPO:', JSON.stringify(cq));

close();
