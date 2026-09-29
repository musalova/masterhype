import { useEffect, useMemo, useRef, useState } from 'react';
import { Disc3, RefreshCw, Flame, Usb, Eraser, ArrowUpFromLine, AlertTriangle, CheckCircle2, GripVertical, Save, ClipboardList, Loader2, Sparkles } from 'lucide-react';
import { motion, Reorder, useDragControls } from 'framer-motion';
import { useApp } from '../store';
import { usePersistedState } from '../persist';
import { api, isRemote } from '../api';
import { resyncWhen, pcGone, isStandalone, syncNote } from '../remote';
import TrackRow from '../components/TrackRow';
import { SectionTitle, Empty, ProgressBar, SkeletonRows } from '../components/common';
import type { DriveInfo, BurnProgress, LibraryTrack } from '../../../shared/types';

// Riga trascinabile: grip a sinistra avvia il drag, il resto della riga resta cliccabile
function CdRow({ t, i, onRemove }: { t: LibraryTrack; i: number; onRemove: () => void }) {
  const controls = useDragControls();
  const { moveCd } = useApp();
  return (
    <Reorder.Item value={t} dragListener={false} dragControls={controls} className="flex items-center">
      <button onPointerDown={(e) => controls.start(e)} title="Trascina per riordinare"
        className="pl-2 pr-0.5 text-dim/60 hover:text-dim cursor-grab active:cursor-grabbing touch-none shrink-0 self-stretch flex items-center">
        <GripVertical size={14} />
      </button>
      <div className="flex-1 min-w-0">
        <TrackRow t={t} index={i} showAddCd={false} showRemove onRemove={onRemove}
          move={(dir) => moveCd(t.id, dir)} />
      </div>
    </Reorder.Item>
  );
}

