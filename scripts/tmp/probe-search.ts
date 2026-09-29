// Probe riproduzione ricerca: gira il VERO codice di ytparse.ts su risposte reali
import { Innertube } from 'youtubei.js';
import { collect, extractTopResult, flattenShelves, toTrack, dedupe } from '../../src/shared/ytparse';

const queries = process.argv.slice(2).length ? process.argv.slice(2) : ['u2', 'anyma'];

const yt = await Innertube.create({ retrieve_player: false, location: 'IT', lang: 'it' });

for (const q of queries) {
  console.log('\n==========', q, '==========');
  let res: any;
  try {
    res = await yt.music.search(q);
  } catch (e: any) {
    console.log('music.search THREW:', e.message);
    continue;
  }
  const out = { songs: [] as any[], albums: [] as any[], artists: [] as any[], playlists: [] as any[] };
  try { collect(res, out); } catch (e: any) { console.log('collect THREW:', e.message); }
  console.log('songs:', out.songs.length, '| albums:', out.albums.length, '| artists:', out.artists.length, '| playlists:', out.playlists.length);
  for (const s of out.songs.slice(0, 12)) console.log('  SONG', s.videoId, '|', s.artist, '-', s.title, '|', s.durationS, '|', s.source);
  for (const a of out.artists.slice(0, 8)) console.log('  ARTIST', a.browseId, '|', a.name, '|', a.subscribers);
  for (const a of out.albums.slice(0, 8)) console.log('  ALBUM', a.browseId, '|', a.title, '|', a.artist, '|', a.year);
  for (const p of out.playlists.slice(0, 5)) console.log('  PL', p.id, '|', p.title, '|', p.author);

  const top = extractTopResult(res);
  console.log('topResult:', JSON.stringify(top));

  // item_type 'unknown' persi?
  const flat = flattenShelves(res) as any[];
  const unknown = flat.filter((i) => i.item_type === 'unknown');
  console.log('unknown items:', unknown.length, unknown.slice(0, 4).map((i) => i.type + '/' + JSON.stringify(i.title ?? '').slice(0, 60)));

  // songs dentro la MusicCardShelf?
  const card = res.contents?.find((c: any) => c.type === 'MusicCardShelf');
  if (card) {
    console.log('card title:', JSON.stringify(card.title).slice(0, 80));
    console.log('card on_tap:', JSON.stringify(card.on_tap?.payload ?? {}).slice(0, 200));
    console.log('card contents items:', (card.contents ?? []).map((x: any) => x.item_type ?? x.type).join(','));
  }

  // chips
  const chips = res.header?.chips ?? [];
  console.log('chips:', chips.map((c: any) => c.text).join(' | '));

  // Espansione categorie (come fa search(expand=true))
  const chipFor = (label: string) => chips.find((c: any) => String(c.text ?? '').toLowerCase().startsWith(label));
  for (const label of ['brani', 'album', 'artisti', 'playlist']) {
    const chip = chipFor(label);
    if (!chip) { console.log(`  chip '${label}': MISSING`); continue; }
    try {
      const filtered = await res.applyFilter(chip);
      const f = { songs: [] as any[], albums: [] as any[], artists: [] as any[], playlists: [] as any[] };
      collect(filtered, f);
      console.log(`  chip '${chip.text}': songs=${f.songs.length} albums=${f.albums.length} artists=${f.artists.length} pl=${f.playlists.length}`);
    } catch (e: any) {
      console.log(`  chip '${chip.text}': applyFilter THREW ${e.message}`);
    }
  }

  // continuations?
  try {
    if (res.has_continuation) {
      const cont = await res.getContinuation();
      const c2 = { songs: [] as any[], albums: [] as any[], artists: [] as any[], playlists: [] as any[] };
      collect(cont, c2);
      console.log('continuation: songs=', c2.songs.length, 'more?', cont.has_continuation);
    } else {
      console.log('no continuation');
    }
  } catch (e: any) { console.log('continuation THREW:', e.message); }
}
