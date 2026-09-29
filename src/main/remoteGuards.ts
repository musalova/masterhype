// Guardie pure (niente electron) del server remoto — testabili in vitest.

// Impostazioni modificabili SOLO dal desktop: toccano il PC fisico o la sua
// sicurezza. updateUrl da remoto = il PC installerebbe un EXE arbitrario;
// currentUser aggirerebbe users:setCurrent; token/porta/server staccherebbero
// gli altri dispositivi; libraryDir farebbe scrivere file ovunque.
export const DESKTOP_ONLY_SETTINGS = [
  'updateUrl', 'autoUpdateApp', 'libraryDir', 'currentUser',
  'remoteEnabled', 'remotePort', 'remoteToken', 'autostart',
  'keepAwake', // tocca lo stato fisico del PC: un device remoto non decide la sospensione
] as const;

// Credenziali che non devono MAI lasciare il PC via API remota: remoteToken è
// la credenziale admin (chi la legge scala a admin), le chiavi Spotify/Last.fm
// sono segreti dell'account. Un device token qualunque leggeva settings:get
// completo → privilege escalation totale.
export const SECRET_SETTINGS = [
  'remoteToken', 'spotifyClientSecret', 'spotifyRefreshToken', 'lastfmApiKey',
] as const;

// Placeholder mostrato al posto del segreto: la UI salva i campi così come li
// riceve → in scrittura va strippato o sovrascriverebbe il segreto vero.
export const REDACTED = '••••••••';

// Copia delle Settings per un chiamante remoto (qualsiasi livello: anche un
// telefono autenticato col codice admin non deve ritrovarselo in localStorage).
export function redactRemoteSettings(s: unknown): unknown {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const out: Record<string, unknown> = { ...(s as Record<string, unknown>) };
  for (const k of SECRET_SETTINGS) if (typeof out[k] === 'string' && out[k]) out[k] = REDACTED;
  return out;
}

export function sanitizeRemoteSettings(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const out: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const k of DESKTOP_ONLY_SETTINGS) delete out[k];
  // Il placeholder redatto non è un valore: ignorarlo (senza, un salva-
  // impostazioni dal telefono sovrascriverebbe il segreto vero con '••••').
  for (const k of SECRET_SETTINGS) if (out[k] === REDACTED) delete out[k];
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
