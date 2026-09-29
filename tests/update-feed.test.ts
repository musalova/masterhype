import { describe, it, expect } from 'vitest';
import { normalizeFeed, feedUrlAllowed, feedApkManifest, DEFAULT_UPDATE_FEED } from '../src/shared/updateFeed';

// Policy del feed aggiornamenti: https sempre, http solo su loopback.
// Un feed http:// su rete vera è impersonabile da MITM — gli hash degli
// artifact arriverebbero dalla stessa fonte compromessa.
describe('normalizeFeed', () => {
  it('https valido → normalizzato senza slash finale', () => {
    expect(normalizeFeed('https://example.com/mh/')).toBe('https://example.com/mh');
    expect(normalizeFeed('https://example.com')).toBe('https://example.com');
  });

  it('strip di query e hash', () => {
    expect(normalizeFeed('https://example.com/feed?x=1#frag')).toBe('https://example.com/feed');
  });

  it('http su rete vera → rifiutato (MITM: l\'hash arriverebbe dalla stessa fonte)', () => {
    expect(normalizeFeed('http://example.com/feed')).toBe('');
    expect(normalizeFeed('http://192.168.1.50:8080/feed')).toBe('');
    expect(normalizeFeed('http://10.0.0.2/')).toBe('');
  });

  it('http su loopback → consentito (test/dev)', () => {
    expect(normalizeFeed('http://localhost:8080/feed')).toBe('http://localhost:8080/feed');
    expect(normalizeFeed('http://127.0.0.1:48484')).toBe('http://127.0.0.1:48484');
    expect(normalizeFeed('http://[::1]:9000')).toBe('http://[::1]:9000');
  });

  it('protocolli non-http / invalidi → vuoto', () => {
    expect(normalizeFeed('file:///etc/passwd')).toBe('');
    expect(normalizeFeed('ftp://x/feed')).toBe('');
    expect(normalizeFeed('javascript:alert(1)')).toBe('');
    expect(normalizeFeed('non-un-url')).toBe('');
    expect(normalizeFeed('')).toBe('');
    expect(normalizeFeed(undefined)).toBe('');
    expect(normalizeFeed(null)).toBe('');
  });
});

describe('feedUrlAllowed (usata anche sugli URL manifest manuali)', () => {
  it('https sempre ok', () => {
    expect(feedUrlAllowed('https://github.com/x/releases/latest/download/app-update.json')).toBe(true);
  });
  it('http non-loopback rifiutato', () => {
    expect(feedUrlAllowed('http://evil.lan/app-update.json')).toBe(false);
  });
  it('http loopback ok', () => {
    expect(feedUrlAllowed('http://localhost:9999/app-update.json')).toBe(true);
  });
});

describe('feedApkManifest', () => {
  it('appende app-update.json al feed valido', () => {
    expect(feedApkManifest('https://x.example/mh'))
      .toBe('https://x.example/mh/app-update.json');
    expect(feedApkManifest(DEFAULT_UPDATE_FEED))
      .toBe(`${DEFAULT_UPDATE_FEED}/app-update.json`);
  });
  it('feed http non fidato → stringa vuota (nessuna sorgente)', () => {
    expect(feedApkManifest('http://lan-pc:48484')).toBe('');
  });
});