export default function CdBuilder() {
  const { cdQueue, removeFromCd, setCdQueue, clearCd, toast, settings } = useApp();
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [driveId, setDriveId] = usePersistedState('mh-pref-drive', '');
  const [scanning, setScanning] = useState(false);
  const [firstScan, setFirstScan] = useState(true); // finché il primo scan non torna: "rilevamento", non "nessun drive"
  const [burning, setBurning] = useState<BurnProgress | null>(null);
  const [actionBusy, setActionBusy] = useState(false); // erase/saveAsPlaylist: no doppio-tap
  const [name, setName] = usePersistedState('mh-pref-cdname', 'Il mio CD');
  const [audioCap, setAudioCap] = usePersistedState('mh-pref-audiocap', 80);

  const scan = async () => {
    setScanning(true);
    try {
      const d = await api().burn.drives();
      setDrives(d);
      // mantiene la selezione se il drive c'è ancora, altrimenti prende il primo disponibile
      setDriveId((prev) => (d.some((x) => x.id === prev) ? prev : (d[0]?.id ?? '')));
    } catch {
      // PC giù (telefono remoto) o nessun drive: lista vuota, il polling riprova
      setDrives([]);
    } finally {
      setScanning(false);
      setFirstScan(false);
    }
  };

  // Il polling fa spawn di un processo: mentre il laser scrive il disco si
  // mette in pausa — un accesso IMAPI concorrente può disturbare la scrittura
  const burningRef = useRef(false);
  const phaseRef = useRef(''); // ultima fase vista: se fallisce in 'write' il disco è compromesso
  useEffect(() => {
    void scan();
    const off = api().burn.onEvent((p) => { phaseRef.current = p.phase; setBurning(p.phase === 'done' ? null : p); });
    const t = setInterval(() => { if (!burningRef.current) void scan(); }, 15000);
    return () => { off(); clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { burningRef.current = !!burning; }, [burning]);

  const drive = drives.find((d) => d.id === driveId);
  const mediaReady = !!(drive?.mediaPresent && drive?.mediaBlank);
  // Stima come il pre-flight di burner.ts: settori WAV (75/s, arrotondati a
  // settore per traccia) + gap 2s (150 settori) + ~150s di lead-in/out disco.
  // Barra e gate coincidono con ciò che finisce davvero sul CD — prima si
  // sommavano solo i metadati e partivano scalette che il check reale
  // abortiva dopo aver convertito tutti i WAV.
  const minutes = useMemo(() => {
    const sectors = cdQueue.reduce((s, t) => s + Math.ceil((t.durationS ?? 210) * 75 + 45), 0);
    return (sectors + Math.max(0, cdQueue.length - 1) * 150 + 11250) / 4500;
  }, [cdQueue]);
  const overAudio = minutes > audioCap;
  // Stima reale: durata × bitrate (default 320k) / 8 + ~5% overhead tag/cover
  const totalMB = useMemo(() => {
    const kbps = +(settings?.audioQuality ?? '320');
    return Math.round(cdQueue.reduce((s, t) => s + (t.durationS ?? 210) * (kbps / 8) * 1.05, 0) / 1000);
  }, [cdQueue, settings]);
  const overMp3 = totalMB > 700;

  const startBurn = async (kind: 'audio' | 'data') => {
    if (!drive) return toast('Nessun masterizzatore selezionato', 'err');
    if (!cdQueue.length) return toast('CD vuoto: aggiungi brani dalla Libreria', 'err');
    if (!drive.mediaPresent) return toast('Inserisci un CD nel masterizzatore', 'err');
    if (!drive.mediaBlank) return toast('Il disco non è vuoto — cancellalo o usa un CD vergine', 'err');
    if (kind === 'audio' && overAudio) return toast(`Troppo lungo per Audio CD (${minutes.toFixed(0)} min > ${audioCap})`, 'err');
    setBurning({ jobId: '', phase: 'prepare', percent: 0 });
    phaseRef.current = 'prepare';
    try {
      await api().burn.start(kind, driveId, cdQueue, name || 'MasterHype');
      toast(kind === 'audio' ? 'Audio CD masterizzato!' : 'CD MP3 masterizzato!', 'ok');
      setBurning(null);
    } catch (e) {
      const ruined = phaseRef.current === 'write' || phaseRef.current === 'finalize';
      toast(`Masterizzazione fallita: ${e instanceof Error ? e.message : e}${ruined ? ' — il disco potrebbe essere inutilizzabile' : ''}`, 'err');
      setBurning(null);
    }
  };

  const erase = async (full: boolean) => {
    if (!drive || actionBusy) return;
    setActionBusy(true);
    try {
      await api().burn.erase(driveId, full);
      toast('Disco cancellato', 'ok');
      void scan();
    } catch (e) {
      toast(`Cancellazione fallita: ${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setActionBusy(false);
    }
  };

  // La scaletta composta per il CD non si perde: diventa una playlist riusabile/esportabile
  const saveAsPlaylist = async () => {
    if (!cdQueue.length || actionBusy) return;
    setActionBusy(true);
    try {
      // Local-first: a PC spento create/add vanno in coda e la playlist
      // compare subito sul telefono (id temporaneo rimappato al drain)
      const pl = await api().playlists.create(name || 'Il mio CD', 'cd-audio');
      for (const t of cdQueue) await api().playlists.add(pl.id, t.id);
      toast(`Scaletta salvata come playlist "${pl.name}"${syncNote()}`, 'ok');
    } catch (e) {
      toast(`Salvataggio fallito: ${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setActionBusy(false);
    }
  };

  // Copia la scaletta negli appunti: "1. Artista - Titolo (3:45)"
  const copyTracklist = async () => {
    const f = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
    const text = `${name || 'Il mio CD'}\n` + cdQueue.map((t, i) => `${i + 1}. ${t.artist} - ${t.title}${t.durationS ? ` (${f(t.durationS)})` : ''}`).join('\n');
    try { await navigator.clipboard.writeText(text); toast('Scaletta copiata negli appunti', 'ok'); }
    catch { toast('Copia non riuscita', 'err'); }
  };

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full">
      <SectionTitle title="CD" sub="Componi la tracklist e masterizza per la macchina"
        action={
          <button onClick={() => useApp.getState().nav('assistant')}
            className="text-xs px-3.5 py-2 rounded-full bg-gradient-to-r from-accent to-accent2 text-white font-semibold flex items-center gap-1.5 shadow-lg shadow-accent/25 hover:scale-105 transition-transform">
            <Sparkles size={13} /> Componi con l'assistente
          </button>
        } />

      {/* Drive picker */}
      <div className="bg-panel border border-line rounded-xl p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Usb size={18} className="text-accent" />
          <span className="text-sm font-medium">Masterizzatore</span>
          <button onClick={scan} disabled={scanning} className="text-xs text-dim hover:text-txt flex items-center gap-1">
            <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} /> Rileva
          </button>
          <div className="flex-1" />
          {drive && (
            <div className="flex gap-2">
              <button onClick={() => { void api().burn.eject(driveId).catch(() => toast(`Espulsione fallita — ${pcGone()}`, 'info')); }} disabled={!!burning} className="text-xs px-2.5 py-1.5 rounded bg-panel2 hover:bg-line text-dim flex items-center gap-1 disabled:opacity-40"><ArrowUpFromLine size={12} /> Espelli</button>
              <button onClick={() => erase(false)} disabled={!!burning || actionBusy} className="text-xs px-2.5 py-1.5 rounded bg-panel2 hover:bg-line text-dim flex items-center gap-1 disabled:opacity-40">{actionBusy ? <Loader2 size={12} className="animate-spin" /> : <Eraser size={12} />} Cancella RW</button>
              <button onClick={() => erase(true)} disabled={!!burning || actionBusy} title="Cancellazione completa: può richiedere 20-40 minuti" className="text-xs px-2.5 py-1.5 rounded bg-panel2 hover:bg-line text-dim disabled:opacity-40">Canc. completa</button>
            </div>
          )}
        </div>
        {drives.length === 0 ? (
          firstScan ? (
            <div className="mt-3">
              <div className="text-xs text-dim flex items-center gap-2 mb-2">
                <Loader2 size={13} className="animate-spin text-accent" /> Rilevamento masterizzatori in corso…
              </div>
              <SkeletonRows n={1} />
            </div>
          ) : isRemote() ? (
            // Sul telefono il masterizzatore è SUL PC: "collega l'USB" non ha
            // senso. Standalone → serve proprio un PC; pairato offline → torna da solo.
            <div className="mt-3 flex items-center gap-2 text-sm text-amber-400/90">
              <AlertTriangle size={15} /> {isStandalone()
                ? 'La masterizzazione richiede un PC — collegalo da Impostazioni → Telefono.'
                : `Masterizzatore del PC non raggiungibile — la tracklist resta qui, torna ${resyncWhen()}.`}
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-2 text-sm text-amber-400/90">
              <AlertTriangle size={15} /> Nessun masterizzatore rilevato — collega il masterizzatore USB e premi Rileva.
            </div>
          )
        ) : (
          <div className="mt-3 flex gap-2 flex-wrap">
            {drives.map((d) => (
              <button key={d.id} onClick={() => setDriveId(d.id)}
                className={`px-3 py-2 rounded-lg border text-sm text-left transition-colors
                  ${driveId === d.id ? 'border-accent bg-accent/10' : 'border-line bg-panel2 hover:border-dim'}`}>
                <div className="font-medium">{d.name || 'Masterizzatore'} {d.driveLetter && `(${d.driveLetter})`}</div>
                <div className="text-[11px] text-dim">
                  {d.mediaPresent ? (d.mediaBlank ? `Disco vuoto ${d.mediaType || ''} · ${(d.freeSectors * 2048 / 1048576).toFixed(0)} MB liberi` : `Disco presente (${d.mediaType || 'scritto'}${d.mediaState && d.mediaState !== 'blank' ? ` · ${d.mediaState}` : ''})`) : 'Nessun disco inserito'}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Burn progress */}
      {burning && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="bg-panel border border-accent/40 rounded-xl p-4 mb-6 glow">
          <div className="flex items-center gap-3 mb-2">
            <Flame size={18} className="text-accent" />
            <span className="font-medium text-sm">
              {burning.phase === 'prepare' && 'Preparazione…'}
              {burning.phase === 'write' && `Scrittura${burning.currentTrack ? `: ${burning.currentTrack}` : ''}`}
              {burning.phase === 'finalize' && 'Finalizzazione disco…'}
            </span>
            {burning.trackIndex != null && <span className="text-xs text-dim">traccia {burning.trackIndex}/{burning.trackCount}</span>}
            <span className="ml-auto text-sm font-bold text-accent">{burning.percent}%</span>
          </div>
          <ProgressBar pct={burning.percent} label={burning.message} />
          <div className="text-[11px] text-dim mt-2">Non spegnere il PC e non scollegare il masterizzatore.</div>
        </motion.div>
      )}

      {/* Tracklist + capacity */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-6">
        <div>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome del CD"
            className="w-full bg-panel border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent mb-3" />
          <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
            <Reorder.Group axis="y" values={cdQueue} onReorder={setCdQueue} className="divide-y divide-line/50">
              {cdQueue.map((t, i) => (
                <CdRow key={t.id} t={t} i={i} onRemove={() => removeFromCd(t.id)} />
              ))}
            </Reorder.Group>
            {cdQueue.length === 0 && (
              <Empty icon={<Disc3 size={36} />} title="Tracklist vuota"
                sub="Clicca l'icona disco su un brano ovunque: si scarica e finisce qui da solo." />
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="bg-panel border border-line rounded-xl p-4">
            <div className="text-sm font-semibold mb-3">Capacità disco</div>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-dim flex items-center gap-1.5">Audio CD
                    <select value={audioCap} onChange={(e) => setAudioCap(+e.target.value)}
                      className="bg-panel2 border border-line rounded px-1 py-0.5 text-[10px] outline-none">
                      <option value={80}>80 min</option>
                      <option value={74}>74 min</option>
                    </select>
                  </span>
                  <span className={overAudio ? 'text-red-400 font-bold' : ''} title="Brani + pause tra tracce + margini del disco (lead-in/out)">{minutes.toFixed(1)} min</span>
                </div>
                <ProgressBar pct={(minutes / audioCap) * 100} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-dim">MP3 CD (~700 MB)</span>
                  <span className={overMp3 ? 'text-red-400 font-bold' : ''}>~{totalMB} MB</span>
                </div>
                <ProgressBar pct={(totalMB / 700) * 100} />
              </div>
            </div>
          </div>

          <div className="bg-panel border border-line rounded-xl p-4 space-y-2">
            {overAudio && !overMp3 && (
              <div className="flex items-start gap-2 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2">
                <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                <span>Troppo lunga per un <b>Audio CD</b> ({minutes.toFixed(0)}′ &gt; {audioCap}′, incluse pause e margini del disco) — ma entra in un <b>CD MP3</b> (~{totalMB} MB). Usa il bottone sotto o togli un paio di brani.</span>
              </div>
            )}
            {drive && !mediaReady && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-400/90 pb-1">
                <AlertTriangle size={12} className="shrink-0" />
                {!drive.mediaPresent
                  ? 'Inserisci un CD-R/RW vergine per masterizzare'
                  : /dvd|bd|blu-?ray/i.test(drive.mediaType || '')
                    ? 'Hai inserito un DVD — per un Audio CD serve un CD-R o CD-RW'
                    : 'Il disco contiene già dati — cancellalo con "Cancella RW" o usa un CD vergine'}
              </div>
            )}
            <button onClick={() => startBurn('audio')} disabled={!!burning || !mediaReady || !cdQueue.length || overAudio}
              className="w-full py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:bg-accent/85 disabled:opacity-50 disabled:grayscale-[.55] disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-all">
              <Flame size={16} /> Masterizza Audio CD
            </button>
            <div className="text-[11px] text-dim text-center">CDA classico + CD-Text: titoli e autori sul display dell'autoradio</div>
            <button onClick={() => startBurn('data')} disabled={!!burning || !mediaReady || !cdQueue.length || overMp3}
              className="w-full py-2.5 rounded-lg bg-panel2 border border-line text-sm font-medium hover:border-accent disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2">
              <Disc3 size={16} /> Masterizza CD MP3
            </button>
            <div className="text-[11px] text-dim text-center">File MP3 — solo stereo con supporto MP3</div>
          </div>

          {cdQueue.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={saveAsPlaylist} disabled={actionBusy}
                className="py-2 rounded-lg bg-panel border border-line text-xs text-dim hover:text-accent hover:border-accent flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50">
                {actionBusy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Salva playlist
              </button>
              <button onClick={copyTracklist}
                className="py-2 rounded-lg bg-panel border border-line text-xs text-dim hover:text-accent hover:border-accent flex items-center justify-center gap-1.5 transition-colors">
                <ClipboardList size={13} /> Copia scaletta
              </button>
            </div>
          )}

          <div className="bg-panel border border-line rounded-xl p-4 text-[11px] text-dim space-y-1.5">
            <div className="flex gap-1.5"><CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" /> Usa CD-R per i CD audio (più compatibili)</div>
            <div className="flex gap-1.5"><CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" /> Prova prima su CD-RW, poi cancella e ricrea</div>
            <div className="flex gap-1.5"><CheckCircle2 size={13} className="text-emerald-400 shrink-0 mt-0.5" /> Pausa standard 2s tra tracce audio</div>
          </div>

          {cdQueue.length > 0 && (
            <button onClick={clearCd} className="w-full text-xs text-dim hover:text-red-400 py-1">Svuota tracklist</button>
          )}
        </div>
      </div>
    </div>
  );
}
