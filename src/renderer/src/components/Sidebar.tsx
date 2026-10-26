import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Home, Radio, Search, Library, ListMusic, Disc3, Settings, Check, UserPlus, Heart, Sparkles, Compass, TrendingUp, Download, ChevronDown, Menu, X, ChevronRight } from 'lucide-react';
import { useApp, Screen } from '../store';
import { api } from '../api';
import { isStandalone } from '../remote';
import Logo from './Logo';
import type { Playlist } from '../../../shared/types';

// Navigazione primaria: 6 destinazioni (come Spotify: poche, chiare).
// Le funzioni "di supporto" vivono DENTRO le destinazioni, non nel menu:
//   Trend → tab in Cerca · Download → badge/link in Libreria ·
//   Assistente → pulsante in CD Builder e nell'hero Home · Impostazioni → ingranaggio profilo
const items: { id: Screen; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'search', label: 'Cerca', icon: Search },
  { id: 'stations', label: 'Stazioni', icon: Radio },
  { id: 'library', label: 'Libreria', icon: Library },
];
// Schermate raggiungibili dal foglio "Altro" su mobile: quando si è dentro una
// di queste è il pulsante Altro a restare acceso, non una voce a caso.
const MORE_SCREENS: Screen[] = ['playlists', 'downloads', 'trends', 'cd', 'assistant', 'settings'];
// Stesse sezioni della dashboard desktop: la struttura mentale non cambia
// tra i due form factor. CD si nasconde in modalità senza PC.
const MORE_SECTIONS: { title: string; rows: { id: Screen; label: string; icon: typeof Home }[] }[] = [
  { title: 'Scopri', rows: [{ id: 'trends', label: 'Trend', icon: TrendingUp }] },
  { title: 'Raccolta', rows: [{ id: 'playlists', label: 'Playlist', icon: ListMusic }, { id: 'downloads', label: 'Download', icon: Download }] },
  { title: 'Crea', rows: [{ id: 'cd', label: 'CD', icon: Disc3 }, { id: 'assistant', label: 'Assistente', icon: Sparkles }] },
  { title: 'Generale', rows: [{ id: 'settings', label: 'Impostazioni', icon: Settings }] },
];
// Schermate secondarie: evidenziano la voce primaria a cui appartengono
const PARENT: Partial<Record<Screen, Screen>> = { trends: 'search', downloads: 'library', assistant: 'cd', settings: 'home' };

// Dashboard desktop: poche categorie espandibili, le funzioni come sottovoci.
// kids vuoti = voce singola; un solo kid = voce piatta senza chevron.
const GROUPS: { id: string; label: string; icon: typeof Home; kids: { id: Screen; label: string; icon: typeof Home }[] }[] = [
  { id: 'home', label: 'Home', icon: Home, kids: [] },
  { id: 'discover', label: 'Scopri', icon: Compass, kids: [
    { id: 'search', label: 'Cerca', icon: Search },
    { id: 'stations', label: 'Stazioni', icon: Radio },
    { id: 'trends', label: 'Trend', icon: TrendingUp },
  ] },
  { id: 'collect', label: 'Raccolta', icon: Library, kids: [
    { id: 'library', label: 'Libreria', icon: Library },
    { id: 'playlists', label: 'Playlist', icon: ListMusic },
    { id: 'downloads', label: 'Download', icon: Download },
  ] },
  { id: 'create', label: 'Crea', icon: Disc3, kids: [
    { id: 'cd', label: 'CD', icon: Disc3 },
    { id: 'assistant', label: 'Assistente', icon: Sparkles },
  ] },
];
const GROUP_OF: Partial<Record<Screen, string>> = {
  home: 'home', settings: 'home',
  search: 'discover', stations: 'discover', trends: 'discover',
  library: 'collect', playlists: 'collect', downloads: 'collect',
  cd: 'create', assistant: 'create',
};

