import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Info, X, TriangleAlert, ChevronLeft } from 'lucide-react';
import { Component, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../store';
import type { Screen } from '../store';
import { api } from '../api';

// Se una schermata va in crash non deve trascinare giù tutta la shell:
// errore mostrato + loggato in diagnostica, e si può riprovare.
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) {
    void api().diag.report('renderer-crash', { message: `${err.message}\n${(err.stack ?? '').split('\n').slice(0, 4).join('\n')}` }).catch(() => {});
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <TriangleAlert size={40} className="text-orange-400 mb-4" />
        <div className="font-semibold text-lg mb-1">Questa schermata è andata in errore</div>
        <div className="text-sm text-dim mb-1 max-w-md">Il resto dell'app continua a funzionare. L'errore è stato registrato in Diagnostica.</div>
        <div className="text-[11px] text-dim/60 font-mono mb-5 max-w-lg truncate">{this.state.err.message}</div>
        <button onClick={() => this.setState({ err: null })}
          className="text-sm px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent/85">
          Riprova
        </button>
      </div>
    );
  }
}

// Ultima rete: un errore di render fuori dalle schermate (sidebar, barra
// player, toast) smonterebbe tutto l'albero — su una WebView è una pagina
// bianca che sembra "congelata". Qui l'app resta viva e offre il riavvio.
export class RootErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) {
    try { void api().diag.report('root-crash', { message: `${err.message}\n${(err.stack ?? '').split('\n').slice(0, 4).join('\n')}` }); } catch { /* */ }
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="flex flex-col items-center justify-center h-screen text-center p-8 bg-bg text-txt">
        <TriangleAlert size={40} className="text-orange-400 mb-4" />
        <div className="font-semibold text-lg mb-1">Qualcosa è andato storto</div>
        <div className="text-sm text-dim mb-1 max-w-md">L'errore è stato registrato in Diagnostica. Il riavvio riporta l'app allo stato salvato.</div>
        <div className="text-[11px] text-dim/60 font-mono mb-5 max-w-lg truncate">{this.state.err.message}</div>
        <button onClick={() => location.reload()}
          className="text-sm px-4 py-2 rounded-lg bg-accent text-white font-medium hover:bg-accent/85">
          Ricarica l'app
        </button>
      </div>
    );
  }
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toast-stack fixed bottom-24 right-4 z-50 space-y-2 w-80" role="status" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }}
            className="flex items-center gap-2 bg-panel2/95 backdrop-blur border border-line rounded-xl px-3 py-2.5 shadow-xl shadow-black/40 text-sm">
            {t.kind === 'ok' && <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />}
            {t.kind === 'err' && <AlertTriangle size={16} className="text-red-400 shrink-0" />}
            {t.kind === 'info' && <Info size={16} className="text-accent2 shrink-0" />}
            <span className="truncate flex-1">{t.text}</span>
            {t.action && (
              <button onClick={() => { t.action!.run(); useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })); }}
                className="text-xs font-bold text-accent hover:underline shrink-0">{t.action.label}</button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// Link "← Torna a …" per le schermate secondarie (Trend, Download, Assistente,
// Impostazioni): non stanno nel menu, quindi devono dire da dove si è arrivati.
export function BackLink({ to, label }: { to: Screen; label: string }) {
  const nav = useApp((s) => s.nav);
  return (
    <button onClick={() => nav(to)} className="flex items-center gap-1 text-xs text-dim hover:text-txt mb-3 -mt-1 transition-colors">
      <ChevronLeft size={14} /> {label}
    </button>
  );
}

