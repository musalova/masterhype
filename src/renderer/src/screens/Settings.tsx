import { useCallback, useEffect, useState } from 'react';
import { Settings as SetIcon, FolderOpen, Check, X, Music4, KeyRound, LogIn, BrainCircuit, ThumbsDown, Activity, Wrench, FileDown, RefreshCw, Trash2, Smartphone, UserPlus, Pencil, ArrowUpCircle, MonitorSmartphone, FolderInput } from 'lucide-react';
import QRCode from 'qrcode';
import { api, isRemote } from '../api';
import { clearRemoteConf, remoteBase, isOnline, hasRemoteConf, exitStandalone, resyncWhen, isStandalone, pcGone, remoteIsAdmin } from '../remote';
import { updateSupported, useUpdate, checkUpdate, useDesktopUpdate, checkDesktopUpdate } from '../update';
import { pickFiles, readJsonFile } from '../files';
import { normalizeFeed } from '../../../shared/updateFeed';
import { runSelfTest, selfTestVerdict, type SelfTestReport } from '../selftest';
import { useApp } from '../store';
import { queueSettings, queuePlOp } from '../pendingSync';
import { SectionTitle, BackLink, Skeleton } from '../components/common';
import { usePersistedState } from '../persist';
import { ACCENTS, ACCENT_KEY, MOTION_KEY, applyAppearance, type AccentId } from '../appearance';
import type { Settings, IssueStats, AppInfo, MhDevice } from '../../../shared/types';

// Etichette leggibili per i tipi di evento della telemetria
const KIND_LABEL: Record<string, string> = {
  'play': 'stream non risolto',
  'stream-dead': 'stream morto in play',
  'download': 'download fallito',
  'search-empty': 'ricerca senza risultati',
  'video': 'video non disponibile',
  'generic': 'altro',
};

// Aspetto: palette accent + riduzione animazioni. Preferenze mh-pref-* →
// sincronizzate tra PC e telefono (stesso profilo, stesso look ovunque).
function AppearanceCard() {
  const [accent, setAccent] = usePersistedState<AccentId>(ACCENT_KEY, 'sunset');
  const [motion, setMotion] = usePersistedState<'on' | 'off'>(MOTION_KEY, 'on');
  useEffect(() => applyAppearance(accent, motion), [accent, motion]);
  return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Aspetto</div>
      <Row label="Colore" sub="Il colore dell'app — pulsanti, aloni, stazioni">
        <div className="flex gap-2">
          {ACCENTS.map((a) => (
            <button key={a.id} onClick={() => setAccent(a.id)} title={a.name}
              className={`w-8 h-8 rounded-full border-2 transition-transform hover:scale-110 flex items-center justify-center
                ${accent === a.id ? 'border-white scale-110' : 'border-transparent'}`}
              style={{ background: `linear-gradient(135deg, ${a.c1}, ${a.c2})` }}>
              {accent === a.id && <Check size={13} className="text-white drop-shadow" />}
            </button>
          ))}
        </div>
      </Row>
      <Row label="Riduci animazioni" sub="Spegne sfondo animato ed effetti — utile su PC lenti o per risparmiare batteria">
        <Toggle v={motion === 'off'} onChange={(b) => setMotion(b ? 'off' : 'on')} />
      </Row>
    </div>
  );
}

