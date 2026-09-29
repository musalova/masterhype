// "Novità" post-aggiornamento: bullet per versione, in italiano semplice
// (niente tecnicismi). Unica fonte di verità: la card del renderer li mostra
// una volta dopo ogni update e build-android.mjs li scrive in app-update.json
// (campo notes) per mostrarli anche prima dell'installazione.
// REGOLA: a ogni bump di versione aggiungere una voce qui — altrimenti la
// card mostra il testo generico.
import notes from './whatsnew.json';

export const WHATS_NEW = notes as Record<string, string[]>;

const FALLBACK = ['Miglioramenti interni e correzioni di stabilità.'];

// Bullet per una versione (versionName, es. '0.4.2'); mai vuoto.
export function whatsNewFor(version: string): string[] {
  const n = WHATS_NEW[version];
  return n && n.length ? n : FALLBACK;
}
