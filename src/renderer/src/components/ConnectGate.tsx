import { useEffect, useRef, useState } from 'react';
import { Wifi, Smartphone, User, UserPlus, ArrowLeft, Loader2, MonitorSmartphone, QrCode, ChevronDown } from 'lucide-react';
import { testConnection, saveRemoteConf, fetchProfiles, needsProfilePick, clearProfilePick, confBase, confToken, enterStandalone, watchPcs, requestPair, discoveryAvailable, upgradeToDeviceToken, claimOnBase, deviceLabel, type FoundPc } from '../remote';
import { parsePairPayload } from '../../../shared/paircode';
import type { MhUser } from '../../../shared/types';
import Logo from './Logo';
import { CenterLoader } from './common';
import QrScanner from './QrScanner';

// Schermata di pairing — riprogettata per non richiedere MAI la digitazione
// di indirizzo+codice (troppo complessa per utenti medi):
//
//   1. AUTO-SCOPERTA: il PC annuncia "sono qui" via UDP broadcast; il telefono
//      lo mostra in lista. Tap → POST /pair. Il codice viene consegnato solo
//      dentro la finestra "Accoppia telefono" (90s) aperta sul PC — se è
//      chiusa il gate dice cosa fare e riprova DA SOLO ogni 2.5s.
//   2. QR: "Inquadra il codice" → scanner in-app; il QR mostrato sul PC
//      (http://ip:porta/?token=…) dà base+token senza finestra.
//   3. MANUALE: indirizzo+codice, ripiegato come fallback.
//
// Dopo il pairing si sceglie il PROFILO. Caso speciale 'mh-pick-profile': il
// profilo salvato è stato eliminato sul PC — il pairing resta valido, si
// chiede solo "chi sei?".
// Ultima lista profili vista dal device (scritta da store.loadUsers): con il
// PC spento permette comunque di scegliere tra profili già noti.
function cachedProfiles(): MhUser[] | null {
  try {
    const v = JSON.parse(localStorage.getItem('mh-users-cache') ?? 'null') as MhUser[] | null;
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

// Nome leggibile del dispositivo per la conferma sul PC ("Dispositivo
// collegato: Pixel 8"): deviceLabel() in remote.ts legge il modello
// dall'UA WebView Android.

export default function ConnectGate() {
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Step 2: pairing riuscito → scelta/creazione del profilo
  const [profiles, setProfiles] = useState<MhUser[] | null>(null);
  const [base, setBase] = useState('');
  const [newName, setNewName] = useState('');
  // Il token corrente è già un device token (da /pair o codice monouso)?
  // Ref: deve sopravvivere al render della scelta profilo fino a saveRemoteConf.
  const pairBound = useRef(false);
  // Boot con profilo da ri-scegliere: la fetch dei profili è in volo — mostrare
  // il form di pairing per poi sostituirlo sarebbe un flash confuso
  const [booting, setBooting] = useState(needsProfilePick());

  // Profilo eliminato sul PC: la conf (base+token) è ancora valida — si salta
  // il pairing e si va dritti alla scelta del profilo.
  const [pickFail, setPickFail] = useState(false);
  useEffect(() => {
    if (!needsProfilePick()) { setBooting(false); return; }
    const b = confBase(), t = confToken();
    if (!b || !t) { setBooting(false); return; }
    setBase(b); setToken(t);
    void fetchProfiles(b, t).then((list) => {
      setBooting(false);
      // PC irraggiungibile o risposta non valida: NIENTE auto-scelta —
      // entrare come profilo 1 farebbe sparire playlist/like/cache dell'altro
      // profilo (sono scope-ati per utente) proprio quando serve di più.
      if (list == null) {
        // PC spento: la lista profili in cache permette comunque lo switch
        // offline tra profili già noti (uno eliminato nel frattempo verrà
        // rifiutato alla prima chiamata → 401 → di nuovo scelta profilo).
        const c = cachedProfiles();
        if (c?.length) { setProfiles(c); return; }
        setPickFail(true); return;
      }
      if (list.length <= 1) { // un solo profilo o server legacy: si entra diretti (con claim)
        setBusy(false);
        void enter(b, t, list[0]?.id ?? 1).then((done) => { if (!done) { setBooting(false); setProfiles(list); } });
        return;
      }
      setProfiles(list);
    });
  }, []);

  // ---- Auto-scoperta UDP (solo APK; in browser il plugin non c'è) ----
  const [found, setFound] = useState<FoundPc[]>([]);
  const [noPcYet, setNoPcYet] = useState(false); // dopo 12s senza annunci → hint onesto
  useEffect(() => {
    if (!discoveryAvailable) return;
    const hint = setTimeout(() => setNoPcYet(true), 12_000);
    const stop = watchPcs((pc) => setFound((f) => f.some((x) => x.base === pc.base) ? f : [...f, pc]));
    return () => { clearTimeout(hint); stop(); };
  }, []);

  // ---- Consegna token durante la finestra "Accoppia telefono" ----
  // Se il PC è stato trovato ma la finestra è chiusa, il gate aspetta e
  // riprova da solo: l'utente preme il bottone sul PC e il telefono si
  // collega senza un secondo tap.
  const [awaiting, setAwaiting] = useState<FoundPc | null>(null);
  const awaitingDead = useRef(0); // ms dall'apertura attesa — stop dopo 3min
  useEffect(() => {
    if (!awaiting) return;
    let alive = true;
    awaitingDead.current = Date.now();
    const tick = async () => {
      const r = await requestPair(awaiting.base, deviceLabel());
      if (!alive) return;
      if (typeof r === 'object') { void finishPair(awaiting.base, r.token, true); return; }
      if (r === 'down') {
        setErr(`${awaiting.name} non risponde più — controlla che MasterHype sia aperto sul PC`);
        setAwaiting(null);
        return;
      }
      // 'closed': la finestra non è ancora aperta — continua a riprovare
      if (Date.now() - awaitingDead.current > 180_000) {
        setErr('Tempo scaduto — sul PC premi "Accoppia telefono" e riprova');
        setAwaiting(null);
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [awaiting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Destinazione comune di TUTTI i percorsi (discovery, QR, manuale):
  // il segreto può essere un codice MONOUSO (?pair= del QR — si riscatta via
  // /pair direttamente in device token) oppure il codice condiviso admin
  // (inserimento manuale / QR legacy ?token= → upgrade via device:register).
  const finishPair = async (b: string, secret: string, devBoundHint = false) => {
    setBusy(true); setErr('');
    let t = secret;
    let devBound = devBoundHint;
    if (!devBoundHint) {
      // Primo tentativo: codice monouso — /pair lo scambia in un device token
      // senza toccare il codice condiviso (speso → già consumato; scaduto → 403).
      const pr = await requestPair(b, deviceLabel(), secret);
      if (typeof pr === 'object') { t = pr.token; devBound = true; }
      else if (pr === 'down') { setBusy(false); setErr('PC non raggiungibile — controlla la Wi-Fi e che MasterHype sia aperto sul PC'); return; }
      else {
        // 'closed': non è un codice monouso valido — forse è il codice condiviso
        const ok = await testConnection(b, secret);
        if (ok === 'auth') { setBusy(false); setErr('Codice non valido o già usato — rigenera il QR in Impostazioni → Telefono sul PC'); return; }
        if (ok !== 'ok') { setBusy(false); setErr('PC non raggiungibile — controlla la Wi-Fi e che MasterHype sia aperto sul PC'); return; }
        // Codice admin: convertito SUBITO in device token — non resta sul telefono
        const up = await upgradeToDeviceToken(b, secret, deviceLabel());
        devBound = up !== secret;
        t = up;
      }
    }
    const list = await fetchProfiles(b, t);
    setBusy(false);
    // Il server era vivo un attimo fa (testConnection): null = perso di nuovo —
    // non azzerare il profilo dell'utente su un errore di rete.
    if (list == null) { setErr('Perso il contatto col PC — riprova'); return; }
    setBase(b); setToken(t);
    pairBound.current = devBound;
    // Zero profili = PC con versione precedente ai profili (users:* → 404 → []):
    // fallback compatibilità — si entra come profilo legacy 1, niente vicolo cieco.
    // Un solo profilo (o server legacy): claim + ingresso diretto. enter()
    // riceve b/t espliciti — lo state base/token non è ancora applicato qui.
    if (list.length <= 1) { void enter(b, t, list[0]?.id ?? 1, devBound).then((done) => { if (!done) setProfiles(list); }); return; }
    setProfiles(list);
  };

  const connect = () => {
    let h = host.trim();
    if (!h || !token.trim()) { setErr('Inserisci indirizzo e codice'); return; }
    if (!/^https?:\/\//.test(h)) h = `http://${h}`;
    void finishPair(h, token.trim());
  };

  // Tap su un PC trovato: prima richiesta /pair — finestra aperta → token
  // subito; chiusa → schermata "premi Accoppia sul PC" con auto-retry.
  const tapPc = async (pc: FoundPc) => {
    setErr('');
    const r = await requestPair(pc.base, deviceLabel());
    if (typeof r === 'object') { void finishPair(pc.base, r.token, true); return; }
    if (r === 'down') { setErr(`${pc.name} non risponde — controlla che MasterHype sia aperto sul PC`); return; }
    setAwaiting(pc);
  };

  // QR letto dallo scanner: mh://pair, http://host:porta/?pair=… (codice
  // monouso) o ?token=… legacy (codice condiviso → upgrade immediato)
  const onQr = (text: string) => {
    const p = parsePairPayload(text);
    if (!p || (!p.pair && !p.token)) { setErr('Codice non riconosciuto — inquadra il QR di MasterHype sul PC'); setScanning(false); return; }
    setScanning(false);
    void finishPair(p.base, (p.pair ?? p.token)!);
  };
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(!discoveryAvailable); // senza discovery il manuale resta visibile

  // Scelta del profilo: il token del device si LEGA al profilo sul PC
  // (device:claim) PRIMA di salvare la conf — da qui in poi il server serve
  // solo i dati di quel profilo, qualunque header mandi il client.
  // Ritorna false se il claim non è andato (il chiamante decide il fallback).
  const enter = async (b: string, t: string, id: number, bound = pairBound.current): Promise<boolean> => {
    const r = await claimOnBase(b, t, id);
    if (r === 'window') { setErr('Questo dispositivo è già legato a un altro profilo — sul PC premi «Accoppia telefono» e riprova'); return false; }
    if (r === 'err') { setErr('Perso il contatto col PC — riprova'); return false; }
    // 'ok' (legato) o 'legacy' (server pre-device: il profilo va su X-MH-User)
    clearProfilePick();
    saveRemoteConf(b, t, id, bound);
    location.reload();
    return true;
  };
  const pick = async (id: number) => {
    setBusy(true); setErr('');
    await enter(base, token.trim(), id);
    setBusy(false);
  };

  const createProfile = async () => {
    const n = newName.trim();
    if (!n) return;
    setBusy(true); setErr('');
    try {
      const res = await fetch(`${base}/api/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MH-Token': token.trim() },
        body: JSON.stringify({ c: 'users:create', a: [n] }),
      });
      const j = (await res.json()) as { r?: MhUser; e?: string };
      if (!res.ok || !j.r) throw new Error(j.e ?? 'errore');
      pick(j.r.id);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : 'Creazione profilo fallita');
    }
  };

  // ---- Boot: profilo da ri-scegliere, lista profili in arrivo ----
  if (booting) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6 bg-bg">
        <Logo size={40} />
        <CenterLoader label="Cerco i profili sul PC…" />
      </div>
    );
  }

  // ---- Boot: profilo da ri-scegliere ma PC irraggiungibile ----
  // Non si può verificare chi esiste ancora: si offre il retry e l'uscita
  // "continua col profilo salvato" — se era davvero eliminato, la prima
  // chiamata al PC riaprirà questa scelta da sola (401 'profilo non valido').
  if (pickFail) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6 bg-bg text-center">
        <Logo size={40} />
        <div className="font-bold text-lg">PC non raggiungibile</div>
        <div className="text-sm text-dim max-w-xs">Serve il PC per scegliere il profilo. Riprova quando è acceso e sulla stessa rete.</div>
        <button onClick={() => { setPickFail(false); setBooting(true); const b = confBase(), t = confToken(); void fetchProfiles(b, t).then((list) => { if (list == null) { setBooting(false); const c = cachedProfiles(); if (c?.length) { setProfiles(c); return; } setPickFail(true); return; } if (list.length <= 1) { setBase(b); setToken(t); void enter(b, t, list[0]?.id ?? 1).then((done) => { if (!done) { setBooting(false); setProfiles(list); } }); return; } setBooting(false); setProfiles(list); }); }}
          className="px-5 py-2.5 rounded-xl bg-accent text-white text-sm font-bold">Riprova</button>
        <button onClick={() => { clearProfilePick(); location.reload(); }}
          className="text-xs text-dim hover:text-txt underline underline-offset-2">
          Continua col profilo salvato (offline)
        </button>
        {/* Profilo sparito E il PC potrebbe non tornare: l'utente non resta
            intrappolato nel gate — può sempre entrare in modalità senza PC
            (enterStandalone dimentica anche il pairing salvato) */}
        <button onClick={enterStandalone}
          className="text-xs text-dim hover:text-txt flex items-center gap-1.5 mt-2">
          <Smartphone size={12} /> Continua senza PC
        </button>
      </div>
    );
  }

  // ---- Step 2: scelta profilo ----
  if (profiles) {
    return (
      <div className="h-full flex items-center justify-center p-6 bg-bg">
        <div className="w-full max-w-sm bg-panel border border-line rounded-2xl p-6 space-y-5">
          <div className="flex items-center gap-3">
            <Logo size={34} />
            <div>
              <div className="font-bold text-lg">Chi sei?</div>
              <div className="text-xs text-dim">Ogni profilo ha gusti, preferiti e playlist propri</div>
            </div>
          </div>

          <div className="space-y-2">
            {profiles.map((u) => (
              <button key={u.id} onClick={() => void pick(u.id)} disabled={busy}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-panel2 border border-line hover:border-accent/60 transition-colors text-left disabled:opacity-50">
                <span className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm text-white shrink-0"
                  style={{ background: u.color }}>{u.name[0]?.toUpperCase()}</span>
                <span className="font-semibold text-sm">{u.name}</span>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <UserPlus size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
              <input value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createProfile(); }}
                placeholder="Nuovo profilo…" maxLength={30}
                className="w-full bg-panel2 border border-line rounded-lg pl-9 pr-3 py-2.5 text-sm outline-none focus:border-accent" />
            </div>
            <button onClick={() => void createProfile()} disabled={busy || !newName.trim()}
              className="px-4 py-2.5 rounded-lg bg-accent text-white text-sm font-bold disabled:opacity-40 shrink-0">
              {busy ? <Loader2 size={15} className="animate-spin" /> : 'Crea'}
            </button>
          </div>

          {err && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{err}</div>}

          <button onClick={() => setProfiles(null)} className="text-xs text-dim hover:text-txt flex items-center gap-1 mx-auto">
            <ArrowLeft size={12} /> Torna al pairing
          </button>
        </div>
      </div>
    );
  }

  // ---- Step 1: pairing ----
  return (
    <div className="h-full flex items-center justify-center p-6 bg-bg">
      {scanning && <QrScanner onCode={onQr} onClose={() => setScanning(false)} />}
      <div className="w-full max-w-sm bg-panel border border-line rounded-2xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <Logo size={34} />
          <div>
            <div className="font-bold text-lg">Master<span className="neon-text">Hype</span></div>
            <div className="text-xs text-dim">Collega questo dispositivo al tuo PC</div>
          </div>
        </div>

        {awaiting ? (
          // Finestra chiusa: istruzione chiara + auto-retry — l'utente preme
          // "Accoppia telefono" sul PC e il telefono si collega da solo.
          <div className="space-y-4 text-center">
            <div className="flex justify-center"><Loader2 size={22} className="animate-spin text-accent" /></div>
            <div className="text-sm leading-relaxed">
              <b className="text-txt">{awaiting.name}</b> trovato!<br />
              <span className="text-dim">Sul PC apri <b className="text-txt">Impostazioni → Telefono</b> e premi <b className="text-txt">«Accoppia telefono»</b>. Il collegamento parte da solo.</span>
            </div>
            <button onClick={() => setAwaiting(null)} className="text-xs text-dim hover:text-txt underline underline-offset-2">Annulla</button>
          </div>
        ) : (
          <>
            {discoveryAvailable && (
              <div className="space-y-2">
                {found.length === 0 ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2.5 text-xs text-dim py-1">
                      <Loader2 size={13} className="animate-spin shrink-0" />
                      Cerco il PC sulla rete Wi-Fi…
                    </div>
                    {noPcYet && (
                      <div className="text-[11px] text-dim/80 leading-relaxed">
                        Nessun PC trovato — verifica che il telefono sia sulla stessa Wi-Fi e
                        MasterHype aperto sul PC. Oppure usa il QR qui sotto.
                      </div>
                    )}
                  </div>
                ) : (
                  found.map((pc) => (
                    <button key={pc.base} onClick={() => void tapPc(pc)} disabled={busy}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-accent/10 border border-accent/40 hover:border-accent transition-colors text-left disabled:opacity-50">
                      <MonitorSmartphone size={18} className="text-accent shrink-0" />
                      <div className="min-w-0">
                        <div className="text-sm font-bold truncate">{pc.name}</div>
                        <div className="text-[11px] text-dim truncate">{pc.base.replace(/^https?:\/\//, '')} — tocca per collegare</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}

            <button onClick={() => setScanning(true)}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-accent to-accent2 text-white font-bold text-sm hover:opacity-90 glow flex items-center justify-center gap-2">
              <QrCode size={16} /> Inquadra il codice sul PC
            </button>
            <div className="text-[11px] text-dim leading-relaxed -mt-1">
              Il QR è in <b className="text-txt">Impostazioni → Telefono</b> sul PC
              (telefono e PC sulla stessa Wi-Fi).
            </div>

            {err && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{err}</div>}

            {/* Inserimento manuale: fallback per reti strane (discovery bloccata,
                camera rotta) — ripiegato per non spaventare chi non serve */}
            <div>
              <button onClick={() => setManual((m) => !m)}
                className="w-full text-xs text-dim hover:text-txt flex items-center justify-center gap-1.5 py-1">
                <ChevronDown size={12} className={`transition-transform ${manual ? 'rotate-180' : ''}`} />
                Inserimento manuale
              </button>
              {manual && (
                <div className="space-y-3 pt-2">
                  <label className="block">
                    <span className="text-xs text-dim flex items-center gap-1.5 mb-1"><Wifi size={12} /> Indirizzo del PC</span>
                    <input value={host} onChange={(e) => setHost(e.target.value)}
                      placeholder="es. 192.168.1.20:48484" autoCapitalize="off" autoCorrect="off"
                      inputMode="url" className="w-full bg-panel2 border border-line rounded-lg px-3 py-2.5 text-sm outline-none focus:border-accent" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-dim flex items-center gap-1.5 mb-1"><User size={12} /> Codice di pairing</span>
                    <input value={token} onChange={(e) => setToken(e.target.value)}
                      placeholder="8 caratteri" autoCapitalize="off" autoCorrect="off"
                      className="w-full bg-panel2 border border-line rounded-lg px-3 py-2.5 text-sm outline-none focus:border-accent font-mono tracking-widest" />
                  </label>
                  <button onClick={connect} disabled={busy}
                    className="w-full py-3 rounded-xl bg-panel2 border border-line text-sm font-bold hover:border-accent/60 disabled:opacity-50">
                    {busy ? 'Connessione…' : 'Connetti'}
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Non tutti hanno il PC: l'app funziona da sola — YouTube diretto,
            download sul telefono, code che si sincronizzano al primo pairing */}
        {!awaiting && (
          <>
            <div className="relative">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-line" /></div>
              <div className="relative flex justify-center"><span className="bg-panel px-3 text-[11px] text-dim">oppure</span></div>
            </div>
            <button onClick={enterStandalone}
              className="w-full py-3 rounded-xl bg-panel2 border border-line text-sm font-bold hover:border-accent/60 transition-colors flex items-center justify-center gap-2">
              <Smartphone size={15} /> Continua senza PC
            </button>
            <div className="text-[11px] text-dim leading-relaxed -mt-1">
              Ricerca, streaming e download sul telefono funzionano comunque. Potrai collegare
              un PC più tardi da Impostazioni → Telefono (libreria condivisa e masterizzazione CD).
            </div>
          </>
        )}
      </div>
    </div>
  );
}
