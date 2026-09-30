// Aspetto (palette accent + animazioni): letto al boot da persist (già idratato
// dal server) e riapplicato quando la preferenza cambia — anche da un altro
// dispositivo via 'mh-pref-live'. Le palette vivono in index.css (data-accent).
import { loadPref } from './persist';

export type AccentId = 'sunset' | 'ocean' | 'lime' | 'violet' | 'gold' | 'mono' | 'rose' | 'ember' | 'midnight';
export const ACCENT_KEY = 'mh-pref-accent';
export const MOTION_KEY = 'mh-pref-motion';

export const ACCENTS: { id: AccentId; name: string; desc: string }[] = [
  { id: 'sunset', name: 'Signature', desc: 'Ossidiana, menta e rame' },
  { id: 'ocean', name: 'Abissi', desc: 'Blu profondo, luce di ghiaccio' },
  { id: 'lime', name: 'Aurora', desc: 'Verde boreale, riflessi giada' },
  { id: 'violet', name: 'Nebula', desc: 'Viola vellutato e orchidea' },
  { id: 'gold', name: 'Champagne', desc: 'Toni caldi, dettagli dorati' },
  { id: 'mono', name: 'Graphite', desc: 'Nero e argento, solo l’essenziale' },
  { id: 'rose', name: 'Sakura', desc: 'Rosa cipria su prugna scuro' },
  { id: 'ember', name: 'Terracotta', desc: 'Rame, ambra e terra bruciata' },
  { id: 'midnight', name: 'Blue Hour', desc: 'Indaco notturno e pervinca' },
];

export function applyAppearance(accent?: string, motion?: string): void {
  const root = document.documentElement;
  root.dataset.accent = ACCENTS.some((a) => a.id === accent) ? accent! : 'sunset';
  root.dataset.motion = motion === 'off' ? 'off' : 'on';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', getComputedStyle(root).getPropertyValue('--color-bg').trim());
}

// Boot + live: applica subito e resta in ascolto dei cambi (locale o remoto)
export function initAppearance(): void {
  const apply = () => applyAppearance(loadPref<string>(ACCENT_KEY, 'sunset'), loadPref<string>(MOTION_KEY, 'on'));
  apply();
  window.addEventListener('mh-pref-live', apply);
}
