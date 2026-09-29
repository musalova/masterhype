import { describe, it, expect } from 'vitest';
import { sanitizeRemoteSettings, safeUploadName, redactRemoteSettings, REDACTED } from '../src/main/remoteGuards';
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
  it('il placeholder redatto non sovrascrive il segreto vero', () => {
    // La UI salva i campi così come li riceve: '••••••••' strippato in
    // scrittura o il remoteToken vero diventerebbe il placeholder.
    const out = sanitizeRemoteSettings({
      spotifyClientSecret: REDACTED, lastfmApiKey: REDACTED,
      spotifyClientId: 'nuovo-id', country: 'IT',
    });
    expect(out).toEqual({ spotifyClientId: 'nuovo-id', country: 'IT' });
  });
});

describe('settings:get verso i remoti — redazione segreti', () => {
  const s = {
    remoteToken: 'abc123XYZ', spotifyClientSecret: 'sec', spotifyRefreshToken: 'rt',
    lastfmApiKey: 'lfm', spotifyClientId: 'pub-id', audioQuality: '320', country: 'IT',
  };
  it('i segreti diventano placeholder, il resto passa intero', () => {
    const out = redactRemoteSettings(s) as Record<string, unknown>;
    expect(out.remoteToken).toBe(REDACTED);
    expect(out.spotifyClientSecret).toBe(REDACTED);
    expect(out.spotifyRefreshToken).toBe(REDACTED);
    expect(out.lastfmApiKey).toBe(REDACTED);
    expect(out.spotifyClientId).toBe('pub-id'); // client id non è un segreto
    expect(out.audioQuality).toBe('320');
    expect(s.remoteToken).toBe('abc123XYZ'); // l'originale non viene toccato
  });
  it('campo segreto vuoto resta vuoto (non "valorizzato" finto)', () => {
    const out = redactRemoteSettings({ ...s, lastfmApiKey: '' }) as Record<string, unknown>;
    expect(out.lastfmApiKey).toBe('');
  });
  it('input non-oggetto passa invariato', () => {
    expect(redactRemoteSettings(null)).toBe(null);
    expect(redactRemoteSettings('x')).toBe('x');
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
