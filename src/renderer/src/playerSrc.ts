// Risoluzione della sorgente audio di una traccia (estratto da PlayerBar):
// file scaricato SUL telefono (IndexedDB, funziona anche senza rete), poi
// file della libreria (media:// su desktop, http://<pc>/media sul telefono),
// infine stream remoto con auto-riparazione (se il videoId è difettoso il
// main ne trova un altro da solo).
import type { LibraryTrack, TrackRef } from '../../shared/types';
import { api, mediaUrl, isRemote } from './api';
import { phoneAudioUrlFor } from './phoneLocal';
import { isOnline, retryNow } from './remote';

export const srcOf = async (t: TrackRef & { local?: boolean }, skipPc = false): Promise<{ url: string; videoId: string; healed: boolean; local?: boolean }> => {
  const lib = t as LibraryTrack;
  // Telefono: prova SEMPRE la copia su IndexedDB — per id libreria O per id
  // sintetico del videoId (brani scaricati fuori dalla libreria). Una get è
  // economica e l'URL è in cache: niente race con phoneInit, niente stale.
  if (isRemote()) {
    const u = await phoneAudioUrlFor(t);
    if (u) return { url: u, videoId: t.videoId, healed: false, local: true };
  }
  // File sul PC: solo se il PC risponde — offline l'<audio> resterebbe appeso
  // ~20s su un URL morto prima dell'errore. YouTube diretto è la via giusta.
  if (!skipPc && lib.filePath && lib.id && (!isRemote() || isOnline())) {
    const url = mediaUrl('audio', lib.id);
    if (!isRemote()) return { url, videoId: t.videoId, healed: false, local: true };
    // Finestra probe: isOnline() può essere ancora true col PC appena morto —
    // un audio element ci metterebbe ~20-60s a dichiarare l'errore. Ping
    // range 0-0 (3s): QUALSIASI risposta HTTP = host vivo (anche 404: la
    // gestione errori del brano resta la stessa); nessuna risposta = PC giù →
    // kick del probe ufficiale + risoluzione diretta, senza i 10s di call().
    const ac = new AbortController();
    const tmr = setTimeout(() => ac.abort(), 3000);
    try {
      await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      return { url, videoId: t.videoId, healed: false, local: true };
    } catch {
      retryNow(); // aggiorna isOnline() reale; intanto non fidiamoci più del PC
      const { directPlayStream } = await import('./direct');
      return directPlayStream(t.videoId, t.artist, t.title);
    } finally { clearTimeout(tmr); }
  }
  // Stream: col PC up passa dal server (auto-riparazione), col PC giù
  // il client remoto risolve YouTube da solo (modalità autonoma).
  return api().yt.playStream(t.videoId, t.artist, t.title);
};
