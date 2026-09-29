import { ev, sleep, close } from './cdp-test.mjs';
// dopo riavvio: schermata ripristinata? audio muto?
console.log('restored:', JSON.stringify(await ev(`(()=>{
  const p=window.__app.getState().player;
  return {screen:window.__app.getState().screen, muted:localStorage.getItem('mh-pref-muted'), vols:[...document.querySelectorAll('audio')].map(a=>a.volume)};
})()`)));
close();
