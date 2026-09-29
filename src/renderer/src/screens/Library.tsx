import { useMemo, useState } from 'react';
import { Library as LibIcon, FolderOpen, Heart, Disc3, ListPlus, Trash2, X, LayoutGrid, List, Smartphone, Loader2, Download, FolderInput } from 'lucide-react';
import { pickFiles } from '../files';
import { AnimatePresence, motion } from 'framer-motion';
import { useApp } from '../store';
import { api, isRemote } from '../api';
import { isOnline, pcGone, resyncWhen, syncNote } from '../remote';
import { usePersistedState } from '../persist';
import { queuePlOp } from '../pendingSync';
import TrackRow from '../components/TrackRow';
import { TrackPoster } from '../components/Shelf';
import { SectionTitle, Empty, SkeletonRows, SkeletonGrid } from '../components/common';
import type { Playlist } from '../../../shared/types';

export default function Library() {
  const { library, libraryLoaded, loadLibrary, toast, settings, remoteLikeList, phoneIds } = useApp();
  const activeDl = useApp((s) => s.downloads.filter((d) => !['done', 'error'].includes(d.status)).length);
  const [filter, setFilter] = useState('');
  const [bulkBusy, setBulkBusy] = useState<string | null>(null); // progresso operazioni multipla
  const [onlyLiked, setOnlyLiked] = usePersistedState('mh-pref-libliked', false);
  const [onlyPhone, setOnlyPhone] = useState(false); // filtro "sul telefono" (sessione)
  const [sort, setSort] = usePersistedState<'recent' | 'artist' | 'title' | 'album'>('mh-pref-libsort', 'recent');
  const [view, setView] = usePersistedState<'list' | 'grid'>('mh-pref-libview', 'list');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [plMenu, setPlMenu] = useState(false);
  const [pls, setPls] = useState<Playlist[]>([]);
  // Righe "rimosse" con PC spento: il soft-delete è solo accodato — la riga
  // sparisce a vista finché non torna il PC (al drain il delete parte davvero).
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());

  // In vista Preferiti entrano anche i like remoti (non scaricati): li vedi,
  // li ascolti, puoi togliere il cuore o scaricarli — senza duplicati.
  const remoteOnly = useMemo(() => {
    if (!onlyLiked) return [];
    const owned = new Set(library.map((t) => t.videoId));
    return remoteLikeList
      .filter((r) => !owned.has(r.videoId))
      .filter((r) => !filter || `${r.artist} ${r.title}`.toLowerCase().includes(filter.toLowerCase()));
  }, [onlyLiked, remoteLikeList, library, filter]);

  const tracks = useMemo(() => {
    const list = library
      .filter((t) => !removedIds.has(t.id))
      .filter((t) => (!onlyLiked || t.liked))
      .filter((t) => (!onlyPhone || phoneIds.has(t.id)))
      .filter((t) => !filter || `${t.artist} ${t.title} ${t.album ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
    if (sort === 'recent') return list; // già added_at DESC dal DB
    const cmp = (a: string, b: string) => a.localeCompare(b, 'it', { sensitivity: 'base' });
    return [...list].sort((a, b) =>
      sort === 'artist' ? cmp(a.artist, b.artist) || cmp(a.title, b.title)
      : sort === 'album' ? cmp(a.album ?? '', b.album ?? '') || cmp(a.title, b.title)
      : cmp(a.title, b.title));
  }, [library, filter, onlyLiked, onlyPhone, phoneIds, sort, removedIds]);

  const addAllToCd = () => {
    const burnable = tracks.filter((t) => !t.phoneOnly); // "solo telefono" non esiste sul PC
    if (!burnable.length) { toast('Nessun brano masterizzabile nella selezione', 'err'); return; }
    for (const t of burnable) useApp.getState().addToCd(t, true);
    const mins = Math.round(burnable.reduce((a, t) => a + (t.durationS ?? 0), 0) / 60);
    const skipped = tracks.length - burnable.length;
    toast(mins > 80
      ? `${burnable.length} brani aggiunti — attenzione: ~${mins} min, oltre la capienza di un CD audio`
      : `${burnable.length} brani aggiunti al CD${skipped ? ` (${skipped} solo-telefono esclusi)` : ''}`, 'ok');
  };

  const selected = useMemo(() => tracks.filter((t) => sel.has(t.id)), [tracks, sel]);
  const toggleSel = (id: number, v: boolean) =>
    setSel((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
  const clearSel = () => setSel(new Set());

  const bulkCd = () => {
    const burnable = selected.filter((t) => !t.phoneOnly);
    if (!burnable.length) { toast('Brani solo sul telefono — non masterizzabili', 'err'); return; }
    for (const t of burnable) useApp.getState().addToCd(t, true);
    const skipped = selected.length - burnable.length;
    toast(`${burnable.length} brani aggiunti al CD${skipped ? ` (${skipped} solo-telefono esclusi)` : ''}`, 'ok');
    clearSel();
  };

  const bulkPlaylist = async () => {
    try { setPls(await api().playlists.list()); setPlMenu(true); }
    catch { toast(`Playlist non disponibili — ${pcGone()}`, 'info'); }
  };

  const bulkAddTo = async (pl: Playlist) => {
    if (bulkBusy) return;
    let failed = 0, done = 0;
    const sel0 = selected; // snapshot: clearSel azzera `sel` e il conteggio cambierebbe
    setBulkBusy(`Aggiungo a "${pl.name}"…`);
    for (const t of sel0) {
      // addRef vale per tutto: righe della libreria per id, righe "solo
      // telefono" per videoId (il PC le riscarica); offline → coda locale.
      try { await api().playlists.addRef(pl.id, t); }
      catch { failed++; }
      setBulkBusy(`Aggiungo a "${pl.name}"… ${++done}/${sel0.length}`);
    }
    setBulkBusy(null);
    setPlMenu(false);
    toast(
      failed ? `${sel0.length - failed} brani in "${pl.name}" (${failed} non aggiunti)`
             : `${sel0.length} brani in "${pl.name}"${syncNote()}`,
      failed ? 'err' : 'ok');
    clearSel();
  };

  const bulkDelete = async () => {
    if (bulkBusy) return;
    const removed: number[] = [];
    const sel0 = selected;
    let done = 0;
    setBulkBusy('Elimino…');
    for (const t of sel0) {
      try {
        if (useApp.getState().player.current?.videoId === t.videoId) useApp.getState().stop();
        // Riga "solo telefono": sul PC non esiste — elimina la copia locale
        if (t.phoneOnly) {
          await useApp.getState().removeFromPhone(t.id);
          setBulkBusy(`Elimino… ${++done}/${sel0.length}`); // il continue non deve saltare il conteggio
          continue;
        }
        await api().library.remove(t.id);
        removed.push(t.id);
      } catch {
        // PC spento: soft-delete in coda — parte al reconnect, riga nascosta a vista
        if (isRemote() && !isOnline() && t.id > 0) { queuePlOp('libRemove', [t.id]); removed.push(t.id); }
        /* un fallimento non blocca gli altri */
      }
      setBulkBusy(`Elimino… ${++done}/${sel0.length}`);
    }
    setBulkBusy(null);
    clearSel();
    if (removed.length) setRemovedIds((s) => new Set([...s, ...removed]));
    await loadLibrary();
    // Soft-delete: i file restano fino al prossimo avvio → Annulla ripristina tutto
    toast(`${removed.length} brani eliminati`, 'info', {
      label: 'Annulla',
      run: async () => {
        for (const id of removed) {
          try { await api().library.restore(id); }
          catch { if (isRemote() && !isOnline()) queuePlOp('libRestore', [id]); }
        }
        setRemovedIds((s) => { const n = new Set(s); for (const id of removed) n.delete(id); return n; });
        await loadLibrary();
      },
    });
  };

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full relative">
      <SectionTitle title="Libreria"
        sub={`${library.length} brani · MP3 320 kbps${isRemote() && phoneIds.size ? ` · ${phoneIds.size} sul telefono` : ''}`}
        action={
          <div className="flex items-center gap-2">
            <button onClick={() => useApp.getState().nav('downloads')}
              className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 ${activeDl ? 'bg-accent2/15 text-accent2 border border-accent2/30' : 'bg-panel2 hover:bg-line text-dim hover:text-txt'}`}
              title="Coda di download">
              {activeDl ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download{activeDl ? ` (${activeDl})` : ''}
            </button>
            {!isRemote() && (
              <button onClick={() => settings && api().sys.openFolder(settings.libraryDir)}
                className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1.5 text-dim hover:text-txt">
                <FolderOpen size={13} /> Apri cartella
              </button>
            )}
            {/* Import file audio: desktop (oltre al drag&drop) E telefono —
                dal telefono il file resta offline e va anche sul PC se c'è */}
            <button onClick={() => { void pickFiles('audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus', true).then((f) => useApp.getState().importAudioFiles(f)); }}
              className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1.5 text-dim hover:text-txt"
              title={isRemote() ? 'Importa file audio dalla memoria del telefono' : 'Importa file audio dal PC'}>
              <FolderInput size={13} /> Importa
            </button>
            {isRemote() && phoneIds.size > 0 && (
              <button onClick={() => setOnlyPhone(!onlyPhone)}
                className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 ${onlyPhone ? 'bg-accent text-white' : 'bg-panel2 hover:bg-line text-dim hover:text-txt'}`}>
                <Smartphone size={13} /> Sul telefono ({phoneIds.size})
              </button>
            )}
            <button onClick={() => setOnlyLiked(!onlyLiked)}
              className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 ${onlyLiked ? 'bg-accent text-white' : 'bg-panel2 hover:bg-line text-dim hover:text-txt'}`}>
              <Heart size={13} /> Preferiti
            </button>
            <button onClick={addAllToCd}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent hover:bg-accent/80 text-white flex items-center gap-1.5 font-medium">
              <Disc3 size={13} /> Tutto al CD
            </button>
          </div>
        } />

      <div className="flex items-center gap-2 mb-4">
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtra per artista, titolo, album…"
          className="w-full max-w-sm bg-panel border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}
          className="bg-panel border border-line rounded-lg px-2 py-2 text-xs text-dim outline-none focus:border-accent">
          <option value="recent">Recenti</option>
          <option value="artist">Artista</option>
          <option value="title">Titolo</option>
          <option value="album">Album</option>
        </select>
        <div className="flex bg-panel2 rounded-lg p-0.5">
          <button onClick={() => setView('list')} title="Vista elenco"
            className={`p-1.5 rounded-md ${view === 'list' ? 'bg-accent text-white' : 'text-dim hover:text-txt'}`}><List size={14} /></button>
          <button onClick={() => setView('grid')} title="Vista copertine"
            className={`p-1.5 rounded-md ${view === 'grid' ? 'bg-accent text-white' : 'text-dim hover:text-txt'}`}><LayoutGrid size={14} /></button>
        </div>
        {view === 'list' && !isRemote() && <div className="text-[11px] text-dim ml-2 max-md:hidden">Hover sulla riga → spunta per selezionare · trascina file audio qui per importarli</div>}
      </div>

      {/* Barra azioni bulk */}
      <AnimatePresence>
        {sel.size > 0 && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className="sticky top-0 z-30 mb-3 flex items-center gap-2 bg-panel2 border border-accent/40 rounded-xl px-4 py-2.5 shadow-lg">
            <span className="text-sm font-medium text-accent">{sel.size} selezionati</span>
            {bulkBusy && <span className="text-[11px] text-dim flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {bulkBusy}</span>}
            <div className="flex-1" />
            <button onClick={bulkCd} disabled={!!bulkBusy} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white flex items-center gap-1.5 font-medium disabled:opacity-50">
              <Disc3 size={13} /> Al CD
            </button>
            <div className="relative">
              <button onClick={bulkPlaylist} disabled={!!bulkBusy} className="text-xs px-3 py-1.5 rounded-lg bg-panel hover:bg-line flex items-center gap-1.5 text-dim hover:text-txt disabled:opacity-50">
                <ListPlus size={13} /> A playlist
              </button>
              {plMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setPlMenu(false)} />
                  <div className="absolute right-0 top-9 z-50 w-52 bg-panel border border-line rounded-lg shadow-2xl py-1">
                    {pls.length === 0 && <div className="px-3 py-2 text-xs text-dim">Nessuna playlist</div>}
                    {pls.map((p) => (
                      <button key={p.id} onClick={() => bulkAddTo(p)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-line/60">{p.name}</button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button onClick={bulkDelete} disabled={!!bulkBusy} className="text-xs px-3 py-1.5 rounded-lg bg-panel hover:bg-red-500/20 flex items-center gap-1.5 text-dim hover:text-red-400 disabled:opacity-50">
              <Trash2 size={13} /> Elimina
            </button>
            <button onClick={clearSel} className="p-1.5 text-dim hover:text-txt"><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Banner: i preferiti remoti non sono su disco — un click li scarica tutti (CD-ready) */}
      {remoteOnly.length > 0 && (
        <div className="mb-3 flex items-center gap-3 bg-accent/10 border border-accent/30 rounded-xl px-4 py-2.5">
          <Heart size={14} className="text-accent shrink-0" />
          <span className="text-xs flex-1">
            {remoteOnly.length} preferit{remoteOnly.length === 1 ? 'o solo in streaming' : 'i solo in streaming'} —
            non sono ancora file MP3, non possono finire su CD.
          </span>
          <button onClick={async () => {
              if (bulkBusy) return;
              let n = 0, done = 0;
              setBulkBusy('Accodo i download…');
              for (const r of remoteOnly) {
                try { await useApp.getState().addDownload({ ...r, source: 'ytmusic' }, true); n++; } catch { /* offline */ }
                setBulkBusy(`Accodo i download… ${++done}/${remoteOnly.length}`);
              }
              setBulkBusy(null);
              toast(n
                ? `${n} download ${isOnline() ? 'avviati' : `in coda — partono ${resyncWhen()}`}`
                : `Download non avviabili — ${pcGone()}`, n ? 'ok' : 'info');
            }}
            disabled={!!bulkBusy}
            className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium hover:bg-accent/85 shrink-0 disabled:opacity-50 flex items-center gap-1.5">
            {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : null} Scarica tutti
          </button>
        </div>
      )}

      {!libraryLoaded && tracks.length === 0 && remoteOnly.length === 0 ? (
        // Skeleton nella stessa forma della vista scelta: la pagina non "salta"
        // quando arrivano i dati
        view === 'grid' ? <SkeletonGrid n={14} /> : <SkeletonRows n={9} />
      ) : tracks.length === 0 && remoteOnly.length === 0 ? (
        <Empty icon={<LibIcon size={40} />} title={library.length || remoteLikeList.length ? 'Nessun risultato col filtro' : 'Libreria vuota'}
          sub={isRemote()
            ? `Cerca brani e scaricali sul telefono — quelli del PC tornano ${resyncWhen()}.`
            : "Cerca brani e premi l'icona download — oppure trascina qui i tuoi file audio."} />
      ) : view === 'grid' ? (
        /* Vista copertine stile Netflix: poster con hover-zoom, click = play */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-x-4 gap-y-6">
          {remoteOnly.map((r) => <TrackPoster key={`r-${r.videoId}`} t={{ ...r, source: 'ytmusic' }}
            queue={[...remoteOnly.map((x) => ({ ...x, source: 'ytmusic' as const })), ...tracks]} />)}
          {tracks.map((t) => <TrackPoster key={t.id} t={t}
            queue={[...remoteOnly.map((x) => ({ ...x, source: 'ytmusic' as const })), ...tracks]} />)}
        </div>
      ) : (
        <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
          {remoteOnly.map((r, i) => (
            <TrackRow key={`r-${r.videoId}`} t={{ ...r, source: 'ytmusic' }} index={i}
              queue={[...remoteOnly.map((x) => ({ ...x, source: 'ytmusic' as const })), ...tracks]} />
          ))}
          {tracks.map((t, i) => (
            <TrackRow key={t.id} t={t} index={remoteOnly.length + i}
              queue={[...remoteOnly.map((x) => ({ ...x, source: 'ytmusic' as const })), ...tracks]}
              showRemove dangerRemove
              checked={sel.has(t.id)} onCheck={(v) => toggleSel(t.id, v)}
              onRemove={async () => {
                if (useApp.getState().player.current?.videoId === t.videoId) useApp.getState().stop();
                // "Solo telefono": sul PC non esiste — elimina la copia locale, niente undo PC
                if (t.phoneOnly) { await useApp.getState().removeFromPhone(t.id); toast(`${t.title} rimosso dal telefono`, 'info'); return; }
                try {
                  await api().library.remove(t.id);
                } catch (e) {
                  if (!(isRemote() && !isOnline())) { toast(`Rimozione fallita: ${e instanceof Error ? e.message : e}`, 'err'); return; }
                  queuePlOp('libRemove', [t.id]); // soft-delete in coda al reconnect
                }
                setRemovedIds((s) => new Set([...s, t.id]));
                toast(`${t.title} rimosso`, 'info', {
                  label: 'Annulla',
                  run: async () => {
                    try { await api().library.restore(t.id); }
                    catch { if (isRemote() && !isOnline()) queuePlOp('libRestore', [t.id]); }
                    setRemovedIds((s) => { const n = new Set(s); n.delete(t.id); return n; });
                    await loadLibrary();
                  },
                });
              }} />
          ))}
        </div>
      )}
    </div>
  );
}
