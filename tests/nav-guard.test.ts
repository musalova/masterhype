import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { allowedNavigation } from '../src/main/navGuard';

// Guardia will-navigate: la finestra col preload IPC può navigare solo dentro
// la directory del renderer (o sul dev-server). file:// generico aprirebbe
// file locali arbitrari e share UNC (file://host/share = remoto su Windows).
const RENDERER = join(process.cwd(), 'out', 'renderer');
const file = (p: string) => pathToFileURL(p).href;

describe('allowedNavigation — will-navigate', () => {
  it('permette il renderer stesso (index.html, hash, asset interni)', () => {
    expect(allowedNavigation(file(join(RENDERER, 'index.html')), RENDERER)).toBe(true);
    expect(allowedNavigation(file(join(RENDERER, 'index.html')) + '#/player', RENDERER)).toBe(true);
    expect(allowedNavigation(file(join(RENDERER, 'assets', 'app.js')), RENDERER)).toBe(true);
  });
  it('blocca file:// fuori dalla directory del renderer', () => {
    expect(allowedNavigation(file(join(RENDERER, '..', 'secret.html')), RENDERER)).toBe(false);
    // il confine è sul separatore: una dir "renderer-evil" non passa
    expect(allowedNavigation(file(join(RENDERER + '-evil', 'x.html')), RENDERER)).toBe(false);
    expect(allowedNavigation('file:///etc/passwd', RENDERER)).toBe(false);
  });
  it('blocca share UNC file://host/share', () => {
    expect(allowedNavigation('file://server/share/index.html', RENDERER)).toBe(false);
    expect(allowedNavigation('file://evil.example/x/payload.html', RENDERER)).toBe(false);
  });
  it('blocca schemi remoti e non-file', () => {
    expect(allowedNavigation('https://evil.example/', RENDERER)).toBe(false);
    expect(allowedNavigation('http://localhost:48484/', RENDERER)).toBe(false);
    expect(allowedNavigation('javascript:alert(1)', RENDERER)).toBe(false);
    expect(allowedNavigation('data:text/html,<b>x</b>', RENDERER)).toBe(false);
    expect(allowedNavigation('about:blank', RENDERER)).toBe(false);
  });
  it('URL non parsabile → bloccato', () => {
    expect(allowedNavigation('non un url', RENDERER)).toBe(false);
    expect(allowedNavigation('', RENDERER)).toBe(false);
  });
  it('dev-server permesso solo in sviluppo', () => {
    const dev = 'http://localhost:5173/';
    expect(allowedNavigation('http://localhost:5173/', RENDERER, dev)).toBe(true);
    expect(allowedNavigation('http://localhost:5173/src/main.tsx', RENDERER, dev)).toBe(true);
    expect(allowedNavigation('https://evil.example/', RENDERER, dev)).toBe(false);
  });
  it('drive letter minuscola resta permessa su Windows', () => {
    if (process.platform !== 'win32') return;
    const url = file(join(RENDERER, 'index.html')).replace(/^file:\/\/\/([A-Z])/, (m) => m.toLowerCase());
    expect(allowedNavigation(url, RENDERER)).toBe(true);
  });
});
