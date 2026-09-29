import { useEffect, useState } from 'react';
import { ListMusic, Plus, Trash2, FileDown, Disc3, Pencil, Play, RefreshCw, Sparkles, Heart, Flame, Zap, Save, AudioLines, ChevronLeft, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api, isRemote } from '../api';
import { pcGone, syncNote } from '../remote';
import { useApp } from '../store';
import TrackRow from '../components/TrackRow';
import { CoverImg } from '../components/CoverImg';
import { SectionTitle, Empty, SkeletonRows } from '../components/common';
import type { Playlist, TrackRef, LibraryTrack } from '../../../shared/types';
import { cachedAuto, cacheAuto, offlineAutoplaylist } from '../offlineRec';

const KIND_LABEL: Record<Playlist['kind'], string> = {
  'lista': 'Playlist',
  'cd-audio': 'CD Audio',
  'cd-mp3': 'CD MP3',
};

// Playlist autogenerate dal motore gusti — stile Spotify
const AUTO_LISTS = [
  { id: 'mix', name: 'Il tuo mix', desc: 'Preferiti e affini, rinnovati a ogni apertura', grad: 'from-accent to-accent2', icon: Sparkles },
  { id: 'top', name: 'Le tue più ascoltate', desc: 'I brani che non smetti di riprodurre', grad: 'from-amber-500 to-red-500', icon: Flame },
  { id: 'scoperte', name: 'Scoperte per te', desc: 'Novità cucite sui tuoi gusti', grad: 'from-emerald-500 to-teal-400', icon: Zap },
  { id: 'nuove', name: 'Nuove uscite', desc: 'Le uscite recenti che potrebbero piacerti', grad: 'from-amber-500 to-orange-400', icon: Heart },
] as const;

// "vasco rossi" (chiave normalizzata del profilo) → "Vasco Rossi" per i titoli
const titleCase = (s: string) => s.replace(/(^|\s|-)([a-zà-ú])/g, (m) => m.toUpperCase());

// "Brani che ti piacciono": raccolta first-class stile Spotify, in cima a tutto
const LIKED = { id: 'liked', name: 'Brani che ti piacciono', desc: 'Tutti i tuoi like — scaricati e solo streaming', grad: 'from-violet-600 to-indigo-500', icon: Heart };

// Copertina a mosaico 2x2 come Spotify: le prime 4 cover dei brani
function MosaicCover({ tracks }: { tracks?: LibraryTrack[] }) {
  const thumbs = (tracks ?? []).map((t) => t.thumbnail).filter(Boolean).slice(0, 4) as string[];
  if (!thumbs.length) {
    return <div className="w-12 h-12 rounded-lg bg-panel2 flex items-center justify-center shrink-0"><ListMusic size={18} className="text-dim" /></div>;
  }
  return (
    <div className="w-12 h-12 rounded-lg overflow-hidden grid grid-cols-2 grid-rows-2 shrink-0 shadow-md">
      {thumbs.map((t, i) => <CoverImg key={i} src={t} className="w-full h-full object-cover" icon={null} />)}
    </div>
  );
}

