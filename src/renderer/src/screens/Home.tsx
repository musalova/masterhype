import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Disc3, TrendingUp, Music2, Flame, Play, Wand2, ArrowRight, Radio, Plus, Heart, Zap, AudioLines, ListMusic, Settings as SettingsIcon, Search, User, Check, Loader2 } from 'lucide-react';
import { useApp } from '../store';
import { api, isRemote } from '../api';
import { isOnline, resyncWhen, pcGone } from '../remote';
import { usePersistedState } from '../persist';
import { Shelf, TrackPoster } from '../components/Shelf';
import { CoverImg } from '../components/CoverImg';
import { SectionTitle, Empty, SkeletonCards, Skeleton, ProgressBar, LoadingState } from '../components/common';
import { STATIONS } from '../../../shared/types';
import type { AppStats, TrackRef, OnboardArtist, SuggestedTrack } from '../../../shared/types';
import { offlineSuggest } from '../offlineRec';
import { queuePlOp } from '../pendingSync';

const CACHE_TTL = 10 * 60 * 1000; // Home: cache 10 min — il refetch dei suggerimenti è lento

// Tile stazione come poster: apre la scaletta (vista lista), niente autoplay
function StationPoster({ s, i }: { s: (typeof STATIONS)[number]; i: number }) {
  const openStation = useApp((st) => st.openStation);
  return (
    <motion.button
      onClick={() => openStation({ kind: 'station', id: s.id })}
      initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: Math.min(i, 10) * 0.04 }}
      className="poster text-left w-40"
      title={s.desc}>
      <div className={`station-art poster-img w-40 h-40 relative bg-gradient-to-br ${s.grad} flex flex-col justify-end p-4`}>
        <Radio size={40} className="absolute top-2 right-2 text-white/20 rotate-12" />
        <div className="font-bold text-sm text-white drop-shadow leading-tight">{s.name}</div>
        <div className="poster-veil">
          <span className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-xl">
            <ListMusic size={17} />
          </span>
        </div>
      </div>
      <div className="mt-2 px-0.5 text-[11px] text-dim line-clamp-2 leading-snug">{s.desc}</div>
    </motion.button>
  );
}

// Tile "quick pick" stile Spotify: apre la lista — stazione → Stazioni,
// autogenerata → Playlist. Nessun autoplay: il play lo decide l'utente.
function QuickTile({ icon: Icon, name, autoId, stationId, grad, i }: {
  icon: React.ElementType; name: string; grad: string; i: number;
  autoId?: string; stationId?: string;
}) {
  const openStation = useApp((st) => st.openStation);
  const openAutoList = useApp((st) => st.openAutoList);
  return (
    <motion.button
      onClick={() => {
        if (autoId) openAutoList(autoId);
        else if (stationId) openStation({ kind: 'station', id: stationId });
      }}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: i * 0.05 }}
      className="quick-tile group relative flex items-center overflow-hidden transition-colors text-left">
      <div className={`w-12 h-12 md:w-14 md:h-14 shrink-0 bg-gradient-to-br ${grad} flex items-center justify-center`}>
        <Icon size={20} className="text-white drop-shadow" />
      </div>
      <span className="flex-1 min-w-0 font-semibold text-xs md:text-[13px] leading-tight line-clamp-2 pr-2">{name}</span>
      {/* Badge play solo desktop: su mobile occupava spazio e troncava il nome */}
      <span className="max-md:hidden opacity-0 group-hover:opacity-100 transition-opacity mr-3 w-9 h-9 rounded-full
        bg-accent text-ink flex items-center justify-center shrink-0">
        <ArrowRight size={15} />
      </span>
    </motion.button>
  );
}

