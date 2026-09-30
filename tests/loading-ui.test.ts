import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../src/renderer/src/store', () => ({ useApp: vi.fn() }));
vi.mock('../src/renderer/src/api', () => ({ api: vi.fn() }));
import { CenterLoader, LoadingState, ScreenLoader } from '../src/renderer/src/components/common';
import type { Screen } from '../src/renderer/src/store';

const render = (props: Parameters<typeof LoadingState>[0]) => renderToStaticMarkup(createElement(LoadingState, props));

describe('loading feedback', () => {
  it('announces the operation and renders decorative placeholders', () => {
    const html = render({ label: 'Cerco la tua musica…', detail: 'U2', n: 3 });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Cerco la tua musica…');
    expect(html).toContain('U2');
    expect(html.match(/class="skeleton /g)).toHaveLength(12);
    expect(html).not.toContain('aria-valuenow');
    expect(html).not.toContain('Annulla');
  });
  it('offers cancellation only when supported by the operation', () => {
    expect(render({ label: 'Cerco…', onCancel: () => {} })).toContain('Annulla');
  });
  it.each(['inline', 'center'] as const)('%s feedback has no list placeholders', (layout) => {
    expect(render({ label: 'Preparo…', layout })).not.toContain('class="skeleton ');
  });
  it('provides a labelled loader when no label is passed', () => {
    expect(renderToStaticMarkup(createElement(CenterLoader))).toContain('Preparo il tuo spazio musicale…');
  });
  it.each(['home', 'search', 'stations', 'library', 'playlists', 'cd', 'trends', 'assistant', 'downloads', 'settings'] as Screen[])('labels the %s lazy screen fallback', (screen) => {
    const html = renderToStaticMarkup(createElement(ScreenLoader, { screen }));
    expect(html).toContain('role="status"');
    expect(html).toContain('data-loading="true"');
  });
});
