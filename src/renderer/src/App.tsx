import { lazy, Suspense, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderInput, RefreshCw, WifiOff, X } from 'lucide-react';
import { useApp } from './store';
import { api, isRemote } from './api';
import { isOnline, onConnectivity, onReconnected, retryNow, setLocalUserId, hasRemoteConf, pcFreshAt } from './remote';
import { drainPending, pendingCount } from './pendingSync';
import { syncPrefs } from './persist';
import { initNativeMedia, crashResume } from './nativeMedia';
import { handleBack } from './backStack';
import Sidebar from './components/Sidebar';
import PlayerBar from './components/PlayerBar';
import UpdateCard from './components/UpdateCard';
import WhatsNewCard from './components/WhatsNewCard';
import { checkUpdate, initDesktopUpdate } from './update';
import { Toasts, SkeletonRows, ScreenErrorBoundary } from './components/common';
import Backdrop from './components/Backdrop';

// Code-splitting: ogni schermata è un chunk separato → avvio più veloce
const Home = lazy(() => import('./screens/Home'));
const Stations = lazy(() => import('./screens/Stations'));
const Search = lazy(() => import('./screens/Search'));
const Library = lazy(() => import('./screens/Library'));
const Playlists = lazy(() => import('./screens/Playlists'));
const CdBuilder = lazy(() => import('./screens/CdBuilder'));
const Trends = lazy(() => import('./screens/Trends'));
const Assistant = lazy(() => import('./screens/Assistant'));
const Downloads = lazy(() => import('./screens/Downloads'));
const Settings = lazy(() => import('./screens/Settings'));

const screens = {
  home: Home, stations: Stations, search: Search, library: Library, playlists: Playlists,
  cd: CdBuilder, trends: Trends, assistant: Assistant, downloads: Downloads, settings: Settings,
};

