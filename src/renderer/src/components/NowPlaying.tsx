import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Disc3, VideoOff, Radio, Trash2, Shuffle, Repeat, Repeat1, Moon, Maximize2, Minimize2, PictureInPicture2, Clapperboard, PanelRightOpen } from 'lucide-react';
import { usePersistedState } from '../persist';
import { api } from '../api';
import { pushBack } from '../backStack';
import { useApp } from '../store';
import { CoverImg } from './CoverImg';
import { LoadingState } from './common';
import type { LibraryTrack, LyricsResult, TrackRef } from '../../../shared/types';

const VID_RE = /^[A-Za-z0-9_-]{6,15}$/; // solo ID YouTube plausibili, mai URL arbitrari
const lyrCache = new Map<string, LyricsResult>(); // testo già scaricato: niente refetch a ogni apertura

// Precarica il testo appena parte un brano: aprendo la vista è già lì
export function prefetchLyrics(t: TrackRef): void {
  if (lyrCache.has(t.videoId)) return;
  void api().yt.lyrics(t.artist, t.title, t.durationS)
    .then((r) => lyrCache.set(t.videoId, r))
    .catch(() => {});
}

// Coda unificata nella vista brano: stessa lista del pannello "In coda" del player,
// con auto-scroll sul brano corrente e salto diretto al click.
function QueueList() {
  const queue = useApp((s) => s.player.queue);
  const queueIndex = useApp((s) => s.player.queueIndex);
  const playing = useApp((s) => s.player.playing);
  const radio = useApp((s) => s.player.radio);
  const playAt = useApp((s) => s.playAt);
  const removeFromQueue = useApp((s) => s.removeFromQueue);
  const curRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { curRef.current?.scrollIntoView({ block: 'center' }); }, [queueIndex]);

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-6">
      {queue.length === 0 && <div className="text-xs text-dim py-6 text-center">Coda vuota.</div>}
      {queue.map((t, i) => (
        <div key={`${t.videoId}-${i}`} ref={i === queueIndex ? curRef : undefined}
          onClick={() => playAt(i)}
          className={`group flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-panel2/70 ${i === queueIndex ? 'bg-accent/10' : ''}`}>
          <div className="w-9 h-9 rounded bg-panel2 overflow-hidden shrink-0">
            <CoverImg src={t.thumbnail} trackId={t.id} videoId={t.videoId} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <div className={`text-xs font-medium truncate ${i === queueIndex ? 'text-accent' : ''}`}>{t.title}</div>
            <div className="text-[10px] text-dim truncate">{t.artist}</div>
          </div>
          {i === queueIndex && playing && <div className="eq"><i /><i /><i /></div>}
          <button onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}
            title="Rimuovi dalla coda"
            className="opacity-0 group-hover:opacity-100 max-md:opacity-100 text-dim hover:text-red-400 transition-opacity shrink-0">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {radio && queue.length > 0 && (
        <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-accent/80">
          <Radio size={12} /> Radio infinita: a fine coda continua con brani simili
        </div>
      )}
    </div>
  );
}