export function SectionTitle({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <div className="section-title flex flex-wrap items-end justify-between gap-x-4 gap-y-2 mb-3">
      <div className="min-w-0">
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
        {sub && <p className="text-xs text-dim mt-0.5">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Empty({ icon, title, sub }: { icon: React.ReactNode; title: string; sub?: string }) {
  return (
    <div className="empty-state flex flex-col items-center justify-center text-center">
      <div className="empty-state-icon">{icon}</div>
      <div className="font-semibold">{title}</div>
      {sub && <div className="text-sm text-dim mt-1 max-w-sm">{sub}</div>}
    </div>
  );
}

// Skeleton shimmer per i caricamenti (liste di brani, card)
export function Skeleton({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden="true" className={`skeleton rounded-md bg-panel2 ${className}`} style={style} />;
}

export function SkeletonRows({ n = 6 }: { n?: number }) {
  return (
    <div aria-hidden="true" className="bg-panel border border-line rounded-xl divide-y divide-line/50">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3" style={{ width: `${[48, 65, 37, 56][i % 4]}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${[28, 36, 22][i % 3]}%` }} />
          </div>
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ n = 6 }: { n?: number }) {
  return (
    <div aria-hidden="true" className="flex gap-4 overflow-hidden">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="w-36 shrink-0 bg-panel border border-line rounded-xl p-3 space-y-2"
          style={{ animationDelay: `${i * 70}ms` }}>
          <Skeleton className="w-full aspect-square" />
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// Skeleton per la vista a copertine della Libreria (griglia di poster)
export function SkeletonGrid({ n = 12 }: { n?: number }) {
  return (
    <div aria-hidden="true" className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-4 gap-y-6">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="w-full" style={{ animationDelay: `${i * 50}ms` }}>
          <Skeleton className="w-full aspect-square rounded-[10px]" />
          <div className="mt-2 space-y-1.5 px-0.5">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

// Loader centrato a tutta schermata: per i punti in cui non si conosce ancora
// la forma del contenuto (boot, gate, fallback Suspense delle schermate lazy)
export function CenterLoader({ label = 'Preparo il tuo spazio musicale…' }: { label?: string }) {
  return <div className="h-full min-h-[200px] flex items-center justify-center p-6"><LoadingState label={label} layout="center" /></div>;
}

type LoadingLayout = 'inline' | 'center' | 'rows' | 'cards' | 'grid';

export function LoadingState({ label, detail, layout = 'rows', n = 6, onCancel }: {
  label: string; detail?: string; layout?: LoadingLayout; n?: number; onCancel?: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [label, detail]);
  return (
    <div className={`loading-state ${layout === 'center' ? 'loading-centered' : ''}`} data-loading="true">
      <div className="loading-heading">
        <span className="loading-disc" aria-hidden="true"><i /></span>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <div className="loading-label">{label}</div>
          {detail && <div className="loading-detail">{detail}</div>}
          {slow && <p className="loading-patience">Sta richiedendo più tempo del solito. La preparazione è ancora in corso.</p>}
        </div>
        {onCancel && <button onClick={onCancel} className="loading-cancel">Annulla</button>}
      </div>
      {layout === 'rows' && <SkeletonRows n={n} />}
      {layout === 'cards' && <SkeletonCards n={n} />}
      {layout === 'grid' && <SkeletonGrid n={n} />}
    </div>
  );
}

const SCREEN_LOADING: Record<Screen, { label: string; layout: LoadingLayout }> = {
  home: { label: 'Apro il tuo spazio musicale…', layout: 'cards' },
  search: { label: 'Preparo la ricerca…', layout: 'cards' },
  stations: { label: 'Apro le stazioni…', layout: 'grid' },
  library: { label: 'Apro la tua libreria…', layout: 'rows' },
  playlists: { label: 'Apro le tue playlist…', layout: 'grid' },
  cd: { label: 'Preparo il tuo CD…', layout: 'rows' },
  trends: { label: 'Apro le tendenze…', layout: 'rows' },
  assistant: { label: 'Preparo l’assistente…', layout: 'rows' },
  downloads: { label: 'Apro i download…', layout: 'rows' },
  settings: { label: 'Apro le impostazioni…', layout: 'rows' },
};

export function ScreenLoader({ screen }: { screen: Screen }) {
  return <div className="p-4 md:p-8 h-full overflow-hidden"><LoadingState {...SCREEN_LOADING[screen]} /></div>;
}

export function ProgressBar({ pct, label }: { pct: number; label?: string }) {
  return (
    <div className="w-full">
      <div className="h-1.5 bg-panel2 rounded-full overflow-hidden">
        <div className="h-full bg-gradient-to-r from-accent to-accent2 rounded-full transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      {label && <div className="text-[11px] text-dim mt-1">{label}</div>}
    </div>
  );
}
