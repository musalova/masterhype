// Release completa: APK (versionCode +1) → EXE (con l'APK dentro) → cartella
// feed pronta da pubblicare sul server degli aggiornamenti.
//
//   npm run release                 → release/feed/
//   MH_FEED_DIR=Z:\mh npm run release → copia anche in una cartella (share di
//                                       rete, cartella sincronizzata, mount del server)
//
// Il feed contiene esattamente ciò che serve all'auto-aggiornamento:
//   latest.yml + MasterHype-Setup-X.Y.Z.exe (+ .blockmap)  → EXE (electron-updater)
//   app-update.json + MasterHype-Android.apk               → telefoni (fuori casa / senza PC)
// Ordine di upload consigliato: prima exe/apk, POI latest.yml/app-update.json
// (i manifest per ultimi: nessun client vede una versione i cui file mancano).
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const run = (cmd, args) => {
  console.log('\n>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const whatsNew = JSON.parse(readFileSync(join(root, 'src', 'shared', 'whatsnew.json'), 'utf8'));
const skipApk = process.argv.includes('--skip-apk');
// --publish-only: salta le build, ripubblica su GitHub il feed già prodotto
// (es. primo upload dopo aver cablato DEFAULT_UPDATE_FEED, o retry del publish).
const publishOnly = process.argv.includes('--publish-only');

if (!publishOnly) {
  if (!skipApk) run('node', ['scripts/build-android.mjs']); // include `npm run build`
  else run('npm', ['run', 'build']);
  if (!existsSync(join(root, 'build', 'apk', 'MasterHype-Android.apk'))) {
    console.error('APK mancante in build/apk: l\'installer non potrebbe aggiornare i telefoni. Esegui senza --skip-apk.');
    process.exit(1);
  }
  run('npx', ['electron-builder', '--win', '--publish', 'never']);
}

const rel = join(root, 'release');
const setup = `MasterHype-Setup-${pkg.version}.exe`;
const files = [
  [join(rel, setup), setup],
  [join(rel, `${setup}.blockmap`), `${setup}.blockmap`],
  [join(rel, 'latest.yml'), 'latest.yml'],
  [join(root, 'build', 'apk', 'MasterHype-Android.apk'), 'MasterHype-Android.apk'],
  [join(root, 'build', 'apk', 'app-update.json'), 'app-update.json'],
];
for (const [src] of files) if (!existsSync(src)) { console.error('File di release mancante:', src); process.exit(1); }

const publish = (dir) => {
  mkdirSync(dir, { recursive: true });
  // Binari prima, manifest per ultimi (vedi sopra)
  const isManifest = (n) => /\.(yml|json)$/.test(n);
  for (const [src, name] of [...files.filter((f) => !isManifest(f[1])), ...files.filter((f) => isManifest(f[1]))]) copyFileSync(src, join(dir, name));
};

const feed = join(rel, 'feed');
rmSync(feed, { recursive: true, force: true }); // cartella generata da questo script
publish(feed);
if (process.env.MH_FEED_DIR) { publish(process.env.MH_FEED_DIR); console.log('Copiato anche in', process.env.MH_FEED_DIR); }

const apk = JSON.parse(readFileSync(join(feed, 'app-update.json'), 'utf8'));
console.log(`\nRelease ${pkg.version} pronta in ${feed}`);
for (const [, name] of files) console.log(`  ${name.padEnd(36)} ${(statSync(join(feed, name)).size / 1e6).toFixed(1)} MB`);
console.log(`APK build ${apk.versionCode} (${apk.versionName})`);

// ---- Publish su GitHub Releases (feed pubblico di DEFAULT_UPDATE_FEED) ----
// GH_TOKEN = PAT (fine-grained, Contents: Read&Write sul repo). La release
// vX.Y.Z ospita i 5 file del feed come asset: /releases/latest/download/<file>
// li serve sempre dalla release più recente. Il repo DEVE essere pubblico.
const GH_REPO = process.env.GH_REPO || 'musalova/masterhype';
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${GH_REPO}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
  });
  if (!res.ok && res.status !== 404) throw new Error(`GitHub ${opts.method ?? 'GET'} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}
async function publishGithub() {
  const tag = `v${pkg.version}`;
  const notes = (whatsNew[pkg.version] ?? []).map((b) => `• ${b}`).join('\n');
  let relRes = await gh(`/releases/tags/${tag}`);
  let release = relRes.ok ? await relRes.json() : null;
  if (!release) {
    console.log(`\n> GitHub: creo la release ${tag}`);
    release = await (await gh('/releases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: `MasterHype ${pkg.version}`, body: notes }),
    })).json();
    if (!release?.id) throw new Error(`creazione release fallita: ${JSON.stringify(release).slice(0, 300)}`);
  } else {
    console.log(`\n> GitHub: release ${tag} esiste — aggiorno gli asset`);
    const assets = (await (await gh(`/releases/${release.id}/assets?per_page=100`)).json()) ?? [];
    for (const a of assets) {
      if (files.some(([, n]) => n === a.name)) await gh(`/releases/assets/${a.id}`, { method: 'DELETE' });
    }
  }
  const up = release.upload_url.replace(/\{[^}]*\}/, '');
  for (const [src, name] of files) {
    console.log(`> upload ${name}`);
    const r = await fetch(`${up}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(statSync(src).size),
      },
      body: readFileSync(src),
    });
    if (!r.ok) throw new Error(`upload ${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  console.log(`Release pubblicata: https://github.com/${GH_REPO}/releases/tag/${tag}`);
}
if (process.env.GH_TOKEN) {
  try { await publishGithub(); }
  catch (e) { console.error('\n!! Publish GitHub fallito (il feed locale resta valido):', e.message); }
} else {
  console.log('\nPublish GitHub saltato: imposta GH_TOKEN (PAT Contents:RW) — GH_REPO=' + GH_REPO);
}
