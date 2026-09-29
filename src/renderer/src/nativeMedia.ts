import { Capacitor, registerPlugin } from '@capacitor/core';
import { useApp } from './store';

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
  videoId?: string;
  playing: boolean;
  durationMs?: number;
  positionMs?: number;
}

interface MediaSessionPlugin {
  updateSession(s: MediaSessionState): Promise<void>;
  stopSession(): Promise<void>;
  resumeState(): Promise<{ crashed: boolean; playing: boolean; videoId?: string; title?: string; artist?: string; positionMs?: number }>;
  addListener(ev: 'action', cb: (e: { action: string; positionMs?: number }) => void): Promise<{ remove: () => void }>;
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
    }
  });
}

// Stato now-playing → notifica/lockscreen (no-op fuori dall'APK)
export function pushMediaSession(s: MediaSessionState): void {
  if (!plugin) return;
  void plugin.updateSession(s).catch(() => {});
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
