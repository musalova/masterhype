import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const file = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(file(path), 'utf8');

// CSP del renderer: i download sul telefono vivono in IndexedDB e arrivano alla
// UI come object URL blob: (copertine in <img>, fallback audio in <audio>,
// anteprima durata degli import). 'self' NON copre mai blob: — se le direttive
// lo perdono si rompono cover e playback offline senza alcun errore visibile.
function csp(): Map<string, string[]> {
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(read('src/renderer/index.html'))?.[1] ?? '';
  return new Map(
    meta.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p.length > 1)
      .map((p) => [p[0], p.slice(1)]),
  );
}

describe('renderer Content-Security-Policy', () => {
  it.each(['img-src', 'media-src'])('allows blob: in %s for IndexedDB phone media', (directive) => {
    expect(csp().get(directive)).toContain('blob:');
  });
});

describe('phone audio service-worker route', () => {
  it('phoneLocal builds an absolute /__phone/<id> URL handled by sw.js', () => {
    const src = read('src/renderer/src/phoneLocal.ts');
    expect(src).toContain('`/__phone/${id}`'); // path assoluto: '/__pc/*' style, immune al baseURI della pagina
    expect(src).not.toMatch(/\?\s+`__phone\//); // mai relativo
    expect(read('src/renderer/public/sw.js')).toContain("'/__phone/'");
  });
});