// Poster "Mix <genere>": apre la lista autogenerata (Daily Mix stile Spotify)
function MixPoster({ tag, i }: { tag: string; i: number }) {
  const openAutoList = useApp((st) => st.openAutoList);
  const grads = ['from-indigo-500 to-purple-500', 'from-emerald-500 to-teal-400', 'from-sky-500 to-cyan-400', 'from-amber-500 to-orange-500'];
  return (
    <motion.button onClick={() => openAutoList(`genre:${tag}`)}
      initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.3, delay: Math.min(i, 10) * 0.04 }}
      className="poster text-left w-40" title={`Il meglio di ${tag} sui tuoi gusti`}>
      <div className={`station-art poster-img w-40 h-40 relative bg-gradient-to-br ${grads[i % grads.length]} flex flex-col justify-end p-4`}>
        <AudioLines size={40} className="absolute top-2 right-2 text-white/20 rotate-12" />
        <div className="font-bold text-sm text-white drop-shadow leading-tight capitalize">Mix {tag}</div>
        <div className="poster-veil">
          <span className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center shadow-xl">
            <ListMusic size={17} />
          </span>
        </div>
      </div>
      <div className="mt-2 px-0.5 text-[11px] text-dim line-clamp-2 leading-snug">I brani del genere che ami, rinnovati a ogni apertura</div>
    </motion.button>
  );
}

