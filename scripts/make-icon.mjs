// Genera TUTTI gli asset icona MasterHype dal logo sorgente (logo/Gemini_*.jpg):
//   build/icon.ico                         — multi-size PNG-embedded (Windows Vista+)
//   resources/icon.png                     — 256px (tray + icona finestra Electron)
//   src/renderer/public/icon-{192,512}.png — PWA/manifest (+ favicon via index.html)
//   android/.../assets/public/icon-*.png   — copie servite dalla WebView dell'APK
//   android/.../mipmap-*/ic_launcher*.png  — launcher legacy/square/round + foreground adattivo
//   android/.../drawable-*/splash.png      — splash brandizzata (logo su sfondo scuro)
// Il logo è circolare su fondo scuro: il "tile" è un crop quadrato pieno
// (la texture riempie gli angoli), il "disco" lo stesso crop con maschera
// circolare sfumata per fondersi sul background adattivo/splash.
// Uso: node scripts/make-icon.mjs

import sharp from 'sharp';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'logo', 'Gemini_Generated_Image_phv873phv873phv8.jpg');

// Sorgente 2048x2048. Bbox del neon (soglia ~140): x408..1684, y368..1632
// → centro ≈ (1046,1000), diametro anello ≈ 1276.
const TILE = { left: 266, top: 220, width: 1560, height: 1560 }; // anello ≈ 82% del tile
const TIGHT = { left: 396, top: 310, width: 1300, height: 1300 }; // lettere, per icone ≤32px
const BG = { r: 12, g: 10, b: 16 }; // #0c0a10 — come ic_launcher_background / capacitor bg

const tile = (size, region = TILE) =>
  sharp(SRC).extract(region).resize(size, size, { kernel: 'lanczos3' }).png();

// Maschera circolare (alpha) con bordo sfumato `feather` px, raggio in frazione del lato.
const circleMask = (size, rFrac, feather = 0) =>
  sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size * rFrac}" fill="#fff"
        ${feather ? `filter="url(#f)"` : ''}/>
      <defs><filter id="f" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="${feather}"/></filter></defs>
    </svg>`
  )).png().toBuffer();

// Tile ritagliato a cerchio (alpha fuori), bordo opaco o sfumato.
const disc = async (size, feather = 0) =>
  sharp(await tile(size).toBuffer())
    .composite([{ input: await circleMask(size, 0.5, feather), blend: 'dest-in' }])
    .png().toBuffer();

// Disco con bordo sfumato centrato su canvas trasparente `canvas` (disco = dFrac del lato).
const discOnCanvas = async (canvas, dFrac, featherFrac = 0.04) => {
  const d = Math.round(canvas * dFrac);
  const dbuf = await disc(d, Math.max(1, Math.round(d * featherFrac)));
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: dbuf, left: Math.round((canvas - d) / 2), top: Math.round((canvas - d) / 2) }])
    .png().toBuffer();
};

// ── 1. resources/icon.png + src/renderer/public + assets dell'APK ────────────
mkdirSync(join(root, 'resources'), { recursive: true });
writeFileSync(join(root, 'resources', 'icon.png'), await tile(256).toBuffer());
for (const s of [192, 512]) {
  const buf = await tile(s).toBuffer();
  writeFileSync(join(root, 'src', 'renderer', 'public', `icon-${s}.png`), buf);
  const apkPub = join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
  mkdirSync(apkPub, { recursive: true });
  writeFileSync(join(apkPub, `icon-${s}.png`), buf);
}

// ── 2. build/icon.ico — sotto i 48px crop stretto sulle lettere (leggibilità) ─
const SIZES = [256, 64, 48, 32, 24, 16];
const pngs = [];
for (const size of SIZES) {
  pngs.push({ size, buf: await tile(size, size <= 32 ? TIGHT : TILE).toBuffer() });
}
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
const entries = Buffer.alloc(16 * pngs.length);
let offset = 6 + 16 * pngs.length;
pngs.forEach((p, i) => {
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, i * 16);
  entries.writeUInt8(p.size >= 256 ? 0 : p.size, i * 16 + 1);
  entries.writeUInt16LE(1, i * 16 + 4);
  entries.writeUInt16LE(32, i * 16 + 6);
  entries.writeUInt32LE(p.buf.length, i * 16 + 8);
  entries.writeUInt32LE(offset, i * 16 + 12);
  offset += p.buf.length;
});
mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, entries, ...pngs.map((p) => p.buf)]));

// ── 3. Android launcher: square, round, adaptive foreground ──────────────────
const DENS = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FG = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const resDir = join(root, 'android', 'app', 'src', 'main', 'res');
for (const [d, s] of Object.entries(DENS)) {
  const dir = join(resDir, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher.png'), await tile(s).toBuffer());
  writeFileSync(join(dir, 'ic_launcher_round.png'), await disc(s, Math.max(1, Math.round(s * 0.01))));
}
for (const [d, s] of Object.entries(FG)) {
  // safe zone adattiva = cerchio 66%: disco al 72% con bordo sfumato →
  // l'anello neon (82% del disco) resta dentro la safe zone, il bordo fonde sul bg.
  writeFileSync(join(resDir, `mipmap-${d}`, 'ic_launcher_foreground.png'), await discOnCanvas(s, 0.72));
}

// ── 4. Android splash: disco sfumato centrato su fondo scuro ─────────────────
const SPLASH = {
  'drawable': [480, 320],
  'drawable-land-mdpi': [480, 320], 'drawable-land-hdpi': [800, 480],
  'drawable-land-xhdpi': [1280, 720], 'drawable-land-xxhdpi': [1600, 960],
  'drawable-land-xxxhdpi': [1920, 1280],
  'drawable-port-mdpi': [320, 480], 'drawable-port-hdpi': [480, 800],
  'drawable-port-xhdpi': [720, 1280], 'drawable-port-xxhdpi': [960, 1600],
  'drawable-port-xxxhdpi': [1280, 1920],
};
for (const [dir, [w, h]] of Object.entries(SPLASH)) {
  const d = Math.round(Math.min(w, h) * 0.42);
  const dbuf = await disc(d, Math.max(2, Math.round(d * 0.05)));
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: BG } })
    .composite([{ input: dbuf, left: Math.round((w - d) / 2), top: Math.round((h - d) / 2) }])
    .png().toBuffer();
  const out = join(resDir, dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'splash.png'), buf);
}

console.log('OK: icon.ico, icon.png, PWA 192/512, mipmap x5 (square+round+foreground), splash x11');
