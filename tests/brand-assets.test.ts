import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const file = (path: string) => new URL(`../${path}`, import.meta.url);
const image = (path: string) => sharp(readFileSync(file(path))).metadata();

describe('MasterHype brand assets', () => {
  it.each([192, 512])('ships the %ipx app icon rendered from the vector master', async (size) => {
    const actual = readFileSync(file(`src/renderer/public/icon-${size}.png`));
    const expected = await sharp(readFileSync(file('logo/masterhype.svg')))
      .extract({ left: 266, top: 220, width: 1560, height: 1560 })
      .resize(size, size, { kernel: 'lanczos3' }).png().toBuffer();
    expect(actual.equals(expected)).toBe(true);
  });
  it('provides all Windows icon sizes with valid PNG entries', async () => {
    const ico = readFileSync(file('build/icon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(6);
    for (const [i, size] of [256, 64, 48, 32, 24, 16].entries()) {
      const entry = 6 + i * 16;
      const length = ico.readUInt32LE(entry + 8);
      const start = ico.readUInt32LE(entry + 12);
      expect(start + length).toBeLessThanOrEqual(ico.length);
      const meta = await sharp(ico.subarray(start, start + length)).metadata();
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
  });
  it.each([['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]] as const)('provides Android %s icons and transparent adaptive foreground', async (density, size, foreground) => {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const meta = await image(`android/app/src/main/res/mipmap-${density}/${name}.png`);
      expect([meta.width, meta.height]).toEqual([size, size]);
    }
    const meta = await image(`android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`);
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([foreground, foreground, true]);
  });
  it.each([['installerSidebar', 164, 314], ['installerHeader', 150, 57]] as const)('provides valid 24-bit %s art for NSIS', (name, width, height) => {
    const bmp = readFileSync(file(`build/${name}.bmp`));
    expect(bmp.subarray(0, 2).toString()).toBe('BM');
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect([bmp.readInt32LE(18), bmp.readInt32LE(22), bmp.readUInt16LE(28)]).toEqual([width, height, 24]);
  });
});
