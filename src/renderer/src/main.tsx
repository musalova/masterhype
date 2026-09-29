import React from 'react';
import ReactDOM from 'react-dom/client';
import { isRemote, hasRemoteConf, needsProfilePick, isStandalone, ensureDeviceToken, redeemPairParam } from './remote';
import { syncPrefs } from './persist';
import './index.css';

// Bootstrap: su telefono (no preload Electron) servono host+token del PC —
// mostra la schermata di pairing finché non è configurato, TRANNE se l'utente
// ha scelto "continua senza PC" (isStandalone: l'app gira in modalità autonoma).
// needsProfilePick: il pairing è valido ma il profilo salvato è stato
// eliminato sul PC — ConnectGate mostra solo la scelta "chi sei?".
const remote = isRemote();

async function boot(): Promise<void> {
  // QR aperto nel browser: ?pair=<codice monouso> va riscattato PRIMA del
  // gating — diventa un device token salvato + flag "scegli il profilo".
  // Se invece siamo già pairati il codice è di un altro pairing: ignorato.
  if (remote && !hasRemoteConf()) await redeemPairParam();
  const needsPairing = remote && (needsProfilePick() || (!hasRemoteConf() && !isStandalone()));
  // Le preferenze condivise (volume, schermata, code…) devono arrivare dal
  // DB del PC PRIMA che lo store zustand si inizializzi: App va importato
  // dinamicamente, altrimenti savedVolume/savedScreen/restorePlayerQueue
  // leggerebbero i valori vecchi (bug: l'hydration era invisibile allo store).
  // PC raggiungibile: hydrate <200ms su LAN. PC spento: la fetch verso l'host
  // morto non deve fermare lo splash — tetto 3.5s, poi l'app parte lo stesso
  // e la sync continua in background (applyShared aggiorna lo stato live).
  if (!needsPairing) {
    // Conf salvata col codice condiviso del PC (QR/manuale, o pairing
    // pre-device-token): la converte in un token per dispositivo legato a un
    // profilo — la credenziale admin non resta memorizzata sul telefono.
    // Fire-and-forget: PC giù o server vecchio → si riprova al prossimo avvio.
    if (remote && hasRemoteConf()) void ensureDeviceToken();
    await Promise.race([syncPrefs(), new Promise((r) => setTimeout(r, 3500))]);
  }
  const [{ default: App }, { default: ConnectGate }, { initAppearance }, { RootErrorBoundary }] = await Promise.all([
    import('./App'),
    import('./components/ConnectGate'),
    import('./appearance'),
    import('./components/common'),
  ]);
  initAppearance(); // palette/animazioni: dopo l'hydrate, così arriva la scelta del profilo
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RootErrorBoundary>
        {needsPairing ? <ConnectGate /> : <App />}
      </RootErrorBoundary>
    </React.StrictMode>,
  );
}
// Un boot che fallisce prima del render non deve lasciare lo splash (o una
// pagina vuota) congelato: mostra comunque un modo per riavviare.
void boot().catch((err) => {
  console.error('[boot]', err);
  const root = document.getElementById('root');
  if (!root || root.childElementCount) return;
  const box = document.createElement('div');
  box.style.cssText = 'height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#ece8f1;background:#0c0a10;font-family:inherit';
  const msg = document.createElement('div');
  msg.textContent = 'Avvio fallito — riprova a riavviare l’app';
  const btn = document.createElement('button');
  btn.textContent = 'Ricarica';
  btn.style.cssText = 'padding:8px 18px;border-radius:10px;border:0;background:#ff4d6d;color:#fff;font-weight:700;cursor:pointer';
  btn.onclick = () => location.reload();
  box.append(msg, btn);
  root.append(box);
});

// Service worker per "Aggiungi a schermata Home" (PWA) — solo client remoto http
if (remote && location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Splash: resta visibile almeno ~900ms per l'animazione di avvio, poi fade-out
const splash = document.getElementById('splash');
if (splash) {
  setTimeout(() => {
    splash.classList.add('out');
    setTimeout(() => splash.remove(), 600);
  }, 900);
}
