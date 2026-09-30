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

beforeEach(() => {
  prefs.clear();
  vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelector: () => null });
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => vi.unstubAllGlobals());

describe('appearance themes', () => {
  it('provides the six classic themes', () => {
    expect(ACCENTS.map((a) => a.id)).toEqual(['sunset', 'ocean', 'lime', 'violet', 'gold', 'mono']);
  });
  it.each(ACCENTS)('$name defines matching swatch and CSS colors', ({ id, c1, c2 }) => {
    const palette = colors(id);
    expect(palette.accent).toBe(c1);
    expect(palette.accent2).toBe(c2);
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
