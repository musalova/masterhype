// Genera le bitmap NSIS brandizzate MasterHype:
//   build/installerSidebar.bmp  164x314 (colonna sinistra wizard)
//   build/installerHeader.bmp   150x57  (header wizard)
// Sfondo SVG rasterizzato via sharp + logo raster (logo/*.jpg) con angoli
// arrotondati -> RGBA raw -> BMP 24-bit manuale (sharp non scrive BMP).
// Uso: node scripts/make-installer-art.mjs

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'logo', 'masterhype.svg');
// Stesso crop di make-icon.mjs (centro ≈ (1046,1000), anello ≈ 82% del tile)
const TILE = { left: 266, top: 220, width: 1560, height: 1560 };

// BMP 24-bit non compresso (BITMAPFILEHEADER + BITMAPINFOHEADER, bottom-up BGR)
function rgbaToBmp24(rgba, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const px = Buffer.alloc(rowSize * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      const di = ((h - 1 - y) * rowSize) + x * 3;
      const a = rgba[si + 3] / 255;
      // compositing su nero (le bitmap NSIS non hanno alpha)
      px[di] = Math.round(rgba[si + 2] * a);     // B
      px[di + 1] = Math.round(rgba[si + 1] * a); // G
      px[di + 2] = Math.round(rgba[si] * a);     // R
    }
  }
  const out = Buffer.alloc(54 + px.length);
  out.write('BM'); out.writeUInt32LE(54 + px.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);          // info header size
  out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); // planes, bpp
  out.writeUInt32LE(0, 30);           // no compression
  out.writeUInt32LE(px.length, 34);
  out.writeInt32LE(2835, 38); out.writeInt32LE(2835, 42);
  px.copy(out, 54);
  return out;
}

// Logo come tile arrotondato (rx ~22% stile iOS), bordo netto.
async function logoTile(size) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#fff"/>
    </svg>`);
  return sharp(SRC).extract(TILE).resize(size, size, { kernel: 'lanczos3' })
    .composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

// Rasterizza l'SVG di sfondo e compone i layer extra (es. il logo raster).
// layers: [{ input, left, top }]
async function render(svg, w, h, layers = []) {
  const { data, info } = await sharp(Buffer.from(svg), { density: 300 })
    .resize(w, h).composite(layers).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return rgbaToBmp24(data, info.width, info.height);
}

// ── Sidebar 164x314: discoteca — orbe neon, griglia synthwave, forme wireframe ──
const sidebarSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#172b2e"/><stop offset=".55" stop-color="#10191c"/><stop offset="1" stop-color="#090e10"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#79e2cb"/><stop offset="1" stop-color="#efb18a"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="22"/></filter>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <!-- orbe neon sfocate -->
  <circle cx="135" cy="25" r="70" fill="#79e2cb" opacity=".08" filter="url(#soft)"/>
  <!-- griglia synthwave prospettica in basso -->
  <path d="M22 241h120" stroke="#79e2cb" stroke-opacity=".2" stroke-width=".5"/>
  <!-- forme geometriche wireframe -->
  <g fill="none" stroke="#79e2cb" stroke-width=".5">
    <circle cx="159" cy="320" r="62" opacity=".18"/><circle cx="159" cy="320" r="84" opacity=".14"/>
    <circle cx="159" cy="320" r="106" opacity=".1"/><circle cx="159" cy="320" r="128" opacity=".07"/>
  </g>
  <!-- logo raster composto da sharp (76x76 a x44,y40) -->
  <text x="22" y="139" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="600" letter-spacing="-.7" fill="#f2f6f5">Master<tspan fill="#79e2cb">Hype</tspan></text>
  <text x="22" y="164" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#f2f6f5">Musica,</text>
  <text x="22" y="181" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#f2f6f5">a modo tuo.</text>
  <text x="22" y="210" font-family="Segoe UI, Arial, sans-serif" font-size="8" fill="#a5b7b7">Scopri. Ascolta. Porta con te.</text>
  <text x="22" y="261" font-family="Segoe UI, Arial, sans-serif" font-size="7" letter-spacing="1.3" fill="#a5b7b7">PC / TELEFONO / CD</text>
  <!-- equalizzatore neon -->
  <rect x="22" y="284" width="28" height="2" rx="1" fill="url(#bar)"/>
  <text x="22" y="302" font-family="Segoe UI, Arial, sans-serif" font-size="6.5" letter-spacing="1" fill="#a5b7b7">IL TUO UNIVERSO MUSICALE</text>
</svg>`;

// ── Header 150x57: discoteca scura, tile logo + wordmark ──
const headerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <defs>
    <linearGradient id="hbg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#10191c"/><stop offset="1" stop-color="#1b3034"/>
    </linearGradient>
    <filter id="hsoft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="150" height="57" fill="url(#hbg)"/>
  <circle cx="148" cy="6" r="34" fill="none" stroke="#79e2cb" stroke-opacity=".15"/>
  <circle cx="148" cy="6" r="47" fill="none" stroke="#79e2cb" stroke-opacity=".08"/>
  <!-- logo raster composto da sharp (40x40 a x55,y8) -->
  <text x="52" y="27" font-family="Segoe UI, Arial, sans-serif"
    font-size="12" font-weight="600" letter-spacing="-.4" fill="#f2f6f5">Master<tspan fill="#79e2cb">Hype</tspan></text>
  <text x="52" y="39" font-family="Segoe UI, Arial, sans-serif" font-size="6.5" fill="#a5b7b7">Musica, a modo tuo.</text>
</svg>`;

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'installerSidebar.bmp'),
  await render(sidebarSvg, 164, 314, [{ input: await logoTile(76), left: 22, top: 28 }]));
writeFileSync(join(root, 'build', 'installerHeader.bmp'),
  await render(headerSvg, 150, 57, [{ input: await logoTile(38), left: 8, top: 9 }]));
console.log('OK installer art: sidebar + header');
