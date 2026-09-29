import { ev, sleep, close } from '../cdp-test.mjs';

await ev(`window.__app.getState().nav('playlists')`);
await sleep(800);
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Il tuo mix');
  if (b) b.click();
  return !!b;
})()`);
await sleep(15000);
const panel = await ev(`(() => {
  const txt = document.body.innerText.slice(0, 400);
  const rows = document.querySelectorAll('[class*="divide-y"] > *').length;
  const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 30);
  return { rows, btns, txt };
})()`);
console.log(JSON.stringify(panel, null, 1));
close();
process.exit(0);