export default function Playlists() {
  const [pls, setPls] = useState<Playlist[]>([]);
  const [loaded, setLoaded] = useState(false); // primo list() tornato — prima di allora skeleton, non "vuota"
  const [open, setOpen] = useState<number | null>(null);
  const [auto, setAuto] = useState<{ id: string; name: string; desc: string; tracks: TrackRef[] } | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<Playlist['kind']>('lista');
  const [topArtists, setTopArtists] = useState<string[]>([]);
  const [topTags, setTopTags] = useState<string[]>([]);
  const { toast, addToCd, play } = useApp();

  const load = async () => {
    try { setPls(await api().playlists.list()); } catch { /* offline: cached() ha già provato — lista vuota + banner */ }
    setLoaded(true);
  };
  const autoOpen = useApp((s) => s.autoOpen);
  const plSel = useApp((s) => s.plSel);
  useEffect(() => {
    void load();
    // "Mix <artista>" + "Mix <genere>" dai top del profilo gusti
    void api().library.taste('artist').then((r) => {
      setTopArtists(r.filter((x) => x.weight > 0.5).slice(0, 2).map((x) => x.value));
    }).catch(() => {
      // PC spento: top artisti dalla libreria cachata (playCount+like)
      const lib = useApp.getState().library;
      const count = new Map<string, number>();
      for (const t of lib) if (t.artist) count.set(t.artist, (count.get(t.artist) ?? 0) + t.playCount + (t.liked ? 5 : 0));
      setTopArtists([...count.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a).slice(0, 2));
    });
    void Promise.all([api().library.taste('tag'), api().library.taste('genre')]).then(([tags, genres]) => {
      const junk = new Set(['seen live', 'favorites', 'favourite', 'favorite', 'love', 'hate', 'my favorite', 'male vocalists', 'female vocalists', 'all', 'misc', 'other', 'various']);
      const all = [...tags, ...genres].filter((r) => r.weight > 0.3 && !junk.has(r.value)).sort((a, b) => b.weight - a.weight);
      setTopTags([...new Set(all.map((r) => r.value))].slice(0, 4));
    }).catch(() => {
      const lib = useApp.getState().library;
      const count = new Map<string, number>();
      for (const t of lib) if (t.genre) count.set(t.genre, (count.get(t.genre) ?? 0) + 1 + (t.liked ? 2 : 0));
      setTopTags([...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 4));
    });
  }, []);
  // Deep-link dalla Home/sidebar: quick-tile → lista autogenerata, voce → playlist utente
  useEffect(() => {
    if (plSel != null) {
      useApp.setState({ plSel: null });
      setOpen(plSel); setAuto(null); setRenaming(false); setConfirmDel(false);
    }
    if (!autoOpen) return;
    useApp.setState({ autoOpen: null });
    const def = autoLists.find((a) => a.id === autoOpen);
    const name = def?.name ?? (autoOpen.startsWith('artist:') ? `Mix ${titleCase(autoOpen.slice(7))}` : autoOpen.startsWith('genre:') ? `Mix ${titleCase(autoOpen.slice(6))}` : autoOpen);
    void openAuto(autoOpen, name, def?.desc ?? 'Generata sui tuoi gusti');
  }, [autoOpen, plSel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Local-first: col PC giù (o senza PC) l'api accoda e la playlist esiste
  // SUBITO sul telefono (overlay cache+coda); qui arriva solo l'errore vero.
  const create = async () => {
    if (!newName.trim()) return;
    try {
      const pl = await api().playlists.create(newName.trim(), newKind);
      setNewName('');
      await load();
      setOpen(pl.id); setAuto(null);
      toast(`Playlist creata${syncNote()}`, 'ok');
    } catch (e) {
      toast(`Creazione fallita: ${e instanceof Error ? e.message : e}`, 'err');
    }
  };

  // Apre una playlist autogenerata: tracce calcolate al volo dal motore
  const openAuto = async (id: string, name: string, desc: string) => {
    setOpen(null); setAutoLoading(true);
    setAuto({ id, name, desc, tracks: [] });
    try {
      const tracks = await api().rec.autoplaylist(id);
      setAuto({ id, name, desc, tracks });
      if (tracks.length) cacheAuto(`pl:${id}`, tracks);
      else toast('Nessun brano trovato — ascolta ancora un po\'', 'info');
    } catch {
      // PC spento: ultima lista generata dal PC, poi approssimazione locale
      // da libreria/like cachate + ricerca diretta.
      const s = useApp.getState();
      const tracks = cachedAuto<TrackRef[]>(`pl:${id}`)
        ?? await offlineAutoplaylist(id, s.library, s.remoteLikeList).catch(() => []);
      if (tracks?.length) {
        setAuto({ id, name, desc, tracks });
        toast(`${pcGone()} — lista approssimata dai dati locali`, 'info');
      } else {
        toast(`Generazione fallita — ${pcGone()} e nessun dato locale`, 'info');
        setAuto(null);
      }
    } finally {
      setAutoLoading(false);
    }
  };

  // Salva TUTTI i brani della lista generata: quelli non in libreria il PC li
  // scarica e li aggiunge al termine (addRef) — prima si perdevano i remoti.
  const saveAutoAsPlaylist = async () => {
    if (!auto) return;
    try {
      const pl = await api().playlists.create(auto.name, 'lista');
      let queued = 0;
      for (const t of auto.tracks) {
        if (!t.videoId) continue;
        const r = await api().playlists.addRef(pl.id, t).catch(() => null);
        if (r?.queued) queued++;
      }
      await load();
      toast(queued
        ? `"${auto.name}" salvata — ${queued} brani in download, entrano appena pronti`
        : `"${auto.name}" salvata come playlist${syncNote()}`, 'ok');
    } catch (e) {
      toast(`Salvataggio fallito: ${e instanceof Error ? e.message : e}`, 'err');
    }
  };

  // Modifica di una playlist + ricarica: la lista (PC o overlay locale) è la
  // fonte di verità, niente patch ottimistiche a mano che possono divergere.
  const plAction = async (fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> => {
    try {
      await fn();
      await load();
      if (okMsg) toast(`${okMsg}${syncNote()}`, 'ok');
      return true;
    } catch (e) {
      toast(`Operazione non riuscita: ${e instanceof Error ? e.message : e}`, 'err');
      return false;
    }
  };

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const cur = pls.find((p) => p.id === open);

  const autoLists = [
    { ...LIKED },
    ...AUTO_LISTS.map((a) => ({ ...a })),
    // "Mix <genere>": i Daily Mix di Spotify — dai tag/generi del profilo
    ...topTags.map((g) => ({ id: `genre:${g}`, name: `Mix ${titleCase(g)}`, desc: 'I brani del genere che ami', grad: 'from-indigo-500 to-purple-500', icon: AudioLines })),
    ...topArtists.map((a) => ({ id: `artist:${a}`, name: `Mix ${titleCase(a)}`, desc: `I suoi brani + artisti simili`, grad: 'from-teal-500 to-cyan-400', icon: Sparkles })),
  ];

  // Niente selezionato → la griglia occupa tutta la larghezza (stile "La tua
  // libreria" di Spotify). Con una lista aperta → colonna stretta + dettaglio.
  const showDetail = !!auto || open != null;

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full flex flex-col md:flex-row gap-6">
      <div className={`w-full shrink-0 transition-all ${showDetail ? 'md:w-80' : ''}`}>
        {/* ===== Fatte per te: playlist generate dal motore ===== */}
        <SectionTitle title="Fatte per te" sub="Si rigenerano da sole sui tuoi gusti" />
        <div className={`grid gap-2.5 mb-6 ${showDetail ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'}`}>
          {autoLists.map((a) => (
            <motion.button key={a.id} onClick={() => void openAuto(a.id, a.name, a.desc)}
              whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
              className={`relative text-left rounded-xl overflow-hidden bg-gradient-to-br ${a.grad} p-3 min-h-[86px]
                flex flex-col justify-end shadow-lg ${auto?.id === a.id ? 'ring-2 ring-white/50' : ''}`}>
              {autoLoading && auto?.id === a.id
                ? <Loader2 size={22} className="absolute top-2 right-2 text-white animate-spin" />
                : <a.icon size={26} className="absolute top-2 right-2 text-white/25" />}
              <div className="font-bold text-[13px] text-white drop-shadow leading-tight">{a.name}</div>
            </motion.button>
          ))}
        </div>

        <SectionTitle title="Le tue playlist" sub={`${pls.length} totali`} />
        <div className={`bg-panel border border-line rounded-xl p-3 mb-4 space-y-2 ${showDetail ? '' : 'max-w-md'}`}>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder="Nome nuova playlist…"
            className="w-full bg-panel2 border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          <div className="flex gap-2">
            <select value={newKind} onChange={(e) => setNewKind(e.target.value as Playlist['kind'])}
              className="flex-1 bg-panel2 border border-line rounded-lg px-2 py-2 text-xs outline-none">
              <option value="lista">Playlist semplice</option>
              <option value="cd-audio">Destinata a CD Audio</option>
              <option value="cd-mp3">Destinata a CD MP3</option>
            </select>
            <button onClick={create} className="px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/80">
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className={showDetail ? 'space-y-1' : 'grid gap-1 md:grid-cols-2 xl:grid-cols-3'}>
          {pls.map((p) => (
            <div key={p.id} onClick={() => { setOpen(p.id); setAuto(null); setRenaming(false); setConfirmDel(false); }}
              className={`group w-full flex items-center gap-3 px-2 py-2 rounded-lg text-sm cursor-pointer transition-colors
                ${open === p.id ? 'bg-panel2 text-txt' : 'text-dim hover:text-txt hover:bg-panel2/50'}`}>
              <MosaicCover tracks={p.tracks} />
              <div className="flex-1 min-w-0 text-left">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="text-[10px] text-dim">{KIND_LABEL[p.kind]} · {p.tracks?.length ?? 0} brani</div>
              </div>
              {!!p.tracks?.length && (
                <button onClick={(e) => { e.stopPropagation(); play(p.tracks![0], p.tracks!); }}
                  title="Riproduci playlist"
                  className="opacity-0 group-hover:opacity-100 max-md:opacity-100 w-8 h-8 rounded-full bg-accent text-white flex items-center justify-center shrink-0 shadow-lg">
                  <Play size={13} className="ml-0.5" fill="currentColor" />
                </button>
              )}
            </div>
          ))}
          {!loaded ? (
            <div className="space-y-1.5 py-1">
              {[64, 80, 56].map((w, i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2" style={{ animationDelay: `${i * 70}ms` }}>
                  <div className="w-12 h-12 rounded-lg skeleton bg-panel2" />
                  <div className="space-y-1.5">
                    <div className="h-3 rounded skeleton bg-panel2" style={{ width: w * 2 }} />
                    <div className="h-2.5 w-20 rounded skeleton bg-panel2" />
                  </div>
                </div>
              ))}
            </div>
          ) : pls.length === 0 && <Empty icon={<ListMusic size={28} />} title="Nessuna playlist" />}
        </div>
      </div>

      {showDetail && <div className="flex-1 min-w-0">
        <AnimatePresence mode="wait">
          {auto ? (
            /* ===== Playlist autogenerata ===== */
            <motion.div key={auto.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
              <button onClick={() => setAuto(null)} className="flex items-center gap-1 text-xs text-dim hover:text-txt mb-2"><ChevronLeft size={14} /> Tutte le playlist</button>
              <SectionTitle title={auto.name} sub={`${auto.desc} · ${auto.tracks.length} brani`}
                action={
                  <div className="flex gap-2 items-center">
                    <button onClick={() => auto.tracks.length && play(auto.tracks[0], auto.tracks)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white flex items-center gap-1.5 font-medium hover:bg-accent/85">
                      <Play size={13} fill="currentColor" /> Riproduci
                    </button>
                    <button onClick={() => void openAuto(auto.id, auto.name, auto.desc)} disabled={autoLoading}
                      className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
                      <RefreshCw size={12} className={autoLoading ? 'animate-spin' : ''} /> Rigenera
                    </button>
                    <button onClick={() => void saveAutoAsPlaylist()}
                      className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
                      <Save size={12} /> Salva playlist
                    </button>
                  </div>
                } />
              {autoLoading ? <SkeletonRows n={8} /> : (
                <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
                  {auto.tracks.map((t, i) => <TrackRow key={t.videoId + i} t={t} index={i} queue={auto.tracks} />)}
                  {!auto.tracks.length && <Empty icon={<Sparkles size={28} />} title="Playlist vuota" sub="Il motore non ha trovato brani — ascolta e metti like per affinare i gusti." />}
                </div>
              )}
            </motion.div>
          ) : cur ? (
            /* ===== Playlist utente ===== */
            <motion.div key={cur.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
              <button onClick={() => { setOpen(null); setRenaming(false); setConfirmDel(false); }} className="flex items-center gap-1 text-xs text-dim hover:text-txt mb-2"><ChevronLeft size={14} /> Tutte le playlist</button>
              <SectionTitle title={cur.name} sub={`${KIND_LABEL[cur.kind]} · ${cur.tracks?.length ?? 0} brani · ~${Math.round((cur.tracks ?? []).reduce((s, t) => s + (t.durationS ?? 210), 0) / 60)} min`}
                action={
                  <div className="flex gap-2 items-center">
                    {!!cur.tracks?.length && (
                      <button onClick={() => play(cur.tracks![0], cur.tracks!)}
                        className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white flex items-center gap-1.5 font-medium hover:bg-accent/85">
                        <Play size={13} fill="currentColor" /> Riproduci
                      </button>
                    )}
                    {renaming ? (
                      <>
                        <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={async (e) => { if (e.key === 'Enter' && renameVal.trim()) { await plAction(() => api().playlists.rename(cur.id, renameVal.trim()), 'Rinominata'); setRenaming(false); } if (e.key === 'Escape') setRenaming(false); }}
                          className="bg-panel2 border border-accent rounded-lg px-2 py-1.5 text-xs outline-none w-36" />
                        <button onClick={() => setRenaming(false)} className="text-xs text-dim">Annulla</button>
                      </>
                    ) : (
                      <button onClick={() => { setRenameVal(cur.name); setRenaming(true); }}
                        className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
                        <Pencil size={12} /> Rinomina</button>
                    )}
                    <button onClick={async () => { try { const p = await api().playlists.export(cur.id); if (p) toast(isRemote() ? `M3U salvato in ${p}` : 'M3U esportato', 'ok'); else toast('Nessuna traccia da esportare', 'info'); } catch (e) { toast(`Esportazione fallita: ${e instanceof Error ? e.message : e}`, 'err'); } }}
                      className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
                      <FileDown size={12} /> Esporta M3U</button>
                    <button onClick={() => { (cur.tracks ?? []).forEach((t) => addToCd(t, true)); toast('Tracce nel CD Builder', 'ok'); useApp.getState().nav('cd'); }}
                      className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
                      <Disc3 size={12} /> Al CD Builder</button>
                    <button onClick={async () => {
                        if (!confirmDel) { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 3000); return; }
                        setConfirmDel(false);
                        if (await plAction(() => api().playlists.remove(cur.id), 'Playlist eliminata')) setOpen(null);
                      }}
                      className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 ${confirmDel ? 'bg-red-500/25 text-red-300' : 'bg-panel2 hover:bg-red-500/20 text-dim hover:text-red-400'}`}>
                      <Trash2 size={12} />{confirmDel && <span>Sicuro?</span>}</button>
                  </div>
                } />
              <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
                {(cur.tracks ?? []).map((t, i) => (
                  <TrackRow key={t.id} t={t} index={i} queue={cur.tracks}
                    move={(dir) => { void plAction(() => api().playlists.move(cur.id, t.id, dir)); }}
                    showRemove onRemove={() => { void plAction(() => api().playlists.removeTrack(cur.id, t.id), 'Rimossa dalla playlist'); }} />
                ))}
                {!cur.tracks?.length && <Empty icon={<ListMusic size={28} />} title="Playlist vuota" sub="Aggiungi brani dal menu ⋮ di qualsiasi traccia — anche dai risultati di ricerca." />}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>}
    </div>
  );
}