// Sleep timer nella vista brano (su mobile la barra lo nasconde): stesso menu
// del PlayerBar — minuti o "a fine brano".
const SLEEP_OPTS: (number | 'end')[] = [5, 10, 15, 30, 45, 60, 'end'];
function MobileSleep() {
  const sleepAt = useApp((s) => s.sleepAt);
  const sleepEnd = useApp((s) => s.sleepEndOfTrack);
  const setSleepTimer = useApp((s) => s.setSleepTimer);
  const [open, setOpen] = useState(false);
  const active = sleepAt != null || sleepEnd;
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} title="Sleep timer"
        className={active ? 'text-accent' : 'text-dim'}>
        <Moon size={16} fill={active ? 'currentColor' : 'none'} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-7 right-0 z-50 w-40 bg-panel2 border border-line rounded-lg shadow-2xl py-1">
            <div className="px-3 py-1.5 text-[11px] text-dim uppercase tracking-wide">Spegni tra</div>
            {SLEEP_OPTS.map((v) => (
              <button key={String(v)} onClick={() => { setSleepTimer(v); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-line/60">
                {v === 'end' ? 'A fine brano' : `${v} min`}
              </button>
            ))}
            {active && (
              <button onClick={() => { setSleepTimer(null); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-line/60 border-t border-line/60">
                Disattiva
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}


// ---- Ambient light: colore dominante da copertina o dal frame video ----
// Il video YouTube (googlevideo) non manda CORS → drawImage "sporca" il canvas
// e getImageData lancia: in quel caso si resta sul colore della copertina.
// Campionamento a 24×14 px ogni ~700ms: costo trascurabile, effetto continuo.
function useAmbient(imgUrl: string | undefined, video: HTMLVideoElement | null, active: boolean): string {
  const [rgb, setRgb] = useState('255,77,109');
  useEffect(() => {
    if (!imgUrl) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = 24; c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, 24, 24);
        setRgb(dominant(ctx.getImageData(0, 0, 24, 24).data));
      } catch { /* CORS: resta il default */ }
    };
    img.src = imgUrl;
  }, [imgUrl]);
  useEffect(() => {
    if (!video || !active) return;
    const c = document.createElement('canvas'); c.width = 24; c.height = 14;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    let ok = true;
    const iv = setInterval(() => {
      if (!ok || !ctx || video.readyState < 2 || video.paused) return;
      try { ctx.drawImage(video, 0, 0, 24, 14); setRgb(dominant(ctx.getImageData(0, 0, 24, 14).data)); }
      catch { ok = false; clearInterval(iv); } // tainted canvas: il video non è campionabile
    }, 700);
    return () => clearInterval(iv);
  }, [video, active]);
  return rgb;
}

// Colore "vivo": media dei pixel saturi, evitando neri/bianchi che appiattirebbero
function dominant(d: Uint8ClampedArray): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    if (max < 40 || (max > 235 && min > 200) || max - min < 25) continue; // scuro, bianco o grigio
    r += R; g += G; b += B; n++;
  }
  if (n < 6) return '255,77,109';
  // Boost di saturazione leggero: l'alone deve "accendersi", non essere pastello
  const R = r / n, G = g / n, B = b / n, m = (R + G + B) / 3;
  const s = (v: number) => Math.round(Math.min(255, Math.max(0, m + (v - m) * 1.35)));
  return `${s(R)},${s(G)},${s(B)}`;
}

