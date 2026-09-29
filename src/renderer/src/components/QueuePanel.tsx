import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { useApp } from '../store';
import { CoverImg } from './CoverImg';

// Pannello "In coda": lista dei brani in riproduzione, click per saltare, X per rimuovere
export default function QueuePanel({ onClose }: { onClose: () => void }) {
  const { player, playAt, removeFromQueue } = useApp();
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-24 right-4 w-80 max-h-96 bg-panel border border-line rounded-xl shadow-2xl shadow-black/60 flex flex-col z-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold">In coda · {player.queue.length}</span>
        <button onClick={onClose} className="text-dim hover:text-txt"><X size={15} /></button>
      </div>
      <div className="overflow-y-auto flex-1 py-1">
        {player.queue.map((t, i) => (
          <div key={`${t.videoId}-${i}`}
            className={`group flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-panel2/70 ${i === player.queueIndex ? 'bg-accent/10' : ''}`}
            onClick={() => { playAt(i); }}>
            <div className="w-8 h-8 rounded bg-panel2 overflow-hidden shrink-0">
              <CoverImg src={t.thumbnail} trackId={t.id} videoId={t.videoId} className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-medium truncate ${i === player.queueIndex ? 'text-accent' : ''}`}>{t.title}</div>
              <div className="text-[10px] text-dim truncate">{t.artist}</div>
            </div>
            {i === player.queueIndex && player.playing && <div className="eq"><i /><i /><i /></div>}
            <button onClick={(e) => { e.stopPropagation(); removeFromQueue(i); }}
              className="opacity-0 group-hover:opacity-100 text-dim hover:text-red-400 transition-opacity"><X size={13} /></button>
          </div>
        ))}
        {player.queue.length === 0 && <div className="px-4 py-6 text-xs text-dim text-center">Coda vuota — riproduci un brano.</div>}
      </div>
    </motion.div>
  );
}
