import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { appVersion } from '../update';
import { whatsNewFor } from '../../../shared/whatsnew';

// Card "Novità": al primo avvio su una versione diversa dall'ultima vista
// (quindi dopo un aggiornamento installato) spiega in parole semplici cosa
// è cambiato. Una sola volta per versione — 'mh-seen-version' ricorda.
// Il rilevamento vale su tutte le piattaforme: APK (versione nativa del
// pacchetto), desktop (app:info) e client remoto (versione del PC che
// serve il renderer: PC aggiornato → il telefono in browser vede le novità).
const SEEN_KEY = 'mh-seen-version';

export default function WhatsNewCard() {
  const [ver, setVer] = useState('');
  const [notes, setNotes] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => {
      if (!alive || !v) return;
      let seen = '';
      try { seen = localStorage.getItem(SEEN_KEY) ?? ''; } catch { /* */ }
      if (seen === v) return; // stessa versione: niente da annunciare
      // Anche al primo avvio (seen vuoto): meglio mostrare le novità una
      // volta in più — altrimenti chi installa la prima versione con questa
      // card non vedrebbe mai nulla (la chiave non esisteva prima).
      setVer(v);
      setNotes(whatsNewFor(v));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const close = () => {
    try { localStorage.setItem(SEEN_KEY, ver); } catch { /* */ }
    setNotes(null);
  };

  return (
    <AnimatePresence>
      {notes && (
        <motion.div initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.96 }}
          className="w-full bg-panel border border-line rounded-2xl shadow-2xl glow p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-accent/15 text-accent flex items-center justify-center shrink-0">
              <Sparkles size={17} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold">Novità di MasterHype {ver}</div>
              <ul className="text-[11px] text-dim leading-snug mt-1.5 space-y-1">
                {notes.map((n, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-accent shrink-0">•</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </div>
            <button onClick={close} title="Chiudi" className="p-1 text-dim hover:text-txt shrink-0"><X size={14} /></button>
          </div>
          <button onClick={close}
            className="w-full py-2 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white text-xs font-bold hover:opacity-90">
            Perfetto
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
