import { useEffect, useState } from 'react';
import { Play, Download, Disc3, ListPlus, Heart, ThumbsDown, Trash2, ChevronUp, ChevronDown, Check, Smartphone, Loader2, MoreHorizontal, ListEnd, Radio } from 'lucide-react';
import { motion } from 'framer-motion';
import { useApp } from '../store';
import { api, isRemote } from '../api';
import { pcGone, isOnline, syncNote, isStandalone } from '../remote';
import { phoneVidId } from '../phoneLocal';
import { CoverImg } from './CoverImg';
import type { TrackRef, LibraryTrack, Playlist } from '../../../shared/types';

const fmt = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '—');

export default function TrackRow({ t, index, queue, radio, showAddCd = true, showRemove = false, dangerRemove = false, onRemove, move, checked, onCheck }: {
  t: TrackRef | LibraryTrack;
  index?: number;
  queue?: (TrackRef | LibraryTrack)[];
  radio?: boolean; // la riga vive in una stazione: a fine coda la radio continua
  showAddCd?: boolean;
  showRemove?: boolean;
  dangerRemove?: boolean;
  onRemove?: () => void;
  move?: (dir: -1 | 1) => void;
  checked?: boolean;
  onCheck?: (v: boolean) => void;
}) {
  // Selettori mirati: la riga si ridisegna solo quando cambia ciò che la riguarda —
  // non a ogni tick di download, toast o evento store (prima tutte le righe insieme).
  const lib = t as LibraryTrack;
  const play = useApp((s) => s.play);
  const addDownload = useApp((s) => s.addDownload);
  const addToCd = useApp((s) => s.addToCd);
  const downloadToCd = useApp((s) => s.downloadToCd);
  const toggleLike = useApp((s) => s.toggleLike);
  const dislike = useApp((s) => s.dislike);
  const toast = useApp((s) => s.toast);
  const nav = useApp((s) => s.nav);
  const libTrack = useApp((s) => (lib.id != null ? lib : s.library.find((x) => x.videoId === t.videoId)));
  const liked = useApp((s) => (libTrack ? libTrack.liked : (t.videoId ? !!s.remoteLiked[t.videoId] : false)));
  const isCurrent = useApp((s) => s.player.current?.videoId === t.videoId);
  const playingNow = useApp((s) => s.player.playing);
  const buffering = useApp((s) => s.buffering);
  // "Sul telefono" vale anche per brani non in libreria (id sintetico da videoId)
  const pid = lib.id ?? (t.videoId ? phoneVidId(t.videoId) : null);
  const onPhone = useApp((s) => (pid != null && s.phoneIds.has(pid)));
  const phoneBusy = useApp((s) => (pid != null && s.phoneDl.has(pid)));
  const phonePct = useApp((s) => (pid != null ? s.phoneDlPct[pid] : undefined));
  // Riga "solo telefono" (file eliminato sul PC): le azioni che parlano col PC
  // (CD, download, playlist) non hanno senso e fallirebbero.
  const phoneOnly = !!lib.phoneOnly;
  const downloadToPhone = useApp((s) => s.downloadToPhone);
  const removeFromPhone = useApp((s) => s.removeFromPhone);

  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pls, setPls] = useState<Playlist[]>([]);
  const [plsLoading, setPlsLoading] = useState(false);
  const inLib = lib.id != null || !!libTrack;

  // Il menu si apre subito: la lista playlist arriva un attimo dopo —
  // su remoto la fetch può durare e un click "muto" sembra un bug
  const openMenu = () => {
    setMenu(true);
    if (t.videoId && !pls.length && !plsLoading) {
      setPlsLoading(true);
      void api().playlists.list()
        .then(setPls)
        .catch(() => setPls([]))
        .finally(() => setPlsLoading(false));
    }
  };

  // I transform di framer-motion rompono i `fixed` dentro la row: chiudo al click esterno via listener.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menu]);

  return (
    // Niente `layout`: su liste lunghe framer misurava ogni riga a ogni render.
    // `row-cv` (content-visibility) salta impaginazione/paint delle righe fuori schermo.
    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index ?? 0, 12) * 0.025, ease: 'easeOut' }}
      className={`row-cv group flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-panel2/70 transition-colors relative ${checked ? 'bg-accent/10' : ''}`}>
      {onCheck != null && (
        <input type="checkbox" checked={!!checked} onChange={(e) => onCheck(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          className={`w-3.5 h-3.5 accent-[--color-accent] cursor-pointer shrink-0 transition-opacity ${checked ? '' : 'opacity-0 group-hover:opacity-100 max-md:opacity-60'}`} />
      )}
      <div className="w-6 text-xs text-dim text-center shrink-0 max-md:hidden">
        {isCurrent && buffering
          ? <Loader2 size={13} className="text-accent animate-spin mx-auto" />
          : isCurrent && playingNow ? <div className="eq"><i /><i /><i /></div> : (index != null ? index + 1 : '')}
      </div>
      <button onClick={() => play(t, queue, undefined, radio)} className="w-9 h-9 rounded bg-panel2 overflow-hidden shrink-0 relative">
        <CoverImg src={t.thumbnail} trackId={pid} videoId={t.videoId} className="w-full h-full object-cover" />
        <div className={`absolute inset-0 bg-black/50 flex items-center justify-center transition-opacity
          ${isCurrent && buffering ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
          {isCurrent && buffering ? <Loader2 size={15} className="text-white animate-spin" /> : <Play size={14} className="text-white" />}
        </div>
      </button>
      <div className="flex-1 min-w-0 cursor-pointer" onClick={() => play(t, queue, undefined, radio)} title="Riproduci">
        <div className={`text-sm font-medium truncate ${isCurrent ? 'text-accent' : ''}`}>{t.title}</div>
        <div className="text-xs text-dim truncate">{t.artist}{lib.album ? ` · ${lib.album}` : ''}</div>
      </div>
      <div className="text-xs text-dim w-10 text-right shrink-0 max-md:hidden">{fmt(t.durationS)}</div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Azioni primarie sempre visibili */}
        {/* CD e libreria del PC: senza PC (standalone) non esistono — il
            download utile è quello sul telefono, qui sotto */}
        {showAddCd && !phoneOnly && !isStandalone() && (
          <button
            onClick={() => (libTrack ? addToCd(libTrack) : void downloadToCd(t))}
            className="p-1 text-dim hover:text-accent"
            title={libTrack ? 'Aggiungi al CD' : 'Scarica e aggiungi al CD'}>
            <Disc3 size={15} />
          </button>
        )}
        {!inLib && !isStandalone() && (
          // addDownload accoda da sé quando il PC è giù: chi arriva nel catch
          // ha un errore applicativo a PC vivo — non può dare la colpa al PC.
          <button onClick={() => { void addDownload(t).catch(() => toast(`Download sul PC non avviato — ${isRemote() && !isOnline() ? pcGone() : 'riprova'}`, 'info')); }}
            className="p-1 text-dim hover:text-txt" title="Scarica in libreria (sul PC)">
            <Download size={15} />
          </button>
        )}
        {inLib && !lib.id && <Check size={15} className="text-accent p-1" />}
        {/* Copia fisica sul telefono: riproducibile anche senza rete/PC.
            Vale per QUALSIASI brano — risultati di ricerca compresi (download diretto) */}
        {isRemote() && pid != null && (
          phoneBusy ? (
            <span className="flex items-center gap-0.5 text-accent" title="Download sul telefono in corso">
              <Loader2 size={15} className="p-1 animate-spin" />
              {phonePct != null && <span className="text-[9px] font-medium w-7">{Math.round(phonePct * 100)}%</span>}
            </span>
          ) : (
            <button
              onClick={() => (onPhone ? void removeFromPhone(pid) : void downloadToPhone(t).catch(() => {}))}
              className={`p-1 ${onPhone ? 'text-accent' : 'text-dim hover:text-txt'}`}
              title={onPhone ? 'Sul telefono — tocca per rimuovere' : 'Scarica sul telefono (offline)'}>
              <Smartphone size={15} fill={onPhone ? 'currentColor' : 'none'} />
            </button>
          )
        )}
        {/* Like universale: funziona anche su brani non scaricati. Se è già
            "mi piace" resta SEMPRE visibile (come la spunta verde di Spotify) */}
        <button onClick={() => toggleLike(t)}
          className={`p-1 transition-opacity ${liked ? 'text-accent' : 'text-dim hover:text-accent opacity-0 group-hover:opacity-100 max-md:opacity-100'}`}
          title={liked ? 'Togli dai preferiti' : 'Mi piace'}>
          <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
        </button>
        {/* Azioni secondarie on hover — sempre visibili su touch (niente hover) */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 max-md:opacity-100 transition-opacity">
          {move && (
            <>
              <button onClick={() => move(-1)} className="p-1 text-dim hover:text-txt" title="Su"><ChevronUp size={15} /></button>
              <button onClick={() => move(1)} className="p-1 text-dim hover:text-txt" title="Giù"><ChevronDown size={15} /></button>
            </>
          )}
          <button onClick={() => dislike(t)}
            className="p-1 text-dim hover:text-orange-400" title="Meno così — il motore impara">
            <ThumbsDown size={14} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); void openMenu(); }} className="p-1 text-dim hover:text-txt" title="Altre opzioni">
            <MoreHorizontal size={15} />
          </button>
          {showRemove && (
            <button
              onClick={() => {
                if (!dangerRemove || confirming) { setConfirming(false); onRemove?.(); }
                else { setConfirming(true); setTimeout(() => setConfirming(false), 3000); }
              }}
              className={`p-1 ${confirming ? 'text-red-400' : 'text-dim hover:text-red-400'}`}
              title={confirming ? 'Conferma: elimina anche il file' : 'Rimuovi'}>
              {confirming ? <span className="text-[10px] font-bold whitespace-nowrap">Sicuro?</span> : <Trash2 size={15} />}
            </button>
          )}
        </div>
      </div>

      {menu && (
        <>
          <div className="absolute right-2 top-9 z-40 w-52 bg-panel2 border border-line rounded-lg shadow-2xl py-1"
            onClick={(e) => e.stopPropagation()}>
            {/* Azioni rapide stile Spotify: coda e radio valgono per ogni brano */}
            <button onClick={() => { setMenu(false); useApp.getState().enqueue(t); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-line/60 text-left">
              <ListEnd size={14} className="text-dim" /> Aggiungi in coda
            </button>
            <button onClick={() => { setMenu(false); useApp.getState().openStation({ kind: 'radio', radioKind: 'artist', value: t.artist }); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-line/60 text-left">
              <Radio size={14} className="text-dim" /> Radio di {t.artist}
            </button>
            {/* Qualsiasi brano, anche non scaricato (stile Spotify): se non è in
                libreria il PC lo scarica e lo aggiunge appena pronto; senza PC
                la playlist si aggiorna subito sul telefono e si sincronizza dopo */}
            {!!t.videoId && (
              <>
                <div className="px-3 py-1.5 text-[11px] text-dim uppercase tracking-wide border-t border-line/60 mt-1">Aggiungi a playlist</div>
                {plsLoading && <div className="px-3 py-2 text-xs text-dim flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Carico le playlist…</div>}
                {!plsLoading && pls.length === 0 && <div className="px-3 py-2 text-xs text-dim">Nessuna playlist — creala in Playlist</div>}
                {pls.map((p) => (
                  <button key={p.id}
                    onClick={async () => {
                      setMenu(false);
                      try {
                        const r = await api().playlists.addRef(p.id, libTrack ?? t);
                        toast(r.queued ? `"${t.title}" in download — lo aggiungo a "${p.name}" appena pronto` : `Aggiunto a "${p.name}"${syncNote()}`, r.queued ? 'info' : 'ok');
                      } catch (e) {
                        toast(`Non aggiunto a "${p.name}": ${e instanceof Error ? e.message : e}`, 'err');
                      }
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-line/60 flex items-center gap-2.5">
                    <ListPlus size={14} className="text-dim" /> {p.name}
                  </button>
                ))}
                <button onClick={() => { setMenu(false); nav('playlists'); }}
                  className="w-full text-left px-3 py-2 text-xs text-accent hover:bg-line/60">Gestisci playlist →</button>
              </>
            )}
          </div>
        </>
      )}
    </motion.div>
  );
}
