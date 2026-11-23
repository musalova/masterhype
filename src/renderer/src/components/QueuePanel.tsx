import { useRef, useState } from 'react';
import { X, GripVertical, ListX, ListPlus } from 'lucide-react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import { useApp } from '../store';
import { CoverImg } from './CoverImg';
import type { TrackRef } from '../../../shared/types';

// Pannello "In coda": lista dei brani in riproduzione, click per saltare, X per
// rimuovere, grip per il riordino drag&drop; in testa "salva come playlist" e
// "svuota" (stile Spotify: resta solo il brano in riproduzione).
export default function QueuePanel({ onClose }: { onClose: () => void }) {
  const { player, playAt, removeFromQueue, moveQueue, clearQueue, saveQueueAsPlaylist } = useApp();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const dragIdx = useRef(-1);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-24 right-4 w-80 max-h-96 bg-panel border border-line rounded-xl shadow-2xl shadow-black/60 flex flex-col z-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold">In coda · {player.queue.length}</span>
        <div className="flex items-center gap-1.5">
          {!!player.queue.length && (
            <>
              <button onClick={() => setSaving((v) => !v)} aria-label="Salva la coda come playlist" title="Salva come playlist"
                className={`hover:text-txt ${saving ? 'text-accent' : 'text-dim'}`}><ListPlus size={15} /></button>
              <button onClick={() => { clearQueue(); }} aria-label="Svuota la coda" title="Svuota la coda"
                className="text-dim hover:text-red-400"><ListX size={15} /></button>
            </>
          )}
          <button onClick={onClose} aria-label="Chiudi la coda" title="Chiudi" className="text-dim hover:text-txt"><X size={15} /></button>
        </div>
      </div>
      {saving && (
        <div className="px-3 py-2 border-b border-line flex items-center gap-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') { setSaving(false); await saveQueueAsPlaylist(name || 'Coda salvata'); onClose(); }
              if (e.key === 'Escape') setSaving(false);
            }}
            placeholder="Nome della playlist…"
            className="flex-1 min-w-0 bg-panel2 border border-line rounded px-2 py-1 text-xs outline-none focus:border-accent" />
          <button onClick={async () => { setSaving(false); await saveQueueAsPlaylist(name || 'Coda salvata'); onClose(); }}
            className="text-xs text-accent hover:underline shrink-0">Salva</button>
        </div>
      )}
      <div className="overflow-y-auto flex-1 py-1">
        <Reorder.Group axis="y" values={player.queue}
          onReorder={(ord: (TrackRef & { local?: boolean })[]) => {
            const to = dragIdx.current >= 0 ? ord.indexOf(player.queue[dragIdx.current]) : -1;
            if (to >= 0) moveQueue(dragIdx.current, to);
          }}
          className="list-none">
          {player.queue.map((t, i) => (
            <QRow key={`${t.videoId}-${i}`} t={t} i={i}
              active={i === player.queueIndex} playing={player.playing}
              onPlay={() => playAt(i)} onRemove={() => removeFromQueue(i)}
              onDragStart={() => { dragIdx.current = i; }} />
          ))}
        </Reorder.Group>
        {player.queue.length === 0 && <div className="px-4 py-6 text-xs text-dim text-center">Coda vuota — riproduci un brano.</div>}
      </div>
    </motion.div>
  );
}

function QRow({ t, i: _i, active, playing, onPlay, onRemove, onDragStart }: {
  t: TrackRef & { local?: boolean }; i: number; active: boolean; playing: boolean;
  onPlay: () => void; onRemove: () => void; onDragStart: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item value={t} dragListener={false} dragControls={controls} onDragStart={onDragStart}
      className={`group flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-panel2/70 ${active ? 'bg-accent/10' : ''}`}
      onClick={onPlay}>
      <button onPointerDown={(e) => { e.stopPropagation(); controls.start(e); }} onClick={(e) => e.stopPropagation()}
        aria-label={`Trascina ${t.title}`} title="Trascina per riordinare"
        className="opacity-0 group-hover:opacity-100 max-md:opacity-100 text-dim hover:text-txt cursor-grab active:cursor-grabbing touch-none shrink-0">
        <GripVertical size={13} />
      </button>
      <div className="w-8 h-8 rounded bg-panel2 overflow-hidden shrink-0">
        <CoverImg src={t.thumbnail} trackId={t.id} videoId={t.videoId} className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <div className={`text-xs font-medium truncate ${active ? 'text-accent' : ''}`}>{t.title}</div>
        <div className="text-[10px] text-dim truncate">{t.artist}</div>
      </div>
      {active && playing && <div className="eq"><i /><i /><i /></div>}
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }}
        aria-label={`Togli ${t.title} dalla coda`} title="Togli dalla coda"
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 text-dim hover:text-red-400 transition-opacity"><X size={13} /></button>
    </Reorder.Item>
  );
}
