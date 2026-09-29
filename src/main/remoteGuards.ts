// Guardie pure (niente electron) del server remoto — testabili in vitest.

// Impostazioni modificabili SOLO dal desktop: toccano il PC fisico o la sua
// sicurezza. updateUrl da remoto = il PC installerebbe un EXE arbitrario;
// currentUser aggirerebbe users:setCurrent; token/porta/server staccherebbero
// gli altri dispositivi; libraryDir farebbe scrivere file ovunque.
export const DESKTOP_ONLY_SETTINGS = [
  'updateUrl', 'autoUpdateApp', 'libraryDir', 'currentUser',
  'remoteEnabled', 'remotePort', 'remoteToken', 'autostart',
] as const;

export function sanitizeRemoteSettings(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const out: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const k of DESKTOP_ONLY_SETTINGS) delete out[k];
  return out;
}

// Nome file di un upload dal telefono: solo il basename, estensione audio
// ammessa, caratteri riservati di Windows rimossi. null = rifiutato.
const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus|webm|wma)$/i;
export function safeUploadName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[<>:"|?*\x00-\x1f]/g, '').replace(/^\.+/, '').trim().slice(0, 150);
  return clean && AUDIO_EXT.test(clean) ? clean : null;
}
