import { ev, close } from '../cdp-test.mjs';
console.log(await ev(`Object.keys(window.masterhype).join(',')`));
const tr = await ev(`(async () => {
  const api = window.masterhype;
  const fn = api.trends?.get ?? api.rec?.trends;
  if (!fn) return 'NO trends fn';
  const t = await fn.call(api.trends ?? api.rec);
  const dz = t.filter((x) => (x.sources ?? []).includes('deezer')).slice(0, 4)
    .map((x) => ({ t: x.title, th: x.thumbnail ?? null }));
  return { n: t.length, dz };
})()`);
console.log(JSON.stringify(tr, null, 1));
close(); process.exit(0);
