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
  settings = { ...defaults(), ...saved };
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
  settings = { ...settings, ...patch };
  writeFileAtomic(join(app.getPath('userData'), 'settings.json'), JSON.stringify(settings, null, 2));
  // Drive removibile assente: non deve far fallire il salvataggio delle altre opzioni
  if (patch.libraryDir) try { mkdirSync(settings.libraryDir, { recursive: true }); } catch { /* */ }
  try { onSettingsChanged(patch); } catch { /* hook non deve rompere il salvataggio */ }
  return settings;
}
