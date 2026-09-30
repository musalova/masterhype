import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const profile = mkdtempSync(join(tmpdir(), 'mh-appearance-'));
const output = process.env.MH_AUDIT_OUT || join(root, 'release', 'visual-audit');
mkdirSync(output, { recursive: true });
writeFileSync(join(profile, 'settings.json'), JSON.stringify({
  libraryDir: join(profile, 'music'), remoteEnabled: false, autostart: false,
  autoUpdateTools: false, autoUpdateApp: false,
}));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const port = 9236;
const proc = spawn(join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), [
  join(root, 'out', 'main', 'index.js'), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
], { env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
let seq = 0;
let failures = 0;
const pending = new Map();
const errors = [];
const check = (name, value) => {
  console.log(`${value ? 'PASS' : 'FAIL'} ${name}`);
  if (!value) failures++;
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};
const screenshot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(output, `${name}.png`), Buffer.from(data, 'base64'));
};
const navigate = async (screen) => {
  await ev(`window.__app.getState().nav(${JSON.stringify(screen)})`);
  await sleep(650);
};
const viewport = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: width < 768 });
  await sleep(150);
};

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page'); } catch {}
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('Electron non raggiungibile');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  for (let i = 0; i < 80 && !await ev('!!window.__app'); i++) await sleep(250);
  await ev(`localStorage.setItem('mh-pref-onboarded', 'true'); [...document.querySelectorAll('.system-cards button')].find(el => el.textContent.trim() === 'Perfetto')?.click(); location.reload()`);
  await sleep(2200);
  await viewport(1365, 900);
  await navigate('settings');
  check('six theme swatches', await ev(`document.querySelectorAll('.theme-swatch').length === 6`));
  const accents = new Set();
  for (const id of ['sunset', 'ocean', 'lime', 'violet', 'gold', 'mono']) {
    await ev(`document.querySelector('.theme-swatch[data-accent="${id}"]').click()`);
    await sleep(100);
    check(`theme ${id} applies and persists`, await ev(`document.documentElement.dataset.accent === '${id}' && JSON.parse(localStorage.getItem('mh-pref-accent')) === '${id}' && document.querySelector('.theme-swatch[data-accent="${id}"]').getAttribute('aria-pressed') === 'true'`));
    accents.add(await ev(`getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()`));
  }
  check('six distinct accent palettes', accents.size === 6);
  await ev(`document.querySelector('.theme-swatch[data-accent="sunset"]').click()`);
  await sleep(150);
  await screenshot('desktop-themes');
  await ev(`document.querySelector('[aria-label="Riduci animazioni"]').click()`);
  check('reduced motion preference', await ev(`document.documentElement.dataset.motion === 'off'`));
  await send('Page.reload');
  await sleep(1800);
  check('appearance survives reload', await ev(`document.documentElement.dataset.accent === 'sunset' && document.documentElement.dataset.motion === 'off'`));
  const screens = ['home', 'search', 'stations', 'library', 'playlists', 'cd', 'assistant', 'downloads', 'settings'];
  for (const [width, height] of [[1365, 900], [768, 1024], [390, 844], [320, 740]]) {
    await viewport(width, height);
    for (const screen of screens) {
      await navigate(screen);
      const layout = await ev(`(() => {
        const main = document.querySelector('main');
        const content = main?.querySelector(':scope > div > div');
        const play = document.querySelector('.player-play')?.getBoundingClientRect();
        return main?.innerText.length > 0 && !main.innerText.includes('Questa schermata è andata in errore')
          && document.documentElement.scrollWidth <= innerWidth
          && (!content || content.scrollWidth <= content.clientWidth + 1)
          && play && play.right <= innerWidth && play.left >= 0
          && document.querySelector('.player-bar').scrollWidth <= document.querySelector('.player-bar').clientWidth + 1;
      })()`);
      check(`${width}px ${screen}: rendered, no horizontal overflow`, layout);
      if (!layout) {
        console.log(await ev(`JSON.stringify([...document.querySelectorAll('main, main > div > div, .player-bar, .player-play')].map(el => ({ cls: el.className, width: el.clientWidth, scroll: el.scrollWidth, right: el.getBoundingClientRect().right })))`));
        await screenshot(`overflow-${width}-${screen}`);
      }
    }
    if (width === 1365 || width === 390) {
      await navigate('home');
      await screenshot(`${width === 1365 ? 'desktop' : 'phone'}-home`);
      await navigate('stations');
      await screenshot(`${width === 1365 ? 'desktop' : 'phone'}-stations`);
    }
    if (width < 768) {
      check(`${width}px mobile nav and controls`, await ev(`(() => {
        const visible = [...document.querySelectorAll('.player-controls > button')].filter((el) => getComputedStyle(el).display !== 'none');
        const nav = document.querySelector('.app-sidebar').getBoundingClientRect();
        const player = document.querySelector('.player-bar').getBoundingClientRect();
        return visible.length === 3 && visible.every((el) => el.getBoundingClientRect().height >= 42) && player.bottom <= nav.top + 1;
      })()`));
    }
  }
  await viewport(390, 844);
  await navigate('settings');
  await screenshot('phone-themes');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('system reduced motion respected', await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches && parseFloat(getComputedStyle(document.querySelector('.theme-swatch')).transitionDuration) < .001`));
  check('no automatic playback', await ev(`!window.__app.getState().player.playing && [...document.querySelectorAll('audio')].every((a) => a.paused)`));
  check('no renderer exceptions', errors.length === 0);
  if (errors.length) console.log(errors);
  console.log(`Screenshots: ${output}`);
} finally {
  ws?.close();
  proc.kill();
}
process.exitCode = failures ? 1 : 0;