// Onboarding cold-start (come Spotify al primo avvio): "Scegli almeno 3 artisti
// che ami" → il profilo gusti parte già personalizzato invece che dalle classifiche.
function Onboarding({ onDone }: { onDone: () => void }) {
  const [artists, setArtists] = useState<OnboardArtist[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState('');
  useEffect(() => {
    void api().rec.onboard().then(setArtists).catch(() => {
      // PC spento: gli artisti proposti vengono dalle classifiche dirette —
      // il seed va in coda e parte alla riconnessione (op tasteSeed).
      void import('../direct').then(({ directCharts }) => directCharts()).then((charts) => {
        const seen = new Set<string>();
        setArtists(charts.map((t) => t.artist ?? '').filter((a) => a && !seen.has(a) && !!seen.add(a)).slice(0, 20)
          .map((name) => ({ name })));
      }).catch(() => {});
    });
  }, []);
  const toggle = (n: string) => setSel((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const addCustom = () => { const n = custom.trim(); if (n) { setSel((s) => new Set(s).add(n)); setCustom(''); } };
  const finish = async () => {
    setBusy(true);
    try { await api().library.tasteSeed([...sel]); useApp.getState().toast(`Perfetto — costruisco i tuoi mix su ${sel.size} artisti`, 'ok'); }
    catch {
      if (isRemote() && !isOnline()) {
        queuePlOp('tasteSeed', [[...sel]]);
        useApp.getState().toast(`${pcGone()} — i tuoi artisti saranno salvati ${resyncWhen()}`, 'info');
      } else useApp.getState().toast('Non sono riuscito a salvare i gusti — riprova', 'err');
    }
    finally { setBusy(false); onDone(); }
  };
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="m-4 md:m-6 rounded-2xl border border-line bg-panel/80 backdrop-blur p-5 md:p-8 relative overflow-hidden">
      <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-accent/20 blur-3xl pointer-events-none" />
      <div className="relative">
        <div className="text-[11px] font-bold tracking-[0.25em] text-accent uppercase mb-2 flex items-center gap-2"><Sparkles size={12} /> Benvenuto</div>
        <h1 className="text-2xl md:text-3xl font-black tracking-tight">Quali artisti ami?</h1>
        <p className="text-sm text-dim mt-1.5 max-w-xl">Scegline almeno 3: stazioni, mix e suggerimenti partono subito sui tuoi gusti. Puoi cambiare idea quando vuoi — l'app impara da ogni ascolto.</p>
        <div className="flex flex-wrap gap-2 mt-5">
          {artists.map((a) => {
            const on = sel.has(a.name);
            return (
              <button key={a.name} onClick={() => toggle(a.name)}
                className={`flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border text-sm transition-all
                  ${on ? 'bg-accent text-white border-accent shadow-lg shadow-accent/30 scale-[1.03]' : 'bg-panel2/70 border-line text-txt hover:border-accent/50'}`}>
                <span className="w-7 h-7 rounded-full bg-black/30 overflow-hidden flex items-center justify-center shrink-0">
                  <CoverImg src={a.thumbnail} className="w-full h-full object-cover" icon={<User size={13} className="opacity-70" />} />
                </span>
                {a.name}{on && <Check size={13} />}
              </button>
            );
          })}
          {[...sel].filter((n) => !artists.some((a) => a.name === n)).map((n) => (
            <button key={n} onClick={() => toggle(n)} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-accent text-white border border-accent text-sm">{n} <Check size={13} /></button>
          ))}
          {artists.length === 0 && [72, 96, 60, 84, 68, 90, 76].map((w, i) => (
            <Skeleton key={i} className="h-8 rounded-full" style={{ width: w }} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 mt-6">
          <div className="relative">
            <input value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCustom(); }}
              placeholder="Altro artista…" className="bg-panel2 border border-line rounded-full px-4 py-2 text-sm outline-none focus:border-accent w-52" />
            {custom && <button onClick={addCustom} className="absolute right-2 top-1/2 -translate-y-1/2 text-accent"><Plus size={16} /></button>}
          </div>
          <div className="flex-1" />
          <button onClick={onDone} className="text-xs text-dim hover:text-txt px-3 py-2">Salta per ora</button>
          <button onClick={() => void finish()} disabled={sel.size < 3 || busy}
            className="btn-hero btn-hero-play disabled:opacity-40 disabled:hover:transform-none">
            {busy ? <Loader2 size={17} className="animate-spin" /> : <Play size={17} fill="currentColor" />}
            {sel.size < 3 ? `Scegli ancora ${3 - sel.size}` : 'Inizia'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

export default function Home() {
  const { library, nav, homeCache, setHomeCache, cdQueue, play } = useApp();
  const [onboarded, setOnboarded] = usePersistedState('mh-pref-onboarded', false);
  const [stats, setStats] = useState<AppStats>();
  const [recent, setRecent] = useState<TrackRef[]>([]);
  const [mixTags, setMixTags] = useState<string[]>([]);
  // Suggerimenti calcolati in locale quando il PC è giù: non entrano in
  // homeCache (restano per-sessione) — al ritorno del PC il refresh TTL
  // ripristina quelli del motore vero.
  const [suggLocal, setSuggLocal] = useState<SuggestedTrack[]>([]);
  const sugg = homeCache?.sugg.length ? homeCache.sugg : suggLocal;
  const charts = homeCache?.charts ?? [];
  const [loading, setLoading] = useState(!homeCache);

  const load = async (force = false) => {
    void api().library.stats().then(setStats).catch(() => {});
    if (!force && homeCache && Date.now() - homeCache.at < CACHE_TTL) return;
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        api().rec.suggest().catch(() => []),
        api().yt.charts(useApp.getState().settings?.country ?? 'IT').catch(() => []),
      ]);
      const st = useApp.getState();
      // PC spento e niente suggerimenti: li approssimo da libreria+like
      // cachate (senza toccare homeCache: a PC acceso tornano quelli veri)
      setSuggLocal(s.length ? [] : offlineSuggest(st.library, st.remoteLikeList).slice(0, 16));
      setHomeCache(s.slice(0, 16), c.slice(0, 12));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void api().library.stats().then(setStats).catch(() => {});
    void api().library.recent(10).then(setRecent).catch(() => {});
    // Tag/generi del profilo per la shelf "I tuoi mix"
    void Promise.all([api().library.taste('tag'), api().library.taste('genre')]).then(([tags, genres]) => {
      const junk = new Set(['seen live', 'favorites', 'favourite', 'favorite', 'love', 'hate', 'my favorite', 'male vocalists', 'female vocalists', 'all', 'misc', 'other', 'various']);
      const all = [...tags, ...genres].filter((r) => r.weight > 0.3 && !junk.has(r.value)).sort((a, b) => b.weight - a.weight);
      setMixTags([...new Set(all.map((r) => r.value))].slice(0, 6));
    }).catch(() => {
      // PC spento: "I tuoi mix" dai generi della libreria cachata
      const count = new Map<string, number>();
      for (const t of useApp.getState().library)
        if (t.genre) count.set(t.genre, (count.get(t.genre) ?? 0) + 1 + (t.liked ? 2 : 0));
      setMixTags([...count.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g).slice(0, 6));
    });
  }, [library.length]);

  const hour = new Date().getHours();
  const greet = hour < 13 ? 'Buongiorno' : hour < 19 ? 'Buon pomeriggio' : 'Buonasera';
  const cdMin = cdQueue.reduce((s, t) => s + (t.durationS ?? 210), 0) / 60;

  // Il titolo in vetrina: primo suggerimento, altrimenti primo in classifica
  const hero = sugg[0] ?? charts[0];
  const heroBg = hero?.thumbnail?.replace(/w\d+-h\d+/, 'w1080-h1080');
  // Precarica il backdrop dell'hero: senza questo l'immagine appare a scatti
  // (metà scaricata o in ritardo); con la preload entra in fade, già decodificata
  const [heroBgReady, setHeroBgReady] = useState('');
  useEffect(() => {
    if (!heroBg) { setHeroBgReady(''); return; }
    const img = new Image();
    img.onload = () => setHeroBgReady(heroBg);
    img.src = heroBg;
  }, [heroBg]);

  // Cold start: profilo senza gusti → onboarding "scegli gli artisti che ami"
  const coldStart = !!stats && stats.topArtists.length === 0 && library.length === 0 && !onboarded;

  return (
    <div className="overflow-y-auto h-full relative">
      {/* Mobile: Impostazioni non è nella barra inferiore → ingranaggio in alto a destra (come Spotify) */}
      <header className="home-header">
        <div>
          <div className="eyebrow mb-2">Il tuo universo musicale</div>
          <h1>{greet}.</h1>
          <p>Un nuovo ascolto. Una nuova scoperta.</p>
        </div>
        <div className="home-tools">
          <button onClick={() => nav('search')} title="Cerca musica (Ctrl+K)" aria-label="Cerca musica" className="home-tool"><Search size={17} /></button>
          <button onClick={() => nav('settings')} title="Impostazioni" aria-label="Impostazioni" className="home-tool"><SettingsIcon size={17} /></button>
        </div>
      </header>

      {coldStart && <Onboarding onDone={() => { setOnboarded(true); void load(true); void api().library.stats().then(setStats).catch(() => {}); }} />}

      {/* ===== HERO cinematografico stile Netflix ===== */}
      {coldStart ? null : loading && !hero ? (
        /* Skeleton hero: stessa altezza del vero hero — niente salto di layout
           quando arriva il brano in vetrina */
        <div className="hero home-hero bg-panel border border-line">
          <div className="relative p-5 pb-5 md:p-8 md:pb-7 max-w-2xl w-full space-y-3">
            <LoadingState label="Preparo i tuoi prossimi ascolti…" detail="Mix, scoperte e musica scelta per te." layout="inline" />
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <div className="flex gap-3 pt-3">
              <Skeleton className="h-10 w-32 rounded-lg" />
              <Skeleton className="h-10 w-36 rounded-lg" />
            </div>
          </div>
        </div>
      ) : hero ? (
        <section className="hero home-hero" aria-label="Scelto per te">
          {heroBgReady && <div className="hero-bg" style={{ backgroundImage: `url(${heroBgReady})` }} />}
          <div className="hero-fade" />
          <div className="hero-art" aria-hidden="true"><CoverImg src={hero.thumbnail} className="w-full h-full object-cover" icon={<Disc3 />} /></div>
          <div className="hero-content">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
              <div className="text-[11px] font-bold tracking-[0.25em] text-accent uppercase mb-2 flex items-center gap-2">
                <Sparkles size={12} /> Scelto per te
              </div>
              <h2 className="hero-title">{hero.title}</h2>
              <div className="text-base text-white/85 mt-1.5 font-medium">{hero.artist}</div>
              {'reason' in hero && hero.reason && (
                <div className="text-[12px] text-white/60 mt-2 max-w-md">{hero.reason}</div>
              )}
              <div className="flex flex-wrap items-center gap-3 mt-5">
                <button onClick={() => play(hero, sugg.length ? sugg : charts)}
                  className="btn-hero btn-hero-play">
                  <Play size={19} fill="currentColor" /> Riproduci
                </button>
                <button onClick={() => nav('assistant')} className="btn-hero btn-hero-ghost">
                  <Wand2 size={17} /> Componi un CD
                </button>
                <button onClick={() => void useApp.getState().downloadToCd(hero)}
                  className="btn-hero btn-hero-ghost max-md:!hidden" title="Scarica e aggiungi al CD">
                  <Plus size={18} /> CD
                </button>
              </div>
            </motion.div>
          </div>
        </section>
      ) : (
        <div className="home-hero hero" style={{ minHeight: 260 }}>
          <div className="hero-fade" />
          <div className="hero-art" aria-hidden="true"><Disc3 strokeWidth={0.7} /></div>
          <div className="hero-content">
            <div className="eyebrow mb-3">Premi play al tuo mondo</div>
            <h2 className="hero-title">La musica giusta.<br /><span className="text-accent">Il tuo momento.</span></h2>
            <p className="text-dim text-sm mt-3 max-w-md leading-relaxed">Ritrova ciò che ami, scopri la prossima ossessione. La tua collezione comincia con un ascolto.</p>
            <div className="flex flex-wrap gap-3 mt-5">
              <button onClick={() => nav('search')} className="btn-hero btn-hero-play"><Play size={18} /> Cerca musica</button>
              <button onClick={() => nav('assistant')} className="btn-hero btn-hero-ghost"><Wand2 size={17} /> Componi un CD</button>
            </div>
          </div>
        </div>
      )}

      <div className="home-sections px-6 pb-8 space-y-9">
        {/* ===== Quick pick stile Spotify: accesso diretto alle autogenerate ===== */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4">
          <QuickTile i={0} icon={Sparkles} name="Il tuo mix" autoId="mix" grad="from-accent to-accent2" />
          <QuickTile i={1} icon={Flame} name="Più ascoltate" autoId="top" grad="from-amber-500 to-red-500" />
          <QuickTile i={2} icon={Zap} name="Scoperte per te" autoId="scoperte" grad="from-emerald-500 to-teal-400" />
          <QuickTile i={3} icon={Heart} name="Nuove uscite" autoId="nuove" grad="from-amber-500 to-orange-400" />
          <QuickTile i={4} icon={Radio} name="La tua stazione" stationId="per-te" grad="from-teal-500 to-cyan-400" />
          <QuickTile i={5} icon={Flame} name="Novità per te" stationId="novita-te" grad="from-yellow-500 to-amber-400" />
        </div>

        {/* CD in lavorazione: banner compatto */}
        {cdQueue.length > 0 && (
          <motion.button initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            onClick={() => nav('cd')}
            className="w-full text-left bg-panel/80 border border-accent/30 rounded-xl p-3.5 flex items-center gap-4 card-hover">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-accent to-accent2 flex items-center justify-center shrink-0 glow">
              <Disc3 size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">CD in lavorazione · {cdQueue.length} brani</div>
              <div className="mt-1.5 max-w-xs"><ProgressBar pct={(cdMin / 80) * 100} /></div>
            </div>
            <div className="text-xs text-dim">{cdMin.toFixed(0)} / 80 min</div>
            <span className="text-xs text-accent font-medium flex items-center gap-1">Continua <ArrowRight size={13} /></span>
          </motion.button>
        )}

        {/* Statistiche compatte */}
        {stats && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm -mt-2">
            {[
              { icon: Music2, label: 'brani', value: stats.trackCount },
              { icon: Flame, label: 'minuti', value: stats.totalMinutes },
              { icon: Disc3, label: 'CD masterizzati', value: stats.burnedCount },
              { icon: TrendingUp, label: 'playlist', value: stats.playlistCount },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-2 text-dim">
                <Icon size={14} className="text-accent" />
                <span className="font-bold text-txt">{value}</span> {label}
              </div>
            ))}
          </div>
        )}

        {/* ===== Shelf: le tue stazioni ===== */}
        <section>
          <SectionTitle title="Le tue stazioni" sub="Apri la scaletta: radio infinita sui tuoi gusti"
            action={<button onClick={() => nav('stations')} className="text-xs text-accent hover:underline">Tutte le stazioni →</button>} />
          <Shelf>
            {STATIONS.filter((s) => s.group === 'per-te').map((s, i) => <StationPoster key={s.id} s={s} i={i} />)}
          </Shelf>
        </section>

        {/* ===== Shelf: i tuoi mix di genere (Daily Mix stile Spotify) ===== */}
        {mixTags.length > 0 && (
          <section>
            <SectionTitle title="I tuoi mix" sub="Una playlist per ogni genere che ami"
              action={<button onClick={() => nav('playlists')} className="text-xs text-accent hover:underline">Tutte le playlist →</button>} />
            <Shelf>
              {mixTags.map((t, i) => <MixPoster key={t} tag={t} i={i} />)}
            </Shelf>
          </section>
        )}

        {/* ===== Shelf: per te ===== */}
        <section>
          <SectionTitle title="Per te" sub="Basato sui tuoi gusti, verificato su più fonti"
            action={<button onClick={() => load(true)} disabled={loading} className="text-xs text-dim hover:text-txt flex items-center gap-1.5">
              {loading && <Loader2 size={11} className="animate-spin" />}{loading ? 'Aggiorno…' : 'Aggiorna'}</button>} />
          {loading && sugg.length === 0 ? <SkeletonCards n={6} /> : sugg.length === 0 ? (
            <Empty icon={<Sparkles size={32} />}
              title={library.length ? 'Sto imparando i tuoi gusti…' : 'Nessun suggerimento ancora'}
              sub="Ascolta e metti like: MasterHype impara e ti propone brani coerenti." />
          ) : (
            <Shelf>{sugg.map((t, i) => <TrackPoster key={t.videoId + i} t={t} i={i} queue={sugg} />)}</Shelf>
          )}
        </section>

        {/* ===== Shelf: classifica con numeri stile Top 10 ===== */}
        <section>
          <SectionTitle title="In classifica ora" sub="Top brani YouTube Music"
            action={<button onClick={() => nav('trends')} className="text-xs text-accent hover:underline">Trend Radar →</button>} />
          {loading && charts.length === 0 ? <SkeletonCards n={6} /> : charts.length === 0 ? (
            <Empty icon={<TrendingUp size={32} />} title="Classifiche non disponibili" sub="Controlla la connessione." />
          ) : (
            <Shelf>{charts.map((t, i) => <TrackPoster key={t.videoId + i} t={t} i={i} queue={charts} rank={i < 10 ? i + 1 : undefined} />)}</Shelf>
          )}
        </section>

        {/* ===== Shelf: ascoltati di recente ===== */}
        {recent.length > 0 && (
          <section>
            <SectionTitle title="Ascoltati di recente" sub="Riprendi da dove eri rimasto" />
            <Shelf>{recent.map((t, i) => <TrackPoster key={t.videoId + i} t={t} i={i} queue={recent} />)}</Shelf>
          </section>
        )}
      </div>
    </div>
  );
}
