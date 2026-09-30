import { useEffect, useRef, useState } from 'react';
import { Search as SearchIcon, Disc3, User, ListMusic, Sparkles, Heart, ChevronRight, History, X, Radio, Play, Shuffle, TrendingUp } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../api';
import { pushBack } from '../backStack';
import { usePersistedState } from '../persist';
import TrackRow from '../components/TrackRow';
import { CoverImg } from '../components/CoverImg';
import Trends from './Trends';
import { SectionTitle, Empty, LoadingState } from '../components/common';
import { useApp } from '../store';
import { STATIONS } from '../../../shared/types';
import type { SearchResult, TrackRef, ArtistPage, TopResult, ArtistRef, AlbumRef, PlaylistRef } from '../../../shared/types';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').trim();

// Cronologia ricerche (localStorage, max 8)
const HIST_KEY = 'mh-search-history';
const loadHist = (): string[] => {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) ?? '[]') as string[]; } catch { return []; }
};
const pushHist = (h: string[], s: string) => {
  const next = [s, ...h.filter((x) => norm(x) !== norm(s))].slice(0, 8);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(next)); } catch { /* quota */ }
  return next;
};

// Card per album/singolo
function AlbumCard({ a, onOpen, i = 0 }: { a: AlbumRef; onOpen: () => void; i?: number }) {
  return (
    <motion.button onClick={onOpen}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.04, ease: 'easeOut' }}
      className="w-36 shrink-0 bg-panel border border-line rounded-xl p-3 card-hover text-left">
      <div className="w-full aspect-square rounded-lg bg-panel2 overflow-hidden mb-2 flex items-center justify-center">
        <CoverImg src={a.thumbnail} className="w-full h-full object-cover" icon={<Disc3 size={28} className="text-dim" />} />
      </div>
      <div className="text-sm font-medium truncate">{a.title}</div>
      <div className="text-[10px] text-dim truncate">{a.artist}{a.year ? ` · ${a.year}` : ''}</div>
    </motion.button>
  );
}

// Card artista (search + correlati)
function ArtistCard({ a, onOpen, known, i = 0 }: { a: ArtistRef; onOpen: () => void; known?: boolean; i?: number }) {
  return (
    <motion.button onClick={onOpen}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.04, ease: 'easeOut' }}
      className="w-32 shrink-0 bg-panel border border-line rounded-xl p-3 card-hover text-center relative">
      {known && <div className="absolute top-1.5 right-1.5 text-accent" title="Nei tuoi gusti"><Heart size={11} fill="currentColor" /></div>}
      <div className="w-20 h-20 mx-auto rounded-full bg-panel2 overflow-hidden mb-2 flex items-center justify-center">
        <CoverImg src={a.thumbnail} className="w-full h-full object-cover" icon={<User size={24} className="text-dim" />} />
      </div>
      <div className="text-sm font-medium truncate">{a.name}</div>
      <div className="text-[10px] text-dim truncate">{a.subscribers || 'Artista'}</div>
    </motion.button>
  );
}

// Card playlist
function PlaylistCard({ p, onOpen, i = 0 }: { p: PlaylistRef; onOpen: () => void; i?: number }) {
  return (
    <motion.button onClick={onOpen}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: Math.min(i, 12) * 0.04, ease: 'easeOut' }}
      className="w-36 shrink-0 bg-panel border border-line rounded-xl p-3 card-hover text-left">
      <div className="w-full aspect-square rounded-lg bg-panel2 overflow-hidden mb-2 flex items-center justify-center">
        <CoverImg src={p.thumbnail} className="w-full h-full object-cover" icon={<ListMusic size={26} className="text-dim" />} />
      </div>
      <div className="text-sm font-medium truncate">{p.title}</div>
      <div className="text-[10px] text-dim truncate">{p.author || 'Playlist'}</div>
    </motion.button>
  );
}

