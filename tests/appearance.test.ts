import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const prefs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../src/renderer/src/persist', () => ({ loadPref: (k: string, fallback: unknown) => prefs.get(k) ?? fallback }));
import { ACCENTS, ACCENT_KEY, MOTION_KEY, applyAppearance, initAppearance } from '../src/renderer/src/appearance';

const css = readFileSync(new URL('../src/renderer/src/index.css', import.meta.url), 'utf8');
const colors = (id: string) => {
  const block = css.match(new RegExp(`\\[data-accent='${id}'\\]\\s*\\{([^}]+)\\}`))?.[1] ?? '';
  return Object.fromEntries([...block.matchAll(/--color-([\w]+):\s*(#[\da-f]{6})/g)].map((m) => [m[1], m[2]]));
};
const luminance = (hex: string) => {
  const rgb = hex.slice(1).match(/../g)!.map((c) => parseInt(c, 16) / 255).map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

beforeEach(() => {
  prefs.clear();
  vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelector: () => null });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe('complete appearance themes', () => {
  it('provides nine unique themes while retaining existing preference IDs', () => {
    expect(new Set(ACCENTS.map((a) => a.id)).size).toBe(9);
    expect(ACCENTS.map((a) => a.id)).toEqual(expect.arrayContaining(['sunset', 'ocean', 'lime', 'violet', 'gold', 'mono']));
  });
  it.each(ACCENTS)('$name defines surfaces and readable foregrounds', ({ id }) => {
    const palette = colors(id);
    for (const key of ['bg', 'panel', 'panel2', 'line', 'txt', 'dim', 'accent', 'accent2']) expect(palette[key], `${id}: ${key}`).toBeTruthy();
    for (const surface of ['bg', 'panel', 'panel2']) {
      expect(contrast(palette.txt, palette[surface])).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.dim, palette[surface])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.accent, palette[surface])).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast('#091112', palette.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#091112', palette.accent2)).toBeGreaterThanOrEqual(4.5);
  });
  it('falls back safely for unknown persisted values', () => {
    applyAppearance('invalid', 'invalid');
    expect(document.documentElement.dataset).toMatchObject({ accent: 'sunset', motion: 'on' });
  });
  it('applies all themes without reload', () => {
    for (const { id } of ACCENTS) {
      applyAppearance(id, 'off');
      expect(document.documentElement.dataset).toMatchObject({ accent: id, motion: 'off' });
    }
  });
  it('applies preferences at boot and on profile preference updates', () => {
    prefs.set(ACCENT_KEY, 'ocean');
    initAppearance();
    expect(document.documentElement.dataset.accent).toBe('ocean');
    prefs.set(ACCENT_KEY, 'violet');
    prefs.set(MOTION_KEY, 'off');
    window.dispatchEvent(new Event('mh-pref-live'));
    expect(document.documentElement.dataset).toMatchObject({ accent: 'violet', motion: 'off' });
  });
});