// Banner "PC non raggiungibile": informativo e contestuale — se il telefono
// ha internet la modalità autonoma (YouTube diretto) copre ricerca e streaming;
// senza rete restano i brani scaricati sul telefono. Retry auto via SSE/backoff
// + evento 'online'; il bottone forza il retry immediato.
// Chiudibile: lo stato PC-giù può durare giorni — una barra permanente è solo
// rumore. La chiusura vale finché la connessione non cambia stato (online→
// offline = nuovo evento → si ri-mostra).
function OfflineBanner() {
  const [on, setOn] = useState(isOnline());
  const [net, setNet] = useState(navigator.onLine);
  const [dismissed, setDismissed] = useState(false);
  const nPhone = useApp((s) => s.phoneIds.size);
  useEffect(() => onConnectivity((v) => { setOn(v); if (v) setDismissed(false); }), []);
  useEffect(() => {
    const f = () => setNet(navigator.onLine);
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); };
  }, []);
  // Quanto è vecchio ciò che si vede: ogni cache dal PC segna il timestamp
  // (mh-cache-fresh). Un telefono che non vedeva il PC da giorni lo dichiara
  // invece di mostrare libreria/playlist come se fossero attuali.
  const fmtAgo = (ts: number) => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (m < 1) return 'adesso';
    if (m < 60) return `${m} min fa`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h fa`;
    const d = Math.round(h / 24);
    return d === 1 ? 'ieri' : `${d} giorni fa`;
  };
  const fresh = on ? null : pcFreshAt();
  const msg = (net
    ? 'PC non raggiungibile — ricerca e streaming funzionano dal telefono'
    : nPhone > 0
      ? `Nessuna rete — ${nPhone} brani sul telefono restano riproducibili`
      : 'Nessuna rete — scarica brani sul telefono per ascoltarli offline')
    + (fresh ? ` · dati di ${fmtAgo(fresh)}` : '');
  return (
    <AnimatePresence>
      {!on && !dismissed && (
        <motion.div initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
          className="absolute top-0 inset-x-0 z-[60] flex items-center justify-center gap-2.5 px-4 py-1.5 bg-amber-500/90 text-black text-xs font-medium">
          <WifiOff size={13} className="shrink-0" />
          <span className="truncate">{msg}</span>
          <button onClick={retryNow} className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md bg-black/15 hover:bg-black/25 font-bold">
            <RefreshCw size={11} /> Riprova
          </button>
          <button onClick={() => setDismissed(true)} title="Nascondi finché il PC non torna"
            className="shrink-0 p-0.5 rounded hover:bg-black/15" aria-label="Chiudi">
            <X size={13} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default function App() {
  const screen = useApp((s) => s.screen);
  const loadSettings = useApp((s) => s.loadSettings);
  const loadLibrary = useApp((s) => s.loadLibrary);
  const Screen = screens[screen];

  useEffect(() => {
    // Profilo attivo: il server lo sa già (header X-MH-User su remoto,
    // settings.currentUser su desktop) — qui lo specchiamo per la UI e
    // per il filtro delle preferenze live
    void api().users.current().then((id) => { setLocalUserId(id); useApp.setState({ currentUser: id }); }).catch(() => {});
    void useApp.getState().loadUsers();
    void loadSettings();
    void loadLibrary().then(() => {
      // "Aggiungi al CD" su download partiti prima dell'ultimo riavvio:
      // pendingCd è persistito — chi era in coda e ora è in libreria entra
      const s = useApp.getState();
      for (const vid of [...s.pendingCd]) {
        const lib = s.library.find((x) => x.videoId === vid);
        if (lib) { s.pendingCd.delete(vid); s.addToCd(lib, true); }
      }
    }).catch(() => {});
    void useApp.getState().phoneInit(); // brani scaricati sul telefono (offline)
    void useApp.getState().loadRemoteLikes();
    // Prepara il client YouTube diretto in idle: se il PC cade, il primo play
    // è già veloce invece di aspettare download del player JS + decifratore
    if (isRemote()) void import('./direct').then((m) => m.warmup());
    // APK: media session nativa (notifica/lockscreen/BT) + servizio foreground
    // che tiene viva la WebView audio a schermo spento — no-op fuori dall'app
    initNativeMedia();
    // Aggiornamento APK: check silenzioso a boot assestato (il PC pairato
    // serve l'APK via LAN; sorgente pubblica se configurata) + re-check a
    // ogni riconnessione e ogni 6h di app aperta — un boot partito a PC
    // spento non perde il giro, e l'app lasciata aperta si aggiorna da sola.
    const updT = setTimeout(() => void checkUpdate(), 4000);
    const updI = setInterval(() => void checkUpdate(), 6 * 3600_000);
    const offUpd = onReconnected(() => void checkUpdate());
    // Desktop: stato auto-aggiornamento dell'EXE (card "Riavvia e aggiorna")
    const offDesk = initDesktopUpdate();
    useApp.getState().restorePlayerQueue();
    // Recreate post-render-crash (il servizio nativo conserva lo stato
    // sessione): riparte il brano che suonava, con la posizione salvata.
    void crashResume();
    // Prefetch dei chunk delle schermate in idle: la navigazione diventa istantanea
    const idle = (cb: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(cb) : setTimeout(cb, 800));
    idle(() => {
      void import('./screens/Home'); void import('./screens/Stations'); void import('./screens/Search');
      void import('./screens/Library'); void import('./screens/Playlists'); void import('./screens/CdBuilder');
      void import('./screens/Trends'); void import('./screens/Assistant'); void import('./screens/Downloads');
      void import('./screens/Settings');
    });
    void api().downloads.list().then((d) => useApp.setState({ downloads: d })).catch(() => {});
    const off = api().downloads.onEvent(async (j) => {
      useApp.setState((s) => {
        const idx = s.downloads.findIndex((x) => x.id === j.id);
        if (idx < 0) return { downloads: [...s.downloads, j] };
        const d = [...s.downloads];
        d[idx] = j;
        return { downloads: d };
      });
      const s = useApp.getState();
      if (j.status === 'done') {
        await loadLibrary();
        s.toast(`Scaricato: ${j.track.title}`, 'ok');
        // "Aggiungi al CD" da ricerca su brano non in libreria: entra appena pronto
        if (s.pendingCd.has(j.track.videoId)) {
          s.pendingCd.delete(j.track.videoId);
          const lib = useApp.getState().library.find((x) => x.videoId === j.track.videoId);
          if (lib) s.addToCd(lib);
        }
      } else if (j.status === 'error') {
        s.pendingCd.delete(j.track.videoId); // niente attesa infinita per il CD
      }
    });
    // Rientro in Wi-Fi / PC riacceso: risincronizza preferenze e memoria
    // condivisa (libreria, like, tracklist CD, coda se il player è fermo)
    // L'altro dispositivo ha modificato la libreria (like, eliminazioni,
    // import, like remoti): ricarica live — debounced per non rifare la fetch
    // a raffica durante operazioni bulk.
    let libT: ReturnType<typeof setTimeout> | undefined;
    const offLib = api().library.onChanged(() => {
      clearTimeout(libT);
      libT = setTimeout(() => {
        void useApp.getState().loadLibrary();
        void useApp.getState().loadRemoteLikes();
      }, 600);
    });
    // Impostazioni cambiate sull'altro lato (desktop, altro telefono, o eco
    // del nostro set): lo store si allinea subito — stesso contratto delle
    // mh-pref via remote:prefs:event. Il payload porta lo stato intero.
    const offSettings = api().settings.onEvent((s) => {
      useApp.setState({ settings: s });
      try { localStorage.setItem('mh-settings-cache', JSON.stringify(s)); } catch { /* quota */ }
    });
    // Rientro in Wi-Fi / PC riacceso: risincronizza preferenze e memoria
    // condivisa (libreria, like, tracklist CD, coda se il player è fermo)
    const resync = () => {
      void syncPrefs().then(async () => {
        const s = useApp.getState();
        // Azioni compiute col PC spento (like, ascolti): le spediamo ora
        const dr = await drainPending().catch(() => null);
        // PRIMA il drain (le patch settings accodate sono state applicate),
        // POI la lettura canonica: include anche i cambi fatti da altri
        // dispositivi mentre eravamo offline (gli eventi SSE erano giù).
        await s.loadSettings();
        await s.loadLibrary();       // rilegge anche la tracklist CD condivisa
        await s.loadRemoteLikes();
        void api().downloads.list().then((d) => useApp.setState({ downloads: d })).catch(() => {});
        // Download finiti mentre eravamo offline: completano il CD virtuale
        for (const vid of [...s.pendingCd]) {
          const lib = useApp.getState().library.find((x) => x.videoId === vid);
          if (lib) { s.pendingCd.delete(vid); s.addToCd(lib, true); }
        }
        if (!s.player.current) s.restorePlayerQueue(); // solo se non sta suonando
        s.toast(dr?.sent ? `Sincronizzato col PC — ${dr.sent} azioni recuperate` : 'Sincronizzato col PC', 'info');
        if (dr?.resurrected) s.toast(`${dr.resurrected} playlist ripristinate: eliminate sul PC ma modificate qui`, 'info');
        if (dr?.dropped) s.toast(`${dr.dropped} modifiche offline non applicate — l'elemento non esiste più sul PC`, 'err');
      });
    };
    const offReconnect = onReconnected(resync);
    // Race al boot: persist.ts apre l'SSE a livello di modulo, PRIMA che App
    // monti — se il PC risponde subito la "riconnessione" (boot partito
    // offline, o primo pairing dopo la modalità senza PC) scatta quando questo
    // callback non esiste ancora e le code offline restavano ferme fino al
    // prossimo blackout. Se al mount siamo già online con azioni in coda → ora.
    if (isRemote() && hasRemoteConf() && isOnline() && pendingCount() > 0) resync();
    return () => { off(); offLib(); offReconnect(); offUpd(); offDesk(); offSettings(); clearTimeout(libT); clearTimeout(updT); clearInterval(updI); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag&drop file audio da Esplora risorse → import in libreria (solo desktop)
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    if (isRemote()) return; // sul telefono i file non si trascinano
    let depth = 0;
    const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    const onEnter = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); depth++; setDragOver(true); } };
    const onOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onLeave = (e: DragEvent) => { if (hasFiles(e)) { depth--; if (depth <= 0) { depth = 0; setDragOver(false); } } };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; setDragOver(false);
      const paths = [...(e.dataTransfer?.files ?? [])]
        .map((f) => { try { return api().sys.pathForFile(f); } catch { return ''; } })
        .filter(Boolean);
      if (!paths.length) return;
      const s = useApp.getState();
      try {
        const n = await api().library.importFiles(paths);
        if (n > 0) { s.toast(`${n} file importati in libreria`, 'ok'); await s.loadLibrary().catch(() => {}); }
        else s.toast('Nessun file audio valido tra quelli rilasciati', 'err');
      } catch {
        s.toast('Import fallito — riprova', 'err');
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // Scorciatoie: spazio = play/pausa, Ctrl+frecce = avanti/indietro, Ctrl+K o / = cerca
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      const onButton = el.tagName === 'BUTTON'; // spazio su bottone = click nativo, non toggle
      if (e.key === ' ' && !typing && !onButton) { e.preventDefault(); useApp.getState().toggle(); }
      else if (e.key === 'ArrowRight' && (e.ctrlKey || e.metaKey) && !typing) { e.preventDefault(); useApp.getState().next(); }
      else if (e.key === 'ArrowLeft' && (e.ctrlKey || e.metaKey) && !typing) { e.preventDefault(); useApp.getState().prev(); }
      else if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        useApp.getState().nav('search');
        setTimeout(() => document.querySelector<HTMLInputElement>('main input')?.focus(), 60);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Tasto indietro hardware (Android): MainActivity invoca window.__mhBack.
  // Ordine: layer aperti (lettore, pannelli, dettagli) → cronologia schermate
  // → false = niente da chiudere, il sistema minimizza/esce normalmente.
  useEffect(() => {
    window.__mhBack = () => {
      if (handleBack()) return true;
      return useApp.getState().navBack();
    };
    return () => { delete window.__mhBack; };
  }, []);

  // Tasti multimediali hardware (anche con finestra in background)
  useEffect(() => api().player.onMediaKey((a) => {
    const s = useApp.getState();
    if (a === 'toggle') s.toggle();
    else if (a === 'next') s.next();
    else if (a === 'prev') s.prev();
  }), []);

  return (
    <div className="h-full flex flex-col">
      <Backdrop />
      {/* Banner offline solo se un PC ESISTE e non risponde: in modalità
          senza PC non c'è nessuno da "ritrovare" — il banner mentirebbe */}
      {isRemote() && hasRemoteConf() && <OfflineBanner />}
      <div className="flex-1 flex min-h-0 relative z-[1]">
        <Sidebar />
        <main className="flex-1 min-w-0">
          {/* Suspense FUORI da AnimatePresence: se la schermata lazy sospende,
              mode="wait" resterebbe bloccato sulla schermata vecchia per sempre */}
          <Suspense fallback={<div className="p-4 md:p-8"><SkeletonRows n={8} /></div>}>
            <AnimatePresence mode="wait">
              <motion.div key={screen} className="h-full"
                initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.15 }}>
                {/* key={screen}: il boundary si resetta a ogni cambio schermata */}
                <ScreenErrorBoundary key={screen}><Screen /></ScreenErrorBoundary>
              </motion.div>
            </AnimatePresence>
          </Suspense>
        </main>
      </div>
      <PlayerBar />
      {/* Stack flottante delle card di sistema: novità post-update sopra,
          card aggiornamento sotto — si impilano se compaiono insieme */}
      <div className="fixed bottom-24 left-4 right-4 sm:left-auto sm:right-4 sm:w-80 z-[70] flex flex-col gap-3">
        <WhatsNewCard />
        <UpdateCard />
      </div>
      <Toasts />

      {/* Overlay drag&drop */}
      <AnimatePresence>
        {dragOver && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-bg/80 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <div className="border-2 border-dashed border-accent rounded-3xl px-12 py-10 flex flex-col items-center gap-3 bg-panel/90 glow">
              <FolderInput size={40} className="text-accent" />
              <div className="text-lg font-bold">Rilascia per importare</div>
              <div className="text-sm text-dim">MP3, FLAC, WAV, M4A, OGG — tag e durata letti automaticamente</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