// Griglia orizzontale scrollabile
function HScroll({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-4 overflow-x-auto pb-2">{children}</div>;
}

// Elenco brani
function TrackList({ tracks }: { tracks: TrackRef[] }) {
  return (
    <div className="bg-panel border border-line rounded-xl divide-y divide-line/50">
      {tracks.map((t, i) => <TrackRow key={t.videoId + i} t={t} index={i} queue={tracks} />)}
      {tracks.length === 0 && <Empty icon={<SearchIcon size={28} />} title="Nessuna traccia" />}
    </div>
  );
}

export default function Search() {
  const { toast, library } = useApp();
  const [q, setQ] = useState('');
  const [emptyTab, setEmptyTab] = usePersistedState<'browse' | 'trends'>('mh-pref-searchtab', 'browse');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadContext, setLoadContext] = useState({ label: 'Cerco la tua musica…', detail: '' });
  const [expanding, setExpanding] = useState(false); // fase 2: categorie in arrivo
  const [tab, setTab] = useState<'all' | 'songs' | 'albums' | 'artists' | 'playlists'>('all');
  const [panel, setPanel] = useState<{ title: string; sub?: string; art?: string; tracks: TrackRef[] } | null>(null);
  const [artist, setArtist] = useState<ArtistPage | null>(null);
  const [history, setHistory] = useState<ArtistPage[]>([]); // stack per navigazione correlati
  const [topArtists, setTopArtists] = useState<Set<string>>(new Set());
  const [topArtistNames, setTopArtistNames] = useState<string[]>([]); // nomi leggibili (non normalizzati)
  const [searchHist, setSearchHist] = useState<string[]>(loadHist);
  const [sugg, setSugg] = useState<string[]>([]); // suggerimenti live sotto l'input
  const [suggOpen, setSuggOpen] = useState(false);
  const [suggIdx, setSuggIdx] = useState(-1); // -1 = testo digitato
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0); // scarta risposte di ricerche superate
  const suggReq = useRef(0); // scarta suggerimenti di query superate

  // Gusti: badge "Nei tuoi gusti" su artisti conosciuti
  useEffect(() => {
    void api().library.stats().then((s) => {
      setTopArtists(new Set([
        ...s.topArtists.map((a) => norm(a.artist)),
        ...library.map((t) => norm(t.artist)),
      ]));
      // I nomi nel profilo sono normalizzati (lowercase): title-case per la UI
      setTopArtistNames(s.topArtists.slice(0, 6).map((a) =>
        a.artist.replace(/\b\p{L}/gu, (c) => c.toUpperCase())));
    }).catch(() => {
      // PC spento: badge "Nei tuoi gusti" dalla sola libreria cachata
      setTopArtists(new Set(useApp.getState().library.map((t) => norm(t.artist))));
    });
  }, [library.length]);

  const doSearch = async (e?: React.FormEvent, query?: string) => {
    e?.preventDefault();
    const queryStr = (query ?? q).trim();
    if (!queryStr) return;
    // Il debounce non deve rilanciare una query appena cercata dai bottoni
    // (cronologia/top artisti): lo marcavano loro, uno si dimenticava →
    // doppia fetch a 450ms. Si marca qui dentro, la fonte unica.
    lastQ.current = queryStr;
    setSuggOpen(false); // la ricerca parte: il dropdown si chiude
    const id = ++reqId.current;
    setLoading(true);
    setExpanding(false);
    setLoadContext({ label: 'Cerco la tua musica…', detail: queryStr });
    setPanel(null); setArtist(null); setHistory([]);
    setTab('all');
    setSearchHist((h) => pushHist(h, queryStr));
    try {
      // Fase 1: risultati base subito; Fase 2: categorie complete in background
      const fast = await api().yt.search(queryStr, false);
      if (reqId.current !== id) return;
      setRes(fast);
      setLoading(false);
      setExpanding(true);
      try {
        const full = await api().yt.search(queryStr, true);
        if (reqId.current !== id) return;
        setRes(full);
        // Contesto per l'auto-miglioramento: chi suona un risultato lo "sceglie" per questa query
        useApp.getState().setSearchCtx(queryStr, full.songs.map((s) => s.videoId));
      } catch {
        if (reqId.current === id) useApp.getState().setSearchCtx(queryStr, fast.songs.map((s) => s.videoId));
      }
      if (reqId.current === id) setExpanding(false);
    } catch {
      if (reqId.current !== id) return;
      setRes({ songs: [], albums: [], artists: [], playlists: [] });
      toast('Ricerca fallita — controlla la connessione', 'err');
      setLoading(false);
      setExpanding(false);
    }
  };

  // Ricerca live mentre digiti (debounce 450ms) — niente più Enter obbligatorio
  const lastQ = useRef('');
  useEffect(() => {
    const t = setTimeout(() => {
      const s = q.trim();
      if (s && s !== lastQ.current) { lastQ.current = s; void doSearch(undefined, s); }
    }, 450);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Suggerimenti mentre digiti (debounce 220ms, più veloce della ricerca):
  // soppressi mentre il testo coincide con la query già cercata (lastQ).
  useEffect(() => {
    const t = setTimeout(() => {
      const s = q.trim();
      if (!s || norm(s) === norm(lastQ.current)) { if (!s) { setSugg([]); setSuggOpen(false); } return; }
      const id = ++suggReq.current;
      void api().yt.suggest(s).then((list) => {
        if (suggReq.current !== id) return;
        // Risposta arrivata DOPO che la ricerca su questo testo è già partita:
        // riaprire il dropdown coprirebbe i risultati — sopprimi.
        if (norm(s) === norm(lastQ.current)) return;
        setSugg(list.filter((x) => norm(x) !== norm(s)));
        setSuggIdx(-1);
        setSuggOpen(true);
      }).catch(() => {});
    }, 220);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickSuggestion = (s: string) => {
    setQ(s);
    setSuggOpen(false);
    void doSearch(undefined, s);
  };

  // Seed esterno (es. click su un trend Deezer senza videoId → cerca su YT)
  useEffect(() => {
    const s = useApp.getState().searchSeed;
    if (s) {
      useApp.setState({ searchSeed: null });
      setQ(s);
      lastQ.current = s;
      void doSearch(undefined, s);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openCollection = async (kind: 'album' | 'playlist', id: string, title: string, art?: string, sub?: string) => {
    const request = ++reqId.current;
    setLoading(true); setExpanding(false);
    setLoadContext({ label: kind === 'album' ? 'Apro l’album…' : 'Apro la playlist…', detail: title });
    try {
      const tracks = await (kind === 'album' ? api().yt.albumTracks(id) : api().yt.playlistTracks(id));
      if (reqId.current !== request) return;
      setArtist(null);
      setPanel({ title, art, sub, tracks });
    } catch {
      if (reqId.current === request) toast(kind === 'album' ? 'Album non disponibile' : 'Playlist non disponibile', 'err');
    } finally {
      if (reqId.current === request) setLoading(false);
    }
  };
  const openAlbum = (id: string, title: string, art?: string, sub?: string) => openCollection('album', id, title, art, sub);
  const openPlaylist = (id: string, title: string, art?: string, sub?: string) => openCollection('playlist', id, title, art, sub);

  const openArtist = async (id: string, name = '') => {
    const request = ++reqId.current;
    setLoading(true); setExpanding(false);
    setLoadContext({ label: 'Apro la pagina artista…', detail: name });
    try {
      const page = await api().yt.artistPage(id);
      if (reqId.current !== request) return;
      setPanel(null);
      setHistory((h) => (artist ? [...h, artist] : h));
      setArtist(page);
    } catch {
      if (reqId.current === request) toast(`Pagina artista non disponibile${name ? `: ${name}` : ''}`, 'err');
    } finally {
      if (reqId.current === request) setLoading(false);
    }
  };

  const cancelLoad = () => { reqId.current++; setLoading(false); setExpanding(false); };

  const goBack = () => {
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setArtist(prev ?? null);
  };

  // Tasto indietro hardware (Android): un dettaglio aperto — pagina artista o
  // tracklist di album/playlist — si chiude prima di uscire dalla schermata.
  useEffect(() => {
    if (!artist && !panel) return;
    return pushBack(() => {
      if (artist) goBack(); else setPanel(null);
      return true;
    });
  }); // ri-registra a ogni render: goBack cattura l'ultima history

  const openTop = (t: TopResult) => {
    if (t.kind === 'artist') return openArtist(t.id, t.title);
    if (t.kind === 'album') return openAlbum(t.id, t.title, t.thumbnail, t.subtitle);
    if (t.kind === 'playlist') return openPlaylist(t.id, t.title, t.thumbnail, t.subtitle);
    // Il "risultato principale" può NON essere nella lista songs (dedup YT):
    // senza fallback il tap non faceva nulla — si suona il TrackRef sintetico.
    // artist/durationS arrivano dal sottotitolo della card (ytparse.subtitleMeta).
    const track = res?.songs.find((s) => s.videoId === t.id)
      ?? (t.id ? { videoId: t.id, title: t.title, artist: t.artist ?? '', durationS: t.durationS, thumbnail: t.thumbnail, source: 'ytmusic' as const } : undefined);
    if (track) useApp.getState().play(track, res?.songs.length ? res.songs : [track]);
  };

  const knownArtist = (name: string) => topArtists.has(norm(name));

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full">
      <form onSubmit={doSearch} className="relative max-w-xl mb-6">
        <SearchIcon size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-dim" />
        <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} autoFocus
          type="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" spellCheck={false}
          placeholder="Cosa vuoi ascoltare? Brano, artista o album"
          onFocus={() => { if (sugg.length && q.trim() && norm(q) !== norm(lastQ.current)) setSuggOpen(true); }}
          onBlur={() => setSuggOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (!suggOpen || !sugg.length) return;
              e.preventDefault();
              const d = e.key === 'ArrowDown' ? 1 : -1;
              const n = sugg.length;
              setSuggIdx((i) => (i + d >= n ? 0 : i + d < 0 ? n - 1 : i + d));
            } else if (e.key === 'Enter' && suggOpen && suggIdx >= 0 && sugg[suggIdx]) {
              e.preventDefault();
              pickSuggestion(sugg[suggIdx]);
            } else if (e.key === 'Escape') {
              setSuggOpen(false);
            }
          }}
          className="w-full bg-panel border border-line rounded-full pl-11 pr-4 py-3 text-sm outline-none focus:border-accent focus-visible:outline-none focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent),0_0_22px_-4px_color-mix(in_srgb,var(--color-accent)_50%,transparent)] transition-shadow" />
        {q && (
          <button type="button" aria-label="Cancella ricerca" onClick={() => { cancelLoad(); suggReq.current++; setQ(''); setRes(null); setSugg([]); setSuggOpen(false); lastQ.current = ''; inputRef.current?.focus(); }}
            className="absolute right-4 top-1/2 -translate-y-1/2 text-dim hover:text-txt">
            <X size={15} />
          </button>
        )}
        {/* Suggerimenti live (YouTube Music): freccia su/giù + Invio, o tap */}
        {suggOpen && sugg.length > 0 && (
          <div role="listbox" className="absolute left-0 right-0 top-full mt-2 bg-panel border border-line rounded-2xl overflow-hidden shadow-2xl z-30">
            {sugg.map((s, i) => (
              <button key={s} type="button" role="option" aria-selected={i === suggIdx}
                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s); }}
                onMouseEnter={() => setSuggIdx(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors ${i === suggIdx ? 'bg-accent/15 text-txt' : 'text-dim hover:bg-panel2'}`}>
                <SearchIcon size={14} className="shrink-0 opacity-70" />
                <span className="truncate">{s}</span>
              </button>
            ))}
          </div>
        )}
      </form>

      {/* Accesso rapido: i tuoi top artisti → un tap e cerchi */}
      {!q && !res && topArtistNames.length > 0 && (
        <div className="mb-6 -mt-2">
          <div className="flex items-center gap-1.5 text-[11px] text-dim mb-2"><Sparkles size={11} /> Dai tuoi gusti</div>
          <div className="flex flex-wrap gap-2">
            {topArtistNames.map((a) => (
              <button key={a} onClick={() => { setQ(a); void doSearch(undefined, a); }}
                className="text-xs px-3 py-1.5 rounded-full bg-panel border border-accent/25 text-txt hover:border-accent hover:bg-accent/10 transition-colors">
                {a}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Ricerche recenti */}
      {!q && !res && searchHist.length > 0 && (
        <div className="mb-6 -mt-2">
          <div className="flex items-center gap-1.5 text-[11px] text-dim mb-2"><History size={11} /> Recenti</div>
          <div className="flex flex-wrap gap-2">
            {searchHist.map((s) => (
              <button key={s} onClick={() => { setQ(s); void doSearch(undefined, s); }}
                className="text-xs px-3 py-1.5 rounded-full bg-panel border border-line text-dim hover:text-txt hover:border-accent transition-colors">
                {s}
              </button>
            ))}
            <button onClick={() => { setSearchHist([]); try { localStorage.removeItem(HIST_KEY); } catch { /* */ } }}
              className="text-xs px-2 py-1.5 text-dim/60 hover:text-red-400" title="Cancella cronologia">
              <X size={13} />
            </button>
          </div>
        </div>
      )}

      {/* Pagina vuota: due tab — Sfoglia (categorie, stile Spotify) e Trend
          (il vecchio "Trend Radar", ora dentro Cerca invece che nel menu) */}
      {!q && !res && !loading && (
        <section>
          <div className="flex items-center gap-1 bg-panel border border-line rounded-full p-1 w-fit mb-4">
            {([['browse', 'Sfoglia', Radio], ['trends', 'Trend', TrendingUp]] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => setEmptyTab(id)}
                className={`px-4 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition-colors
                  ${emptyTab === id ? 'bg-accent text-white shadow' : 'text-dim hover:text-txt'}`}>
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          {emptyTab === 'trends' ? <Trends embedded /> : (
            <>
              <SectionTitle title="Sfoglia tutto" sub="Mood, generi e decenni — ogni tile è una stazione con la sua scaletta" />
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {STATIONS.filter((s) => s.group !== 'per-te').map((s, i) => (
                  <motion.button key={s.id}
                    onClick={() => useApp.getState().openStation({ kind: 'station', id: s.id })}
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 14) * 0.03 }}
                    className={`station-art relative text-left rounded-xl overflow-hidden bg-gradient-to-br ${s.grad} p-4 min-h-[110px]
                      flex flex-col justify-end card-hover shadow-lg`}>
                    <Radio size={30} className="absolute -top-1 -right-1 text-white/20 rotate-12" />
                    <div className="font-bold text-[13px] text-white drop-shadow leading-tight">{s.name}</div>
                  </motion.button>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {loading && <LoadingState {...loadContext} n={7} onCancel={cancelLoad} />}

      {/* "Forse cercavi…" */}
      {!loading && res?.correctedQuery && (
        <button onClick={() => { setQ(res.correctedQuery!); void doSearch(undefined, res.correctedQuery!); }}
          className="mb-4 text-sm text-dim hover:text-accent transition-colors">
          Forse cercavi: <span className="text-accent font-medium">{res.correctedQuery}</span>
        </button>
      )}

      {/* Pannello tracce (album / playlist) — header con copertina stile Spotify */}
      <AnimatePresence>
        {!loading && panel && (
          <motion.section initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-8">
            <div className="flex items-end gap-4 mb-5">
              <div className="w-24 h-24 md:w-28 md:h-28 rounded-xl bg-panel2 overflow-hidden shrink-0 shadow-xl flex items-center justify-center">
                <CoverImg src={panel.art} className="w-full h-full object-cover" icon={<Disc3 size={30} className="text-dim" />} />
              </div>
              <div className="min-w-0 flex-1 pb-0.5">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-dim">Raccolta</div>
                <h2 className="text-2xl font-bold truncate">{panel.title}</h2>
                <div className="text-xs text-dim mt-1 truncate">
                  {panel.sub}{panel.sub && panel.tracks.length ? ' · ' : ''}{panel.tracks.length ? `${panel.tracks.length} brani` : ''}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 pb-1">
                {panel.tracks.length > 0 && (
                  <button onClick={() => useApp.getState().play(panel.tracks[0], panel.tracks)}
                    className="text-xs px-4 py-2 rounded-full bg-accent text-white flex items-center gap-1.5 font-semibold hover:bg-accent/85 shadow-lg">
                    <Play size={13} fill="currentColor" /> Riproduci
                  </button>
                )}
                <button onClick={() => setPanel(null)} className="text-xs text-dim hover:text-txt px-2 py-2">← Torna</button>
              </div>
            </div>
            <TrackList tracks={panel.tracks} />
          </motion.section>
        )}
      </AnimatePresence>

      {/* Pagina artista completa */}
      <AnimatePresence>
        {!loading && artist && !panel && (
          <motion.div key={artist.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {/* Hero artista stile Spotify: backdrop sfocato dalla foto, nome
                enorme, azioni prominenti (Riproduci / Mescola / Radio) */}
            <div className="relative rounded-2xl overflow-hidden mb-8 border border-line">
              {artist.thumbnail && (
                <div className="absolute inset-0 bg-cover bg-center"
                  style={{ backgroundImage: `url(${artist.thumbnail.replace(/w\d+-h\d+/, 'w1080-h1080')})`, filter: 'blur(26px) brightness(0.4) saturate(1.25)', transform: 'scale(1.2)' }} />
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/55 to-transparent" />
              <div className="relative px-5 md:px-8 pt-8 pb-6 flex items-end gap-5 min-h-[190px]">
                <div className="w-28 h-28 md:w-36 md:h-36 rounded-full bg-panel2 overflow-hidden shrink-0 shadow-2xl shadow-black/60 flex items-center justify-center">
                  <CoverImg src={artist.thumbnail?.replace(/w\d+-h\d+/, 'w544-h544')} className="w-full h-full object-cover" icon={<User size={44} className="text-dim" />} />
                </div>
                <div className="min-w-0 flex-1 pb-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-3xl md:text-4xl font-black tracking-tight truncate drop-shadow-lg">{artist.name}</h2>
                    {knownArtist(artist.name) && <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent/20 text-accent font-medium shrink-0">Nei tuoi gusti</span>}
                  </div>
                  {artist.subscribers && <div className="text-sm text-white/70 mt-1">{artist.subscribers}</div>}
                  {artist.description && <div className="text-xs text-white/60 mt-1.5 line-clamp-2 max-w-2xl">{artist.description}</div>}
                  <div className="flex flex-wrap items-center gap-2.5 mt-4">
                    {artist.topSongs.length > 0 && (
                      <>
                        <button onClick={() => useApp.getState().play(artist.topSongs[0], artist.topSongs)}
                          className="px-5 py-2.5 rounded-full bg-accent text-white font-bold text-sm flex items-center gap-2 shadow-xl hover:scale-105 transition-transform">
                          <Play size={15} fill="currentColor" /> Riproduci
                        </button>
                        <button onClick={() => {
                            const a = [...artist.topSongs];
                            for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
                            useApp.getState().play(a[0], a);
                          }}
                          className="px-4 py-2.5 rounded-full bg-white/10 backdrop-blur text-white text-sm font-medium flex items-center gap-2 hover:bg-white/20 transition-colors">
                          <Shuffle size={14} /> Mescola
                        </button>
                      </>
                    )}
                    <button onClick={() => useApp.getState().openStation({ kind: 'radio', radioKind: 'artist', value: artist.name })}
                      className="px-4 py-2.5 rounded-full bg-white/10 backdrop-blur text-white text-sm font-medium flex items-center gap-2 hover:bg-white/20 transition-colors"
                      title={`Radio infinita partendo da ${artist.name}`}>
                      <Radio size={14} /> Radio
                    </button>
                    {history.length > 0 && (
                      <button onClick={goBack} className="px-3 py-2.5 text-xs text-white/70 hover:text-white">← Indietro</button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {artist.topSongs.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Brani più ascoltati" />
                <TrackList tracks={artist.topSongs} />
              </section>
            )}

            {artist.albums.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Album" sub={`${artist.albums.length} pubblicazioni`} />
                <HScroll>{artist.albums.map((a, i) => <AlbumCard key={a.browseId} a={a} i={i} onOpen={() => openAlbum(a.browseId, a.title, a.thumbnail, `${a.artist}${a.year ? ` · ${a.year}` : ''}`)} />)}</HScroll>
              </section>
            )}

            {artist.singles.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Singoli ed EP" />
                <HScroll>{artist.singles.map((a, i) => <AlbumCard key={a.browseId} a={a} i={i} onOpen={() => openAlbum(a.browseId, a.title, a.thumbnail, `${a.artist}${a.year ? ` · ${a.year}` : ''}`)} />)}</HScroll>
              </section>
            )}

            {artist.related.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Ai fan piace anche" sub="Alternative coerenti — clicca per esplorare" />
                <HScroll>{artist.related.map((a, i) => <ArtistCard key={a.browseId} a={a} i={i} known={knownArtist(a.name)} onOpen={() => openArtist(a.browseId, a.name)} />)}</HScroll>
              </section>
            )}

            {artist.playlists.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Playlist" />
                <HScroll>{artist.playlists.map((p, i) => <PlaylistCard key={p.id} p={p} i={i} onOpen={() => openPlaylist(p.id, p.title, p.thumbnail, p.author)} />)}</HScroll>
              </section>
            )}

            {artist.videos.length > 0 && (
              <section className="mb-8">
                <SectionTitle title="Live e video" sub="Versioni video — scaricabili come audio" />
                <TrackList tracks={artist.videos} />
              </section>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Risultati ricerca */}
      {!loading && res && !artist && !panel && (
        <div className="space-y-8">
          {/* Tab filtri + stato espansione */}
          <div className="flex items-center gap-2 flex-wrap">
            {([
              ['all', 'Tutto'], ['songs', 'Brani'], ['albums', 'Album'], ['artists', 'Artisti'], ['playlists', 'Playlist'],
            ] as const).map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${tab === k ? 'bg-accent text-white font-medium' : 'bg-panel2 text-dim hover:text-txt'}`}>
                {label}
              </button>
            ))}
            {expanding && <span role="status" className="text-[11px] text-dim flex items-center gap-1.5 ml-1"><div className="eq"><i /><i /><i /></div> altre categorie…</span>}
          </div>

          {/* Top result */}
          {tab === 'all' && res.topResult && (
            <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <SectionTitle title="Risultato principale" />
              <button onClick={() => openTop(res.topResult!)}
                className="flex items-center gap-4 bg-panel border border-line rounded-2xl p-4 card-hover w-full max-w-md text-left">
                <div className="w-16 h-16 rounded-xl bg-panel2 overflow-hidden shrink-0 flex items-center justify-center">
                  <CoverImg src={res.topResult.thumbnail} className="w-full h-full object-cover" icon={<Sparkles size={24} className="text-accent" />} />
                </div>
                <div className="min-w-0">
                  <div className="text-lg font-bold truncate">{res.topResult.title}</div>
                  <div className="text-xs text-dim truncate">{res.topResult.subtitle}</div>
                </div>
                <ChevronRight size={18} className="ml-auto text-dim shrink-0" />
              </button>
            </motion.section>
          )}

          {(tab === 'all' || tab === 'artists') && res.artists.length > 0 && (
            <section>
              <SectionTitle title="Artisti" />
              <HScroll>{res.artists.map((a, i) => <ArtistCard key={a.browseId} a={a} i={i} known={knownArtist(a.name)} onOpen={() => openArtist(a.browseId, a.name)} />)}</HScroll>
            </section>
          )}

          {(tab === 'all' || tab === 'albums') && res.albums.length > 0 && (
            <section>
              <SectionTitle title="Album" />
              <HScroll>{res.albums.map((a, i) => <AlbumCard key={a.browseId} a={a} i={i} onOpen={() => openAlbum(a.browseId, a.title, a.thumbnail, `${a.artist}${a.year ? ` · ${a.year}` : ''}`)} />)}</HScroll>
            </section>
          )}

          {(tab === 'all' || tab === 'playlists') && res.playlists.length > 0 && (
            <section>
              <SectionTitle title="Playlist" />
              <HScroll>{res.playlists.map((p, i) => <PlaylistCard key={p.id} p={p} i={i} onOpen={() => openPlaylist(p.id, p.title, p.thumbnail, p.author)} />)}</HScroll>
            </section>
          )}

          {((tab === 'all' && (res.songs.length > 0 || !(res.albums.length || res.artists.length || res.playlists.length))) || tab === 'songs') && (
            <section>
              <SectionTitle title="Brani" sub="Versioni audio ufficiali — senza intro/effetti dei video" />
              {res.songs.length === 0
                ? res.degraded
                  // La risposta conteneva brani ma il parser non li ha letti
                  // (layout YouTube cambiato): onesto, non "nessun risultato".
                  ? <Empty icon={<SearchIcon size={32} />} title="Ricerca in difficoltà"
                      sub="YouTube ha cambiato formato: aggiorna l'app o riprova più tardi." />
                  : <Empty icon={<SearchIcon size={32} />} title="Nessun risultato" sub="Prova con un'altra ricerca." />
                : <TrackList tracks={res.songs} />}
            </section>
          )}
        </div>
      )}

      {!res && !loading && !artist && !panel && (
        <Empty icon={<SearchIcon size={40} />} title="Cerca la tua musica"
          sub="I risultati arrivano da YouTube Music: tracce audio ufficiali, pulite, senza gli effetti dei video." />
      )}
    </div>
  );
}