// Chip profilo in fondo alla sidebar (solo desktop: su mobile i profili
// sono in Impostazioni → Profili). Click → switcher con tutti i profili.
function UserChip() {
  const users = useApp((s) => s.users);
  const currentUser = useApp((s) => s.currentUser);
  const setUser = useApp((s) => s.setUser);
  const nav = useApp((s) => s.nav);
  const toast = useApp((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const me = users.find((u) => u.id === currentUser) ?? users[0];

  const create = async () => {
    const n = newName.trim();
    if (!n) return;
    try {
      const u = await api().users.create(n);
      await useApp.getState().loadUsers();
      setNewName('');
      toast(`Profilo "${u.name}" creato`, 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
  };

  const screen = useApp((s) => s.screen);
  return (
    <div className="relative px-2 pt-2 max-md:hidden flex items-center gap-1.5">
      {open && (
        <div className="absolute bottom-full left-2 right-2 mb-1 bg-panel2 border border-line rounded-xl overflow-hidden shadow-xl z-50">
          <div className="px-3 py-2 text-[10px] font-bold text-dim uppercase tracking-wider">Profili</div>
          {users.map((u) => (
            <button key={u.id} onClick={() => { setOpen(false); void setUser(u.id); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-panel text-left">
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0"
                style={{ background: u.color }}>{u.name[0]?.toUpperCase()}</span>
              <span className="flex-1 text-sm truncate">{u.name}</span>
              {u.id === currentUser && <Check size={14} className="text-accent" />}
            </button>
          ))}
          <div className="flex gap-1.5 p-2 border-t border-line">
            <div className="relative flex-1">
              <UserPlus size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
                placeholder="Nuovo profilo…" maxLength={30}
                className="w-full bg-panel border border-line rounded-lg pl-8 pr-2 py-1.5 text-xs outline-none focus:border-accent" />
            </div>
            <button onClick={() => void create()} disabled={!newName.trim()}
              className="px-2.5 py-1.5 rounded-lg bg-accent text-white text-xs font-bold disabled:opacity-40">Crea</button>
          </div>
          <button onClick={() => { setOpen(false); nav('settings'); }}
            className="w-full px-3 py-2 text-[11px] text-dim hover:text-txt border-t border-line text-left">
            Gestisci profili →
          </button>
        </div>
      )}
      <button onClick={() => setOpen(!open)}
        className="flex-1 min-w-0 flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-panel2/60 hover:bg-panel2 border border-line transition-colors">
        <span className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
          style={{ background: me?.color ?? '#2dd4bf' }}>{me?.name?.[0]?.toUpperCase() ?? 'U'}</span>
        <span className="flex-1 text-left text-sm font-medium truncate">{me?.name ?? 'Profilo'}</span>
      </button>
      <button onClick={() => nav('settings')} title="Impostazioni"
        className={`w-10 h-10 shrink-0 rounded-xl border border-line flex items-center justify-center transition-colors
          ${screen === 'settings' ? 'bg-accent/15 text-accent border-accent/40' : 'bg-panel2/60 text-dim hover:text-txt hover:bg-panel2'}`}>
        <Settings size={16} />
      </button>
    </div>
  );
}

// "La tua libreria" in sidebar (stile Spotify): preferiti pinned + playlist
// dell'utente — un click apre direttamente la lista in Playlist.
function LibrarySection() {
  const screen = useApp((s) => s.screen);
  const openAutoList = useApp((s) => s.openAutoList);
  const openPlaylistById = useApp((s) => s.openPlaylistById);
  const [pls, setPls] = useState<Playlist[]>([]);
  useEffect(() => {
    void api().playlists.list().then(setPls).catch(() => {});
  }, [screen]); // rilettura a ogni navigazione: le playlist create/editate appaiono subito

  return (
    <div className="px-2 mt-2 pt-3 border-t border-line max-md:hidden">
      <div className="px-3 pb-1.5 text-[10px] font-bold text-dim uppercase tracking-wider">La tua libreria</div>
      <button onClick={() => openAutoList('liked')}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-dim hover:text-txt hover:bg-panel2/60 transition-colors">
        <span className="w-7 h-7 rounded-md bg-gradient-to-br from-violet-600 to-indigo-500 flex items-center justify-center shrink-0">
          <Heart size={13} className="text-white" fill="currentColor" />
        </span>
        <span className="flex-1 text-left truncate text-[13px]">Brani che ti piacciono</span>
      </button>
      {pls.slice(0, 6).map((p) => (
        <button key={p.id} onClick={() => openPlaylistById(p.id)}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-dim hover:text-txt hover:bg-panel2/60 transition-colors">
          <span className="w-7 h-7 rounded-md bg-panel2 flex items-center justify-center shrink-0">
            <ListMusic size={13} />
          </span>
          <span className="flex-1 text-left truncate text-[13px]">{p.name}</span>
          <span className="text-[10px] text-dim/60 shrink-0">{p.tracks?.length ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

export default function Sidebar() {
  const screen = useApp((s) => s.screen);
  const nav = useApp((s) => s.nav);
  const cdCount = useApp((s) => s.cdQueue.length);
  const active = useApp((s) => s.downloads.filter((d) => !['done', 'error'].includes(d.status)).length);
  const users = useApp((s) => s.users);
  const currentUser = useApp((s) => s.currentUser);
  const navRef = useRef<HTMLElement>(null);
  // Su mobile: dentro una schermata "Altro" si illumina il pulsante Altro
  const moreActive = MORE_SCREENS.includes(screen);
  // Foglio "Altro" mobile: tutte le funzioni secondarie in sezioni
  const [sheet, setSheet] = useState(false);
  const go = (s: Screen) => { setSheet(false); nav(s); };

  // Stato dei gruppi espansi (persistito; default = tutti aperti = dashboard)
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('mh-nav-groups') ?? '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem('mh-nav-groups', JSON.stringify(open)); } catch { /* */ }
  }, [open]);
  // Se si naviga dentro un gruppo compresso (es. tab Trend da Cerca) si riapre:
  // la voce attiva non deve mai restare nascosta.
  useEffect(() => {
    const g = GROUP_OF[screen];
    if (g && g !== 'home') setOpen((o) => (o[g] === false ? { ...o, [g]: true } : o));
  }, [screen]);

  // Mobile: la barra scorre orizzontalmente — la voce attiva resta visibile
  useEffect(() => {
    navRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [screen]);

  // es. in Trend resta accesa "Cerca"; senza PC l'assistente è voce primaria
  const activeId = screen === 'assistant' && isStandalone() ? 'assistant' : PARENT[screen] ?? screen;
  const itemCls = (id: Screen) =>
    `nav-item w-full max-md:w-auto flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-colors duration-150 relative shrink-0
     max-md:flex-col max-md:px-1 max-md:py-1.5 max-md:text-[10px] max-md:flex-1 max-md:min-w-0 max-md:justify-center
     ${activeId === id ? 'text-accent' : 'text-dim hover:text-txt hover:bg-panel2/60'}`;

  return (
    // Desktop: colonna laterale 224px — Mobile: barra inferiore fissa con icone
    <div className="app-sidebar w-56 bg-panel border-r border-line flex flex-col py-4 shrink-0
      max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:z-40
      max-md:w-auto max-md:flex-row max-md:items-center max-md:py-0 max-md:h-[60px]
      max-md:border-r-0 max-md:border-t max-md:px-1
      max-md:pb-[env(safe-area-inset-bottom)]">
      <div className="sidebar-brand flex items-center gap-2.5 max-md:hidden">
        <Logo size={38} />
        <div>
          <span className="font-semibold text-[17px] tracking-[-0.05em]">Master<span className="text-accent">Hype</span></span>
          <div className="text-[9px] text-dim tracking-[0.16em] uppercase mt-0.5">Musica, a modo tuo.</div>
        </div>
      </div>
      {/* 6 voci: su mobile stanno tutte in una riga, niente scroll nascosto */}
      <nav ref={navRef} aria-label="Navigazione principale" className="flex-1 space-y-1 px-2 max-md:flex max-md:flex-col max-md:space-y-0 max-md:px-0 max-md:py-0">
        {/* Mobile: 4 destinazioni principali + "Altro" (foglio con le sezioni).
            Prima erano 6 icone piatte e Trend/Download/Assistente/Impostazioni
            non avevano nessuna voce di navigazione. */}
        <div className="md:hidden flex items-stretch flex-1 px-0.5 py-1">
          {items.map(({ id, label, icon: Icon }) => {
            const on = !moreActive && activeId === id;
            return (
              <button key={id} data-active={on ? 1 : 0} aria-current={on ? 'page' : undefined} onClick={() => nav(id)} className={itemCls(id)}>
                <Icon size={18} className={on ? 'text-accent' : ''} />
                <span className="flex-1 text-left max-md:flex-none max-md:text-center max-md:leading-none truncate max-md:max-w-full">{label}</span>
                {id === 'library' && active > 0 && (
                  <span title={`${active} download in corso`}
                    className="text-[10px] bg-accent2 text-white rounded-full px-1.5 py-0.5 font-bold max-md:absolute max-md:top-0.5 max-md:right-1/2 max-md:translate-x-4">{active}</span>
                )}
              </button>
            );
          })}
          <button data-active={moreActive || sheet ? 1 : 0} aria-current={moreActive ? 'page' : undefined} aria-label="Altro — tutte le funzioni"
            onClick={() => setSheet((v) => !v)} className={itemCls('cd')}>
            <Menu size={18} className={moreActive ? 'text-accent' : ''} />
            <span className="flex-1 text-left max-md:flex-none max-md:text-center max-md:leading-none truncate max-md:max-w-full">Altro</span>
            {(cdCount > 0 || active > 0) && (
              <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 font-bold max-md:absolute max-md:top-0.5 max-md:right-1/2 max-md:translate-x-4">{cdCount + active}</span>
            )}
          </button>
        </div>
        {/* Foglio "Altro" mobile: sezioni ordinate = stessa dashboard del desktop.
            Chiusura su backdrop, sul tasto X o quando si sceglie una voce. */}
        <AnimatePresence>
          {sheet && (
            <>
              <motion.div key="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setSheet(false)} className="fixed inset-0 z-40 bg-black/60 md:hidden" />
              <motion.div key="moresheet" role="dialog" aria-modal="true" aria-label="Altre funzioni"
                initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 32, stiffness: 320 }}
                className="fixed inset-x-0 bottom-0 z-50 md:hidden bg-panel border-t border-line rounded-t-3xl max-h-[76dvh] overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+12px)]">
                <div className="w-10 h-1 rounded-full bg-line/60 mx-auto mt-2.5" />
                <div className="px-5 pt-2.5 pb-1 flex items-center justify-between">
                  <span className="font-semibold text-[15px]">Altro</span>
                  <button onClick={() => setSheet(false)} aria-label="Chiudi" className="w-9 h-9 flex items-center justify-center rounded-xl text-dim hover:text-txt hover:bg-panel2 transition-colors"><X size={18} /></button>
                </div>
                <button onClick={() => go('settings')}
                  className="mx-4 mb-2 w-[calc(100%-2rem)] flex items-center gap-3 px-3.5 py-3 rounded-2xl bg-panel2/60 border border-line text-left">
                  <span className="w-9 h-9 rounded-full bg-gradient-to-br from-fuchsia-600 to-violet-500 flex items-center justify-center text-sm font-bold text-white shrink-0">
                    {(users.find((x) => x.id === currentUser)?.name ?? users[0]?.name ?? '?')[0].toUpperCase()}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate">{users.find((x) => x.id === currentUser)?.name ?? 'Profilo'}</span>
                    <span className="block text-[11px] text-dim">Profili e impostazioni</span>
                  </span>
                  <ChevronRight size={16} className="text-dim shrink-0" />
                </button>
                {MORE_SECTIONS.map((sec) => {
                  const rows = sec.rows.filter((r) => !(isStandalone() && r.id === 'cd'));
                  if (!rows.length) return null;
                  return (
                    <div key={sec.title} className="px-4 pt-3">
                      <div className="px-3 pb-1.5 text-[10px] font-bold text-dim uppercase tracking-wider">{sec.title}</div>
                      {rows.map((r) => {
                        const on = screen === r.id;
                        const b = r.id === 'cd' ? cdCount : r.id === 'downloads' ? active : 0;
                        return (
                          <button key={r.id} onClick={() => go(r.id)} aria-current={on ? 'page' : undefined}
                            className={`w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl text-left transition-colors ${on ? 'text-accent bg-panel2/80' : 'text-txt hover:bg-panel2/60'}`}>
                            <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${on ? 'bg-accent/20 text-accent' : 'bg-panel2 text-dim'}`}>
                              <r.icon size={17} />
                            </span>
                            <span className="flex-1 min-w-0 text-[14px] font-medium truncate">{r.label}</span>
                            {b > 0 && <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 font-bold">{b}</span>}
                            <ChevronRight size={15} className="text-dim/60 shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </motion.div>
            </>
          )}
        </AnimatePresence>
        {/* Desktop: dashboard a gruppi espandibili (stato in mh-nav-groups).
            Senza PC il masterizzatore non esiste: "CD" sparisce dal gruppo Crea. */}
        <div className="max-md:hidden space-y-1">
          {GROUPS.map((g) => {
            const kids = g.kids.filter((k) => !(isStandalone() && k.id === 'cd'));
            if (!kids.length) return null;
            const gActive = GROUP_OF[screen] === g.id;
            const badge = g.id === 'create' ? cdCount : g.id === 'collect' ? active : 0;
            if (kids.length === 1) { // voce singola/piatta: niente chevron
              const k = kids[0];
              const on = screen === k.id || (g.id === 'home' && (screen === 'home' || screen === 'settings'));
              return (
                <button key={g.id} data-active={on ? 1 : 0} aria-current={on ? 'page' : undefined} onClick={() => nav(k.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-colors ${on ? 'text-accent' : 'text-dim hover:text-txt hover:bg-panel2/60'}`}>
                  <k.icon size={18} className={on ? 'text-accent' : ''} />
                  <span className="flex-1 text-left truncate">{g.id === 'home' ? g.label : k.label}</span>
                  {badge > 0 && <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 font-bold">{badge}</span>}
                </button>
              );
            }
            const isOpen = open[g.id] !== false; // dashboard: aperto di default, si comprime
            return (
              <div key={g.id}>
                <div className={`group/nav w-full flex items-center rounded-xl text-[13px] font-medium transition-colors ${gActive ? 'text-accent' : 'text-dim hover:text-txt hover:bg-panel2/60'}`}>
                  <button onClick={() => nav(kids[0].id)} className="flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 text-left">
                    <g.icon size={18} className={gActive ? 'text-accent' : ''} />
                    <span className="flex-1 text-left truncate">{g.label}</span>
                    {!isOpen && badge > 0 && <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 font-bold">{badge}</span>}
                  </button>
                  <button onClick={() => setOpen((o) => ({ ...o, [g.id]: !isOpen }))} aria-label={isOpen ? `Comprimi ${g.label}` : `Espandi ${g.label}`} aria-expanded={isOpen}
                    className="w-8 h-8 mr-1 flex items-center justify-center rounded-lg text-dim hover:text-txt hover:bg-panel transition-colors shrink-0">
                    <ChevronDown size={14} className={`transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`} />
                  </button>
                </div>
                {isOpen && (
                  <div className="mt-0.5 ml-[22px] pl-3 border-l border-line space-y-0.5">
                    {kids.map((k) => {
                      const on = screen === k.id;
                      const kb = k.id === 'cd' ? cdCount : k.id === 'downloads' ? active : 0;
                      return (
                        <button key={k.id} data-active={on ? 1 : 0} aria-current={on ? 'page' : undefined} onClick={() => nav(k.id)}
                          className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[12.5px] transition-colors ${on ? 'text-accent bg-panel2/70' : 'text-dim hover:text-txt hover:bg-panel2/60'}`}>
                          <k.icon size={14} />
                          <span className="flex-1 text-left truncate">{k.label}</span>
                          {kb > 0 && <span className="text-[10px] bg-accent2 text-white rounded-full px-1.5 py-0.5 font-bold">{kb}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </nav>
      <LibrarySection />
      <UserChip />
    </div>
  );
}
