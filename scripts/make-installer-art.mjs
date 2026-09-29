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
const SRC = join(root, 'logo', 'Gemini_Generated_Image_phv873phv873phv8.jpg');
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
    <linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0" stop-color="#0a0c0d"/>
      <stop offset="0.55" stop-color="#0d1718"/>
      <stop offset="1" stop-color="#0f211e"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#ff9e3d"/>
    </linearGradient>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <!-- orbe neon sfocate -->
  <circle cx="140" cy="60" r="70" fill="#2dd4bf" opacity="0.30" filter="url(#soft)"/>
  <circle cx="10" cy="240" r="75" fill="#ff9e3d" opacity="0.26" filter="url(#soft)"/>
  <circle cx="120" cy="300" r="60" fill="#2dd4bf" opacity="0.10" filter="url(#soft)"/>
  <!-- griglia synthwave prospettica in basso -->
  <g opacity="0.35">
    <line x1="-40" y1="314" x2="60" y2="220" stroke="#2dd4bf" stroke-width="1" opacity="0.5"/>
    <line x1="10" y1="314" x2="75" y2="220" stroke="#2dd4bf" stroke-width="1" opacity="0.4"/>
    <line x1="60" y1="314" x2="88" y2="220" stroke="#ff9e3d" stroke-width="1" opacity="0.4"/>
    <line x1="110" y1="314" x2="102" y2="220" stroke="#ff9e3d" stroke-width="1" opacity="0.35"/>
    <line x1="160" y1="314" x2="116" y2="220" stroke="#2dd4bf" stroke-width="1" opacity="0.3"/>
    <line x1="0" y1="248" x2="164" y2="248" stroke="#2dd4bf" stroke-width="1" opacity="0.35"/>
    <line x1="0" y1="272" x2="164" y2="272" stroke="#ff9e3d" stroke-width="1" opacity="0.3"/>
    <line x1="0" y1="296" x2="164" y2="296" stroke="#2dd4bf" stroke-width="1" opacity="0.25"/>
  </g>
  <!-- forme geometriche wireframe -->
  <polygon points="20,200 42,238 -2,238" fill="none" stroke="#2dd4bf" stroke-width="1.5" opacity="0.55"/>
  <rect x="126" y="196" width="26" height="26" rx="4" fill="none" stroke="#ff9e3d" stroke-width="1.5" opacity="0.5" transform="rotate(14 139 209)"/>
  <circle cx="30" cy="90" r="16" fill="none" stroke="#2dd4bf" stroke-width="1.5" opacity="0.35"/>
  <!-- logo raster composto da sharp (76x76 a x44,y40) -->
  <text x="82" y="146" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
    font-size="19" font-weight="700" fill="#f2f2f8">Master<tspan fill="#ff9e3d">Hype</tspan></text>
  <text x="82" y="164" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
    font-size="9.5" fill="#a9c6c0">La tua musica, il tuo CD</text>
  <!-- equalizzatore neon -->
  <g transform="translate(58,180)" opacity="0.95">
    <rect x="0" y="8" width="5" height="12" rx="1.5" fill="url(#bar)"/>
    <rect x="9" y="0" width="5" height="20" rx="1.5" fill="url(#bar)"/>
    <rect x="18" y="5" width="5" height="15" rx="1.5" fill="url(#bar)"/>
    <rect x="27" y="2" width="5" height="18" rx="1.5" fill="url(#bar)"/>
    <rect x="36" y="10" width="5" height="10" rx="1.5" fill="url(#bar)"/>
  </g>
</svg>`;

// ── Header 150x57: discoteca scura, tile logo + wordmark ──
const headerSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <defs>
    <linearGradient id="hbg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#0d1617"/><stop offset="1" stop-color="#0f211e"/>
    </linearGradient>
    <filter id="hsoft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <rect width="150" height="57" fill="url(#hbg)"/>
  <circle cx="140" cy="8" r="34" fill="#2dd4bf" opacity="0.3" filter="url(#hsoft)"/>
  <circle cx="10" cy="52" r="30" fill="#ff9e3d" opacity="0.24" filter="url(#hsoft)"/>
  <!-- logo raster composto da sharp (40x40 a x55,y8) -->
  <text x="75" y="52" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
    font-size="8" font-weight="600" fill="#c4d8d3">MasterHype</text>
</svg>`;

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'installerSidebar.bmp'),
  await render(sidebarSvg, 164, 314, [{ input: await logoTile(76), left: 44, top: 40 }]));
writeFileSync(join(root, 'build', 'installerHeader.bmp'),
  await render(headerSvg, 150, 57, [{ input: await logoTile(40), left: 55, top: 8 }]));
console.log('OK installer art: sidebar + header');
