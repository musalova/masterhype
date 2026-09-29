// PoToken (Proof of Origin) via BotGuard — la stessa tecnica di yt-dlp
// (bgutils-js). YouTube "gating": gli URL videoplayback di client
// senza token servono solo i primi ~1-2MB (sps=2); con po_token nella player
// request + parametro &pot= sull'URL lo stream è completo.
//
// Pipeline (tutta lazy, solo in modalità autonoma):
//   challenge WAA → program BotGuard + script interprete → eseguito dentro
//   un iframe same-origin (po.html) con CSP permissiva propria: la VM si
//   auto-decodifica via eval (bloccato nella pagina principale) e tocca
//   DOM/trustedTypes — serve il DOM reale → snapshot → integrity token
//   → WebPoMinter.
//
// Se QUALSIASI passo fallisce → null: il resolver resta degradata (URL
// validati + heal + Audius) invece di rompersi.
import { Capacitor } from '@capacitor/core';
import { mhFetch } from './direct';

const REQUEST_KEY = 'O43z0dpjhgX20SCx4KAo'; // request key pubblico di YouTube
const WAA = 'https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa';

export interface PoMinter {
  mint(binding: string): Promise<string>;
}

let minterP: Promise<PoMinter | null> | null = null;
let frameP: Promise<Window | null> | null = null;

export function poMinter(): Promise<PoMinter | null> {
  // La memoizzazione vale SOLO per il successo: un fallimento transitorio
  // (challenge rifiutata, rete appena tornata) non deve spegnere il PoToken
  // per tutta la sessione — il prossimo play riprova la pipeline da capo.
  minterP ??= init()
    .then((m) => { if (!m) minterP = null; return m; })
    .catch((e) => { dbg('init', e); minterP = null; return null; });
  return minterP;
}

// Iframe same-origin con CSP permissiva (po.html): realm con eval per la VM
// BotGuard E per il decipher dei player (Platform.shim.eval in direct.ts).
// Stesso discorso: un load fallito si ritenta (l'iframe morto viene rimosso).
export function poFrame(): Promise<Window | null> {
  frameP ??= (async () => {
    const frame = document.createElement('iframe');
    frame.style.display = 'none';
    frame.src = 'po.html';
    const ok = await new Promise<boolean>((res) => {
      frame.onload = () => res(true);
      frame.onerror = () => res(false);
      document.body.appendChild(frame);
    });
    if (!ok || !frame.contentWindow) { frame.remove(); return null; }
    return frame.contentWindow;
  })().then((w) => { if (!w) frameP = null; return w; });
  return frameP;
}

// Diagnostica del pipeline: stage raggiunto + ultimo errore (lettura via CDP).
const dbg = (stage: string, err?: unknown) => {
  (window as unknown as { __poDbg: { stage: string; err?: string } }).__poDbg =
    { stage, err: err ? String(err instanceof Error ? err.message : err).slice(0, 160) : undefined };
};

async function init(): Promise<PoMinter | null> {
  if (!Capacitor.isNativePlatform()) return null;
  dbg('imports');
  const [{ BotGuardClient, getChallenge }, { base64ToU8, u8ToBase64 }] = await Promise.all([
    import('bgutils-js/botguard'),
    import('bgutils-js/utils'),
  ]);

  // 1) challenge BotGuard (WAA Create): program bytecode + script interprete
  dbg('challenge');
  const ch = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: mhFetch, useYouTubeAPI: false });
  const program = ch.program, globalName = ch.globalName;
  if (!program || !globalName) { dbg('challenge-incomplete'); return null; }
  let js = ch.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js) {
    const u = ch.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
    if (!u) { dbg('no-interpreter'); return null; }
    const r = await mhFetch(u.startsWith('http') ? u : `https:${u}`);
    if (!r.ok) { dbg(`interpreter-http-${r.status}`); return null; }
    js = await r.text();
  }

  // 2) interprete in un iframe same-origin con CSP permissiva (po.html):
  // eval lì è consentito e la VM si registra su iframeWindow[globalName].
  dbg('vm-frame');
  const iw = await poFrame();
  if (!iw) { dbg('vm-frame-null'); return null; }
  try { (iw as unknown as { eval: (s: string) => unknown }).eval(js); } catch (e) { dbg('vm-eval', e); return null; }
  const w = iw as unknown as Record<string, unknown>;
  if (!w[globalName]) { dbg('vm-missing'); return null; }

  // 3) carica il program nella VM → snapshot (token + funzione minter)
  dbg('botguard');
  let bg: InstanceType<typeof BotGuardClient>;
  try { bg = await BotGuardClient.create({ program, globalName, globalObject: w }); }
  catch (e) { dbg('botguard-load', e); return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webPoSignalOutput: any[] = [];
  let bgResponse: string;
  try { bgResponse = await bg.snapshot({ webPoSignalOutput }); }
  catch (e) { dbg('snapshot', e); return null; }
  if (!bgResponse || !webPoSignalOutput.length) { dbg('snapshot-empty'); return null; }

  // 4) integrity token (WAA GenerateIT) → minter WebPO
  dbg('integrity');
  const itRes = await mhFetch(`${WAA}/GenerateIT`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json+protobuf',
      'x-goog-api-key': 'AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw',
      'x-user-agent': 'grpc-web-javascript/0.1',
    },
    body: JSON.stringify([REQUEST_KEY, bgResponse]),
  });
  if (!itRes.ok) { dbg(`integrity-http-${itRes.status}`); return null; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = await itRes.json() as any[];
  // WebPoMinter.create fa `mintCallback instanceof Function` — il callback
  // vive nel realm dell'iframe → instanceof cross-realm fallirebbe sempre
  // (APF:Failed). Reimplementiamo il minter con check typeof e copia dei
  // byte: identico a WebPoMinter.mintAsWebsafeString, cross-realm safe.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getMinter = webPoSignalOutput[0] as any;
    if (!integrityToken || typeof getMinter !== 'function') { dbg('minter-args'); return null; }
    const mintCallback = await getMinter(base64ToU8(integrityToken));
    if (typeof mintCallback !== 'function') { dbg('minter-apf'); return null; }
    const enc = new TextEncoder();
    const mint = async (b: string) => {
      const res = await mintCallback(enc.encode(b));
      // res è un Uint8Array del realm iframe → copia nel realm corrente
      return u8ToBase64(res instanceof Uint8Array ? res : new Uint8Array(res), true);
    };
    dbg('ready');
    return { mint };
  } catch (e) { dbg('minter', e); return null; }
}
