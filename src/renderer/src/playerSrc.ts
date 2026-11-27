// Risoluzione della sorgente audio di una traccia (estratto da PlayerBar):
// file scaricato SUL telefono (IndexedDB, funziona anche senza rete), poi
// file della libreria (media:// su desktop, http://<pc>/media sul telefono),
// infine stream remoto con auto-riparazione (se il videoId è difettoso il
// main ne trova un altro da solo).
import type { LibraryTrack, TrackRef } from '../../shared/types';
import { api, mediaUrl, isRemote } from './api';
import { phoneAudioUrlFor } from './phoneLocal';
import { isOnline, retryNow, remoteViaTailscale } from './remote';

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
    // range 0-0 (3s): serve una risposta ok/404 dal PC VERO — il service
    // worker risponde 503/502 (auth mancante, PC giù) anche con fetch
    // riuscita, e contava come "vivo" portando <audio> su un URL morto.
    // Il 404 è una risposta del server (traccia mancante = errore normale
    // del brano); probe fallita/non-ok = PC non affidabile → kick del
    // probe ufficiale + risoluzione diretta, senza i 10s di call().
    const ac = new AbortController();
    const tmr = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ac.signal });
      if (!res.ok && res.status !== 404) throw new Error(`probe ${res.status}`);
      return { url, videoId: t.videoId, healed: false, local: true };
    } catch {
      retryNow(); // aggiorna isOnline() reale; intanto non fidiamoci più del PC
      const { directPlayStream } = await import('./direct');
      return directPlayStream(t.videoId, t.artist, t.title);
    } finally { clearTimeout(tmr); }
  }
  // Stream via Tailscale/4G: l'URL googlevideo che il PC risolve è IP-locked
  // alla WAN del PC — il telefono esce col proprio IP pubblico → 403 secco al
  // play (e a cascata skip su tutta la coda). Su LAN condividono l'IP pubblico
  // e funziona; via tunnel risolve diretto (YouTube vede l'IP del telefono).
  if (isRemote() && remoteViaTailscale()) {
    const { directPlayStream } = await import('./direct');
    return directPlayStream(t.videoId, t.artist, t.title);
  }
  // Stream: col PC up passa dal server (auto-riparazione), col PC giù
  // il client remoto risolve YouTube da solo (modalità autonoma).
  return api().yt.playStream(t.videoId, t.artist, t.title);
};
