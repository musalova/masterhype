// E2E: play di un TrackRef con videoId difettoso → auto-riparazione → audio in play.
import { ev, sleep, close, enableLogs, getLogs } from './cdp-test.mjs';

await enableLogs();
await sleep(2500);

// Suona un TrackRef remoto con videoId rotto: playStream deve ripararlo
await ev(`window.__app.getState().play({videoId:'videoIdROTTOnonfunziona', title:'Albachiara', artist:'Vasco Rossi', source:'ytmusic'})`);
await sleep(9000); // tempo per fallire + cercare + riparare

const st = await ev(`(() => { const p = window.__app.getState().player; const a=[...document.querySelectorAll('audio')].map(e=>({src:(e.src||'').slice(0,40), paused:e.paused, t:e.currentTime})); return {cur: p.current?.videoId, playing: p.playing, audios: a}; })()`);
console.log('PLAYER:', JSON.stringify(st));

const stats = await ev(`window.masterhype.diag.stats().then(s => ({byKind: s.byKind, healed: s.healed, bad: s.bad, recent: s.recent.slice(0,2).map(r=>r.kind+':'+r.healed)}))`);
console.log('STATS:', JSON.stringify(stats));

// Screenshot sezione diagnostica
await ev(`window.__app.getState().nav('settings')`);
await sleep(1200);
console.log('LOGS:', JSON.stringify(getLogs().slice(0, 5)));
close();
process.exit(0);
