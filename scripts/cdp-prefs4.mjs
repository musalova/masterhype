import { ev, sleep, close } from './cdp-test.mjs';
console.log('restored:', JSON.stringify(await ev(`(()=>({
  screen: window.__app.getState().screen,
  muted: localStorage.getItem('mh-pref-muted'),
  sliderVol: document.querySelector('input[type=range][max="1"]')?.value,
}))()`)));
close();
