import { useEffect, useRef, useState } from 'react';
import { Home, Radio, Search, Library, ListMusic, Disc3, Settings, Check, UserPlus, Heart, Sparkles } from 'lucide-react';
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
  { id: 'playlists', label: 'Playlist', icon: ListMusic },
  { id: 'cd', label: 'CD', icon: Disc3 },
];
// Schermate secondarie: evidenziano la voce primaria a cui appartengono
const PARENT: Partial<Record<Screen, Screen>> = { trends: 'search', downloads: 'library', assistant: 'cd', settings: 'home' };

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
  const navRef = useRef<HTMLElement>(null);

  // Mobile: la barra scorre orizzontalmente — la voce attiva resta visibile
  useEffect(() => {
    navRef.current?.querySelector('[data-active="1"]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [screen]);

  // es. in Trend resta accesa "Cerca"; senza PC l'assistente è voce primaria
  const activeId = screen === 'assistant' && isStandalone() ? 'assistant' : PARENT[screen] ?? screen;
  const itemCls = (id: Screen) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 relative shrink-0
     max-md:flex-col max-md:gap-0.5 max-md:px-1 max-md:py-1.5 max-md:text-[10px] max-md:flex-1 max-md:min-w-0 max-md:justify-center
     ${activeId === id
      ? 'bg-gradient-to-r from-accent/15 to-transparent text-txt before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[3px] before:rounded-full before:bg-accent before:shadow-[0_0_10px_1px_var(--color-accent)] max-md:before:left-3 max-md:before:right-3 max-md:before:top-auto max-md:before:bottom-0 max-md:before:w-auto max-md:before:h-[3px]'
      : 'text-dim hover:text-txt hover:bg-panel2/60'}`;

  return (
    // Desktop: colonna laterale 224px — Mobile: barra inferiore fissa con icone
    <div className="w-56 bg-panel border-r border-line flex flex-col py-4 shrink-0
      max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0 max-md:z-40
      max-md:w-auto max-md:flex-row max-md:items-center max-md:py-0 max-md:h-[60px]
      max-md:border-r-0 max-md:border-t max-md:px-1
      max-md:pb-[env(safe-area-inset-bottom)]">
      <div className="px-5 pb-6 flex items-center gap-2.5 max-md:hidden">
        <Logo size={26} />
        <span className="font-bold text-lg tracking-tight">Master<span className="neon-text">Hype</span></span>
      </div>
      {/* 6 voci: su mobile stanno tutte in una riga, niente scroll nascosto */}
      <nav ref={navRef} className="flex-1 space-y-0.5 px-2 max-md:flex max-md:items-stretch max-md:space-y-0 max-md:px-0.5 max-md:py-1">
        {/* Senza PC il masterizzatore non esiste: al posto di "CD" l'assistente
            scalette (funziona anche sul telefono da solo) */}
        {(isStandalone() ? items.map((i) => (i.id === 'cd' ? { id: 'assistant' as Screen, label: 'Assistente', icon: Sparkles } : i)) : items).map(({ id, label, icon: Icon }) => (
          <button key={id} data-active={activeId === id ? 1 : 0} onClick={() => nav(id)} className={itemCls(id)}>
            <Icon size={18} className={activeId === id ? 'text-accent drop-shadow-[0_0_6px_var(--color-accent)]' : ''} />
            <span className="flex-1 text-left max-md:flex-none max-md:text-center max-md:leading-none truncate max-md:max-w-full">{label}</span>
            {id === 'cd' && cdCount > 0 && (
              <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5 font-bold max-md:absolute max-md:top-0.5 max-md:right-1/2 max-md:translate-x-4">{cdCount}</span>
            )}
            {id === 'library' && active > 0 && (
              <span title={`${active} download in corso`}
                className="text-[10px] bg-accent2 text-white rounded-full px-1.5 py-0.5 font-bold max-md:absolute max-md:top-0.5 max-md:right-1/2 max-md:translate-x-4">{active}</span>
            )}
          </button>
        ))}
      </nav>
      <LibrarySection />
      <UserChip />
    </div>
  );
}
