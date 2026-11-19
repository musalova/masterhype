import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { randomBytes } from 'crypto';
import type { Settings } from '../shared/types';
import { writeFileAtomic, readJsonWithBackup, snapshotBackup } from './fsAtomic';

let settings: Settings;

const defaults = (): Settings => ({
  libraryDir: join(app.getPath('music'), 'MasterHype'),
  audioQuality: '320',
  normalizeAudio: true,
  // OFF di default: il trim è distruttivo (cuoce silenceremove nel file e può
  // tagliare intro voluti); i gap dei CD audio li gestisce il burning.
  trimSilence: false,
  burnSpeed: 0,
  country: 'IT',
  lastfmApiKey: '',
  spotifyClientId: '',
  spotifyClientSecret: '',
  spotifyConnected: false,
  spotifyRefreshToken: '',
  autoUpdateTools: true,
  remoteEnabled: true,
  remoteToken: '',
  remotePort: 48484,
  keepAwake: true, // il PC è il server di casa: non deve dormire mentre serve
  autostart: true, // il telefono dipende dal server del PC: avvia con Windows
  currentUser: 1,  // profilo attivo sul PC (creato dalla migrazione in db.ts)
  updateUrl: '',   // feed aggiornamenti (EXE + APK): vuoto = DEFAULT_UPDATE_FEED
  autoUpdateApp: true,
});

// Whitelist sulle chiavi di defaults(): un patch con chiavi arbitrarie (da
// remoto il body arriva a ~5MB) si annidava in settings.json e il file —
// riscritto interamente a ogni salvataggio — cresceva per sempre. Il filtro
// vale anche per il file letto al boot: le chiavi piantate in passato muoiono
// al primo avvio.
let knownKeys: Set<string> | undefined;
const pickKnown = (obj: unknown): Partial<Settings> => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  knownKeys ??= new Set(Object.keys(defaults()));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) if (knownKeys.has(k)) out[k] = (obj as Record<string, unknown>)[k];
  return out as Partial<Settings>;
};

export function initSettings(): Settings {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  // File corrotto (blackout a metà scrittura, disco pieno): si ripiega sulla
  // copia dell'ultimo avvio riuscito invece di azzerare tutto — cartella
  // libreria, chiavi Spotify/Last.fm e codice del PC sopravvivono.
  const loaded = readJsonWithBackup<unknown>(file);
  const saved = loaded && loaded.value && typeof loaded.value === 'object' && !Array.isArray(loaded.value)
    ? loaded.value as Partial<Settings> : {};
  settings = { ...defaults(), ...pickKnown(saved) };
  if (loaded?.fromBackup) writeFileAtomic(file, JSON.stringify(settings, null, 2)); // ripara il principale
  else if (loaded) snapshotBackup(file);
  // Un disco removibile sparito non deve impedire l'avvio dell'app
  try { mkdirSync(settings.libraryDir, { recursive: true }); } catch { /* drive mancante */ }
  // Token di pairing per il server LAN: generato una volta, poi stabile
  if (!settings.remoteToken) {
    settings.remoteToken = randomBytes(6).toString('base64url'); // 8 caratteri, leggibile
    writeFileAtomic(file, JSON.stringify(settings, null, 2));
  }
  return settings;
}

export function getSettings(): Settings {
  return settings;
}

// Notifica i cambi di impostazioni (es. restart del server remoto al toggle)
export let onSettingsChanged: (patch: Partial<Settings>) => void = () => {};
export function setSettingsChangedHook(fn: (patch: Partial<Settings>) => void): void {
  onSettingsChanged = fn;
}

export function setSettings(patch: Partial<Settings>): Settings {
  const clean = pickKnown(patch);
  if (!Object.keys(clean).length) return settings; // solo chiavi ignote: niente da salvare
  settings = { ...settings, ...clean };
  writeFileAtomic(join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2));
  // Drive removibile assente: non deve far fallire il salvataggio delle altre opzioni
  if (clean.libraryDir) try { mkdirSync(settings.libraryDir, { recursive: true }); } catch { /* */ }
  try { onSettingsChanged(clean); } catch { /* hook non deve rompere il salvataggio */ }
  return settings;
}
