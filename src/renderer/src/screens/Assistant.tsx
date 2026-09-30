import { useState } from 'react';
import { usePersistedState } from '../persist';
import { Sparkles, Zap, CloudSun, Car, PartyPopper, Disc3, Compass, ChevronRight, Download, RefreshCw, Play, X, Wand2, Dumbbell, Heart, Moon, Flag, Sun, UserX, UserPlus, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { useApp } from '../store';
import TrackRow from '../components/TrackRow';
import { SectionTitle, Empty, LoadingState, ProgressBar, BackLink } from '../components/common';
import type { AssistantResult, SuggestedTrack } from '../../../shared/types';
import { offlineAssistant } from '../offlineRec';
import { isRemote } from '../api';
import { isOnline, pcGone, resyncWhen } from '../remote';


const VIBES = [
  { id: 'energico', label: 'Energico', icon: Zap },
  { id: 'chill', label: 'Chill', icon: CloudSun },
  { id: 'viaggio', label: 'Viaggio', icon: Car },
  { id: 'festa', label: 'Festa', icon: PartyPopper },
  { id: 'anni90', label: 'Anni \'90', icon: Disc3 },
  { id: 'allenamento', label: 'Allenamento', icon: Dumbbell },
  { id: 'romantico', label: 'Romantico', icon: Heart },
  { id: 'sera', label: 'Sera', icon: Moon },
  { id: 'italiana', label: 'Italiana', icon: Flag },
  { id: 'estate', label: 'Estate', icon: Sun },
  { id: 'scoperte', label: 'Solo scoperte', icon: Compass },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// Stessa normalizzazione del main: "Ligabue" ≡ "LIGABUE", accenti e punteggiatura ignorati
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const tkey = (t: SuggestedTrack) => `${norm(t.artist)}|${norm(t.title)}`;

// Riga risultato con azioni "sostituisci" e "rimuovi"
function ResultRow({ t, i, queue, onSwap, onRemove }: {
  t: SuggestedTrack; i: number; queue: SuggestedTrack[];
  onSwap: () => void; onRemove: () => void;
}) {
  return (
    <div className="relative group/row">
      <TrackRow t={t} index={i} queue={queue} />
      <div className="pl-16 pb-2 -mt-1 text-[11px] text-accent2/80 flex items-center gap-1 pr-3">
        <ChevronRight size={10} className="shrink-0" />
        <span className="truncate flex-1">{t.reason}</span>
        <span className="opacity-0 group-hover/row:opacity-100 max-md:opacity-100 transition-opacity flex gap-1 shrink-0">
          <button onClick={onSwap} title="Sostituisci con un'alternativa"
            className="text-[10px] px-2 py-0.5 rounded bg-panel2 hover:bg-accent/20 text-dim hover:text-accent flex items-center gap-1">
            <RefreshCw size={10} /> Altra
          </button>
          <button onClick={onRemove} title="Togli dalla tracklist"
            className="text-[10px] px-2 py-0.5 rounded bg-panel2 hover:bg-red-500/20 text-dim hover:text-red-400 flex items-center gap-1">
            <X size={10} /> Togli
          </button>
        </span>
      </div>
    </div>
  );
}

export default function Assistant() {
  const [vibe, setVibe] = usePersistedState('mh-pref-vibe', 'energico');
  const [minutes, setMinutes] = usePersistedState('mh-pref-cdminutes', 80);
  const [discovery, setDiscovery] = usePersistedState('mh-pref-discovery', 40);
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [tracks, setTracks] = useState<SuggestedTrack[]>([]);
  const [alts, setAlts] = useState<SuggestedTrack[]>([]);
  const [loading, setLoading] = useState(false);
  const [dlBusy, setDlBusy] = useState(''); // accodamento download/CD: "3/18"
  const { toast, addDownload, downloadToCd, nav, play } = useApp();

  const generate = async () => {
    setLoading(true);
    setResult(null);
    try {
      const r = await api().rec.assistant({
        vibe, targetMinutes: minutes, discoveryPct: discovery,
        prompt: prompt.trim() || undefined,
      });
      setResult(r);
      setTracks(r.tracks);
      setAlts(r.alternates);
    } catch (e) {
      // PC spento: versione degradata — ricerca diretta sul prompt/vibe,
      // niente motore gusti. Il risultato è dichiarato nella spiegazione.
      if (isRemote() && !isOnline()) {
        try {
          const r = await offlineAssistant({
            vibe, targetMinutes: minutes, discoveryPct: discovery,
            prompt: prompt.trim() || undefined,
          });
          if (r.tracks.length) {
            setResult(r); setTracks(r.tracks); setAlts(r.alternates);
            return;
          }
          toast(`${pcGone()} e ricerca senza risultati`, 'info');
        } catch { toast(`${pcGone()} — assistente non disponibile`, 'info'); }
      } else {
        toast(`Errore: ${e instanceof Error ? e.message : e}`, 'err');
      }
    } finally {
      setLoading(false);
    }
  };

  // Sostituisci un brano col primo ricambio valido: niente duplicati e non sfora la capienza CD
  const swap = (idx: number) => {
    const inList = new Set(tracks.map(tkey));
    const cur = tracks[idx];
    const freeS = capS ? capS - (totalS - (cur?.durationS ?? 210)) : Infinity;
    const next = alts.find((a) => !inList.has(tkey(a)) && (a.durationS ?? 210) <= freeS);
    if (!next) { toast('Nessun ricambio disponibile che entri nel disco', 'info'); return; }
    setAlts((a) => a.filter((x) => x !== next));
    if (cur) setAlts((a) => [...a, cur]); // il brano tolto torna tra i ricambi
    setTracks((ts) => ts.map((t, i) => (i === idx ? next : t)));
  };

  const removeAt = (idx: number) => setTracks((ts) => ts.filter((_, i) => i !== idx));

  // Riempie i minuti liberi del disco coi ricambi, senza sforare la capienza
  const refill = () => {
    const inList = new Set(tracks.map(tkey));
    const add: SuggestedTrack[] = [];
    let space = capS ? capS - totalS : Infinity;
    for (const a of alts) {
      const d = a.durationS ?? 210;
      if (inList.has(tkey(a)) || d + 2 > space) continue;
      add.push(a); inList.add(tkey(a)); space -= d + 2;
    }
    if (!add.length) { toast('Nessun ricambio entra nel disco', 'info'); return; }
    setAlts((a) => a.filter((x) => !add.includes(x)));
    setTracks((ts) => [...ts, ...add]);
  };

  const downloadAll = async () => {
    if (dlBusy) return;
    // Un enqueue fallito (rete, yt-dlp giù) non deve abortire gli altri
    let failed = 0, deferred = 0, done = 0;
    setDlBusy(`0/${tracks.length}`);
    for (const t of tracks) {
      try {
        const j = await addDownload(t, true);
        if (j?.id.startsWith('pending-')) deferred++; // accodato, non avviato
      } catch { failed++; }
      setDlBusy(`${++done}/${tracks.length}`);
    }
    setDlBusy('');
    if (deferred) toast(`${tracks.length - failed} brani in coda — scarico ${resyncWhen()}`, 'info');
    else toast(
      failed ? `Download avviato per ${tracks.length - failed} brani (${failed} non accodati)`
             : `Download avviato per ${tracks.length} brani`,
      failed ? 'err' : 'ok');
  };

  const downloadAllToCd = async () => {
    if (dlBusy) return;
    const offline = isRemote() && !isOnline();
    let failed = 0, done = 0;
    setDlBusy(`0/${tracks.length}`);
    for (const t of tracks) {
      try { await downloadToCd(t); } catch { failed++; }
      setDlBusy(`${++done}/${tracks.length}`);
    }
    setDlBusy('');
    // Offline/standalone: i brani sono in pendingSync, NON in cdQueue — aprire
    // il CD Builder mostrerebbe una tracklist vuota. Si naviga solo se serve.
    if (!offline) nav('cd');
    toast(
      offline
        ? `${pcGone()} — ${tracks.length - failed} brani accodati: il CD si compone ${resyncWhen()}`
        : failed
          ? `Tracklist in preparazione (${failed} brani non accodati)`
          : 'Tracklist in preparazione nel CD Builder',
      failed ? 'err' : 'info');
  };

  const totalS = tracks.reduce((s, t) => s + (t.durationS ?? 210), 0) + Math.max(0, tracks.length - 1) * 2;
  const capS = minutes > 0 ? minutes * 60 : 0;
  const pct = capS ? Math.min(100, (totalS / capS) * 100) : 0;

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full">
      <BackLink to="cd" label="CD" />
      <SectionTitle title="Assistente" sub="Descrivi il CD che vuoi — capisco artisti, vibe, decenni ed esclusioni" />

      <AnimatePresence mode="wait">
        {!result ? (
          <motion.div key="wizard" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="max-w-3xl space-y-6">
            {/* Prompt libero */}
            <div>
              <div className="text-sm font-medium mb-2 flex items-center gap-2">
                <Wand2 size={15} className="text-accent" /> Raccontami il CD che vuoi
              </div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                placeholder={'Es. "rock anni 90 per un viaggio con Ligabue e Grignani, senza rap" — oppure lascia vuoto e usa le vibe sotto'}
                className="w-full bg-panel border border-line rounded-xl px-4 py-3 text-sm outline-none focus:border-accent transition-colors resize-none" />
            </div>

            {/* Vibe chips */}
            <div>
              <div className="text-sm font-medium mb-2">Vibe {prompt.trim() ? <span className="text-[11px] text-dim font-normal">(il testo sopra può cambiarla da solo)</span> : null}</div>
              <div className="flex flex-wrap gap-2">
                {VIBES.map(({ id, label, icon: Icon }) => (
                  <button key={id} onClick={() => setVibe(id)}
                    className={`px-3.5 py-2 rounded-full border text-xs font-medium flex items-center gap-1.5 transition-all
                      ${vibe === id ? 'border-accent bg-accent/15 text-txt glow' : 'border-line bg-panel text-dim hover:text-txt hover:border-dim'}`}>
                    <Icon size={13} className={vibe === id ? 'text-accent' : ''} /> {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Formato + scoperte su una riga */}
            <div className="grid grid-cols-2 gap-6">
              <div>
                <div className="text-sm font-medium mb-2">Formato</div>
                <div className="flex gap-2">
                  {[{ m: 80, l: 'CD 80 min' }, { m: 74, l: 'CD 74 min' }, { m: 0, l: 'Solo lista' }].map((o) => (
                    <button key={o.m} onClick={() => setMinutes(o.m)}
                      className={`flex-1 py-2.5 rounded-lg border text-xs font-medium transition-all ${minutes === o.m ? 'border-accent bg-accent/10 text-txt' : 'border-line bg-panel text-dim hover:text-txt'}`}>
                      {o.l}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">Scoperte <span className="text-accent font-bold">{discovery}%</span></div>
                <input type="range" min={0} max={100} step={10} value={discovery} onChange={(e) => setDiscovery(+e.target.value)}
                  className="w-full h-1.5 accent-[--color-accent] mt-2.5" />
                <div className="flex justify-between text-[11px] text-dim mt-1">
                  <span>Solo preferiti</span><span>Solo novità</span>
                </div>
              </div>
            </div>

            <button onClick={generate} disabled={loading}
              className="w-full py-3.5 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-bold text-sm hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2 transition-opacity glow">
              {loading ? <><div className="eq"><i /><i /><i /></div> Sto componendo il tuo CD…</> : <><Sparkles size={16} /> Componi il mio CD</>}
            </button>
            {loading && <LoadingState label="Compongo la tua scaletta…" detail="Scelgo i brani in base alla tua richiesta e ai tuoi gusti." n={6} />}
          </motion.div>
        ) : (
          <motion.div key="result" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            {/* Spiegazione + cosa ho capito dal prompt */}
            <div className="bg-panel border border-accent/30 rounded-xl p-4 mb-4">
              <div className="flex items-center gap-3">
                <Sparkles size={18} className="text-accent shrink-0" />
                <p className="text-sm flex-1">{result.explanation}</p>
              </div>
              {result.parsed && (result.parsed.seeds.length > 0 || result.parsed.excluded.length > 0 || result.parsed.extraTags.length > 0) && (
                <div className="flex flex-wrap gap-1.5 mt-3 pl-8">
                  {result.parsed.seeds.map((s) => (
                    <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent flex items-center gap-1">
                      <UserPlus size={9} /> {s}
                    </span>
                  ))}
                  {result.parsed.excluded.map((s) => (
                    <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 flex items-center gap-1">
                      <UserX size={9} /> no {s}
                    </span>
                  ))}
                  {result.parsed.extraTags.map((s) => (
                    <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-panel2 text-dim">{s}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Barra riempimento CD */}
            {capS > 0 && (
              <div className="mb-4 bg-panel border border-line rounded-xl p-3">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-dim">Riempimento disco</span>
                  <span className={pct > 100 ? 'text-red-400 font-bold' : 'text-txt'}>{fmt(totalS)} / {minutes}:00</span>
                </div>
                <ProgressBar pct={pct} />
              </div>
            )}

            {/* Azioni */}
            <div className="flex gap-2 mb-4 flex-wrap">
              <button onClick={downloadAllToCd} disabled={!!dlBusy}
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-accent to-accent2 text-white text-sm font-semibold flex items-center gap-2 hover:opacity-90 glow disabled:opacity-60">
                {dlBusy ? <><Loader2 size={15} className="animate-spin" /> Accodo {dlBusy}</> : <><Disc3 size={15} /> Scarica e componi il CD</>}
              </button>
              <button onClick={() => play(tracks[0], tracks)} disabled={!tracks.length}
                className="px-4 py-2 rounded-lg bg-panel2 border border-line text-sm flex items-center gap-2 hover:border-accent disabled:opacity-40">
                <Play size={15} /> Ascolta tutto
              </button>
              <button onClick={downloadAll} disabled={!!dlBusy}
                className="px-4 py-2 rounded-lg bg-panel2 border border-line text-sm text-dim hover:text-txt flex items-center gap-2 disabled:opacity-50">
                {dlBusy ? <><Loader2 size={15} className="animate-spin" /> {dlBusy}</> : <><Download size={15} /> Solo in libreria</>}
              </button>
              <button onClick={refill} disabled={!alts.length} title="Aggiungi altri brani dai ricambi"
                className="px-4 py-2 rounded-lg bg-panel2 border border-line text-sm text-dim hover:text-txt flex items-center gap-2 disabled:opacity-40">
                <RefreshCw size={15} /> Riempi ({alts.length} ricambi)
              </button>
              <button onClick={generate} disabled={loading}
                className="px-4 py-2 rounded-lg bg-panel2 border border-line text-sm text-dim hover:text-txt flex items-center gap-2 disabled:opacity-40">
                <Sparkles size={15} /> Rimescola
              </button>
              <button onClick={() => setResult(null)} className="px-4 py-2 rounded-lg text-sm text-dim hover:text-txt">
                ← Ricomincia
              </button>
            </div>

            <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
              {tracks.map((t, i) => (
                <ResultRow key={t.videoId + i} t={t} i={i} queue={tracks}
                  onSwap={() => swap(i)} onRemove={() => removeAt(i)} />
              ))}
              {tracks.length === 0 && <Empty icon={<Sparkles size={32} />} title="Tracklist vuota" sub="Rimescola o ricomincia con un prompt diverso." />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
