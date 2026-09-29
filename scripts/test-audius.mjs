// Test ramo Audius: risoluzione stream diretto + heal con match stretto
import { ev, sleep, close } from './cdp-test.mjs';

// 1) streamUrl su un id Audius vero (dalla search API)
const r = await ev(`(async () => {
  const res = await fetch('https://discoveryprovider.audius.co/v1/tracks/search?query=electronic&limit=1&app_name=MasterHype');
  const d = await res.json();
  const id = d.data?.[0]?.id;
  if (!id) return 'NO-SEARCH';
  const u = await window.masterhype.yt.streamUrl('audius:' + id);
  return { id, url: u?.slice(0, 110) };
})()`);
console.log('audius streamUrl:', JSON.stringify(r));

// 2) heal con videoId rotto per un brano che esiste SOLO su Audius? (difficile)
//    Più utile: verifica che un brano YT si ripari ancora via YouTube (regressione)
const h = await ev(`(async () => {
  const r = await window.masterhype.yt.playStream('ID_INESISTENTE_2', 'vasco rossi', 'albachiara');
  return { healed: r.healed, vid: r.videoId, url: r.url?.slice(0, 60) };
})()`);
console.log('heal yt:', JSON.stringify(h));
close();
process.exit(0);