function Row({ label, sub, children }: { label: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 border-b border-line/50 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {sub && <div className="text-xs text-dim mt-0.5">{sub}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ v, onChange }: { v: boolean; onChange: (b: boolean) => void }) {
  return (
    <button onClick={() => onChange(!v)}
      className={`w-10 h-6 rounded-full transition-colors relative ${v ? 'bg-accent' : 'bg-panel2 border border-line'}`}>
      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${v ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}

// ---- Gestione profili utente ----
// Ogni profilo: gusti, preferiti, playlist, preferenze e cronologia propri.
// "Usa" cambia il profilo di QUESTO dispositivo (reload); elimina rimuove
// tutti i dati personali del profilo — mai il proprio, mai l'ultimo.
function ProfilesCard() {
  const users = useApp((s) => s.users);
  const currentUser = useApp((s) => s.currentUser);
  const setUser = useApp((s) => s.setUser);
  const toast = useApp((s) => s.toast);
  const [newName, setNewName] = useState('');
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // Rinomina/elimina profili = amministrazione: consentita solo al codice
  // condiviso del PC (admin). Un device token riceverebbe 403 — nascondiamo
  // i bottoni invece di mostrare errori. "Usa" resta: il cambio profilo di
  // un device passa da device:claim (serve la finestra «Accoppia» sul PC).
  const [isAdmin, setIsAdmin] = useState(!isRemote());
  useEffect(() => { void remoteIsAdmin().then(setIsAdmin); }, []);

  const create = async () => {
    const n = newName.trim();
    if (!n) return;
    setBusy(true);
    try {
      const u = await api().users.create(n);
      await useApp.getState().loadUsers();
      setNewName('');
      toast(`Profilo "${u.name}" creato`, 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    finally { setBusy(false); }
  };

  const rename = async (id: number) => {
    const n = editName.trim();
    if (!n) { setEditId(null); return; }
    try {
      await api().users.rename(id, n);
      await useApp.getState().loadUsers();
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    setEditId(null);
  };

  const remove = async (id: number) => {
    setBusy(true);
    try {
      await api().users.remove(id);
      await useApp.getState().loadUsers();
      toast('Profilo eliminato', 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    finally { setBusy(false); setConfirmDel(null); }
  };

  // Modalità senza PC: esiste un solo profilo virtuale — la gestione
  // (crea/rinomina/elimina/switch) vive sul PC e torna utile dopo il pairing.
  if (isRemote() && !hasRemoteConf()) return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Profili</div>
      <div className="py-3 text-xs text-dim">Profilo locale del telefono — gusti, preferiti e download restano qui finché non colleghi un PC (Telefono → Collega un PC), poi migrano sul profilo scelto.</div>
    </div>
  );

  return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Profili</div>
      <div className="py-2 text-xs text-dim">Gusti, preferiti, playlist e preferenze sono separati per ogni profilo — su PC e su tutti i dispositivi collegati.</div>
      {users.map((u) => (
        <div key={u.id} className="flex items-center gap-3 py-3 border-b border-line/50 last:border-0">
          <span className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white shrink-0"
            style={{ background: u.color }}>{u.name[0]?.toUpperCase()}</span>
          {editId === u.id ? (
            <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void rename(u.id); if (e.key === 'Escape') setEditId(null); }}
              onBlur={() => void rename(u.id)} maxLength={30}
              className="flex-1 bg-panel2 border border-accent rounded-lg px-3 py-1.5 text-sm outline-none" />
          ) : (
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate">{u.name}</div>
              {u.id === currentUser && <div className="text-[10px] text-accent font-bold">PROFILO ATTIVO SU QUESTO DISPOSITIVO</div>}
            </div>
          )}
          <div className="flex items-center gap-1.5 shrink-0">
            {u.id !== currentUser && (
              <button onClick={() => void setUser(u.id)} disabled={busy}
                className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold hover:opacity-90 disabled:opacity-40">
                Usa
              </button>
            )}
            {isAdmin && (
              <button onClick={() => { setEditId(u.id); setEditName(u.name); }} title="Rinomina"
                className="p-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt">
                <Pencil size={13} />
              </button>
            )}
            {isAdmin && u.id !== currentUser && users.length > 1 && (
              confirmDel === u.id ? (
                <button onClick={() => void remove(u.id)} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded-lg bg-red-500 text-white font-bold disabled:opacity-40">
                  Conferma
                </button>
              ) : (
                <button onClick={() => setConfirmDel(u.id)} title="Elimina profilo"
                  className="p-1.5 rounded-lg bg-panel2 hover:bg-red-500/20 text-dim hover:text-red-400">
                  <Trash2 size={13} />
                </button>
              )
            )}
          </div>
        </div>
      ))}
      <div className="flex gap-2 py-4">
        <div className="relative flex-1">
          <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
          <input value={newName} onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
            placeholder="Nome del nuovo profilo…" maxLength={30}
            className="w-full bg-panel2 border border-line rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-accent" />
        </div>
        <button onClick={() => void create()} disabled={busy || !newName.trim()}
          className="px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-bold disabled:opacity-40 shrink-0">
          Crea
        </button>
      </div>
    </div>
  );
}

// Dispositivi remoti pairati: ognuno ha un token proprio legato a UN profilo
// (tabella devices sul PC). Da qui il proprietario può riassegnare il profilo
// di un device o scollegarlo del tutto (revoca → il telefono torna al pairing).
function DevicesList() {
  const toast = useApp((x) => x.toast);
  const users = useApp((s) => s.users);
  const [devs, setDevs] = useState<MhDevice[]>([]);
  const [confirmRev, setConfirmRev] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => void api().devices.list().then(setDevs).catch(() => {});
  useEffect(() => {
    load();
    return api().pairing.onUsed(() => load()); // un pairing appena riuscito appare subito
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!devs.length) return null;
  const assign = async (d: MhDevice, userId: number | null) => {
    setBusy(true);
    try {
      await api().devices.setUser(d.id, userId);
      load();
      toast(userId == null ? `${d.name || 'Dispositivo'} dovrà ri-scegliere il profilo` : 'Profilo del dispositivo aggiornato', 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    finally { setBusy(false); }
  };
  const revoke = async (d: MhDevice) => {
    setBusy(true);
    try {
      await api().devices.revoke(d.id);
      setConfirmRev(null);
      load();
      toast(`${d.name || 'Dispositivo'} scollegato — dovrà ri-accoppiarsi`, 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    finally { setBusy(false); }
  };
  // Sospetto sniffing/perdita di un device: scollega TUTTI i telefoni in un
  // colpo — i device token muoiono subito e ogni telefono torna al pairing.
  const revokeAll = async () => {
    setBusy(true);
    try {
      const n = await api().devices.revokeAll();
      setConfirmAll(false);
      load();
      toast(`${n} dispositivi scollegati — andranno ri-accoppiati`, 'ok');
    } catch (e) { toast(e instanceof Error ? e.message : 'Errore', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <div className="py-3 border-b border-line/50">
      <div className="flex items-center justify-between pb-2">
        <div className="text-xs font-bold text-dim uppercase tracking-wider">Dispositivi collegati</div>
        {devs.length > 1 && (
          confirmAll ? (
            <button onClick={() => void revokeAll()} disabled={busy}
              className="text-[10px] px-2 py-1 rounded bg-red-500 text-white font-bold disabled:opacity-40">
              Conferma: scollega tutti
            </button>
          ) : (
            <button onClick={() => setConfirmAll(true)} disabled={busy}
              title="Un token sniffato vale finché il device è pairato — scollega tutto e ri-accoppia"
              className="text-[10px] px-2 py-1 rounded bg-panel2 hover:bg-red-500/20 text-dim hover:text-red-400 disabled:opacity-40">
              Scollega tutti
            </button>
          )
        )}
      </div>
      <div className="space-y-2.5">
        {devs.map((d) => (
          <div key={d.id} className="flex items-center gap-3">
            <Smartphone size={15} className="text-dim shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{d.name || 'Dispositivo'}</div>
              <div className="text-[10px] text-dim">
                {d.lastSeen ? `visto ${new Date(d.lastSeen).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'mai connesso'}
              </div>
            </div>
            {/* Riassegnazione profilo: il device non può farlo da solo — serve
                proprio questo controllo lato PC per tenere il confine */}
            <select value={d.userId ?? ''} disabled={busy}
              onChange={(e) => void assign(d, e.target.value === '' ? null : Number(e.target.value))}
              className="bg-panel2 border border-line rounded-lg px-2 py-1.5 text-xs outline-none max-w-36 truncate">
              <option value="">— nessun profilo —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            {confirmRev === d.id ? (
              <button onClick={() => void revoke(d)} disabled={busy}
                className="text-xs px-2.5 py-1.5 rounded-lg bg-red-500 text-white font-bold disabled:opacity-40 shrink-0">
                Conferma
              </button>
            ) : (
              <button onClick={() => setConfirmRev(d.id)} title="Scollega dispositivo" disabled={busy}
                className="p-1.5 rounded-lg bg-panel2 hover:bg-red-500/20 text-dim hover:text-red-400 shrink-0 disabled:opacity-40">
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="text-[11px] text-dim/80 pt-2 leading-relaxed">
        Ogni dispositivo vede solo i dati del suo profilo. I dispositivi accoppiati con versioni
        precedenti usano il codice condiviso (accesso a tutti i profili): «Rigenera» il codice per
        scollegarli, o ri-accoppiali per fargli avere un token proprio.
      </div>
    </div>
  );
}

// Aggiornamenti dell'app DESKTOP: versione installata, feed (GitHub Releases
// di default — override manuale possibile), stato download e riavvio. Il feed
// si propaga da solo ai telefoni (via /api/info) → anche loro si aggiornano
// da lì quando sono lontani dal PC o in modalità senza PC.
function DesktopUpdateCard({ s, save }: { s: Settings; save: (p: Partial<Settings>) => Promise<void> }) {
  const u = useDesktopUpdate();
  const toast = useApp((x) => x.toast);
  const [feed, setFeed] = useState(s.updateUrl ?? '');
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { setFeed(s.updateUrl ?? ''); }, [s.updateUrl]);
  useEffect(() => { void api().app.info().then(setInfo).catch(() => {}); }, [u.phase]);
  const sub =
    u.phase === 'checking' ? 'Controllo in corso…'
    : u.phase === 'downloading' ? `Scarico la versione ${u.version ?? ''}… ${u.pct != null ? `${Math.round(u.pct * 100)}%` : ''}`
    : u.phase === 'ready' ? `Versione ${u.version} pronta — riavvia per installarla (o si installa all'uscita dal tray)`
    : u.phase === 'uptodate' ? 'Sei all\'ultima versione'
    : u.phase === 'disabled' ? (u.msg ?? 'Aggiornamento automatico non attivo')
    : u.phase === 'error' ? `Errore: ${u.msg ?? 'sconosciuto'}`
    : 'Controllo automatico all\'avvio e ogni 6 ore';
  const saveFeed = async () => {
    const f = normalizeFeed(feed);
    if (feed.trim() && !f) { toast('Indirizzo non valido — serve un URL https://… (http solo per localhost)', 'err'); return; }
    if (f === (s.updateUrl ?? '')) return;
    await save({ updateUrl: f });
    toast(f ? 'Server aggiornamenti salvato — controllo in corso' : 'Server aggiornamenti rimosso', 'ok');
  };
  return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50 flex items-center gap-1.5">
        <ArrowUpCircle size={13} /> Aggiornamenti
      </div>
      <Row label={`MasterHype ${u.current || info?.version || ''}`} sub={sub}>
        {u.phase === 'ready' ? (
          <button onClick={() => { void api().app.updateInstall().catch((e: unknown) => toast(`Aggiornamento non avviato: ${e instanceof Error ? e.message : e}`, 'err')); }}
            className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold hover:opacity-90 flex items-center gap-1.5">
            <RefreshCw size={11} /> Riavvia e aggiorna
          </button>
        ) : (
          <button disabled={u.phase === 'checking' || u.phase === 'downloading'} onClick={() => void checkDesktopUpdate()}
            className="text-xs px-3 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 flex items-center gap-1.5">
            {u.phase === 'checking' || u.phase === 'downloading' ? <RefreshCw size={11} className="animate-spin" /> : <ArrowUpCircle size={12} />}
            Controlla ora
          </button>
        )}
      </Row>
      {u.phase === 'downloading' && u.pct != null && (
        <div className="pb-3 -mt-1"><div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
          <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2 transition-all" style={{ width: `${Math.round(u.pct * 100)}%` }} />
        </div></div>
      )}
      <Row label="Aggiorna automaticamente" sub="Scarica le nuove versioni in background; l'installazione avviene al riavvio">
        <Toggle v={s.autoUpdateApp !== false} onChange={(v) => void save({ autoUpdateApp: v })} />
      </Row>
      <Row label="Server aggiornamenti" sub="Vuoto = GitHub Releases (default). Compila solo per un feed alternativo/privato">
        <input value={feed} onChange={(e) => setFeed(e.target.value)} onBlur={() => void saveFeed()}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          placeholder="github.com/…/releases/latest/download" spellCheck={false}
          className="w-56 bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent font-mono" />
      </Row>
      <Row label="App Android per i telefoni"
        sub={info?.apk
          ? `Il PC distribuisce la ${info.apk.versionName ?? ''} (build ${info.apk.versionCode}) ai telefoni collegati — si aggiornano da soli${info.feed ? ', anche fuori casa dal server' : ''}`
          : 'Nessun APK disponibile da distribuire (arriva con l\'installer della prossima versione)'}>
        <Smartphone size={15} className={info?.apk ? 'text-accent' : 'text-dim'} />
      </Row>
    </div>
  );
}

// Dati: backup/ripristino e import di file audio — su TUTTE le piattaforme.
// Desktop: dialoghi nativi. Telefono: file nella cartella Download del
// telefono (profilo dal PC se raggiungibile + stato del dispositivo), import
// col selettore di sistema. In modalità senza PC il backup è l'unico modo per
// portare preferiti/playlist/gusti su un telefono nuovo.
function DataCard({ onImported }: { onImported?: () => void }) {
  const toast = useApp((x) => x.toast);
  const importAudioFiles = useApp((x) => x.importAudioFiles);
  const [busy, setBusy] = useState<'exp' | 'imp' | 'audio' | null>(null);
  const remote = isRemote();
  const doExport = async () => {
    setBusy('exp');
    try {
      const p = await api().backup.export();
      if (p) toast(remote ? `Backup salvato in ${p}` : 'Backup salvato', 'ok');
    } catch (e) { toast(`Export fallito: ${e instanceof Error ? e.message : e}`, 'err'); }
    finally { setBusy(null); }
  };
  const applyImport = async (data?: unknown) => {
    setBusy('imp');
    try {
      const r = await api().backup.import(data);
      if (!r) return;
      const parts = [r.taste && `${r.taste} gusti`, r.likes && `${r.likes} preferiti`, r.playlists && `${r.playlists} playlist`].filter(Boolean);
      toast(parts.length ? `Importati: ${parts.join(', ')}${r.device ? ' + dati del telefono' : ''}` : r.device ? 'Dati del telefono ripristinati' : 'Niente di nuovo da importare', 'ok');
      onImported?.();
      // Lo stato locale del telefono è cambiato sotto lo store: reload pulito
      if (r.device) setTimeout(() => location.reload(), 1200);
    } catch (e) { toast(e instanceof Error ? e.message : 'File di backup non valido', 'err'); }
    finally { setBusy(null); }
  };
  // Il selettore file va aperto DENTRO il gesto (onClick sincrono)
  const doImport = () => {
    if (!remote) { void applyImport(); return; }
    void pickFiles('.json,application/json').then(async (f) => {
      if (!f[0]) return;
      try { await applyImport(await readJsonFile(f[0])); } catch { toast('Il file scelto non è un backup MasterHype', 'err'); }
    });
  };
  const doAudio = () => {
    void pickFiles('audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus', true).then(async (files) => {
      if (!files.length) return;
      setBusy('audio');
      try { await importAudioFiles(files); } finally { setBusy(null); }
    });
  };
  const sub = !remote
    ? 'Gusti, preferiti e playlist in un file — su un altro PC i brani mancanti si riscaricano da soli'
    : isStandalone()
      ? 'Preferiti, playlist, gusti e impostazioni del telefono in un file (cartella Download)'
      : 'Profilo dal PC + dati del telefono in un unico file nella cartella Download';
  return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">I tuoi dati</div>
      <Row label="Backup" sub={sub}>
        <div className="flex gap-2">
          <button onClick={() => void doExport()} disabled={!!busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1.5 disabled:opacity-50">
            {busy === 'exp' ? <RefreshCw size={12} className="animate-spin" /> : <FileDown size={12} />} Esporta
          </button>
          <button onClick={doImport} disabled={!!busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw size={12} className={busy === 'imp' ? 'animate-spin' : ''} /> Importa…
          </button>
        </div>
      </Row>
      <Row label="Importa file audio"
        sub={!remote ? 'MP3, FLAC, WAV, M4A, OGG dal PC — oppure trascinali nella finestra'
          : isOnline() ? 'Dalla memoria del telefono: restano ascoltabili offline e vanno anche nella libreria del PC'
          : 'Dalla memoria del telefono: ascoltabili subito, anche offline'}>
        <button onClick={doAudio} disabled={!!busy}
          className="text-xs px-3 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 flex items-center gap-1.5 disabled:opacity-50">
          {busy === 'audio' ? <RefreshCw size={12} className="animate-spin" /> : <FolderInput size={12} />} Scegli file…
        </button>
      </Row>
    </div>
  );
}

function TasteCard({ taste, reload }: { taste: { kind: string; value: string; weight: number }[]; reload: () => void }) {
  const toast = useApp((x) => x.toast);
  const [confirmReset, setConfirmReset] = useState(false);
  const [cleared, setCleared] = useState(false);
  const shown = cleared ? [] : taste;
  const artists = shown.filter((t) => t.kind === 'artist');
  const tags = shown.filter((t) => t.kind === 'tag' || t.kind === 'genre');
  const pos = artists.filter((t) => t.weight > 0).slice(0, 8);
  const neg = artists.filter((t) => t.weight < 0).slice(0, 8);
  const topTags = tags.filter((t) => t.weight > 0).slice(0, 8);
  const max = Math.max(1e-9, ...pos.map((t) => t.weight));
  useEffect(() => { setCleared(false); }, [taste]);
  return (
    <div className="bg-panel border border-line rounded-xl px-5 mb-6">
      <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50 flex items-center gap-1.5">
        <BrainCircuit size={13} /> Il tuo profilo gusti
      </div>
      {shown.length === 0 ? (
        <div className="py-5 text-xs text-dim">
          Ancora vuoto: il motore impara da like, ascolti, download, skip e "meno così"{isRemote() && !isOnline() ? ' — anche sul telefono, senza PC' : ''}.
        </div>
      ) : (
        <div className="py-4 space-y-4">
          {pos.length > 0 && (
            <div>
              <div className="text-[11px] text-dim mb-2">Artisti che ami</div>
              <div className="space-y-1.5">
                {pos.map((t) => (
                  <div key={t.value} className="flex items-center gap-2">
                    <span className="text-xs w-32 truncate capitalize">{t.value}</span>
                    <div className="flex-1 h-1.5 bg-panel2 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-accent to-accent2 rounded-full"
                        style={{ width: `${Math.round((t.weight / max) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topTags.length > 0 && (
            <div>
              <div className="text-[11px] text-dim mb-2">Generi e mood dedotti</div>
              <div className="flex flex-wrap gap-1.5">
                {topTags.map((t) => (
                  <span key={t.value} className="text-[11px] px-2 py-1 rounded-full bg-panel2 border border-line text-dim capitalize">
                    {t.value}
                  </span>
                ))}
              </div>
            </div>
          )}
          {neg.length > 0 && (
            <div>
              <div className="text-[11px] text-dim mb-2 flex items-center gap-1"><ThumbsDown size={11} /> Artisti penalizzati</div>
              <div className="flex flex-wrap gap-1.5">
                {neg.map((t) => (
                  <span key={t.value} className="text-[11px] px-2 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-300 capitalize">
                    {t.value}
                  </span>
                ))}
              </div>
            </div>
          )}
          <button onClick={async () => {
              if (!confirmReset) { setConfirmReset(true); setTimeout(() => setConfirmReset(false), 4000); return; }
              try {
                await api().library.tasteReset();
                setConfirmReset(false); reload();
                toast('Profilo gusti azzerato — il motore riparte da zero', 'ok');
              } catch (e) {
                if (isRemote() && !isOnline()) {
                  queuePlOp('tasteReset', []);
                  setConfirmReset(false); setCleared(true);
                  toast(isStandalone() ? 'Profilo gusti azzerato' : `${pcGone()} — azzerato qui, sul PC ${resyncWhen()}`, 'info');
                } else toast(`Reset fallito: ${e instanceof Error ? e.message : e}`, 'err');
              }
            }}
            className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
              confirmReset ? 'bg-red-500/20 text-red-300 border border-red-500/40' : 'bg-panel2 hover:bg-line text-dim hover:text-txt'}`}>
            {confirmReset ? 'Conferma: dimentica tutto' : 'Azzera profilo gusti'}
          </button>
        </div>
      )}
    </div>
  );
}

// Riga aggiornamenti APK (solo nell'app nativa): stato live dello store update
// + check manuale. Il download/installazione li fa la UpdateCard.
function UpdateRow() {
  const u = useUpdate();
  useEffect(() => { if (!u.current && u.phase === 'idle') void checkUpdate(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const sub =
    u.phase === 'checking' ? 'Controllo in corso…'
    : u.phase === 'available' ? `Nuova versione ${u.info?.versionName ?? ''} (build ${u.info?.versionCode}) — aprila dalla card`
    : u.phase === 'downloading' ? 'Scaricamento in corso…'
    : u.phase === 'ready' ? 'Scaricata e verificata — pronta all\'installazione'
    : u.phase === 'uptodate' ? 'Sei all\'ultima versione'
    : u.phase === 'error' ? (u.msg ?? 'Errore nel controllo')
    : u.current ? `Installata: ${u.current.versionName} (build ${u.current.versionCode}) — si aggiorna da sola via PC`
    : 'Controllo automatico all\'avvio — via PC pairato o sorgente pubblica';
  return (
    <Row label="Aggiornamenti app" sub={sub}>
      <button disabled={u.phase === 'checking'} onClick={() => void checkUpdate(true)}
        className="text-xs px-3 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 flex items-center gap-1.5">
        {u.phase === 'checking' ? <RefreshCw size={11} className="animate-spin" /> : <ArrowUpCircle size={12} />}
        Controlla ora
      </button>
    </Row>
  );
}

// Sezione "Telefono" vista dal client remoto: stato connessione, self-test
// reale del dispositivo e riga aggiornamenti. Non dipende da `settings` del PC:
// funziona anche offline e in standalone (mai pairato).
function PhoneRemoteSection() {
  const [selfTest, setSelfTest] = useState<SelfTestReport | null>(null);
  const [selfTesting, setSelfTesting] = useState(false);
  const [pcVer, setPcVer] = useState('');
  const toast = useApp((x) => x.toast);
  useEffect(() => { if (hasRemoteConf()) void api().app.info().then((i) => setPcVer(i.version)).catch(() => {}); }, []);
  return (
    <>
    {hasRemoteConf() ? (
    <Row label="Questo dispositivo" sub={`Collegato a ${remoteBase()}${pcVer ? ` · PC con MasterHype ${pcVer}` : ''}${isOnline() ? '' : ` · ${pcGone()}`}`}>
      <button onClick={() => { clearRemoteConf(); location.reload(); }}
        className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-red-300">Scollega</button>
    </Row>
    ) : (
    // Modalità senza PC scelta al primo avvio: niente pairing salvato —
    // si spiega cosa gira in locale e si offre la via di uscita.
    <Row label="Modalità senza PC" sub="Ricerca, streaming e download girano sul telefono. Collega un PC per libreria condivisa, CD e profili.">
      <button onClick={exitStandalone}
        className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold hover:opacity-90">Collega un PC</button>
    </Row>
    )}
    {updateSupported() && <UpdateRow />}
    {/* Auto-test reale: IndexedDB, internet, PC, YouTube diretto, stream,
        riproduzione <audio> — la prova che l'app funziona ovunque */}
    <Row label="Verifica dispositivo"
      sub={selfTest ? selfTestVerdict(selfTest) : 'Testa storage, rete, YouTube diretto e riproduzione — la prova che funziona anche senza PC'}>
      <button disabled={selfTesting}
        onClick={async () => { setSelfTesting(true); try { setSelfTest(await runSelfTest()); } finally { setSelfTesting(false); } }}
        className="text-xs px-3 py-1.5 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50 flex items-center gap-1.5">
        {selfTesting && <RefreshCw size={11} className="animate-spin" />}
        {selfTesting ? 'Test in corso…' : selfTest ? 'Ripeti test' : 'Esegui test'}
      </button>
    </Row>
    {selfTest && (
      <div className="py-3 space-y-1.5 border-b border-line/50">
        {selfTest.rows.map((r) => (
          <div key={r.name} className="flex items-start gap-2 text-[11px]">
            {r.ok === true && <Check size={13} className="text-emerald-400 shrink-0 mt-px" />}
            {r.ok === false && <X size={13} className="text-red-400 shrink-0 mt-px" />}
            {r.ok === null && <Activity size={13} className="text-dim shrink-0 mt-px" />}
            <div className="min-w-0">
              <span className="text-txt font-medium">{r.name}</span>
              {r.ms > 0 && <span className="text-dim"> · {r.ms}ms</span>}
              <div className="text-dim break-words">{r.detail}</div>
            </div>
          </div>
        ))}
      </div>
    )}
    <Row label="Report diagnostica" sub="Errori del PC (se raggiungibile) + test del telefono in un file nella cartella Download">
      <button onClick={async () => {
          try { const p = await api().diag.exportReport(); if (p) toast(`Report salvato in ${p}`, 'ok'); }
          catch (e) { toast(`Report non salvato: ${e instanceof Error ? e.message : e}`, 'err'); }
        }}
        className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1.5">
        <FileDown size={12} /> Esporta
      </button>
    </Row>
    </>
  );
}

export default function Settings() {
  const { settings, loadSettings, toast } = useApp();
  const [s, setS] = useState<Settings | null>(null);
  const [lfmOk, setLfmOk] = useState<boolean | null>(null);
  const [spConnected, setSpConnected] = useState(false);
  const [taste, setTaste] = useState<{ kind: string; value: string; weight: number }[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [diag, setDiag] = useState<IssueStats | null>(null);
  const [confirmDiag, setConfirmDiag] = useState(false);
  const [remoteInfo, setRemoteInfo] = useState<{ enabled: boolean; ip: string; port: number; token: string; alts?: string[] } | null>(null);
  const [qr, setQr] = useState('');
  const [pairLeft, setPairLeft] = useState(0); // ms residui della finestra "Accoppia"
  const [confirmRotate, setConfirmRotate] = useState(false);

  // Conferma visibile a ogni pairing riuscito: se si collega un device
  // estraneo (finestra aperta su LAN condivisa) lo si vede SUBITO qui e si
  // rigenera il codice — è la contropartita della finestra senza PIN.
  useEffect(() => api().pairing.onUsed((p) => {
    setPairLeft(0);
    toast(`✓ ${p.name?.trim() || 'Dispositivo'} collegato`, 'ok');
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Countdown locale della finestra: scade da solo, niente polling.
  useEffect(() => {
    if (pairLeft <= 0) return;
    const iv = setInterval(() => setPairLeft((l) => Math.max(0, l - 1000)), 1000);
    return () => clearInterval(iv);
  }, [pairLeft]);

  const openPairWindow = async () => {
    try {
      const r = await api().pairing.open();
      setPairLeft(r.leftMs);
    } catch { toast('Impossibile aprire il pairing', 'err'); }
  };

  // Rigenera il codice condiviso: scollega i device pairati col VECCHIO
  // modello (il loro token È il codice) e invalida QR/codice corrente.
  // I device con token proprio NON ne risentono — si scollegano singolarmente
  // dalla lista "Dispositivi collegati".
  const rotateToken = async () => {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const t = Array.from(crypto.getRandomValues(new Uint8Array(6))).map((b) => abc[b & 63]).join('');
    await save({ remoteToken: t });
    setConfirmRotate(false);
    loadRemote();
    toast('Codice rigenerato — i dispositivi collegati andranno ri-accoppiati', 'info');
  };

  const loadTaste = () => void api().library.taste().then(setTaste).catch(() => {});
  const loadDiag = () => void api().diag.stats().then(setDiag).catch(() => {});
  // Il QR porta un codice MONOUSO (non il codice condiviso admin): una foto
  // dello schermo non vale più di un pairing. Si rinnova da solo ogni ~4min
  // (TTL 5min lato server) finché questa schermata è aperta.
  const mintQr = useCallback(async () => {
    if (!remoteInfo?.enabled || !remoteInfo.ip || remoteInfo.ip === '127.0.0.1') { setQr(''); return; }
    const c = await api().pairing.code().catch(() => null);
    if (!c?.code) { setQr(''); return; }
    const url = `http://${remoteInfo.ip}:${remoteInfo.port}/?pair=${c.code}`;
    setQr(await QRCode.toDataURL(url, { width: 200, margin: 1, color: { dark: '#f2f2f8', light: '#0a0a0b' } }).catch(() => ''));
  }, [remoteInfo]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void mintQr();
    const iv = setInterval(() => void mintQr(), 4 * 60_000);
    return () => clearInterval(iv);
  }, [mintQr]);

  const loadRemote = () => void api().remote.info().then(setRemoteInfo).catch(() => setRemoteInfo(null));

  useEffect(() => {
    if (settings) setS(settings);
    void api().spotify.status().then(setSpConnected).catch(() => {});
    loadTaste();
    loadDiag();
    loadRemote();
  }, [settings]);

  const save = async (patch: Partial<Settings>) => {
    if (!s) return;
    setS({ ...s, ...patch });
    try {
      await api().settings.set(patch);
      await loadSettings();
    } catch (e) {
      if (isRemote() && !isOnline()) {
        // PC spento: la patch resta in coda (single-slot merged) e viene
        // applicata alla riconnessione; intanto la UI e la cache riflettono
        // già il valore nuovo — niente falso "salvato" né revert a vista.
        queueSettings(patch);
        const merged = { ...s, ...patch };
        useApp.setState({ settings: merged });
        try { localStorage.setItem('mh-settings-cache', JSON.stringify(merged)); } catch { /* quota */ }
        toast(`${pcGone()} — impostazione applicata ${resyncWhen()}`, 'info');
      } else {
        setS(s); // errore applicativo: revert dello stato ottimistico
        toast(`Salvataggio fallito: ${e instanceof Error ? e.message : e}`, 'err');
      }
    }
  };

  // Settings arriva dal main via IPC/HTTP: intanto una sagoma delle card,
  // mai schermata bianca (sul telefono la fetch può durare qualche centinaio di ms).
  // ECCEZIONE: su remoto senza `settings` (standalone mai pairato, o PC spento
  // senza cache) lo skeleton sarebbe INFINITO — le card che non dipendono dal
  // PC (profilo locale, aspetto, sezione telefono/self-test) devono comunque
  // rendersi: le preferenze locali restano modificabili senza PC.
  if (!s && isRemote()) return (
    <div className="p-4 md:p-8 overflow-y-auto h-full max-w-3xl">
      <BackLink to="home" label="Home" />
      <SectionTitle title="Impostazioni" />
      <ProfilesCard />
      <AppearanceCard />
      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50 flex items-center gap-1.5">
          <Smartphone size={13} /> Telefono e tablet
        </div>
        <PhoneRemoteSection />
      </div>
      <DataCard onImported={loadTaste} />
      <TasteCard taste={taste} reload={loadTaste} />
      {!hasRemoteConf() && (
        <div className="text-xs text-dim -mt-3 mb-6">
          Le impostazioni di libreria, audio e integrazioni vivono sul PC — appariranno qui quando lo colleghi.
        </div>
      )}
    </div>
  );
  if (!s) return (
    <div className="p-4 md:p-8 overflow-y-auto h-full max-w-3xl">
      <BackLink to="home" label="Home" />
      <SectionTitle title="Impostazioni" />
      {[4, 2, 3].map((rows, c) => (
        <div key={c} className="bg-panel border border-line rounded-xl px-5 mb-6">
          <Skeleton className="h-3 w-40 my-4" />
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-6 py-3.5 border-b border-line/50 last:border-0">
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
              <Skeleton className="h-6 w-10 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="p-4 md:p-8 overflow-y-auto h-full max-w-3xl">
      <BackLink to="home" label="Home" />
      <SectionTitle title="Impostazioni" />

      <ProfilesCard />
      <AppearanceCard />

      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Libreria e audio</div>
        {!isRemote() && (
          <Row label="Cartella libreria" sub={s.libraryDir}>
            <div className="flex gap-2">
              <button onClick={async () => { const d = await api().sys.pickFolder(); if (d) await save({ libraryDir: d }); }}
                className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line">Cambia…</button>
              <button onClick={() => api().sys.openFolder(s.libraryDir)}
                className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1"><FolderOpen size={12} /></button>
            </div>
          </Row>
        )}
        <Row label="Qualità MP3" sub="Bitrate dei file in libreria">
          <select value={s.audioQuality} onChange={(e) => save({ audioQuality: e.target.value as Settings['audioQuality'] })}
            className="bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none">
            <option value="320">320 kbps (consigliato)</option>
            <option value="256">256 kbps</option>
            <option value="192">192 kbps</option>
          </select>
        </Row>
        <Row label="Normalizza volume" sub="Loudness uniforme su tutto il CD (EBU R128)">
          <Toggle v={s.normalizeAudio} onChange={(v) => save({ normalizeAudio: v })} />
        </Row>
        <Row label="Taglia silenzi inizio/fine" sub="Rimuove pause vuote tipiche dei video YouTube">
          <Toggle v={s.trimSilence} onChange={(v) => save({ trimSilence: v })} />
        </Row>
        <Row label="Paese classifiche" sub="Per Trend Radar e chart">
          <select value={s.country} onChange={(e) => save({ country: e.target.value })}
            className="bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none">
            {['IT', 'US', 'GB', 'DE', 'FR', 'ES', 'BR'].map((c) => <option key={c}>{c}</option>)}
          </select>
        </Row>
      </div>

      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Masterizzazione</div>
        <Row label="Pausa tra tracce" sub="Audio CD: sempre 2s (limite del formato Track-At-Once)">
          <span className="text-xs text-dim">2s fissa</span>
        </Row>
        <Row label="Velocità di scrittura" sub="0 = automatica (più bassa = più affidabile)">
          <select value={s.burnSpeed} onChange={(e) => save({ burnSpeed: +e.target.value })}
            className="bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none">
            <option value={0}>Auto</option><option value={8}>8x</option><option value={16}>16x</option><option value={24}>24x</option><option value={48}>48x</option>
          </select>
        </Row>
      </div>

      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Sistema e profilo</div>
        <Row label="Aggiorna yt-dlp automaticamente" sub="YouTube cambia spesso: il motore di download si tiene aggiornato da solo">
          <Toggle v={s.autoUpdateTools} onChange={(v) => save({ autoUpdateTools: v })} />
        </Row>
        {!isRemote() && (
          <Row label="Avvia con Windows" sub="Il telefono trova sempre il PC: MasterHype parte da solo all'accensione">
            <Toggle v={s.autostart !== false} onChange={(v) => save({ autostart: v })} />
          </Row>
        )}
      </div>

      <DataCard onImported={loadTaste} />
      {!isRemote() && <DesktopUpdateCard s={s} save={save} />}

      {/* Telefono: il PC fa da server — gusti, preferenze, libreria e playlist
          sono gli STESSI dati del desktop, non una copia sincronizzata */}
      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50 flex items-center gap-1.5">
          <Smartphone size={13} /> Telefono e tablet
        </div>
        {isRemote() ? (
          <PhoneRemoteSection />
        ) : (
          <Row label="MasterHype Remote" sub="Usa l'app da telefono/tablet sulla stessa rete Wi-Fi — gusti e preferenze condivisi col PC">
            <Toggle v={s.remoteEnabled} onChange={async (v) => { await save({ remoteEnabled: v }); loadRemote(); }} />
          </Row>
        )}
        {!isRemote() && s.remoteEnabled && (
          <Row label="Mantieni il PC sveglio" sub="Mentre il server è attivo il PC non va in sospensione (lo schermo può spegnersi) — il telefono trova sempre casa">
            <Toggle v={s.keepAwake !== false} onChange={(v) => save({ keepAwake: v })} />
          </Row>
        )}
        {/* Pairing guidato: il telefono scopre il PC da solo (broadcast UDP)
            e il codice gli viene consegnato da /pair solo dentro questa
            finestra — l'utente medio non digita nulla */}
        {!isRemote() && s.remoteEnabled && (
          <Row label="Accoppia telefono"
            sub={pairLeft > 0
              ? `Finestra aperta (${Math.ceil(pairLeft / 1000)}s) — nell'app del telefono tocca il nome di questo PC`
              : "Nell'app del telefono il PC appare da solo — premi qui e tocca il suo nome"}>
            <button onClick={openPairWindow} disabled={pairLeft > 0}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold hover:opacity-90 disabled:opacity-60 flex items-center gap-1.5">
              <MonitorSmartphone size={12} />
              {pairLeft > 0 ? 'In ascolto…' : 'Accoppia telefono'}
            </button>
          </Row>
        )}
        {!isRemote() && s.remoteEnabled && <DevicesList />}
        {!isRemote() && s.remoteEnabled && remoteInfo && (
          <div className="py-4 flex items-start gap-5 max-md:flex-col">
            {qr && (
              <div className="shrink-0 rounded-xl overflow-hidden border border-line p-1 bg-white/5">
                <img src={qr} alt="QR di pairing" className="w-40 h-40 rounded-lg" />
              </div>
            )}
            <div className="text-xs text-dim space-y-2.5 leading-relaxed min-w-0">
              <div>
                <span className="text-txt font-medium">Nell'app:</span> il PC appare da solo nella schermata
                iniziale (stessa Wi-Fi) — tocca il suo nome dopo aver premuto <b className="text-txt">«Accoppia telefono»</b>,
                oppure usa <b className="text-txt">«Inquadra il codice»</b> puntando la fotocamera sul QR.
              </div>
              <div>
                <span className="text-txt font-medium">Browser:</span> apri
                <div className="font-mono text-accent text-sm mt-0.5 select-all">http://{remoteInfo.ip}:{remoteInfo.port}</div>
              </div>
              <div>
                <span className="text-txt font-medium">Codice manuale</span> (in alternativa al QR — è il codice admin del PC)
                <div className="font-mono text-accent text-sm mt-0.5 select-all tracking-widest flex items-center gap-2">
                  {remoteInfo.token}
                  {confirmRotate ? (
                    <button onClick={() => void rotateToken()}
                      className="font-sans not-italic tracking-normal text-[10px] px-2 py-0.5 rounded bg-red-500 text-white font-bold">
                      Conferma: scollega i device col vecchio modello
                    </button>
                  ) : (
                    <button onClick={() => setConfirmRotate(true)} title="Rigenera il codice — scollega i dispositivi che usano il codice condiviso"
                      className="font-sans not-italic tracking-normal text-[10px] px-2 py-0.5 rounded bg-panel2 hover:bg-line text-dim hover:text-txt">
                      Rigenera
                    </button>
                  )}
                </div>
              </div>
              <div className="text-[11px]">
                Oppure <b className="text-txt">inquadra il QR</b> con la fotocamera: si apre già abbinato.
                Per averla come app: menu del browser → <i>Aggiungi a schermata Home</i>.
                Il QR è <b className="text-txt">monouso</b> e scade in ~5 minuti (si rinnova da solo):
                una foto dello schermo non basta per entrare.
                Gusti, preferiti, playlist e preferenze sono condivisi col PC in tempo reale.
              </div>
              {(() => {
                // Alts ora include anche la LAN: per "fuori casa" serve un
                // indirizzo NON-LAN — Tailscale (100.64-127.x) in priorità.
                const ext = remoteInfo.alts?.find((a) => /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a))
                  ?? remoteInfo.alts?.find((a) => !/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
                return ext && (
                  <div className="text-[11px]">
                    <b className="text-txt">Fuori casa:</b> installa <b className="text-txt">Tailscale</b> sul telefono
                    (stessa tailnet del PC) — l'app passa da sola a
                    <span className="font-mono text-accent select-all"> {ext.replace(/^https?:\/\//, '')} </span>
                    quando la Wi-Fi di casa non risponde. Con i brani "sul telefono" funziona anche tutto offline.
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50">Fonti suggerimenti (opzionali, gratis)</div>
        <Row label="Last.fm API key" sub="Migliora similarità artisti e nicchie — key gratis su last.fm/api">
          <div className="flex items-center gap-2">
            <input type="password" value={s.lastfmApiKey} placeholder="API key…"
              onChange={(e) => setS({ ...s, lastfmApiKey: e.target.value })}
              onBlur={() => save({ lastfmApiKey: s.lastfmApiKey })}
              className="w-44 bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent" />
            <button onClick={async () => setLfmOk(await api().lastfm.test(s.lastfmApiKey))}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1"><KeyRound size={11} /> Test</button>
            {lfmOk === true && <Check size={15} className="text-emerald-400" />}
            {lfmOk === false && <X size={15} className="text-red-400" />}
          </div>
        </Row>
        <Row label="Spotify Client ID" sub="developer.spotify.com → Create App (gratis)">
          <input value={s.spotifyClientId} onChange={(e) => setS({ ...s, spotifyClientId: e.target.value })}
            onBlur={() => save({ spotifyClientId: s.spotifyClientId })}
            placeholder="Client ID…"
            className="w-44 bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent" />
        </Row>
        <Row label="Spotify Client Secret">
          <input type="password" value={s.spotifyClientSecret} onChange={(e) => setS({ ...s, spotifyClientSecret: e.target.value })}
            onBlur={() => save({ spotifyClientSecret: s.spotifyClientSecret })}
            placeholder="Client Secret…"
            className="w-44 bg-panel2 border border-line rounded-lg px-3 py-1.5 text-xs outline-none focus:border-accent" />
        </Row>
        <Row label="Collega account Spotify" sub={spConnected ? 'Connesso — puoi importare i tuoi top artisti' : 'Importa i tuoi gusti da Spotify'}>
          {/* Il collegamento (OAuth) apre il browser sul PC; l'import dei gusti
              invece funziona da qualunque dispositivo una volta collegato */}
          {isRemote() && !spConnected ? <span className="text-xs text-dim">collegalo dal PC</span> : spConnected ? (
            <button onClick={async () => {
                try { const r = await api().spotify.importTaste(); toast(`Importati ${r.imported} artisti dai tuoi top Spotify`, 'ok'); loadTaste(); }
                catch (e) { toast(`Import Spotify fallito: ${isRemote() && !isOnline() ? pcGone() : e instanceof Error ? e.message : e}`, 'err'); }
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-medium flex items-center gap-1">
              <Music4 size={12} /> Importa gusti</button>
          ) : (
            <button onClick={async () => {
                const ok = await api().spotify.auth();
                setSpConnected(ok);
                toast(ok ? 'Spotify collegato!' : 'Collegamento fallito — controlla Client ID e redirect URI', ok ? 'ok' : 'err');
              }}
              className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line flex items-center gap-1">
              <LogIn size={12} /> Collega Spotify</button>
          )}
        </Row>
      </div>

      {/* Profilo gusti: cosa il motore ha imparato — e reset */}
      <TasteCard taste={taste} reload={loadTaste} />


      {/* Diagnostica & auto-miglioramento: errori osservati, riparazioni,
          ricerche imparate — dove concentrare gli sforzi */}
      <div className="bg-panel border border-line rounded-xl px-5 mb-6">
        <div className="py-3 text-xs font-bold text-dim uppercase tracking-wider border-b border-line/50 flex items-center justify-between">
          <span className="flex items-center gap-1.5"><Activity size={13} /> Diagnostica & auto-miglioramento</span>
          <button onClick={loadDiag} className="text-dim hover:text-txt normal-case" title="Aggiorna"><RefreshCw size={12} /></button>
        </div>
        {!diag || (Object.keys(diag.byKind).length === 0 && !diag.healed && !diag.bad && !diag.picks) ? (
          <div className="py-5 text-xs text-dim">
            Nessun problema registrato. Quando qualcosa va storto — uno stream che non parte, un download
            fallito, una ricerca a vuoto — viene registrato qui e l'app prova a ripararsi da sola.
          </div>
        ) : (
          <div className="py-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              <span className="text-[11px] px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 flex items-center gap-1">
                <Wrench size={10} /> {diag.healed} riparati da soli
              </span>
              <span className="text-[11px] px-2.5 py-1 rounded-full bg-panel2 border border-line text-dim">
                {diag.bad} stream difettosi noti (saltati in automatico)
              </span>
              <span className="text-[11px] px-2.5 py-1 rounded-full bg-panel2 border border-line text-dim">
                {diag.picks} scelte di ricerca imparate
              </span>
            </div>
            {Object.keys(diag.byKind).length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {Object.entries(diag.byKind).map(([k, c]) => (
                  <span key={k} className="text-[11px] text-dim">
                    <span className="text-txt font-semibold">{c}×</span> {KIND_LABEL[k] ?? k}
                  </span>
                ))}
              </div>
            )}
            {diag.topFailing.length > 0 && (
              <div>
                <div className="text-[11px] text-dim mb-1.5">Brani con più problemi</div>
                <div className="space-y-1">
                  {diag.topFailing.slice(0, 5).map((t, i) => (
                    <div key={i} className="text-xs flex items-center gap-2">
                      <span className="text-red-400 font-mono">{t.c}×</span>
                      <span className="truncate">{t.artist} — {t.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {diag.recent.length > 0 && (
              <div>
                <div className="text-[11px] text-dim mb-1.5">Ultimi eventi</div>
                <div className="space-y-1 max-h-36 overflow-y-auto pr-1">
                  {diag.recent.map((r, i) => (
                    <div key={i} className="text-[11px] text-dim flex items-baseline gap-2">
                      <span className="shrink-0 font-mono">{new Date(r.ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className={`shrink-0 ${r.healed ? 'text-emerald-400' : 'text-orange-300'}`}>{r.healed ? 'riparato' : KIND_LABEL[r.kind] ?? r.kind}</span>
                      <span className="truncate">{[r.artist, r.title].filter(Boolean).join(' — ') || r.query || ''} {r.message ? `· ${r.message}` : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button onClick={async () => {
                  try {
                    const p = await api().diag.exportReport();
                    if (p) toast(isRemote() ? `Report salvato in ${p}` : 'Report salvato — condividilo per l\'analisi', 'ok');
                  } catch (e) { toast(`Report non salvato: ${e instanceof Error ? e.message : e}`, 'err'); }
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-panel2 hover:bg-line text-dim hover:text-txt flex items-center gap-1.5">
                <FileDown size={12} /> Esporta report
              </button>
              <button onClick={async () => {
                  if (!confirmDiag) { setConfirmDiag(true); setTimeout(() => setConfirmDiag(false), 4000); return; }
                  await api().diag.clear(); setConfirmDiag(false); loadDiag();
                  toast('Diagnostica azzerata — ricomincia l\'apprendimento', 'ok');
                }}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                  confirmDiag ? 'bg-red-500/20 text-red-300 border border-red-500/40' : 'bg-panel2 hover:bg-line text-dim hover:text-txt'}`}>
                <Trash2 size={12} /> {confirmDiag ? 'Conferma: azzera tutto' : 'Svuota diagnostica'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="text-[11px] text-dim leading-relaxed">
        <SetIcon size={12} className="inline mr-1" />
        MasterHype scarica audio da YouTube Music per uso personale e masterizza su CD-R. Le API opzionali
        (Last.fm, Spotify) servono solo per i suggerimenti e restano sul tuo PC.
      </div>
    </div>
  );
}
