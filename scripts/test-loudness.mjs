// Test live: play di un brano remoto → attesa misura LUFS → verifica gain
import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';

await enableLogs();
// Stato app pronto?
console.log('app:', await ev(`!!window.__app`));
// Riproduci un brano remoto noto
const r = await ev(`(async () => {
  const s = window.__app.getState();
  const res = await window.masterhype.yt.search('vasco rossi albachiara');
  const t = res.songs?.[0];
  if (!t) return 'NESSUN RISULTATO';
  s.play(t, [t]);
  return { vid: t.videoId, title: t.title };
})()`);
console.log('play:', JSON.stringify(r));
const vid = r.vid;
if (!vid) { close(); process.exit(1); }

// Attendi la misura LUFS (ffmpeg analizza fino a 60s di stream — max ~90s)
let lufs = null;
for (let i = 0; i < 20; i++) {
  await sleep(6000);
  lufs = await ev(`window.masterhype.yt.loudness('${vid}')`);
  const playing = await ev(`(() => { const s = window.__app.getState(); return { playing: s.player.playing, cur: s.player.current?.videoId }; })()`);
  console.log(`t+${(i + 1) * 6}s  playing=${playing.playing}  lufs=${lufs}`);
  if (lufs != null) break;
}
console.log('RISULTATO lufs:', lufs);
const errs = getLogs().filter((l) => l.startsWith('error'));
console.log('errori console:', errs.length ? errs.slice(0, 5) : 'nessuno');
close();
process.exit(0);
