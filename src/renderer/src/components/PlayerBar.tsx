import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Disc3, Heart, ThumbsDown, Shuffle, Repeat, Repeat1, ListMusic, Radio, Waves, ChevronUp, Loader2 } from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { useApp } from '../store';
import { api, mediaUrl, isRemote } from '../api';
import { usePersistedState } from '../persist';
import { pushMediaSession, stopMediaSession } from '../nativeMedia';
import { pushBack } from '../backStack';
import { ScreenErrorBoundary } from './common';
import { CoverImg } from './CoverImg';
import { phoneCoverUrl, phoneVidId, phoneInvalidate } from '../phoneLocal';
import { isOnline } from '../remote';
import NowPlaying, { prefetchLyrics } from './NowPlaying';
import QueuePanel from './QueuePanel';
import SleepTimer from './SleepTimer';
import { srcOf } from '../playerSrc';
import type { LibraryTrack, TrackRef } from '../../../shared/types';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const XF_SECONDS = 6; // durata della dissolvenza incrociata in coda al brano
// Il toggle crossfade è nascosto sotto i 768px (telefoni), ma la preferenza è
// sincronizzata PC↔telefono: attivato su desktop resterebbe attivo sul telefono
// senza modo di spegnerlo. Stesso breakpoint del CSS → il pref vale solo dove
// il controllo esiste.
const xfAllowed = () => !window.matchMedia('(max-width: 767px)').matches;

// Normalizzazione volume in anteprima: il main misura i LUFS dello stream con
// ffmpeg (target -14, lo stesso loudnorm dei download) e qui applichiamo il
// guadagno compensativo. Così i brani remoti suonano a volume uniforme.
const TARGET_LUFS = -14;
const gainMap = new Map<string, number>(); // videoId → moltiplicatore di volume
const gainOf = (lufs: number) => Math.min(2.5, Math.max(0.15, Math.pow(10, (TARGET_LUFS - lufs) / 20)));


