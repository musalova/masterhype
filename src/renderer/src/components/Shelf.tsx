import { useRef, useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Play, Pause, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { useApp } from '../store';
import { CoverImg } from './CoverImg';
import type { TrackRef, LibraryTrack } from '../../../shared/types';

// Riga orizzontale stile Netflix: frecce ‹ › appaiono all'hover e scorrono la riga.
export function Shelf({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canL, setCanL] = useState(false);
  const [canR, setCanR] = useState(true);

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setCanL(el.scrollLeft > 8);
    setCanR(el.scrollLeft < el.scrollWidth - el.clientWidth - 8);
  };
  useEffect(() => {
    update();
    const el = ref.current;
    el?.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { el?.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [children]);

  const go = (dir: -1 | 1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * Math.round(el.clientWidth * 0.85), behavior: 'smooth' });
  };

  return (
    <div className="shelf-wrap">
      <div ref={ref} className="shelf">{children}</div>
      <button className="shelf-arrow left" disabled={!canL} onClick={() => go(-1)} aria-label="Scorri a sinistra">
        <ChevronLeft size={26} />
      </button>
      <button className="shelf-arrow right" disabled={!canR} onClick={() => go(1)} aria-label="Scorri a destra">
        <ChevronRight size={26} />
      </button>
    </div>
  );
}

// Poster di un brano: copertina quadrata, hover-zoom + velo con play, titolo sotto.
export function TrackPoster({ t, queue, i = 0, rank }: {
  t: TrackRef | LibraryTrack; queue?: (TrackRef | LibraryTrack)[]; i?: number; rank?: number;
}) {
  const play = useApp((s) => s.play);
  const isCurrent = useApp((s) => s.player.current?.videoId === t.videoId);
  const playing = useApp((s) => s.player.playing);
  const buffering = useApp((s) => s.buffering);
  const hi = t.thumbnail?.replace(/w\d+-h\d+/, 'w226-h226');

  return (
    <motion.button onClick={() => play(t, queue)}
      initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: Math.min(i, 10) * 0.04, ease: 'easeOut' }}
      className="poster text-left w-40"
      title={`${t.artist} — ${t.title}`}>
      <div className="relative">
        {rank != null && (
          <span className="rank-badge absolute -left-1 -top-3 z-10 text-3xl select-none" style={{ WebkitTextStroke: '1px rgba(0,0,0,.6)' }}>
            {rank}
          </span>
        )}
        <div className="poster-img w-40 h-40 bg-panel2">
          <CoverImg src={hi} trackId={(t as LibraryTrack).id} videoId={t.videoId} className="w-full h-full object-cover"
            icon={<span className="text-3xl text-dim/40">♪</span>} />
        </div>
        <div className={`poster-veil ${isCurrent && buffering ? 'opacity-100' : ''}`}>
          <span className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-xl">
            {isCurrent && buffering ? <Loader2 size={17} className="animate-spin" />
              : isCurrent && playing ? <Pause size={17} /> : <Play size={17} className="ml-0.5" />}
          </span>
        </div>
        {isCurrent && playing && !buffering && (
          <div className="absolute top-2 right-2 bg-black/60 rounded-full p-1.5 backdrop-blur">
            <div className="eq"><i /><i /><i /></div>
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <div className={`text-[13px] font-semibold truncate ${isCurrent ? 'text-accent' : ''}`}>{t.title}</div>
        <div className="text-[11px] text-dim truncate">{t.artist}</div>
      </div>
    </motion.button>
  );
}
