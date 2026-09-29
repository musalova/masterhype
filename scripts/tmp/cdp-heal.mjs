// Test live dell'auto-riparazione: infila in coda un brano con videoId fasullo
// e verifica che playStream lo ripari cercando un'alternativa.
import { ev, sleep, close, enableLogs, getLogs } from '../cdp-test.mjs';

await enableLogs();
await sleep(2500);

// 1. playStream su videoId noto difettoso → deve riparare
const heal = await ev(`window.masterhype.yt.playStream('videoIdFASULLO123', 'Vasco Rossi', 'Albachiara')`);
console.log('HEAL:', JSON.stringify(heal));

// 2. Diagnostica: devono esserci issue registrate
const stats = await ev(`window.masterhype.diag.stats()`);
console.log('STATS:', JSON.stringify(stats));

// 3. La ricerca deve filtrare il videoId marcato difettoso
const srch = await ev(`window.masterhype.yt.search('vasco rossi albachiara', false).then(r => r.songs.slice(0,3).map(s => s.videoId))`);
console.log('SEARCH:', JSON.stringify(srch));

console.log('LOGS:', JSON.stringify(getLogs().slice(0, 6)));
close();
process.exit(0);