export default function PlayerBar() {
  const { player, toggle, next, prev, setVolume, addToCd, downloadToCd, library, toggleShuffle, cycleRepeat, toggleRadio, toggleCrossfade, radioNext, playAt, toggleLike, remoteLiked, recordRemote, dislike } = useApp();
  // Doppio <audio>: l'elemento attivo suona, l'altro pre-carica il brano dopo per il crossfade
  const elsRef = useRef<(HTMLAudioElement | null)[]>([null, null]);
  const actRef = useRef(0);
  const [act, setAct] = useState(0);
  const xfGen = useRef(0);   // invalida ramp di crossfade superate da un cambio traccia
  const xfDone = useRef(''); // videoId per cui il crossfade è già partito
  const manXf = useRef(-1);  // gen della dissolvenza da cambio manuale in corso (-1 = nessuna)
  const healedOnce = useRef(new Set<string>()); // videoId già riparati in questa sessione
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const [loading, setLoading] = useState(false);
  // Fase della cascata stream (modalità diretta) e salute del PoToken:
  // il worst case di healing ~2min era uno spinner muto; ora la riga
  // artista dice cosa sta succedendo ("riparo il brano…") e un chip ambra
  // segnala quando BotGuard è morto e gli stream possono interrompersi.
  const [streamPhase, setStreamPhase] = useState('');
  const [streamWarn, setStreamWarn] = useState(''); // 'potoken' | 'cascade' | ''
  useEffect(() => {
    const onPhase = (e: Event) => setStreamPhase(String((e as CustomEvent).detail ?? ''));
    const onWarn = (e: Event) => setStreamWarn(String((e as CustomEvent).detail ?? ''));
    window.addEventListener('mh-stream-phase', onPhase);
    window.addEventListener('mh-stream-warn', onWarn);
    return () => { window.removeEventListener('mh-stream-phase', onPhase); window.removeEventListener('mh-stream-warn', onWarn); };
  }, []);
  useEffect(() => { if (!loading) setStreamPhase(''); }, [loading]);
  // Seek pendente dalla ripresa post-crash: il brano riparte ma l'elemento
  // non ha ancora i metadati → la posizione si applica a loadedmetadata.
  const pendingSeek = useRef(0);
  useEffect(() => {
    const f = (e: Event) => {
      const ms = (e as CustomEvent<number>).detail;
      if (typeof ms === 'number' && Number.isFinite(ms)) pendingSeek.current = ms / 1000;
    };
    window.addEventListener('mh-resume-seek', f);
    return () => window.removeEventListener('mh-resume-seek', f);
  }, []);
  const phaseLabel = streamPhase === 'heal' ? 'riparo il brano…'
    : streamPhase === 'audius' ? 'cerco una sorgente alternativa…'
    : streamPhase ? 'risolvo lo stream…' : '';
  // Ascolto reale del brano corrente: secondi effettivamente suonati (non la
  // posizione: un seek in avanti non conta). Inviato al motore gusti al cambio brano.
  const listen = useRef<{ vid: string; t: (TrackRef & { local?: boolean }) | null; played: number; last: number; dur: number }>({ vid: '', t: null, played: 0, last: 0, dur: 0 });
  const flushListen = () => {
    const l = listen.current;
    if (l.t && l.played >= 30) useApp.getState().recordListen(l.t, l.played, l.dur || l.t.durationS);
    l.played = 0; l.last = 0;
  };
  const [muted, setMuted] = usePersistedState('mh-pref-muted', false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [npOpen, setNpOpen] = useState(false);
  const cur = player.current;

  // Tasto indietro hardware (Android): il pannello coda aperto si chiude prima
  // di navigare. Il lettore espanso registra da sé (NowPlaying, nel portal).
  useEffect(() => (queueOpen ? pushBack(() => { setQueueOpen(false); return true; }) : undefined), [queueOpen]);

  actRef.current = act;
  const el = () => elsRef.current[actRef.current]!;
  const otherEl = () => elsRef.current[1 - actRef.current]!;
  // Volume target per un videoId: volume utente × guadagno LUFS misurato (clamp ≤1)
  const targetVol = (vid?: string) =>
    muted ? 0 : Math.min(1, useApp.getState().player.volume * (gainMap.get(vid ?? '') ?? 1));

  // Chiede al main la misura LUFS appena è pronta (l'analisi ffmpeg gira in
  // background dopo la risoluzione dello stream); quando arriva riapplica il volume.
  const pollLoudness = (vid: string | undefined, a: HTMLAudioElement) => {
    if (!vid || gainMap.has(vid)) return;
    let n = 0;
    const iv = setInterval(() => {
      if (++n > 8 || a.dataset.vid !== vid) { clearInterval(iv); return; }
      void api().yt.loudness(vid).then((lufs) => {
        if (lufs == null) return;
        clearInterval(iv);
        gainMap.set(vid, gainOf(lufs));
        // Se non siamo in dissolvenza riapplica subito; i ramp leggono già gainMap
        if (a === el() && manXf.current < 0) a.volume = targetVol(vid);
      }).catch(() => {});
    }, 2500);
  };

  // Fade-out morbido (~360ms) su un elemento che non deve più suonare
  const fadeOut = (a: HTMLAudioElement | null) => {
    if (!a || a.paused) return;
    const v0 = a.volume;
    let k = 0;
    const iv = setInterval(() => {
      k++;
      a.volume = Math.max(0, v0 * (1 - k / 6));
      if (k >= 6) { clearInterval(iv); a.pause(); a.currentTime = 0; }
    }, 60);
  };

  // Indice del brano successivo (rispetta shuffle/repeat); null se la coda finisce
  const nextIndex = (): number | null => {
    const p = useApp.getState().player;
    if (p.queue.length < 2) return p.repeat === 'all' && p.queue.length ? 0 : null;
    if (p.shuffle) {
      let i = p.queueIndex;
      while (i === p.queueIndex) i = Math.floor(Math.random() * p.queue.length);
      return i;
    }
    if (p.queueIndex < p.queue.length - 1) return p.queueIndex + 1;
    return p.repeat === 'all' ? 0 : null;
  };

  // Avvia il crossfade: carica il brano dopo sull'altro elemento e incrocia i volumi
  const startXfade = (nxt: TrackRef & { local?: boolean }, ni: number, fromVid: string) => {
    const gen = xfGen.current;
    const a = el();
    const o = otherEl();
    o.dataset.vid = nxt.videoId;
    srcOf(nxt).then((r) => {
      if (gen !== xfGen.current || useApp.getState().player.current?.videoId !== fromVid) return;
      o.src = r.url;
      o.dataset.local = r.local ? '1' : '';
      if (r.videoId !== nxt.videoId) { o.dataset.vid = r.videoId; useApp.getState().healVideoId(nxt.videoId, r.videoId); }
      o.volume = 0;
      void o.play().catch(() => {});
      const steps = 24;
      let k = 0;
      const iv = setInterval(() => {
        if (gen !== xfGen.current) { clearInterval(iv); return; }
        k++;
        const f = Math.min(1, k / steps);
        o.volume = f * targetVol(o.dataset.vid);      // ogni elemento col guadagno del SUO brano
        a.volume = (1 - f) * targetVol(a.dataset.vid);
        if (f >= 1) { clearInterval(iv); a.pause(); a.volume = targetVol(a.dataset.vid); useApp.getState().playAt(ni); }
      }, (XF_SECONDS * 1000) / steps);
    }).catch(() => { /* stream non risolvibile: finirà col salto normale a onEnded */ });
  };

  // Cambio brano → chiudi il conteggio del precedente e apri quello nuovo
  useEffect(() => {
    if (listen.current.vid && listen.current.vid !== cur?.videoId) flushListen();
    listen.current = { vid: cur?.videoId ?? '', t: cur ?? null, played: 0, last: 0, dur: 0 };
  }, [cur?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.addEventListener('beforeunload', flushListen); return () => window.removeEventListener('beforeunload', flushListen); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = el();
    const o = otherEl();
    if (!a || !o || !cur) return;
    const vid = cur.videoId;
    xfGen.current++;
    const gen = xfGen.current;
    // Già caricato sull'elemento attivo (es. dopo auto-riparazione): non ricaricare
    if (a.dataset.vid === vid && a.src) return;
    if (o.dataset.vid === vid && o.src) {
      // Il crossfade a fine brano ha già caricato questo brano sull'altro elemento: basta scambiarli
      fadeOut(a);
      o.volume = targetVol(o.dataset.vid);
      setAct(1 - act);
      return;
    }
    const st = useApp.getState().player;
    const oldPlaying = !!a.src && !a.paused && a.currentTime > 0.5 && a.dataset.vid !== vid;
    // Cambio manuale con brano in corso (skip, click su altra riga, prev/next):
    // dissolvenza breve ~1.4s invece di taglio netto — il nuovo entra sull'altro elemento
    if (st.playing && st.crossfade && xfAllowed() && oldPlaying) {
      setLoading(true); setTime(0);
      o.dataset.vid = vid;
      manXf.current = gen;
      srcOf(cur)
        .then((r) => {
          if (gen !== xfGen.current || useApp.getState().player.current?.videoId !== vid) {
            if (manXf.current === gen) manXf.current = -1;
            return;
          }
          o.src = r.url;
          o.dataset.local = r.local ? '1' : '';
          if (r.videoId !== vid) o.dataset.vid = r.videoId; // auto-riparato: dataset coerente col nuovo id
          o.volume = 0;
          void o.play().catch(() => {});
          const steps = 18;
          let k = 0;
          const iv = setInterval(() => {
            if (gen !== xfGen.current) { clearInterval(iv); if (manXf.current === gen) manXf.current = -1; return; }
            k++;
            const f = Math.min(1, k / steps);
            o.volume = f * targetVol(o.dataset.vid);
            a.volume = (1 - f) * targetVol(a.dataset.vid);
            if (f >= 1) {
              clearInterval(iv);
              manXf.current = -1;
              a.pause(); a.currentTime = 0; a.volume = targetVol(a.dataset.vid);
              setAct(1 - act);
              setDur(Number.isFinite(o.duration) ? o.duration : 0);
              setLoading(false);
              if (r.videoId !== vid) useApp.getState().healVideoId(vid, r.videoId);
            }
          }, 1400 / steps);
        })
        .catch(() => {
          if (manXf.current === gen) manXf.current = -1;
          if (useApp.getState().player.current?.videoId !== vid) return;
          useApp.getState().toast('Anteprima non disponibile', 'err');
          setLoading(false);
          setTimeout(() => { if (useApp.getState().player.current?.videoId === vid) next(); }, 800);
        });
      return;
    }
    fadeOut(o);
    a.dataset.vid = vid;
    a.volume = targetVol(vid);
    setLoading(true); setTime(0);
    srcOf(cur)
      .then((r) => {
        if (useApp.getState().player.current?.videoId !== vid) return; // traccia cambiata nel frattempo
        a.src = r.url;
        a.dataset.local = r.local ? '1' : '';
        if (r.videoId !== vid) {
          // Stream riparato: dataset sul nuovo id così l'effect (ri-innescato
          // da healVideoId) esce alla guardia senza ricaricare
          a.dataset.vid = r.videoId;
          if (useApp.getState().player.playing) void a.play().catch(() => {});
          useApp.getState().healVideoId(vid, r.videoId);
          useApp.getState().toast('Stream riparato automaticamente', 'info');
          return;
        }
        // coda ripristinata all'avvio: carica lo stream ma NON suonare se in pausa
        if (useApp.getState().player.playing) return a.play();
      })
      .catch(() => {
        if (useApp.getState().player.current?.videoId !== vid) return;
        useApp.getState().toast('Anteprima non disponibile', 'err');
        setTimeout(() => { if (useApp.getState().player.current?.videoId === vid) next(); }, 800);
      })
      .finally(() => { if (useApp.getState().player.current?.videoId === vid) setLoading(false); });
  }, [cur?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = el();
    const o = otherEl();
    if (!a) return;
    if (player.playing) void a.play().catch(() => {});
    else { a.pause(); o?.pause(); } // in pausa si ferma anche il brano in crossfade
  }, [player.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prefetch del brano successivo in coda: lo skip diventa quasi istantaneo.
  // In modalità autonoma (PC giù) il prefetch costa una risoluzione COMPLETA
  // (fino a 10 client × getBasicInfo + probe + BotGuard) per un brano che
  // forse non verrà suonato → su 4G è traffico/batteria sprecati: si salta.
  useEffect(() => {
    const nxt = player.queue[player.queueIndex + 1];
    if (!nxt) return;
    if (isRemote() && !isOnline()) return; // autonomo: niente prefetch costoso
    const lib = nxt as LibraryTrack;
    if (lib.filePath && lib.id) return; // già locale
    const s = useApp.getState();
    if (lib.id != null && s.phoneIds.has(lib.id)) return; // già sul telefono
    if (nxt.videoId && s.phoneIds.has(phoneVidId(nxt.videoId))) return;
    const t = setTimeout(() => { void api().yt.streamUrl(nxt.videoId).catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [player.current?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Volume/mute sull'elemento attivo (il ramp del crossfade gestisce l'altro da solo)
  useEffect(() => {
    const a = el();
    if (a) a.volume = targetVol(a.dataset.vid);
  }, [player.volume, muted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Espone il buffering a tutto lo store: righe e poster mostrano lo spinner
  // sul brano che si sta risolvendo, non solo nella barra.
  useEffect(() => {
    useApp.getState().setBuffering(loading);
  }, [loading]);

  // Stato now-playing → tray icon (tooltip + menu) e, sull'APK, → media
  // session nativa (notifica con controlli, lockscreen, Bluetooth).
  const msPushAt = useRef(0);
  const pushMs = (a?: HTMLAudioElement | null) => {
    const c = useApp.getState().player.current;
    if (!c) return; // niente brano → niente sessione nativa
    const lib = c as LibraryTrack;
    const el0 = a ?? el();
    pushMediaSession({
      title: c.title ?? '', artist: c.artist ?? '', album: lib.album || 'MasterHype',
      videoId: c.videoId,
      // L'artwork la scarica il servizio nativo via HTTP: solo URL http(s),
      // mai blob: (la copertina IndexedDB non è raggiungibile dal servizio).
      // Righe "solo telefono" (id sintetico negativo): /media/cover/-id non
      // esiste sul PC → thumbnail YouTube invece di notifica senza copertina.
      artUrl: lib.id && lib.id > 0 ? mediaUrl('cover', lib.id) : c.thumbnail,
      playing: useApp.getState().player.playing,
      durationMs: Math.round((Number.isFinite(el0?.duration) ? el0!.duration : (c.durationS ?? 0)) * 1000),
      positionMs: Math.round((el0?.currentTime ?? 0) * 1000),
    });
  };
  useEffect(() => {
    api().player.updateState({ title: cur?.title, artist: cur?.artist, playing: player.playing });
    if (cur) pushMs(); else stopMediaSession(); // brano sparito → la notifica deve sparire con lui
  }, [cur?.videoId, player.playing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seek da notifica/lockscreen Android: il plugin nativo inoltra l'evento,
  // qui si applica all'elemento <audio> attivo e si riallinea la sessione.
  useEffect(() => {
    const f = (e: Event) => {
      const ms = (e as CustomEvent<number>).detail;
      const a = el();
      if (a && typeof ms === 'number' && Number.isFinite(ms)) {
        a.currentTime = ms / 1000;
        setTime(a.currentTime);
        pushMs(a);
      }
    };
    window.addEventListener('mh-media-seek', f);
    return () => window.removeEventListener('mh-media-seek', f);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Media Session API: controlli da lockscreen/notifica Android e tasti
  // Bluetooth (su desktop li mostra anche l'overlay multimediale di Windows)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => { const s = useApp.getState(); if (!s.player.playing) s.toggle(); });
    ms.setActionHandler('pause', () => { const s = useApp.getState(); if (s.player.playing) s.toggle(); });
    ms.setActionHandler('nexttrack', () => useApp.getState().next());
    ms.setActionHandler('previoustrack', () => useApp.getState().prev());
    return () => { for (const a of ['play', 'pause', 'nexttrack', 'previoustrack'] as const) ms.setActionHandler(a, null); };
  }, []);
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    if (!cur) { navigator.mediaSession.metadata = null; return; } // overlay multimediale pulito a coda finita
    const lib = cur as LibraryTrack;
    void (async () => {
      let art: string | undefined;
      if (isRemote() && lib.id && useApp.getState().phoneIds.has(lib.id)) {
        art = (await phoneCoverUrl(lib.id)) ?? undefined; // copertina locale: va anche offline
      }
      art ??= lib.id && lib.id > 0 ? mediaUrl('cover', lib.id) : cur.thumbnail;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: cur.title ?? '', artist: cur.artist ?? '',
        album: lib.album || 'MasterHype',
        artwork: art ? [{ src: art, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    })();
  }, [cur?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = player.playing ? 'playing' : 'paused';
  }, [player.playing]);

  // Prefetch del testo: se il brano dura, la vista "video+testo" si apre già pronta.
  // Ritardato 1.5s per non martellare LRCLIB durante skip rapidi in coda.
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => {
      if (useApp.getState().player.current?.videoId === cur.videoId) prefetchLyrics(cur);
    }, 1500);
    return () => clearTimeout(t);
  }, [cur?.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Timeupdate: guida la seek bar e, negli ultimi secondi, innesca il crossfade
  const onTime = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    const a = e.currentTarget;
    if (a !== el()) return; // aggiorna la UI solo l'elemento attivo
    clearStall(); // il tempo avanza: lo stream è vivo
    if (manXf.current >= 0) return; // dissolvenza manuale in corso: niente crossfade di coda
    setTime(a.currentTime);
    // Posizione alla sessione nativa (throttle 5s: copre i seek; Android
    // estrapola la posizione da solo tra un push e l'altro via playbackSpeed)
    if (Date.now() - msPushAt.current > 5000) { msPushAt.current = Date.now(); pushMs(a); }
    // Conteggio ascolto: somma solo avanzamenti "naturali" (≤2s tra due tick)
    const l = listen.current;
    if (l.vid === a.dataset.vid && !a.paused) {
      const delta = a.currentTime - l.last;
      if (delta > 0 && delta <= 2) l.played += delta;
      l.last = a.currentTime;
      if (Number.isFinite(a.duration)) l.dur = a.duration;
    }
    const s = useApp.getState();
    const d = a.duration;
    if (!s.player.crossfade || !xfAllowed() || !cur || !Number.isFinite(d) || d < XF_SECONDS + 15) return;
    // 'Ripeti brano': a fine brano si riparte da 0 (onEnded) — un crossfade
    // verso il brano dopo farebbe playAt(ni) e la ripetizione sparirebbe.
    if (s.player.repeat === 'one') return;
    if (d - a.currentTime > XF_SECONDS || xfDone.current === cur.videoId) return;
    const ni = nextIndex();
    if (ni == null) return; // coda finita: la radio (se attiva) parte da onEnded
    const nxt = s.player.queue[ni];
    if (!nxt || nxt.videoId === cur.videoId) return;
    xfDone.current = cur.videoId;
    startXfade(nxt, ni, cur.videoId);
  };

  const onEnded = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    const a = e.currentTarget;
    if (a !== el()) return; // l'elemento in fade-out non comanda
    if (manXf.current >= 0) return; // il brano nuovo sta già entrando: non riavviare il vecchio
    const s = useApp.getState();
    // Sleep timer "a fine brano": il brano finisce → pausa qui, niente next/radio
    if (s.sleepEndOfTrack) {
      s.setSleepTimer(null);
      if (s.player.playing) s.toggle();
      s.toast('Timer di spegnimento — musica in pausa', 'info');
      return;
    }
    const last = s.player.queueIndex >= s.player.queue.length - 1;
    if (s.player.repeat === 'one') {
      a.currentTime = 0;
      void a.play().catch(() => {});
    } else if (last && s.player.repeat === 'all' && s.player.queue.length) {
      s.playAt(0);
    } else if (last && s.player.radio) {
      void s.radioNext(); // radio infinita: continua con brani simili
    } else next();
  };

  // UNA auto-riparazione per videoId per sessione: ricarica la sorgente
  // (copia su telefono → YouTube diretto; skipPc evita di ripescare l'URL del
  // PC appena fallito). Sul telefono si riparano ANCHE i filePath di libreria:
  // un PC morto a metà brano non deve saltare la traccia. Ritorna true se il
  // tentativo è partito (il caller non deve già saltare al brano successivo).
  const attemptHeal = (t: TrackRef & { local?: boolean }): boolean => {
    const vid = t.videoId;
    if (healedOnce.current.has(vid)) return false;
    if (t.filePath && !isRemote()) return false; // desktop: file locale morto = vero errore
    healedOnce.current.add(vid);
    // Se a morire era la copia sul telefono (SW morto a metà stream), l'URL
    // cache punta ancora lì: invalida per ri-risolvere (SW check → blob fallback)
    const pid = (t as LibraryTrack).id ?? (vid ? phoneVidId(vid) : null);
    if (isRemote() && pid != null) phoneInvalidate(pid);
    void api().diag.report('stream-dead', { videoId: vid, artist: t.artist, title: t.title }).catch(() => {});
    srcOf(t, /*skipPc*/ true).then((r) => {
      const st = useApp.getState();
      if (st.player.current?.videoId !== vid) return;
      const a = el();
      a.src = r.url;
      a.dataset.vid = r.videoId;
      a.dataset.local = r.local ? '1' : '';
      if (st.player.playing) void a.play().catch(() => {});
      if (r.videoId !== vid) st.healVideoId(vid, r.videoId);
      st.toast('Stream riparato automaticamente', 'info');
    }).catch(() => {
      const st = useApp.getState();
      if (st.player.current?.videoId !== vid) return;
      if (st.player.queue.length > 1) {
        st.toast('Errore di riproduzione — passo al brano successivo', 'err');
        setTimeout(() => useApp.getState().next(), 800);
      } else st.toast('Errore di riproduzione', 'err');
    });
    return true;
  };

  const errOrSkip = () => {
    const s = useApp.getState();
    if (s.player.queue.length > 1) {
      s.toast('Errore di riproduzione — passo al brano successivo', 'err');
      setTimeout(() => useApp.getState().next(), 800);
    } else {
      s.toast('Errore di riproduzione', 'err');
    }
  };

  const onErr = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (e.currentTarget !== el()) return;
    setLoading(false);
    const t = useApp.getState().player.current;
    if (!t) return;
    if (attemptHeal(t)) return;
    errOrSkip();
  };

  // Watchdog "stalled/waiting": lo stream diretto che si blocca a metà (rete
  // mobile ballerina, URL che smette di servire dopo la probe) emette stalled
  // ma MAI error → senza watchdog la UI resta su "playing" col tempo fermo.
  // 12s di grazia coprono seek e buffering normali; scaduto → heal/skip.
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStall = () => { if (stallTimer.current) { clearTimeout(stallTimer.current); stallTimer.current = null; } };
  const onStall = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    const a = e.currentTarget;
    if (a !== el() || a.paused || !a.src) return; // solo l'elemento attivo che sta suonando
    if (stallTimer.current) return;
    stallTimer.current = setTimeout(() => {
      stallTimer.current = null;
      const s = useApp.getState();
      const t = s.player.current;
      if (!t || el() !== a || a.dataset.vid !== t.videoId || !s.player.playing) return;
      // Ancora fermo dopo 12s: niente error event arriverà — decido io.
      if (!attemptHeal(t)) errOrSkip();
    }, 12_000);
  };

  // Watchdog di caricamento: srcOf risolto ma l'elemento non arriva mai a
  // loadedmetadata (host che accetta TCP e non risponde, URL morto lento) —
  // 30s poi heal/skip, invece di spinner infinito.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => {
      const s = useApp.getState();
      const cur = s.player.current;
      if (!cur) return;
      if (!attemptHeal(cur)) errOrSkip();
      setLoading(false);
    }, 30_000);
    return () => clearTimeout(t);
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const inLib = cur && library.find((t) => t.videoId === cur.videoId);
  const curLiked = cur ? (inLib ? inLib.liked : !!remoteLiked[cur.videoId]) : false;

  // Skip manuale prima dei 30s = segnale negativo sui gusti (locale e remoto).
  // 30s è la stessa soglia di recordListen: senza coincidere, chi saltava a
  // 26-29s non produceva NÉ skip NÉ completamento — un buco nei segnali.
  const skipNext = () => {
    if (time < 30 && cur) recordRemote(cur, 'skip');
    next();
  };

  // Convenzione player: "indietro" dopo 3s ricomincia il brano, prima torna al precedente
  const goPrev = () => {
    const a = el();
    if (a && time > 3) a.currentTime = 0;
    else prev();
  };

  return (
    <div className="h-20 bg-panel/95 backdrop-blur flex items-center gap-4 px-4 shrink-0 relative
      max-md:h-[64px] max-md:px-2 max-md:gap-2 max-md:mb-[60px]
      before:absolute before:top-0 before:left-0 before:right-0 before:h-px
      before:bg-gradient-to-r before:from-transparent before:via-accent/40 before:to-transparent">
      {/* Due elementi audio: [0] e [1] si alternano a ogni crossfade */}
      {[0, 1].map((i) => (
        <audio key={i} ref={(r) => { elsRef.current[i] = r; }}
          onTimeUpdate={onTime}
          onLoadedMetadata={(e) => {
            if (e.currentTarget === el()) {
              setDur(e.currentTarget.duration); setLoading(false);
              if (pendingSeek.current > 0) { e.currentTarget.currentTime = pendingSeek.current; pendingSeek.current = 0; }
            }
            // Stream remoto? Il main sta misurando i LUFS: appena pronti livelliamo il volume
            if (!e.currentTarget.dataset.local) pollLoudness(e.currentTarget.dataset.vid, e.currentTarget);
          }}
          onPlaying={clearStall}
          onStalled={onStall}
          onWaiting={onStall}
          onEnded={(e) => { clearStall(); onEnded(e); }}
          onPause={clearStall}
          onError={(e) => { clearStall(); onErr(e); }} />
      ))}

      {/* Progresso sottile tappabile: solo mobile (la seek bar è nascosta) */}
      <div className="absolute top-0 left-0 right-0 h-2.5 md:hidden cursor-pointer z-10"
        onClick={(e) => {
          if (!dur) return;
          const r = e.currentTarget.getBoundingClientRect();
          const a = el();
          if (a) a.currentTime = Math.min(Math.max(0, dur - 0.5), Math.max(0, (e.clientX - r.left) / r.width * dur));
        }}>
        <div className="h-[3px] bg-gradient-to-r from-accent to-accent2"
          style={{ width: `${dur ? Math.min(100, (time / dur) * 100) : 0}%` }} />
      </div>

      <div className="flex items-center gap-3 w-64 min-w-0 max-md:flex-1 max-md:gap-2">
        <button onClick={() => cur && setNpOpen(true)} disabled={!cur}
          title="Apri video e testo"
          className={`w-12 h-12 rounded-md bg-panel2 overflow-hidden shrink-0 flex items-center justify-center
            cursor-pointer hover:ring-1 hover:ring-accent/60 transition-shadow ${player.playing ? 'glow' : ''}`}>
          <CoverImg src={cur?.thumbnail} trackId={cur?.id} videoId={cur?.videoId}
            className="w-full h-full object-cover"
            icon={<Disc3 size={22} className={`text-dim ${player.playing ? 'spin-slow text-accent' : ''}`} />} />
        </button>
        <div className="min-w-0 flex-1" onClick={() => cur && setNpOpen(true)} role="button">
          <div className="text-sm font-semibold truncate">{cur?.title ?? '—'}</div>
          <div className={`text-xs truncate ${loading && phaseLabel ? 'text-accent/80' : 'text-dim'}`}>
            {loading && phaseLabel ? phaseLabel : (cur?.artist ?? 'Nessuna traccia')}
          </div>
        </div>
        {cur && (
          <>
            <button onClick={() => toggleLike(cur)}
              className="text-dim hover:text-accent transition-colors"
              title={curLiked ? 'Togli dai preferiti' : 'Mi piace'}>
              <Heart size={16} fill={curLiked ? 'currentColor' : 'none'} className={curLiked ? 'text-accent' : ''} />
            </button>
            <button onClick={() => { dislike(cur); if (time < 25) next(); }}
              className="text-dim hover:text-orange-400 transition-colors max-md:hidden" title="Meno così — passa al brano dopo">
              <ThumbsDown size={14} />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center gap-1.5 min-w-0 max-md:flex-none">
        <div className="flex items-center gap-4 max-md:gap-5">
          <button onClick={toggleShuffle} title="Riproduzione casuale"
            className={`transition-colors max-md:hidden ${player.shuffle ? 'text-accent' : 'text-dim hover:text-txt'}`}>
            <Shuffle size={15} />
          </button>
          <button onClick={goPrev} className="text-dim hover:text-txt"><SkipBack size={18} /></button>
          <button onClick={toggle} disabled={!cur}
            className={`w-10 h-10 rounded-full bg-gradient-to-br from-accent to-accent2 text-white flex items-center justify-center hover:scale-105 transition-transform disabled:opacity-40 shadow-lg shadow-accent/30 ${player.playing ? 'neon-play' : ''}`}>
            {loading ? <Loader2 size={18} className="animate-spin" /> : player.playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
          </button>
          <button onClick={skipNext} className="text-dim hover:text-txt"><SkipForward size={18} /></button>
          <button onClick={cycleRepeat}
            title={player.repeat === 'one' ? 'Ripeti brano' : player.repeat === 'all' ? 'Ripeti tutto' : 'Ripetizione off'}
            className={`transition-colors max-md:hidden ${player.repeat !== 'off' ? 'text-accent' : 'text-dim hover:text-txt'}`}>
            {player.repeat === 'one' ? <Repeat1 size={15} /> : <Repeat size={15} />}
          </button>
          <button onClick={toggleCrossfade}
            title={player.crossfade ? 'Dissolvenza attiva: i brani si sfumano l\'uno nell\'altro' : 'Attiva la dissolvenza tra i brani'}
            className={`transition-colors max-md:hidden ${player.crossfade ? 'text-accent' : 'text-dim hover:text-txt'}`}>
            <Waves size={15} />
          </button>
        </div>
        <div className="w-full max-w-xl flex items-center gap-2 text-[11px] text-dim max-md:hidden">
          <span className="w-8 text-right">{fmt(time)}</span>
          <input type="range" min={0} max={dur || 0} step={0.5} value={time}
            onChange={(e) => { const a = el(); if (a) a.currentTime = +e.target.value; }}
            className="flex-1 h-1 accent-[--color-accent] cursor-pointer" />
          <span className="w-8">{fmt(dur)}</span>
        </div>
      </div>

      <div className="w-64 flex items-center justify-end gap-2 max-md:w-auto">
        {loading && <div className="eq"><i /><i /><i /><i /></div>}
        {streamWarn && (
          <span className="text-[10px] font-medium text-amber-400/90 whitespace-nowrap"
            title={streamWarn === 'cascade'
              ? 'Le fonti YouTube stanno fallendo di continuo: se puoi, scarica i brani che ti servono'
              : "Protezione anti-bot di YouTube non attiva: gli stream diretti possono interrompersi a metà brano"}>
            stream a rischio
          </span>
        )}
        {cur && (
          <button onClick={() => (inLib ? addToCd(inLib) : void downloadToCd(cur))}
            title={inLib ? 'Aggiungi al CD' : 'Scarica e aggiungi al CD'}
            className="text-xs px-2 py-1 rounded bg-panel2 hover:bg-line text-dim hover:text-accent transition-colors max-md:hidden">
            + CD
          </button>
        )}
        <button onClick={toggleRadio}
          title={player.radio ? 'Radio attiva: a fine coda continua con brani simili' : 'Attiva la radio infinita'}
          className={`transition-colors max-md:hidden ${player.radio ? 'text-accent' : 'text-dim hover:text-txt'}`}>
          <Radio size={16} />
        </button>
        <SleepTimer />
        {cur && (
          <button onClick={() => setNpOpen((v) => !v)}
            title={npOpen ? 'Chiudi vista brano' : 'Video e testo del brano in riproduzione'}
            className={`transition-colors max-md:hidden ${npOpen ? 'text-accent' : 'text-dim hover:text-txt'}`}>
            <ChevronUp size={17} />
          </button>
        )}
        <button onClick={() => setQueueOpen((v) => !v)} title="In coda"
          className={`transition-colors max-md:hidden ${queueOpen ? 'text-accent' : 'text-dim hover:text-txt'}`}>
          <ListMusic size={17} />
        </button>
        <button onClick={() => setMuted(!muted)} className="text-dim hover:text-txt max-md:hidden">
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : player.volume}
          onChange={(e) => {
            setMuted(false);
            setVolume(+e.target.value);
            const a = el(); if (a) a.volume = +e.target.value;
          }}
          className="w-24 h-1 accent-[--color-accent] cursor-pointer max-md:hidden" />
      </div>

      <AnimatePresence>
        {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
      </AnimatePresence>
      {/* Portal su <body>: il backdrop-blur della barra renderebbe 'fixed' relativo
          alla barra stessa (altezza zero) — il pannello deve coprire la finestra */}
      {createPortal(
        <AnimatePresence>
          {npOpen && cur && (
            // Boundary suo: un errore nella vista brano chiude lei, non tutta l'app.
            <ScreenErrorBoundary>
              <NowPlaying cur={cur} time={time} dur={dur} playing={player.playing}
                onClose={() => setNpOpen(false)}
                onSeek={(t) => { const a = el(); if (a) { a.currentTime = t; setTime(t); } }} />
            </ScreenErrorBoundary>
          )}
        </AnimatePresence>,
        document.body)}
    </div>
  );
}
