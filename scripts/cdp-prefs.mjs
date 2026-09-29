import { ev, enableLogs, getLogs, sleep, close } from './cdp-test.mjs';
await enableLogs();
// cambia preferenze: vai su stations, ordina libreria per artista, mute, tab trends
await ev(`window.__app.getState().nav('library')`);
await sleep(400);
await ev(`(()=>{const sel=[...document.querySelectorAll('select')].find(s=>s.querySelector('option'));if(sel){sel.value='artist';sel.dispatchEvent(new Event('change',{bubbles:true}))}return true})()`);
await sleep(300);
await ev(`localStorage.setItem('mh-pref-libsort','"artist"'); localStorage.setItem('mh-pref-muted','true')`);
await ev(`window.__app.getState().nav('stations')`);
await sleep(400);
console.log('saved:', JSON.stringify(await ev(`({screen:localStorage.getItem('mh-pref-screen'),sort:localStorage.getItem('mh-pref-libsort'),muted:localStorage.getItem('mh-pref-muted')})`)));
console.log('logs:', JSON.stringify(getLogs().slice(0,5)));
close();
