import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const file = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(file(path), 'utf8');

// Copertine sui surface di sistema — due bug storici, un contratto ciascuno:
//  A) Android: PlaybackService (processo app, fuori dalla WebView) scarica
//     l'artwork con new URL(...): un path RELATIVO '/__pc/media/cover/<id>'
//     (prodotto da mediaUrl quando il SW controlla la pagina) lanciava
//     MalformedURLException silenziata → lockscreen/autoradio senza copertina.
//  B) Windows desktop: MediaImage.src accetta solo http/https/data/blob —
//     'media://cover/<id>' veniva rifiutato → overlay multimediale senza
//     copertina. La cover arriva come data: URI via IPC lib:cover
//     (fetch('media://') è vietato dal connect-src della CSP).
describe('artwork media session (lockscreen Android / overlay Windows)', () => {
  it('nativeMedia assolutizza /__pc/ e media:// verso il PC con ?token=', () => {
    const src = read('src/renderer/src/nativeMedia.ts');
    expect(src).toContain("u.startsWith('/__pc/')");
    expect(src).toContain("u.startsWith('media://')");
    expect(src).toContain('remoteBase()');
    expect(src).toContain('encodeURIComponent(token)');
  });

  it('nativeMedia passa la copertina telefono come data: URI (artPhoneId)', () => {
    const src = read('src/renderer/src/nativeMedia.ts');
    expect(src).toContain('artPhoneId');
    expect(src).toContain('phoneCoverDataUrl');
    const pl = read('src/renderer/src/phoneLocal.ts');
    expect(pl).toContain('readAsDataURL');   // blob IndexedDB → data: URI
    expect(pl).toContain('PHONE_ART_MAX_BYTES'); // tetto binder ~1MB sugli extra
  });

  it('PlaybackService decodifica le data: URI e scarica solo URL assoluti', () => {
    const src = read('android/app/src/main/java/com/masterhype/app/PlaybackService.java');
    expect(src).toContain('u.startsWith("data:")');
    expect(src).toContain('Base64.decode');
    expect(src).toContain('new URL(u)');
  });

  it('MediaMetadata.artwork non riceve più media:// (desktop → lib:cover data: URI)', () => {
    const pb = read('src/renderer/src/components/PlayerBar.tsx');
    expect(pb).toContain("art?.startsWith('media://cover/')");
    expect(pb).toContain('coverData');
    // il canale esiste su tutta la catena IPC: mappa condivisa + preload + mirror remoto
    expect(read('src/shared/types.ts')).toContain("libraryCover:");
    expect(read('src/main/handlers.ts')).toContain('[IPC.libraryCover]');
    expect(read('src/preload/index.ts')).toContain('coverData');
    expect(read('src/renderer/src/remoteApi.ts')).toContain('coverData');
  });

  it('PlayerBar passa artPhoneId per le tracce scaricate sul telefono', () => {
    const pb = read('src/renderer/src/components/PlayerBar.tsx');
    expect(pb).toContain('artPhoneId');
    expect(pb).toContain('phoneVidId');
  });
});
