import { useEffect, useState } from 'react';
import { Download, CheckCircle2, AlertTriangle, Loader2, RotateCcw, X, Trash2, Clock, Smartphone, HardDrive } from 'lucide-react';
import { useApp } from '../store';
import { phoneFreeMB } from '../phoneLocal';
import { pendingDownloads } from '../pendingSync';
import { isRemote } from '../api';
import { isOnline, resyncWhen } from '../remote';
import { SectionTitle, Empty, ProgressBar, BackLink } from '../components/common';
import { CoverImg } from '../components/CoverImg';

const STATUS_LABEL: Record<string, string> = {
  queued: 'In coda', downloading: 'Download', converting: 'Conversione + normalizzazione',
  tagging: 'Tag e copertina', done: 'Completato', error: 'Errore',
};

// Sul telefono la schermata Download mostra ANCHE la memoria del dispositivo:
// download in corso verso il telefono (con %), brani salvati e spazio libero —
// in modalità senza PC è l'unica coda che esiste.
function PhoneSection() {
  const phoneDl = useApp((s) => s.phoneDl);
  const pct = useApp((s) => s.phoneDlPct);
  const meta = useApp((s) => s.phoneDlMeta);
  const nPhone = useApp((s) => s.phoneIds.size);
  const nav = useApp((s) => s.nav);
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => { void phoneFreeMB().then(setFree); }, [nPhone]);
  const active = [...phoneDl].map((id) => ({ id, t: meta[id] })).filter((x) => x.t);
  return (
    <div className="mb-6">
      <div className="text-xs font-semibold text-dim uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Smartphone size={12} /> Sul telefono
      </div>
      <div className="bg-panel border border-line rounded-xl p-3 flex items-center gap-3 mb-2">
        <HardDrive size={18} className="text-accent shrink-0" />
        <div className="flex-1 min-w-0 text-sm">
          {nPhone} brani salvati — ascoltabili senza rete
          <div className="text-[11px] text-dim">{free != null ? `${free >= 1024 ? `${(free / 1024).toFixed(1)} GB` : `${free} MB`} liberi per altri download` : 'Spazio disponibile non rilevabile'}</div>
        </div>
        {nPhone > 0 && (
          <button onClick={() => nav('library')} className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt shrink-0">Apri</button>
        )}
      </div>
      {active.map(({ id, t }) => (
        <div key={id} className="bg-panel border border-line rounded-xl p-3 flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-panel2 overflow-hidden shrink-0">
            <CoverImg src={t.thumbnail} videoId={t.videoId} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{t.title}</div>
            <div className="text-xs text-dim truncate">{t.artist}</div>
            <div className="mt-1.5"><ProgressBar pct={Math.round((pct[id] ?? 0) * 100)} /></div>
          </div>
          <Loader2 size={15} className="animate-spin text-accent shrink-0" />
          <span className="text-dim text-xs w-20 text-right">{pct[id] != null ? `${Math.round(pct[id] * 100)}%` : 'sul telefono'}</span>
        </div>
      ))}
    </div>
  );
}

export default function Downloads() {
  const { downloads, retryDownload, dismissDownload, clearFinishedDownloads } = useApp();
  const finished = downloads.filter((j) => ['done', 'error'].includes(j.status)).length;
  // Richieste fatte a PC spento: ripartono da sole alla riconnessione
  const pending = isRemote() && !isOnline() ? pendingDownloads() : [];
  const phoneBusy = useApp((s) => s.phoneDl.size > 0);

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full">
      <BackLink to="library" label="Libreria" />
      <SectionTitle title="Download" sub="Coda di scaricamento: audio pulito → MP3 320 con tag e copertina"
        action={finished > 0 ? (
          <button onClick={clearFinishedDownloads}
            className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1.5">
            <Trash2 size={12} /> Pulisci completati
          </button>
        ) : undefined} />
      {isRemote() && <PhoneSection />}
      {pending.length > 0 && (
        <div className="mb-5">
          <div className="text-xs font-semibold text-dim uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Clock size={12} /> In attesa del PC ({pending.length})
          </div>
          <div className="space-y-2 opacity-80">
            {pending.map((t) => (
              <div key={t.videoId} className="bg-panel border border-dashed border-line rounded-xl p-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-panel2 overflow-hidden shrink-0">
                  <CoverImg src={t.thumbnail} videoId={t.videoId} className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  <div className="text-xs text-dim truncate">{t.artist}</div>
                </div>
                <span className="text-[11px] text-dim shrink-0">parte {resyncWhen()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {downloads.length === 0 && !pending.length ? (
        phoneBusy ? null : <Empty icon={<Download size={36} />} title={isRemote() ? 'Nessun download sul PC' : 'Nessun download'}
          sub={isRemote() ? 'Scarica in libreria (PC) o sul telefono dal menu di ogni brano.' : 'Scarica brani da Cerca, Home o Assistente.'} />
      ) : downloads.length === 0 ? null : (
        <div className="space-y-2">
          {[...downloads].reverse().map((j) => (
            <div key={j.id} className="bg-panel border border-line rounded-xl p-3 flex items-center gap-3 group">
              <div className="w-10 h-10 rounded-lg bg-panel2 overflow-hidden shrink-0">
                <CoverImg src={j.track.thumbnail} videoId={j.track.videoId} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{j.track.title}</div>
                <div className="text-xs text-dim truncate">{j.track.artist}</div>
                {j.status !== 'done' && j.status !== 'error' && (
                  <div className="mt-1.5"><ProgressBar pct={j.percent} /></div>
                )}
                {j.status === 'error' && <div className="text-[11px] text-red-400 mt-1 truncate">{j.error}</div>}
              </div>
              <div className="flex items-center gap-2 text-xs shrink-0">
                {j.status === 'error' && (
                  <button onClick={() => retryDownload(j.id)} title="Riprova"
                    className="p-1.5 rounded bg-panel2 hover:bg-line text-dim hover:text-txt">
                    <RotateCcw size={13} />
                  </button>
                )}
                {['done', 'error'].includes(j.status) && (
                  <button onClick={() => dismissDownload(j.id)} title="Rimuovi dalla lista"
                    className="p-1.5 rounded bg-panel2 hover:bg-line text-dim hover:text-txt opacity-0 group-hover:opacity-100 max-md:opacity-100 transition-opacity">
                    <X size={13} />
                  </button>
                )}
                {j.status === 'done' && <CheckCircle2 size={16} className="text-emerald-400" />}
                {j.status === 'error' && <AlertTriangle size={16} className="text-red-400" />}
                {!['done', 'error'].includes(j.status) && <Loader2 size={15} className="animate-spin text-accent" />}
                <span className="text-dim w-40 text-right truncate">{STATUS_LABEL[j.status]}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
