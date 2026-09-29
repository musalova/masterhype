// Aspetto (palette accent + animazioni): letto al boot da persist (già idratato
// dal server) e riapplicato quando la preferenza cambia — anche da un altro
// dispositivo via 'mh-pref-live'. Le palette vivono in index.css (data-accent).
import { loadPref } from './persist';

export type AccentId = 'sunset' | 'ocean' | 'lime' | 'violet' | 'gold' | 'mono';
export const ACCENT_KEY = 'mh-pref-accent';
export const MOTION_KEY = 'mh-pref-motion';

export const ACCENTS: { id: AccentId; name: string; c1: string; c2: string }[] = [
  { id: 'sunset', name: 'Neon', c1: '#2dd4bf', c2: '#ff9e3d' },
  { id: 'ocean', name: 'Oceano', c1: '#38bdf8', c2: '#6366f1' },
  { id: 'lime', name: 'Lime', c1: '#4ade80', c2: '#22d3ee' },
  { id: 'violet', name: 'Viola', c1: '#a78bfa', c2: '#f472b6' },
  { id: 'gold', name: 'Oro', c1: '#fbbf24', c2: '#fb7185' },
  { id: 'mono', name: 'Mono', c1: '#f5f5f5', c2: '#a3a3a3' },
];

export function applyAppearance(accent?: string, motion?: string): void {
  const root = document.documentElement;
  root.dataset.accent = ACCENTS.some((a) => a.id === accent) ? accent! : 'sunset';
  root.dataset.motion = motion === 'off' ? 'off' : 'on';
}

// Boot + live: applica subito e resta in ascolto dei cambi (locale o remoto)
export function initAppearance(): void {
  const apply = () => applyAppearance(loadPref<string>(ACCENT_KEY, 'sunset'), loadPref<string>(MOTION_KEY, 'on'));
  apply();
  window.addEventListener('mh-pref-live', apply);
}
