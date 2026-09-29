import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Radio, AudioLines, RefreshCw, Shuffle, ArrowLeft, ListMusic } from 'lucide-react';
import { useApp } from '../store';
import type { StationSel } from '../store';
import { api } from '../api';
import { SectionTitle, Empty, SkeletonRows } from '../components/common';
import TrackRow from '../components/TrackRow';
import { STATIONS } from '../../../shared/types';
import type { StationDef, TrackRef } from '../../../shared/types';
import { cachedAuto, cacheAuto, offlineStation, offlineRadio } from '../offlineRec';
import { pcGone } from '../remote';

const GROUPS: { id: StationDef['group']; title: string; sub: string }[] = [
  { id: 'per-te', title: 'Fatte per te', sub: 'Cucite sui tuoi gusti: si affinano a ogni ascolto, like e skip' },
  { id: 'mood', title: 'Per mood', sub: 'La musica giusta per il momento' },
  { id: 'genere', title: 'Per genere', sub: 'Dalla canzone italiana al rap, dal rock alla latina' },
  { id: 'decennio', title: 'Per decennio', sub: 'Un tuffo negli anni che ami' },
  { id: 'news', title: 'Novità', sub: 'Le hit del momento, sempre aggiornate' },
];

// La card apre la scaletta della stazione — non avvia la riproduzione.
function StationCard({ s, i }: { s: StationDef; i: number }) {
  const openStation = useApp((st) => st.openStation);
  return (
    <motion.button onClick={() => openStation({ kind: 'station', id: s.id })}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }}
      className={`group relative text-left rounded-xl p-4 overflow-hidden border border-white/10 bg-gradient-to-br ${s.grad}
        poster min-h-[110px] flex flex-col justify-end`}>
      <Radio size={52} className="absolute -top-2 -right-2 text-white/15 rotate-12" />
      <div className="font-bold text-sm text-white drop-shadow">{s.name}</div>
      <div className="text-[11px] text-white/75 mt-0.5 leading-snug">{s.desc}</div>
      <div className="absolute right-3 bottom-3 w-9 h-9 rounded-full bg-black/60 backdrop-blur flex items-center justify-center
        opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
        <ListMusic size={15} className="text-white" />
      </div>
    </motion.button>
  );
}

// Tag Last.fm che non sono generi veri: mai proporli come radio
const JUNK_TAGS = new Set([
  'seen live', 'favorites', 'favourite', 'favorite', 'love', 'hate', 'my favorite',
  'male vocalists', 'female vocalists', 'all', 'misc', 'other', 'various',
]);

// Radio di genere generata dai tuoi tag: "Radio italian rock", "Radio 90s"…
function GenreRadioChip({ tag, i }: { tag: string; i: number }) {
  const openStation = useApp((st) => st.openStation);
  return (
    <motion.button
      onClick={() => openStation({ kind: 'radio', radioKind: 'genre', value: tag })}
      initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.03 }}
      className="group flex items-center gap-2 px-3.5 py-2 rounded-full bg-panel border border-line
        hover:border-accent hover:bg-accent/10 transition-colors text-sm">
      <AudioLines size={13} className="text-accent2 group-hover:text-accent" />
      <span className="capitalize">{tag}</span>
    </motion.button>
  );
}

// Chiave stabile della selezione: refetch quando cambia stazione/radio
const selKey = (s: StationSel) => (s.kind === 'station' ? `s:${s.id}` : `r:${s.radioKind}:${s.value}`);

function selMeta(s: StationSel): { name: string; desc: string; grad: string } {
  if (s.kind === 'station') {
    const def = STATIONS.find((x) => x.id === s.id);
    return { name: def?.name ?? 'Stazione', desc: def?.desc ?? '', grad: def?.grad ?? 'from-fuchsia-500 to-purple-500' };
  }
  return s.radioKind === 'artist'
    ? { name: `Radio di ${s.value}`, desc: 'I suoi brani + artisti simili, rinnovati a ogni apertura', grad: 'from-teal-500 to-cyan-400' }
    : { name: `Radio ${s.value}`, desc: 'Il meglio del genere sui tuoi gusti, sempre aggiornato', grad: 'from-fuchsia-500 to-purple-500' };
}

