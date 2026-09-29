import { motion, AnimatePresence } from 'framer-motion';
import { Download, RefreshCw, X, Smartphone, CheckCircle2, TriangleAlert, Monitor } from 'lucide-react';
import { useApp } from '../store';
import { useUpdate, downloadUpdate, installUpdate, dismissUpdate, resetUpdateError, checkUpdate, useDesktopUpdate, dismissDesktopUpdate } from '../update';

// Card aggiornamento APK: compare quando il PC (o la sorgente pubblica) ha una
// versione più nuova. Flusso: Scarica (con progresso) → Installa (intent di
// sistema) → Android fa il resto. "Ignora" zittisce solo QUESTA versione.
// Desktop: l'EXE nuovo è scaricato e verificato (electron-updater) → card
// "Riavvia e aggiorna". "Più tardi" non perde nulla: si installa da solo
// alla prossima uscita dal tray.
function DesktopUpdateCard() {
  const u = useDesktopUpdate();
  const toast = useApp((s) => s.toast);
  const visible = u.phase === 'ready' && u.dismissed !== u.version;
  return (
    <AnimatePresence>
      {visible && (
        <motion.div initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.96 }}
          className="w-full bg-panel border border-line rounded-2xl shadow-2xl glow p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-accent/15 text-accent flex items-center justify-center shrink-0"><Monitor size={17} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold">MasterHype {u.version} pronto</div>
              <div className="text-[11px] text-dim leading-snug mt-0.5">
                Scaricato e verificato. Riavvia ora, oppure si installerà da solo quando esci dal tray — libreria, profili e telefoni collegati restano intatti.
              </div>
            </div>
            <button onClick={dismissDesktopUpdate} title="Più tardi" className="p-1 text-dim hover:text-txt shrink-0"><X size={14} /></button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => { void window.masterhype?.app.updateInstall().catch((e: unknown) => toast(`Aggiornamento non avviato: ${e instanceof Error ? e.message : e}`, 'err')); }}
              className="flex-1 py-2 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:opacity-90">
              <RefreshCw size={13} /> Riavvia e aggiorna
            </button>
            <button onClick={dismissDesktopUpdate} className="px-3 py-2 rounded-xl bg-panel2 border border-line text-xs text-dim hover:text-txt">Più tardi</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function UpdateCard() {
  return window.masterhype ? <DesktopUpdateCard /> : <PhoneUpdateCard />;
}

function PhoneUpdateCard() {
  const u = useUpdate();
  const toast = useApp((s) => s.toast);

  const install = async () => {
    try {
      const r = await installUpdate();
      if (r === 'permission') toast('Android chiede il permesso "installa app sconosciute" — abilitalo e tocca di nuovo Installa', 'info');
      // 'gone': il file è sparito — la card è già tornata su 'Scarica'
    } catch (e) {
      toast(`Installazione non avviata: ${e instanceof Error ? e.message : e}`, 'err');
    }
  };

  const visible = u.phase === 'available' || u.phase === 'downloading' || u.phase === 'ready' || u.phase === 'error';
  return (
    <AnimatePresence>
      {visible && (
        <motion.div initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.96 }}
          className="w-full bg-panel border border-line rounded-2xl shadow-2xl glow p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="w-9 h-9 rounded-xl bg-accent/15 text-accent flex items-center justify-center shrink-0">
              <Smartphone size={17} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold">
                {u.phase === 'ready' ? 'Aggiornamento pronto' : u.phase === 'error' ? 'Aggiornamento fallito' : `MasterHype ${u.info?.versionName ?? ''} disponibile`}
              </div>
              <div className="text-[11px] text-dim leading-snug mt-0.5">
                {u.phase === 'available' && (u.info?.required
                  ? `Aggiornamento necessario (build ${u.info.versionCode}) — questa versione è troppo vecchia per continuare.`
                  : `Nuova versione (build ${u.info?.versionCode}) — scarica e installa in un tocco${u.info?.source === 'pc' ? ' dal tuo PC' : u.info?.source === 'lan' ? ' da un PC MasterHype in Wi-Fi' : ''}.`)}
                {u.phase === 'downloading' && 'Scaricamento in corso…'}
                {u.phase === 'ready' && 'File verificato. Android chiederà conferma e riavvierà l’app — preferenze, download e playlist restano intatti.'}
                {u.phase === 'error' && (u.msg ?? 'Errore sconosciuto')}
              </div>
            </div>
            {/* Update obbligatorio: niente X né Ignora — solo aggiornare */}
            {!u.info?.required && (
            <button onClick={() => (u.phase === 'error' ? resetUpdateError() : dismissUpdate())} title="Chiudi"
              className="p-1 text-dim hover:text-txt shrink-0"><X size={14} /></button>
            )}
          </div>

          {/* Novità della versione in arrivo (campo notes del manifest) */}
          {(u.phase === 'available' || u.phase === 'ready') && u.info?.notes && (
            <ul className="text-[11px] text-dim leading-snug space-y-1">
              {u.info.notes.split('\n').filter(Boolean).map((n, i) => (
                <li key={i} className="flex gap-1.5"><span className="text-accent shrink-0">•</span><span>{n}</span></li>
              ))}
            </ul>
          )}

          {u.phase === 'downloading' && (
            <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
              <div className={`h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-all ${Number.isNaN(u.pct) ? 'w-1/3 animate-pulse' : ''}`}
                style={Number.isNaN(u.pct) ? undefined : { width: `${Math.round(u.pct * 100)}%` }} />
            </div>
          )}

          <div className="flex gap-2">
            {u.phase === 'available' && (
              <>
                <button onClick={() => void downloadUpdate()}
                  className="flex-1 py-2 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:opacity-90">
                  {u.info?.required ? <TriangleAlert size={13} /> : <Download size={13} />}
                  Scarica{u.info?.size ? ` (${Math.round(u.info.size / 1e6)} MB)` : ''}
                </button>
                {!u.info?.required && (
                  <button onClick={dismissUpdate}
                    className="px-3 py-2 rounded-xl bg-panel2 border border-line text-xs text-dim hover:text-txt">Ignora</button>
                )}
              </>
            )}
            {u.phase === 'ready' && (
              <button onClick={() => void install()}
                className="flex-1 py-2 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:opacity-90">
                <CheckCircle2 size={13} /> Installa e aggiorna
              </button>
            )}
            {u.phase === 'error' && (
              // Errore col manifest pronto → riprova il download; errore al
              // check (nessun manifest) → riprova il check.
              <button onClick={() => void (u.info ? downloadUpdate() : checkUpdate(true))}
                className="flex-1 py-2 rounded-xl bg-panel2 border border-line text-xs font-bold flex items-center justify-center gap-1.5 hover:border-accent/60">
                <RefreshCw size={12} /> {u.info ? 'Riprova download' : 'Riprova controllo'}
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
