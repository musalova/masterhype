import { Capacitor, registerPlugin } from '@capacitor/core';
import { useApp } from './store';
import { api } from './api';
import { STATIONS } from '../../shared/types';
import type { TrackRef, LibraryTrack } from '../../shared/types';
import { cachedAuto, cacheAuto, offlineStation } from './offlineRec';

// Bridge Android Auto (AutoBrowseService nativo): la WebView spinge l'albero
// sfogliabile in AutoCache (stazioni/preferiti/playlist) e riceve le
// richieste di play come mediaId via evento 'auto-play' (MediaSessionPlugin).
// mediaId: st:<id> stazione · f:<videoId> preferito · pt:<plId>:<videoId> brano
// di playlist. Fuori dall'APK tutto è no-op.

interface AutoPlugin {
  updateAutoTree(o: { tree: string }): Promise<void>;
  autoPending(): Promise<{ mediaId?: string }>;
}

const native = Capacitor.isNativePlatform();
const plugin = native ? registerPlugin<AutoPlugin>('MediaSession') : null;
let armed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

// Copertina per l'auto: solo http(s) caricabili fuori dalla WebView —
// media:// e data: non esistono per AutoBrowseService → fallback YouTube.
const artOf = (t: TrackRef): string | undefined =>
  t.thumbnail && /^https?:/.test(t.thumbnail) ? t.thumbnail
    : t.videoId ? `https://i.ytimg.com/vi/${t.videoId}/mqdefault.jpg` : undefined;

async function pushAutoTree(): Promise<void> {
  const s = useApp.getState();
  const row = (t: TrackRef) => ({ videoId: t.videoId, title: t.title, artist: t.artist, art: artOf(t) });
  const favorites = s.library.filter((x) => x.liked).slice(0, 200).map(row).filter((x) => x.videoId);
  let playlists: unknown[] = [];
  try {
    playlists = (await api().playlists.list()).slice(0, 50).map((p) => ({
      id: p.id, name: p.name,
      tracks: (p.tracks ?? []).slice(0, 200).map(row).filter((x) => x.videoId),
    }));
  } catch { /* PC giù: la cache nativa conserva l'ultimo albero buono */ }
  const tree = { stations: STATIONS.map((x) => ({ id: x.id, name: x.name })), favorites, playlists };
  await plugin!.updateAutoTree({ tree: JSON.stringify(tree) }).catch(() => {});
}

/** Debounce dei push: la stessa alberatura non si ricostruisce a ogni set dello store. */
export function scheduleAutoTree(): void {
  if (!plugin) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void pushAutoTree(); }, 2000);
}

// mediaId → riproduzione reale: la musica resta nella WebView (<audio>),
// l'auto comanda solo. Mai lanciare: un'eccezione dal volante non deve
// tirare giù il renderer.
export async function autoPlayNow(mediaId: string): Promise<void> {
  const s = useApp.getState();
  try {
    if (mediaId.startsWith('st:')) {
      // Stazione → scaletta: PC vivo via rec.station, altrimenti ultima
      // cacheata o approssimazione offline (stesso percorso di StationDetail).
      const id = mediaId.slice(3);
      const ck = `st:${id}`;
      let tracks: TrackRef[] = [];
      try {
        tracks = await api().rec.station(id);
        if (tracks.length) cacheAuto(ck, tracks);
      } catch { /* offline */ }
      if (!tracks.length) tracks = cachedAuto<TrackRef[]>(ck) ?? await offlineStation(id, s.library, s.remoteLikeList).catch(() => []);
      if (!tracks.length) { s.toast('Stazione non disponibile senza PC', 'info'); return; }
      s.playStation(tracks);
      return;
    }
    if (mediaId.startsWith('f:')) {
      // Preferito → play dentro la coda dei preferiti (continua in radio)
      const vid = mediaId.slice(2);
      const favs = s.library.filter((x) => x.liked);
      const i = favs.findIndex((x) => x.videoId === vid);
      const t = i >= 0 ? favs[i] : ({ videoId: vid, artist: '', title: 'Brano', source: 'ytmusic' } as TrackRef);
      s.play(t, favs.length ? favs : [t], Math.max(0, i));
      return;
    }
    if (mediaId.startsWith('pt:')) {
      // Brano di playlist → play nella coda della playlist alla sua posizione
      const rest = mediaId.slice(3);
      const ci = rest.indexOf(':');
      const plId = Number(rest.slice(0, ci));
      const vid = rest.slice(ci + 1);
      const pls = await api().playlists.list().catch(() => []);
      const pl = pls.find((p) => p.id === plId);
      const tracks = (pl?.tracks ?? []) as (TrackRef | LibraryTrack)[];
      const i = Math.max(0, tracks.findIndex((x) => x.videoId === vid));
      const t = tracks[i] ?? ({ videoId: vid, artist: '', title: pl?.name ?? 'Brano', source: 'ytmusic' } as TrackRef);
      s.play(t, tracks.length ? tracks : [t], i);
    }
  } catch { /* volante/auto: niente crash nel renderer */ }
}

export function initNativeAuto(): void {
  if (!plugin || armed) return;
  armed = true;
  // Ripush quando cambia ciò che l'albero mostra (libreria, preferiti,
  // profilo attivo — la cache nativa è per-ultimo-push: il cambio utente
  // riscrive il tree del NUOVO profilo, isolamento preservato).
  useApp.subscribe((s, p) => {
    if (s.library !== p.library || s.remoteLikeList !== p.remoteLikeList || s.currentUser !== p.currentUser) scheduleAutoTree();
  });
  scheduleAutoTree();
  // Le playlist non vivono nello store: refresh periodico copre le modifiche
  // (crea/rinomina/aggiungi) senza hook sparsi in ogni call-site.
  setInterval(scheduleAutoTree, 60_000);
  // Play richiesto dall'auto mentre l'app era chiusa: eseguito una volta al boot.
  void plugin.autoPending().then((r) => { if (r?.mediaId) void autoPlayNow(r.mediaId); });
}
