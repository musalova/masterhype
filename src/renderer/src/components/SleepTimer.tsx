import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { useApp } from '../store';

// Sleep timer stile Spotify: menu con minuti o "a fine brano"; quando attivo
// mostra il countdown residuo. Lo stato vive nello store (sleepAt/endOfTrack).
const SLEEP_OPTS: (number | 'end')[] = [5, 10, 15, 30, 45, 60, 'end'];
export default function SleepTimer() {
  const sleepAt = useApp((s) => s.sleepAt);
  const sleepEnd = useApp((s) => s.sleepEndOfTrack);
  const setSleepTimer = useApp((s) => s.setSleepTimer);
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!sleepAt) { setLeft(0); return; }
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000))), 5000);
    setLeft(Math.max(0, Math.ceil((sleepAt - Date.now()) / 60000)));
    return () => clearInterval(t);
  }, [sleepAt]);
  const active = sleepAt != null || sleepEnd;
  return (
    <div className="relative max-md:hidden">
      <button onClick={() => setOpen((v) => !v)}
        title={sleepEnd ? 'Sleep timer: pausa a fine brano' : sleepAt ? `Sleep timer: pausa tra ~${left} min` : 'Sleep timer — spegne la musica'}
        className={`transition-colors ${active ? 'text-accent' : 'text-dim hover:text-txt'}`}>
        <Moon size={16} fill={active ? 'currentColor' : 'none'} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-9 right-0 z-50 w-44 bg-panel2 border border-line rounded-lg shadow-2xl py-1">
            <div className="px-3 py-1.5 text-[11px] text-dim uppercase tracking-wide">Spegni la musica tra</div>
            {SLEEP_OPTS.map((v) => (
              <button key={String(v)}
                onClick={() => { setSleepTimer(v); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-line/60">
                {v === 'end' ? 'A fine brano' : `${v} minuti`}
              </button>
            ))}
            {active && (
              <button onClick={() => { setSleepTimer(null); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-red-400 hover:bg-line/60 border-t border-line/60">
                Disattiva timer
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
