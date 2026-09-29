import { ev, sleep, close } from '../cdp-test.mjs';
// imposta preferenze e aspetta il flush Chromium (localStorage → leveldb)
await ev(`window.__app.getState().nav('stations')`);
await ev(`localStorage.setItem('mh-pref-muted','true')`);
await sleep(6000);
console.log('before kill:', JSON.stringify(await ev(`localStorage.getItem('mh-pref-muted')`)));
close();