const shuffled = (list: TrackRef[]) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Vista lista della stazione: la scaletta si rigenera a ogni apertura e con
// "Rigenera" — il play resta un gesto esplicito (tutto il pulsante o la riga).
function StationDetail({ sel }: { sel: StationSel }) {
  const { openStation, playStation, toast } = useApp();
  const [tracks, setTracks] = useState<TrackRef[]>([]);
  const [loading, setLoading] = useState(true);
  const meta = useMemo(() => selMeta(sel), [sel]);
  const key = selKey(sel);

  const load = async () => {
    setLoading(true);
    const ck = sel.kind === 'station' ? `st:${sel.id}` : `radio:${sel.radioKind}:${sel.value}`;
    try {
      const t = sel.kind === 'station'
        ? await api().rec.station(sel.id)
        : await api().rec.radio(sel.radioKind, sel.value);
      setTracks(t);
      if (t.length) cacheAuto(ck, t);
      else toast('Stazione vuota, riprova tra poco', 'info');
    } catch {
      // PC spento: ultima scaletta generata, poi approssimazione locale
      // (query della stazione / like+libreria cachate / ricerca diretta).
      const s = useApp.getState();
      const t = cachedAuto<TrackRef[]>(ck)
        ?? await (sel.kind === 'station'
          ? offlineStation(sel.id, s.library, s.remoteLikeList)
          : offlineRadio(sel.radioKind, sel.value)).catch(() => []);
      setTracks(t ?? []);
      if (!t?.length) toast(`Stazione non disponibile — ${pcGone()} e nessuna traccia trovata`, 'info');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
      className="overflow-y-auto h-full">
      {/* Hero della stazione */}
      <div className={`relative bg-gradient-to-br ${meta.grad} px-5 md:px-8 pt-6 pb-7`}>
        <button onClick={() => openStation(null)}
          className="flex items-center gap-1.5 text-xs text-white/85 hover:text-white mb-5">
          <ArrowLeft size={14} /> Stazioni
        </button>
        <div className="flex items-end gap-4">
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-xl bg-black/25 backdrop-blur flex items-center justify-center shrink-0 shadow-xl">
            <Radio size={36} className="text-white/85" />
          </div>
          <div className="min-w-0 pb-1">
            <div className="text-[10px] font-bold tracking-[0.2em] text-white/70 uppercase">Stazione · sempre aggiornata</div>
            <h1 className="text-2xl md:text-3xl font-black text-white drop-shadow leading-tight truncate">{meta.name}</h1>
            {meta.desc && <div className="text-xs text-white/80 mt-1 line-clamp-2 max-w-lg">{meta.desc}</div>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 mt-5">
          <button onClick={() => playStation(tracks)} disabled={!tracks.length}
            className="px-5 py-2.5 rounded-full bg-white text-black font-bold text-sm flex items-center gap-2
              shadow-xl hover:scale-105 transition-transform disabled:opacity-50">
            <Play size={16} fill="currentColor" /> Riproduci
          </button>
          <button onClick={() => playStation(shuffled(tracks))} disabled={!tracks.length}
            className="px-4 py-2.5 rounded-full bg-black/35 backdrop-blur text-white text-sm font-medium
              flex items-center gap-2 hover:bg-black/50 transition-colors disabled:opacity-50">
            <Shuffle size={15} /> Mescola
          </button>
          <button onClick={() => void load()} disabled={loading}
            className="px-4 py-2.5 rounded-full bg-black/35 backdrop-blur text-white text-sm font-medium
              flex items-center gap-2 hover:bg-black/50 transition-colors disabled:opacity-50"
            title="Genera una scaletta nuova">
            <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Rigenera
          </button>
        </div>
      </div>

      {/* Scaletta: skeleton solo al PRIMO caricamento — su "Rigenera" la lista
          resta visibile (il bottone gira) invece di sparire e ricomparire */}
      <div className="p-4 md:p-8 pt-5">
        {loading && tracks.length === 0 ? <SkeletonRows n={10} /> : tracks.length ? (
          <div className={`bg-panel border border-line rounded-xl divide-y divide-line/50 transition-opacity ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {tracks.map((t, i) => <TrackRow key={t.videoId + i} t={t} index={i} queue={tracks} radio />)}
          </div>
        ) : (
          <Empty icon={<Radio size={30} />} title="Nessun brano ora"
            sub="La stazione non ha trovato brani — ascolta e metti like per affinare i gusti, o riprova." />
        )}
      </div>
    </motion.div>
  );
}

export default function Stations() {
  const [myTags, setMyTags] = useState<string[]>([]);
  const sel = useApp((st) => st.stationSel);

  useEffect(() => {
    // Tag Last.fm se ci sono; altrimenti i generi ID3 dei file scaricati
    void Promise.all([api().library.taste('tag'), api().library.taste('genre')]).then(([tags, genres]) => {
      const all = [...tags, ...genres]
        .filter((r) => r.weight > 0.3 && !JUNK_TAGS.has(r.value))
        .sort((a, b) => b.weight - a.weight);
      setMyTags([...new Set(all.map((r) => r.value))].slice(0, 10));
    }).catch(() => {
      // PC spento: i chip "radio di genere" si ricavano dai generi della
      // libreria cachata — stesso effetto, senza il motore dei gusti.
      const lib = useApp.getState().library;
      const count = new Map<string, number>();
      for (const t of lib) if (t.genre) count.set(t.genre, (count.get(t.genre) ?? 0) + 1 + (t.liked ? 2 : 0));
      setMyTags([...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 10));
    });
  }, []);

  return (
    <AnimatePresence mode="wait">
      {sel ? <StationDetail key={selKey(sel)} sel={sel} /> : (
        <motion.div key="grid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="p-4 md:p-8 space-y-8 overflow-y-auto h-full">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="text-3xl font-bold tracking-tight">
              <span className="bg-gradient-to-r from-accent to-accent2 bg-clip-text text-transparent">Stazioni</span>
            </h1>
            <p className="text-dim mt-1 text-sm">
              Apri una stazione e guarda la scaletta: si rinnova a ogni visita con brani nuovi sui tuoi gusti. Il play lo decidi tu.
            </p>
          </motion.div>

          {/* Radio generate dai tuoi generi: vive del profilo gusti */}
          {myTags.length > 0 && (
            <section>
              <SectionTitle title="Radio per i tuoi generi" sub="Dedotti da ciò che ascolti e metti tra i preferiti" />
              <div className="flex flex-wrap gap-2">
                {myTags.map((t, i) => <GenreRadioChip key={t} tag={t} i={i} />)}
              </div>
            </section>
          )}

          {GROUPS.map((g) => {
            const list = STATIONS.filter((s) => s.group === g.id);
            if (!list.length) return null;
            return (
              <section key={g.id}>
                <SectionTitle title={g.title} sub={g.sub} />
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                  {list.map((s, i) => <StationCard key={s.id} s={s} i={i} />)}
                </div>
              </section>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
