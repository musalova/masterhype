import { useEffect, useState } from 'react';
import { TrendingUp, RefreshCw, Gem, Globe, Search as SearchIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from '../api';
import { useApp } from '../store';
import { usePersistedState } from '../persist';
import TrackRow from '../components/TrackRow';
import { CoverImg } from '../components/CoverImg';
import { SectionTitle, Empty, LoadingState } from '../components/common';
import type { TrendItem, TrackRef } from '../../../shared/types';
import { cachedTrends, cacheTrends, offlineTrends } from '../offlineRec';

// Titoli "sporchi" da YouTube ("Artista - Titolo (Official Video)") → solo il titolo
const cleanTitle = (t: string) => t
  .replace(/\s*[([](official\s*(music\s*)?video|official\s*audio|videoclip\s*ufficiale|lyric\s*video|visualizer|audio|hd|4k)[)\]]/gi, '')
  .replace(/^[^-–|]{2,40}\s[-–|]\s(?=\S)/, '')
  .trim() || t;

// `embedded`: renderizzato dentro Cerca (tab "Trend") — niente padding/scroll proprio
export default function Trends({ embedded = false }: { embedded?: boolean }) {
  const [items, setItems] = useState<TrendItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = usePersistedState<'all' | 'niche'>('mh-pref-trendtab', 'all');
  const { toast, seedSearch } = useApp();

  const load = async (refresh = false) => {
    setLoading(true);
    try {
      const list = refresh ? await api().rec.trendsRefresh() : await api().rec.trends();
      setItems(list);
      if (list.length) cacheTrends(list);
    } catch {
      // PC spento: ultima scansione in cache, poi classifiche dirette come
      // approssimazione dei trend (YouTube Music charts ≈ "cosa sale ora").
      const t = cachedTrends() ?? await offlineTrends().catch(() => []);
      setItems(t ?? []);
      if (!t?.length) toast('Trend non disponibili — riprova con la connessione attiva', 'info');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = tab === 'niche' ? items.filter((i) => i.niche) : items;
  const asTracks: (TrendItem & { tr?: TrackRef })[] = shown.map((i) => ({
    ...i,
    tr: i.videoId ? { videoId: i.videoId, title: i.title, artist: i.artist, thumbnail: i.thumbnail, source: 'ytmusic' as const } : undefined,
  }));

  return (
    <div className={embedded ? '' : 'p-4 md:p-8 overflow-y-auto h-full'}>
      <SectionTitle title={embedded ? 'Trend' : 'Trend Radar'} sub="Cosa sta salendo ora su YouTube Music, Deezer e Last.fm — aggiornato ogni 6 ore"
        action={
          <div className="flex gap-2 items-center">
            <div className="flex bg-panel2 rounded-lg p-0.5">
              <button onClick={() => setTab('all')} className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1 ${tab === 'all' ? 'bg-accent text-white' : 'text-dim'}`}>
                <Globe size={12} /> Trend</button>
              <button onClick={() => setTab('niche')} className={`text-xs px-3 py-1.5 rounded-md flex items-center gap-1 ${tab === 'niche' ? 'bg-accent text-white' : 'text-dim'}`}>
                <Gem size={12} /> Nicchia</button>
            </div>
            <button onClick={() => load(true)} disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Scansiona
            </button>
          </div>
        } />

      {loading && <LoadingState label={items.length ? 'Aggiorno le tendenze…' : 'Cerco cosa sta salendo…'}
        detail="Raccolgo le classifiche e le novità disponibili." layout={items.length ? 'inline' : 'rows'} n={8} />}

      {!loading && shown.length === 0 && (
        <Empty icon={<TrendingUp size={36} />}
          title={tab === 'niche' ? 'Nessuna gemma di nicchia trovata' : 'Nessun dato trend'}
          sub={tab === 'niche' ? 'Configura Last.fm nelle Impostazioni per scoperte di nicchia più precise.' : 'Prova a rilanciare la scansione.'} />
      )}

      <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
        {asTracks.map((it, i) => (
          <motion.div key={it.title + it.artist} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.02, 0.5) }}
            className="relative">
            {/* Righe uniformi: TrackRow per i riproducibili; le righe solo-Deezer
                (senza videoId) cercano su YT Music al click, con lo stesso layout */}
            {it.tr
              ? <TrackRow t={{ ...it.tr, title: cleanTitle(it.tr.title) }} index={i} queue={asTracks.filter((x) => x.tr).map((x) => ({ ...x.tr!, title: cleanTitle(x.tr!.title) }))} />
              : <button onClick={() => seedSearch(`${it.artist} ${it.title}`)}
                  title="Cerca su YouTube Music"
                  className="w-full flex items-center gap-3 px-3 py-2 hover:bg-panel2/70 transition-colors text-left group">
                  <div className="w-6 text-xs text-dim text-center shrink-0 max-md:hidden">{i + 1}</div>
                  <div className="w-9 h-9 rounded bg-panel2 overflow-hidden shrink-0 relative">
                    <CoverImg src={it.thumbnail} videoId={it.videoId} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100"><SearchIcon size={13} className="text-white" /></div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{cleanTitle(it.title)}</div>
                    <div className="text-xs text-dim truncate">{it.artist}</div>
                  </div>
                  <span className="text-[10px] text-dim/70 shrink-0 max-md:hidden">Cerca →</span>
                </button>}
            {/* Badge fonte: sotto il numero, a sinistra — non copre più le azioni della riga */}
            <div className="absolute left-3 bottom-0.5 flex items-center gap-1 pointer-events-none max-md:hidden">
              {it.niche && <span className="text-[8px] px-1 rounded bg-accent2/20 text-accent2 font-medium flex items-center gap-0.5"><Gem size={8} /> nicchia</span>}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
