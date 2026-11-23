import { useEffect, useState } from 'react';
import { X, Power } from 'lucide-react';
import { motion } from 'framer-motion';
import { useDeviceState } from '../persist';
import { EQ_BANDS, EQ_KEY, EQ_PRESETS, eqCanRoute, eqPresetName, type EqState } from '../equalizer';

// Pannello equalizzatore a 5 bande: preset stile Spotify + slider in dB.
// Stato per-dispositivo ('mh-device-eq'): il PC e il telefono hanno casse
// diverse — un preset auto sul telefono non deve inquinare il desktop.
export default function EqPanel({ onClose }: { onClose: () => void }) {
  const [eq, setEq] = useDeviceState<EqState>(EQ_KEY, { enabled: false, gains: [0, 0, 0, 0, 0] });
  const [routable, setRoutable] = useState(true);
  useEffect(() => { let d = false; void eqCanRoute().then((ok) => { if (!d) setRoutable(ok); }); return () => { d = true; }; }, []);
  const preset = eqPresetName(eq.gains);

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
      className="absolute bottom-24 right-4 w-80 max-w-[92vw] bg-panel border border-line rounded-xl shadow-2xl shadow-black/60 flex flex-col z-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-line">
        <span className="text-sm font-semibold flex items-center gap-2">
          Equalizzatore
          <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${eq.enabled ? 'bg-accent/15 text-accent' : 'bg-panel2 text-dim'}`}>{preset}</span>
        </span>
        <div className="flex items-center gap-2.5">
          <button onClick={() => setEq((p) => ({ ...p, enabled: !p.enabled }))}
            title={eq.enabled ? 'Spegni equalizzatore' : 'Accendi equalizzatore'}
            aria-label={eq.enabled ? 'Spegni equalizzatore' : 'Accendi equalizzatore'}
            className={`transition-colors ${eq.enabled ? 'text-accent' : 'text-dim hover:text-txt'}`}><Power size={15} /></button>
          <button onClick={onClose} aria-label="Chiudi equalizzatore" className="text-dim hover:text-txt"><X size={15} /></button>
        </div>
      </div>
      {!routable && (
        <div className="px-4 py-2 text-[11px] text-amber-400/90 border-b border-line/60">
          Equalizzatore non disponibile su questo dispositivo — aggiorna l'app.
        </div>
      )}
      <div className="px-3 py-2.5 flex flex-wrap gap-1.5 border-b border-line/60">
        {EQ_PRESETS.map((p) => (
          <button key={p.name}
            onClick={() => setEq({ enabled: true, gains: [...p.gains] })}
            className={`px-2 py-1 rounded text-[11px] transition-colors ${preset === p.name && eq.enabled ? 'bg-accent/20 text-accent' : 'bg-panel2 text-dim hover:text-txt'}`}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="px-4 py-3 space-y-2.5">
        {EQ_BANDS.map((b, i) => (
          <div key={b.freq} className="flex items-center gap-2.5">
            <span className="w-8 text-[10px] text-dim text-right shrink-0">{b.label}</span>
            <input aria-label={`Banda ${b.label}`} type="range" min={-12} max={12} step={1} value={eq.gains[i] ?? 0}
              disabled={!eq.enabled}
              onChange={(e) => setEq((p) => ({ enabled: p.enabled, gains: p.gains.map((v, j) => (j === i ? +e.target.value : v)) }))}
              className="flex-1 h-1 accent-[--color-accent] cursor-pointer disabled:opacity-40" />
            <span className={`w-9 text-[10px] text-right tabular-nums shrink-0 ${eq.gains[i] ? 'text-accent' : 'text-dim'}`}>
              {(eq.gains[i] ?? 0) > 0 ? '+' : ''}{eq.gains[i] ?? 0}
            </span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
