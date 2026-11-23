import { Capacitor, registerPlugin } from '@capacitor/core';
import { useApp } from './store';
import { remoteBase, remoteToken } from './remote';
import { phoneCoverDataUrl } from './phoneLocal';

// Bridge verso il plugin nativo MediaSession (PlaybackService foreground):
// su Android la riproduzione <audio> della WebView sopravvive a schermo
// spento/app in background (il servizio tiene il processo in foreground)
// e i controlli di sistema — notifica, lockscreen, Bluetooth, auricolari —
// comandano il player come fanno tray e Media Session su desktop.
// Fuori dall'APK tutto è no-op.

export interface MediaSessionState {
  title: string;
  artist: string;
  album?: string;
  artUrl?: string;
  // Traccia scaricata sul telefono (id libreria >0 o sintetico <0): la sua
  // copertina IndexedDB viene serializzata in data: URI — funziona anche a
  // PC spento / in modalità autonoma, dove /media/cover non esiste.
  artPhoneId?: number;
  videoId?: string;
  playing: boolean;
  durationMs?: number;
  positionMs?: number;
}

interface MediaSessionPlugin {
  updateSession(s: MediaSessionState): Promise<void>;
  stopSession(): Promise<void>;
  resumeState(): Promise<{ crashed: boolean; playing: boolean; videoId?: string; title?: string; artist?: string; positionMs?: number }>;
  addListener(ev: 'action', cb: (e: { action: string; positionMs?: number; mediaId?: string }) => void): Promise<{ remove: () => void }>;
}

const native = Capacitor.isNativePlatform();
const plugin = native ? registerPlugin<MediaSessionPlugin>('MediaSession') : null;
let armed = false;

// Chiamata una volta all'avvio (App.tsx): le azioni della notifica/lockscreen
// diventano le stesse azioni del player usate da tasti multimediali e tray.
export function initNativeMedia(): void {
  if (!plugin || armed) return;
  armed = true;
  void plugin.addListener('action', (e) => {
    const s = useApp.getState();
    switch (e.action) {
      case 'toggle': s.toggle(); break;
      case 'play': if (!s.player.playing) s.toggle(); break;
      case 'pause': case 'stop': if (s.player.playing) s.toggle(); break;
      case 'next': s.next(); break;
      case 'prev': s.prev(); break;
      case 'seek':
        // Il seek lo esegue PlayerBar sull'elemento <audio> attivo
        if (e.positionMs != null) window.dispatchEvent(new CustomEvent('mh-media-seek', { detail: e.positionMs }));
        break;
      case 'auto-play':
        // Android Auto: mediaId dal browse nativo → lo risolve nativeAuto
        if (e.mediaId) void import('./nativeAuto').then((m) => m.autoPlayNow(e.mediaId!));
        break;
    }
  });
}

// Il servizio nativo è FUORI dalla WebView: niente service worker né fetch
// del renderer. Il suo HttpURLConnection accetta solo URL ASSOLUTI http(s)
// — un path '/__pc/…' dava MalformedURLException silenziata → lockscreen e
// autoradio senza copertina su QUALUNQUE brano di libreria (bug storico).
// → lo risolviamo qui alla forma del fallback senza SW: base + ?token=
//   (l'URL vive solo nell'Intent di processo, mai in cronologia/Referer).
// → 'data:' URI passano così come sono (il servizio le decodifica in Java).
function nativeArtUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const base = remoteBase();
  const token = remoteToken();
  if (u.startsWith('/__pc/')) {
    return base && token ? `${base}${u.slice('/__pc'.length)}?token=${encodeURIComponent(token)}` : undefined;
  }
  // media://cover|audio/<id> (formato desktop): mai fetchabile nativamente —
  // se mai ci arrivasse su remoto la giriamo al PC come /media/<kind>/<id>.
  if (u.startsWith('media://')) {
    return base && token ? `${base}/${u.replace('media://', 'media/')}?token=${encodeURIComponent(token)}` : undefined;
  }
  return u;
}

let pushChain: Promise<void> = Promise.resolve(); // updateSession serializzati in ordine di chiamata

// Stato now-playing → notifica/lockscreen (no-op fuori dall'APK)
export function pushMediaSession(s: MediaSessionState): void {
  if (!plugin) return;
  pushChain = pushChain.then(async () => {
    let art = s.artUrl;
    // Preferita la copertina scaricata sul telefono: è la stessa immagine ma
    // sopravvive a PC spento/offline — dove l'URL remoto fallirebbe. Ogni
    // push resta auto-contenuto (niente dedup: un servizio ricreato trova
    // sempre l'art vera, anche dopo swipe-notifica o kill del processo).
    if (s.artPhoneId != null) {
      const d = await phoneCoverDataUrl(s.artPhoneId).catch(() => null);
      if (d) art = d;
    }
    const { artPhoneId: _a, ...rest } = s; // campo interno: non va al plugin
    await plugin.updateSession({ ...rest, artUrl: nativeArtUrl(art) }).catch(() => {});
  }).catch(() => {});
}

// Coda svuotata/brano rimosso: la notifica deve SPARIRE, non restare appesa
// all'ultimo titolo (senza questo la lockscreen mostrava un brano morto).
export function stopMediaSession(): void {
  if (!plugin) return;
  void plugin.stopSession().catch(() => {});
}

// Ripresa dopo la morte del render process (OS reclama la RAM con audio in
// background): il servizio foreground sopravvive e conserva l'ultimo stato
// sessione; il flag nativo distingue il recreate post-crash da un avvio
// normale — niente auto-play all'apertura dell'app, mai.
// La posizione arriva al player via evento 'mh-resume-seek' (PlayerBar la
// applica appena il nuovo stream carica i metadati).
export async function crashResume(): Promise<void> {
  if (!plugin) return;
  const r = await plugin.resumeState().catch(() => null);
  if (!r?.crashed || !r.playing) return;
  const s = useApp.getState();
  const cur = s.player.current;
  if (!cur) return;
  // Riprendi solo il brano che stava davvero suonando (match videoId; il
  // confronto sul titolo è il ripiego per sessioni vecchie senza videoId).
  if (r.videoId ? cur.videoId !== r.videoId : cur.title !== r.title) return;
  s.play(cur, s.player.queue, s.player.queueIndex);
  if ((r.positionMs ?? 0) > 3000) {
    setTimeout(() => window.dispatchEvent(new CustomEvent('mh-resume-seek', { detail: r.positionMs })), 1500);
  }
}
