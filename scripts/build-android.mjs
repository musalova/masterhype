// Build APK Android: build renderer → cap sync → gradle assembleRelease (se
// android/keystore.properties esiste — keystore gestito, vedi AGENTS.md) con
// fallback ad assembleDebug + WARNING. La release non è debuggable e viene
// firmata con la stessa chiave del debug originario → update seamless.
// Trova JAVA_HOME/ANDROID_HOME da solo. Serve un JDK 21-23: Capacitor 7
// compila con Java 21, ma Gradle 8.11 NON gira su Java 24+ (JBR recenti
// di Android Studio sono Java 25 → "class file major version 69").
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const env = { ...process.env };

const jdkMajor = (home) => {
  if (!home) return 0;
  const v = spawnSync(join(home, 'bin', 'java.exe'), ['-version'], { encoding: 'utf8' }).stderr || '';
  return parseInt(/version "(\d+)/.exec(v)?.[1] ?? '0', 10);
};
const ok = (home) => { const m = jdkMajor(home); return m >= 21 && m <= 23; };
// Candidati: JAVA_HOME già valido, il Temurin portatile in home, il JBR di
// Android Studio (solo se ancora ≤23), il JDK su PATH.
const home = process.env.USERPROFILE ?? '';
const JBR = 'C:\\Program Files\\Android\\Android Studio\\jbr';
const candidates = [
  ok(env.JAVA_HOME) ? env.JAVA_HOME : '',
  ...[21, 22, 23].map((v) => join(home, `jdk-${v}`)),
  JBR,
];
for (const c of candidates) {
  if (c && ok(c)) { env.JAVA_HOME = c; break; }
}
if (!ok(env.JAVA_HOME)) {
  const j = spawnSync('where', ['java'], { encoding: 'utf8' }).stdout.split('\n')[0]?.trim();
  const guess = j ? join(j, '..', '..') : '';
  if (ok(guess)) env.JAVA_HOME = guess;
  else {
    console.error('Serve un JDK 21-23 (Gradle 8.11 non gira su Java 24+).');
    console.error('Scarica Temurin 21 e mettilo in %USERPROFILE%\\jdk-21. Trovato:', env.JAVA_HOME || j || 'nessuno');
    process.exit(1);
  }
}
console.log('JAVA_HOME =', env.JAVA_HOME);
const sdk = join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
if (!env.ANDROID_HOME) env.ANDROID_HOME = existsSync(sdk) ? sdk : env.ANDROID_SDK_ROOT;
if (!env.ANDROID_HOME || !existsSync(env.ANDROID_HOME)) {
  console.error('Android SDK non trovato in %LOCALAPPDATA%\\Android\\Sdk'); process.exit(1);
}
env.ANDROID_SDK_ROOT = env.ANDROID_HOME;

const run = (cmd, args, cwd = root) => {
  console.log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// ---- Versioning automatico ----
// Ogni build incrementa versionCode (Android lo usa per l'auto-aggiornamento:
// i telefoni propongono l'update solo se > installato) e allinea versionName
// a package.json.
const gradlePath = join(root, 'android', 'app', 'build.gradle');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
{
  const g = readFileSync(gradlePath, 'utf8');
  const vc = parseInt(/versionCode\s+(\d+)/.exec(g)?.[1] ?? '0', 10);
  const g2 = g
    .replace(/versionCode\s+\d+/, `versionCode ${vc + 1}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
  if (g2 !== g) writeFileSync(gradlePath, g2);
  console.log(`versionCode ${vc} → ${vc + 1} · versionName ${pkg.version}`);
}

// ---- Firma: release se il keystore gestito è presente, debug altrimenti ----
const propsFile = join(root, 'android', 'keystore.properties');
let variant = 'debug';
if (existsSync(propsFile)) {
  const props = readFileSync(propsFile, 'utf8');
  const storeFile = /^storeFile=(.+)$/m.exec(props)?.[1]?.trim();
  if (storeFile && existsSync(join(root, 'android', storeFile))) {
    variant = 'release';
  } else {
    console.error(`keystore.properties presente ma il keystore '${storeFile}' manca — ripristina il backup in android/keystore/`);
    process.exit(1);
  }
} else {
  console.warn('!! android/keystore.properties assente → build DEBUG (debuggable, firma debug). Vedi AGENTS.md "Firma APK".');
}

execSync('node -v', { stdio: 'inherit' });
run('npm', ['run', 'build']);                       // out/renderer fresco
run('npx', ['cap', 'sync', 'android']);             // copia gli asset nell'APK
run('cmd', ['/c', 'gradlew.bat', variant === 'release' ? 'assembleRelease' : 'assembleDebug'], join(root, 'android'));

const apkName = variant === 'release' ? 'app-release.apk' : 'app-debug.apk';
const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', variant, apkName);
if (!existsSync(apk)) { console.error('APK non trovato:', apk); process.exit(1); }
console.log(`variante ${variant.toUpperCase()} →`, apkName);

// ---- Pubblicazione per l'auto-aggiornamento ----
// L'APK + app-update.json vanno dove il server remoto del PC li cerca:
// release/ del repo (dev) e %APPDATA%/{masterhype,MasterHype}/apk (dev e
// installato). I telefoni pairati si aggiornano da soli via LAN.
const vcNow = parseInt(/versionCode\s+(\d+)/.exec(readFileSync(gradlePath, 'utf8'))?.[1] ?? '0', 10);
const sha = createHash('sha256').update(readFileSync(apk)).digest('hex');
// "Novità" della versione: stessa fonte della card post-update del renderer
// (src/shared/whatsnew.json) → la card di aggiornamento le mostra PRIMA di
// installare e WhatsNewCard le ripete al primo avvio della versione nuova.
const whatsNew = JSON.parse(readFileSync(join(root, 'src', 'shared', 'whatsnew.json'), 'utf8'));
// Cascata client YouTube della modalità autonoma: pubblicarla nel manifest
// permette hot-fix via feed (edit dell'asset su GitHub Releases) quando
// Google rompe un client, SENZA rilasciare un APK nuovo. Fonte unica:
// src/shared/yt-clients.json — l'asset pubblicato si può riordinare a mano.
const ytClients = JSON.parse(readFileSync(join(root, 'src', 'shared', 'yt-clients.json'), 'utf8')).clients;
const man = {
  versionCode: vcNow,
  versionName: pkg.version,
  file: 'MasterHype-Android.apk',
  size: statSync(apk).size,
  sha256: sha,
  builtAt: new Date().toISOString(),
  notes: (whatsNew[pkg.version] ?? []).join('\n') || undefined,
  ytClients,
};
const targets = [
  join(root, 'release'),
  join(root, 'build', 'apk'), // incluso nell'installer EXE (extraResources → resources/apk)
  join(process.env.APPDATA ?? '', 'masterhype', 'apk'),
  join(process.env.APPDATA ?? '', 'MasterHype', 'apk'),
];
for (const dir of targets) {
  try {
    mkdirSync(dir, { recursive: true });
    copyFileSync(apk, join(dir, man.file));
    writeFileSync(join(dir, 'app-update.json'), JSON.stringify(man, null, 2));
    console.log('pubblicato in', dir);
  } catch (e) { console.warn('copia fallita in', dir, e.message); }
}
console.log('\nAPK pronto:', join(root, 'release', man.file), `(${Math.round(man.size / 1e6)} MB, sha256 ${sha.slice(0, 12)}…)`);