// Vista espansa: video YouTube (muto, segue l'audio) + testo sincronizzato LRCLIB.
// L'audio resta sempre al doppio <audio> di PlayerBar — qui il video è solo visivo.
// Modalità: 'cinema' (solo video full-bleed con karaoke sovrimpresso) o
// 'split' (video + colonna testo/coda). Fullscreen (F), PiP, HD 1080p.
export default function NowPlaying({ cur, time, dur, playing, onClose, onSeek }: {
  cur: TrackRef; time: number; dur: number; playing: boolean; onClose: () => void; onSeek: (t: number) => void;
}) {
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [lyrLoading, setLyrLoading] = useState(true);
  const [vSrc, setVSrc] = useState<string | null>(null);
  const [vFail, setVFail] = useState(false);
  const [tab, setTab] = useState<'lyr' | 'queue'>('lyr');
  const [mode, setMode] = usePersistedState<'cinema' | 'split'>('mh-pref-npmode', 'split');
  const [hd, setHd] = usePersistedState('mh-pref-videohd', false);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false); // in cinema i controlli spariscono dopo 2.5s senza mouse
  const [vEl, setVEl] = useState<HTMLVideoElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const actRef = useRef<HTMLDivElement | null>(null);
  const idleT = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Su mobile i toggle secondari escono dalla mini-bar e vivono qui
  const shuffle = useApp((s) => s.player.shuffle);
  const repeat = useApp((s) => s.player.repeat);
  const radio = useApp((s) => s.player.radio);
  const toggleShuffle = useApp((s) => s.toggleShuffle);
  const cycleRepeat = useApp((s) => s.cycleRepeat);
  const toggleRadio = useApp((s) => s.toggleRadio);

  const hasVid = VID_RE.test(cur.videoId);
  const isLocal = !!(cur as LibraryTrack).filePath;
  const cover = cur.thumbnail?.replace(/w\d+-h\d+/, 'w544-h544');
  const rgb = useAmbient(cover, vEl, !!vSrc);

  // Testo: match esatto per artista/titolo/durata, poi ricerca libera (cache per videoId)
  useEffect(() => {
    const hit = lyrCache.get(cur.videoId);
    if (hit) { setLyrics(hit); setLyrLoading(false); return; }
    let dead = false;
    setLyrics(null); setLyrLoading(true);
    api().yt.lyrics(cur.artist, cur.title, dur > 0 ? dur : undefined)
      .then((r) => { lyrCache.set(cur.videoId, r); if (!dead) { setLyrics(r); setLyrLoading(false); } })
      .catch(() => { if (!dead) setLyrLoading(false); });
    return () => { dead = true; };
  }, [cur.videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tasto indietro hardware (Android): la vista brano si chiude come con Esc.
  useEffect(() => pushBack(() => { onClose(); return true; }), [onClose]);

  // Tastiera: Esc chiude (o esce dal fullscreen), F fullscreen, C cinema/split
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape') { if (document.fullscreenElement) void document.exitFullscreen(); else onClose(); }
      else if (e.key.toLowerCase() === 'f') { e.preventDefault(); void toggleFs(); }
      else if (e.key.toLowerCase() === 'c') { e.preventDefault(); setMode(mode === 'cinema' ? 'split' : 'cinema'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const f = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => { document.removeEventListener('fullscreenchange', f); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); };
  }, []);
  const toggleFs = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await rootRef.current?.requestFullscreen(); }
    catch { /* non supportato (es. WebView vecchia) */ }
  };
  const togglePip = async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (vEl && document.pictureInPictureEnabled) await vEl.requestPictureInPicture();
    } catch { useApp.getState().toast('Picture-in-Picture non disponibile qui', 'info'); }
  };

  // Video: stream video-only via yt-dlp; qualità 720 o 1080 (HD) — solo se l'ID è un videoId YouTube valido
  useEffect(() => {
    setVSrc(null); setVFail(false);
    if (!hasVid) return;
    let dead = false;
    api().yt.videoUrl(cur.videoId, hd ? 1080 : 720)
      .then((u) => { if (!dead) setVSrc(u); })
      .catch(() => { if (!dead) setVFail(true); });
    return () => { dead = true; };
  }, [cur.videoId, hd]); // eslint-disable-line react-hooks/exhaustive-deps

  // Il video segue play/pausa dell'audio
  useEffect(() => {
    if (!vEl || !vSrc) return;
    if (playing) void vEl.play().catch(() => {});
    else vEl.pause();
  }, [playing, vSrc, vEl]);

  // Resync se la deriva supera ~0.35s (buffering, seek sulla barra)
  useEffect(() => {
    if (!vEl || !vSrc) return;
    if (Math.abs(vEl.currentTime - time) > 0.35) { try { vEl.currentTime = time; } catch { /* stream non seekabile */ } }
  }, [time, vSrc, vEl]);

  // Riga attiva del testo sincronizzato (+0.4s di anticipo per leggere in tempo)
  const synced = lyrics?.synced;
  let actIdx = -1;
  if (synced) for (let i = 0; i < synced.length; i++) { if (synced[i].t <= time + 0.4) actIdx = i; else break; }
  useEffect(() => { actRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [actIdx]);

  // Automazione: se il testo non c'è ma la coda sì, mostra direttamente la coda
  useEffect(() => {
    if (!lyrLoading && !lyrics?.found && useApp.getState().player.queue.length > 1) setTab('queue');
  }, [lyrLoading, lyrics]);

  // Cinema: controlli a scomparsa quando il mouse sta fermo
  const wake = () => {
    setIdle(false);
    if (idleT.current) clearTimeout(idleT.current);
    idleT.current = setTimeout(() => setIdle(true), 2500);
  };
  useEffect(() => { if (mode === 'cinema') wake(); else setIdle(false); return () => { if (idleT.current) clearTimeout(idleT.current); }; }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const cinema = mode === 'cinema';
  const hideUi = cinema && idle && playing;
  const iconBtn = 'w-9 h-9 rounded-full bg-black/40 backdrop-blur border border-white/10 text-white/85 hover:text-white hover:bg-black/60 flex items-center justify-center transition-colors disabled:opacity-40';

  const videoBox = (
    <div className="relative w-full h-full flex items-center justify-center">
      {vSrc ? (
        <video ref={setVEl} src={vSrc} muted playsInline autoPlay={playing}
          onLoadedMetadata={(e) => { e.currentTarget.muted = true; try { e.currentTarget.currentTime = time; } catch { /* */ } }}
          onError={() => { setVSrc(null); setVFail(true); }}
          className={`max-w-full max-h-full bg-black object-contain ${cinema ? 'w-full h-full' : 'rounded-2xl shadow-[0_30px_80px_-20px_rgba(0,0,0,.9)]'}`}
          style={cinema ? undefined : { boxShadow: `0 30px 90px -20px rgba(0,0,0,.9), 0 0 120px -30px rgba(${rgb},.55)` }} />
      ) : (
        <div className="relative">
          <div className="w-64 h-64 md:w-80 md:h-80 rounded-3xl bg-panel2 overflow-hidden flex items-center justify-center"
            style={{ boxShadow: `0 30px 90px -20px rgba(0,0,0,.9), 0 0 140px -30px rgba(${rgb},.6)` }}>
            {cover
              ? <CoverImg src={cover} trackId={cur.id} videoId={cur.videoId} eager
                  className={`w-full h-full object-cover ${playing ? '' : 'grayscale-[.3]'}`}
                  icon={<Disc3 size={80} className={`text-dim ${playing ? 'spin-slow text-accent' : ''}`} />} />
              : <Disc3 size={80} className={`text-dim ${playing ? 'spin-slow text-accent' : ''}`} />}
          </div>
          {hasVid && !vSrc && !vFail && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/35 rounded-3xl"><div className="eq"><i /><i /><i /><i /></div></div>
          )}
          {(vFail || !hasVid) && (
            <div className="absolute -bottom-8 left-0 right-0 flex items-center justify-center gap-1.5 text-[11px] text-white/60">
              <VideoOff size={12} /> {hasVid ? 'Video non disponibile' : 'Nessun video per questo brano'}
            </div>
          )}
        </div>
      )}
      {/* Karaoke sovrimpresso in cinema: riga attuale grande + prossima */}
      {cinema && synced && actIdx >= 0 && (
        <div className="absolute inset-x-0 bottom-[12%] flex flex-col items-center px-8 pointer-events-none">
          <div key={actIdx} className="text-2xl md:text-4xl font-black text-white text-center leading-tight drop-shadow-[0_2px_18px_rgba(0,0,0,.9)] animate-[fadeUp_.35s_ease]">{synced[actIdx].text}</div>
          {synced[actIdx + 1] && <div className="mt-2 text-base md:text-xl text-white/55 text-center drop-shadow-lg">{synced[actIdx + 1].text}</div>}
        </div>
      )}
    </div>
  );

  return (
    <motion.div ref={rootRef} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 24 }}
      transition={{ duration: 0.22 }} onMouseMove={wake} onTouchStart={wake}
      className={`fixed inset-x-0 top-0 z-40 flex flex-col overflow-hidden bg-bg ${fs ? 'bottom-0' : 'bottom-20 max-md:bottom-[calc(var(--mobile-nav-height)+64px)]'} ${hideUi ? 'cursor-none' : ''}`}>
      {/* Ambient light: due aloni col colore dominante, che respirano piano */}
      <div className="absolute inset-0 pointer-events-none transition-[background] duration-1000"
        style={{ background: `radial-gradient(60% 70% at 25% 20%, rgba(${rgb},${cinema ? .22 : .38}), transparent 65%), radial-gradient(50% 60% at 80% 85%, rgba(${rgb},${cinema ? .14 : .26}), transparent 65%), var(--color-bg)` }} />
      {!cinema && cover && <div className="absolute inset-0 pointer-events-none bg-cover bg-center opacity-[.18]" style={{ backgroundImage: `url(${cover})`, filter: 'blur(70px) saturate(1.4)', transform: 'scale(1.3)' }} />}

      {/* Header */}
      <div className={`relative flex items-center gap-3 px-5 md:px-6 py-3 shrink-0 transition-opacity duration-300 max-md:flex-wrap max-md:gap-y-2 ${hideUi ? 'opacity-0' : 'opacity-100'}`}>
        <div className="min-w-0 flex-1 max-md:w-full max-md:flex-none">
          <div className="text-[10px] font-bold tracking-[0.2em] text-white/50 uppercase">In riproduzione{isLocal ? ' · file locale' : ''}</div>
          <div className="text-base font-bold truncate leading-tight">{cur.title}</div>
          <div className="text-xs text-white/70 truncate">{cur.artist}</div>
        </div>
        {/* Su mobile i toggle secondari escono dalla mini-bar e vivono qui */}
        <div className="flex items-center gap-3 md:hidden shrink-0">
          <button onClick={toggleShuffle} title="Riproduzione casuale" className={shuffle ? 'text-accent' : 'text-white/60'}><Shuffle size={16} /></button>
          <button onClick={cycleRepeat} className={repeat !== 'off' ? 'text-accent' : 'text-white/60'}>{repeat === 'one' ? <Repeat1 size={16} /> : <Repeat size={16} />}</button>
          <button onClick={toggleRadio} title="Radio infinita" className={radio ? 'text-accent' : 'text-white/60'}><Radio size={16} /></button>
          <MobileSleep />
        </div>
        <div className="flex items-center gap-1.5 shrink-0 max-md:ml-auto">
          <button onClick={() => setMode(cinema ? 'split' : 'cinema')} title={cinema ? 'Mostra testo e coda (C)' : 'Modalità cinema: solo video (C)'} className={iconBtn}>
            {cinema ? <PanelRightOpen size={16} /> : <Clapperboard size={16} />}
          </button>
          {hasVid && (
            <button onClick={() => setHd(!hd)} title={hd ? 'HD 1080p attivo — torna a 720p' : 'Qualità HD 1080p'}
              className={`${iconBtn} text-[10px] font-black tracking-wide ${hd ? '!bg-accent !border-accent !text-white' : ''}`}>HD</button>
          )}
          {vSrc && 'pictureInPictureEnabled' in document && (
            <button onClick={() => void togglePip()} title="Picture-in-Picture: il video in una finestrella sopra tutto" className={`${iconBtn} max-md:hidden`}><PictureInPicture2 size={16} /></button>
          )}
          <button onClick={() => void toggleFs()} title={fs ? 'Esci da schermo intero (F)' : 'Schermo intero (F)'} className={iconBtn}>
            {fs ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button onClick={onClose} className={iconBtn} title="Chiudi (Esc)"><X size={17} /></button>
        </div>
      </div>

      <div className="relative flex-1 flex min-h-0 max-md:flex-col">
        {/* Colonna video */}
        <div className={`flex-1 min-w-0 min-h-0 ${cinema ? '' : 'p-4 md:p-8 md:pt-2'}`}>{videoBox}</div>

        {/* Colonna destra: testo e coda in tab (solo in split) */}
        {!cinema && (
          <div className="w-[400px] shrink-0 flex flex-col min-h-0 bg-black/25 backdrop-blur-md border-l border-white/5
            max-md:w-full max-md:border-l-0 max-md:border-t max-md:flex-none max-md:h-[42%]">
            <div className="flex items-center gap-1 px-4 py-2.5 shrink-0 border-b border-white/5">
              {([['lyr', 'Testo'], ['queue', 'In coda']] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`text-[10px] font-bold uppercase tracking-[0.15em] px-2.5 py-1.5 rounded-md transition-colors
                    ${tab === k ? 'text-white bg-white/10' : 'text-white/50 hover:text-white'}`}>{label}</button>
              ))}
            </div>
            {tab === 'queue' ? <QueueList /> : (
              <div className="flex-1 overflow-y-auto px-6 pb-10">
                {lyrLoading && <div className="py-6"><LoadingState label="Cerco il testo…" layout="inline" /></div>}
                {!lyrLoading && !lyrics?.found && <div className="text-xs text-white/50 py-6 text-center">Testo non trovato per questo brano.</div>}
                {synced ? (
                  <div className="space-y-1.5 py-3">
                    {synced.map((l, i) => (
                      <div key={i} ref={i === actIdx ? actRef : undefined} onClick={() => onSeek(l.t)} title="Vai a questo punto del brano"
                        className={`text-[17px] font-semibold leading-snug py-1 cursor-pointer transition-all duration-300 hover:text-white ${
                          i === actIdx ? 'text-white scale-[1.03] origin-left drop-shadow-[0_0_14px_rgba(255,255,255,.35)]'
                            : i < actIdx ? 'text-white/30' : 'text-white/55'}`}>
                        {l.text}
                      </div>
                    ))}
                  </div>
                ) : lyrics?.plain ? (
                  <div className="text-[15px] leading-relaxed text-white/70 whitespace-pre-line py-3">{lyrics.plain}</div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
