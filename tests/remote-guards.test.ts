import { describe, it, expect } from 'vitest';
import { sanitizeRemoteSettings, safeUploadName } from '../src/main/remoteGuards';
import { normalizeFeed, feedApkManifest } from '../src/shared/updateFeed';

// Un client col token (telefono, browser sulla LAN) non deve poter cambiare
// ciò che tocca il PC fisico: feed aggiornamenti (= EXE arbitrario installato),
// profilo del PC, server/token, cartella libreria, autostart.
describe('impostazioni da remoto', () => {
  it('rimuove le chiavi desktop-only e tiene le altre', () => {
    const out = sanitizeRemoteSettings({
      updateUrl: 'https://evil/x', autoUpdateApp: false, libraryDir: 'C:\\', currentUser: 2,
      remoteEnabled: false, remotePort: 1, remoteToken: 'x', autostart: false,
      audioQuality: '256', country: 'US',
    });
    expect(out).toEqual({ audioQuality: '256', country: 'US' });
  });
  it('input non-oggetto → patch vuota', () => {
    expect(sanitizeRemoteSettings(null)).toEqual({});
    expect(sanitizeRemoteSettings(['a'])).toEqual({});
    expect(sanitizeRemoteSettings('x')).toEqual({});
  });
});

describe('nome file upload dal telefono', () => {
  it('solo basename audio, niente traversal né caratteri riservati', () => {
    expect(safeUploadName('../../Windows/evil.mp3')).toBe('evil.mp3');
    expect(safeUploadName('C:\\x\\Vasco - Albachiara.flac')).toBe('Vasco - Albachiara.flac');
    expect(safeUploadName('a<b>:c.m4a')).toBe('abc.m4a');
    expect(safeUploadName('..mp3')).toBeNull();
    expect(safeUploadName('virus.exe')).toBeNull();
    expect(safeUploadName(42)).toBeNull();
  });
});

describe('feed aggiornamenti', () => {
  it('normalizza URL http(s) e rifiuta il resto', () => {
    expect(normalizeFeed(' https://srv.example/mh-8f3k/ ')).toBe('https://srv.example/mh-8f3k');
    expect(normalizeFeed('https://srv.example/a/?x=1#y')).toBe('https://srv.example/a');
    expect(normalizeFeed('file:///C:/x')).toBe('');
    expect(normalizeFeed('non un url')).toBe('');
    expect(normalizeFeed('')).toBe('');
  });
  it('manifest APK dentro il feed', () => {
    expect(feedApkManifest('https://s/x/')).toBe('https://s/x/app-update.json');
    expect(feedApkManifest('')).toBe('');
  });
});
