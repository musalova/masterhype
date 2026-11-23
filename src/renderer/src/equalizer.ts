import { Capacitor, registerPlugin } from '@capacitor/core';
import { isRemote } from './api';
import { remoteBase, remoteToken, isOnline } from './remote';
import { gsEncode, eqRelayAllowed, EQ_RELAY_HOSTS } from '../../shared/eqRelay';

// ---- Equalizzatore a 5 bande (Web Audio API) ----
// MediaElementAudioSourceNode dirotta PER SEMPRE l'uscita dell'<audio> nel
// grafo: element.volume resta valido (è applicato prima del grafo), così il
// crossfade a due elementi e il gainMap loudness funzionano invariati — ogni
// <audio> ha la SUA catena di filtri.
//
// TRAPPOLA CORS (silenzio): il nodo produce silenzio se la risorsa caricata
// è "CORS-tainted". googlevideo NON manda Access-Control-Allow-Origin e un
// documento file:// che carica media:// È cross-origin → con l'elemento in
// crossOrigin='anonymous' ogni src esterno passa dal relay locale:
//   · desktop → media://gs/<b64> (net.fetch nel main + ACAO)
//   · Android → http://127.0.0.1:<port>/gs?u=<b64> (relay nativo, ACAO)
//   · browser remoto → /media/gs?u=<b64> sul PC (ACAO già globale)
// blob:, /__phone/, /__pc/ e gli URL same-origin sono già puliti.
// Regola: una volta attaccato il grafo, OGNI src esterno va wrappato —
// eqSrc wrappa quando esiste almeno una catena (non solo a EQ "acceso"),
// altrimenti il brano successivo uscirebbe muto.

export const EQ_BANDS = [
  { freq: 60, label: '60' },
  { freq: 230, label: '230' },
  { freq: 910, label: '910' },
  { freq: 3600, label: '3,6k' },
  { freq: 14000, label: '14k' },
] as const;

export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: 'Piatto', gains: [0, 0, 0, 0, 0] },
  { name: 'Auto', gains: [4, 1, -1, 2, 4] },
  { name: 'Bassi', gains: [8, 4, 0, 0, -2] },
  { name: 'Rock', gains: [5, 3, -1, 3, 5] },
  { name: 'Pop', gains: [-1, 3, 4, 2, -1] },
  { name: 'Voce', gains: [-3, -1, 3, 5, 3] },
  { name: 'Jazz', gains: [4, 0, -2, 3, 5] },
];

export const EQ_KEY = 'mh-device-eq';
export type EqState = { enabled: boolean; gains: number[] };
export const eqPresetName = (g: number[]) =>
  EQ_PRESETS.find((p) => p.gains.every((v, i) => v === g[i]))?.name ?? 'Personalizzato';

interface RelayPlugin { relayPort(): Promise<{ port: number }> }
const native = Capacitor.isNativePlatform();
const relayPlugin = native ? registerPlugin<RelayPlugin>('MediaSession') : null;
let relayPortP: Promise<number> | null = null;

// Porta del relay loopback nativo (Java): avviato alla prima richiesta,
// 0 se il plugin non c'è (APK vecchio, browser, desktop).
export function nativeRelayPort(): Promise<number> {
  if (!relayPlugin) return Promise.resolve(0);
  relayPortP ??= relayPlugin.relayPort().then((r) => (r?.port > 0 ? r.port : 0)).catch(() => 0);
  return relayPortP;
}

// EQ attaccabile? Desktop: sempre (media://gs). Android: serve il relay nativo.
// Browser remoto (po.html): basta il PC online — /media/gs è same-origin.
export async function eqCanRoute(): Promise<boolean> {
  if (!isRemote()) return true;
  if (native) return (await nativeRelayPort()) > 0;
  return isOnline();
}

let ctx: AudioContext | null = null;
const chains = new Map<HTMLAudioElement, BiquadFilterNode[]>();
let gains = [0, 0, 0, 0, 0];
let armed = false; // EQ abilitato dall'utente (anche prima dell'attach async)

// PlayerBar lo chiama appena legge eq.enabled: gli src risolti nella finestra
// tra enable e attach vanno già wrappati — un googlevideo nudo caricato
// PRIMA dell'attach resterebbe tainted e il grafo lo silenzierebbe.
export function eqArm(): void { armed = true; }

function audioCtx(): AudioContext {
  if (!ctx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error('Web Audio non supportato');
    ctx = new AC();
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// Catena sorgente→5 filtri→destination, UNA per elemento: createMediaElementSource
// lancia se chiamato due volte sullo stesso elemento.
export function eqAttach(el: HTMLAudioElement): void {
  if (chains.has(el)) return;
  const c = audioCtx();
  const src = c.createMediaElementSource(el);
  const filters = EQ_BANDS.map((b, i) => {
    const f = c.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = b.freq;
    f.Q.value = 1;
    f.gain.value = gains[i];
    return f;
  });
  filters.reduce((p, f) => { p.connect(f); return f; }, src as AudioNode).connect(c.destination);
  chains.set(el, filters);
  // Il dirottamento è irreversibile: da qui in poi l'elemento DEVE caricare
  // solo sorgenti CORS-clean → src sempre via eqSrc, e modalità CORS attiva.
  el.crossOrigin = 'anonymous';
}

export function eqIsAttached(el: HTMLAudioElement): boolean {
  return chains.has(el);
}

// Guadagni in dB (±12) applicati a TUTTE le catene esistenti e future.
export function eqApply(g: number[]): void {
  gains = g.slice(0, EQ_BANDS.length);
  for (const fs of chains.values()) fs.forEach((f, i) => { f.gain.value = gains[i] ?? 0; });
}

const toB64 = gsEncode;

// L'URL va wrappato nel relay? Esterno http(s) = tainted → sì.
export function eqNeedsWrap(url: string, origin = location.origin): boolean {
  if (!/^https?:/i.test(url)) return false;
  try { return new URL(url).origin !== origin; } catch { return false; }
}

// URL che l'<audio> può caricare in modo CORS-clean una volta attaccato il grafo.
// Idempotente (un URL già wrappato rientra nei casi "non http(s)" / same-origin).
export async function eqSrc(url: string): Promise<string> {
  if (!(armed || chains.size) || !eqNeedsWrap(url)) return url;
  if (!isRemote()) return `media://gs/${toB64(url)}`;
  const port = await nativeRelayPort();
  if (port) return `http://127.0.0.1:${port}/gs?u=${toB64(url)}`;
  if (isOnline()) {
    return navigator.serviceWorker?.controller
      ? `/__pc/media/gs?u=${toB64(url)}`
      : `${remoteBase()}/media/gs?u=${toB64(url)}&token=${encodeURIComponent(remoteToken())}`;
  }
  // Né relay nativo né PC: la sorgente non può essere CORS-clean. Restituisco
  // comunque l'URL — il brano suonerà muto SOLO se il grafo è attaccato, e
  // eqCanRoute() impedisce proprio quella combinazione.
  return url;
}

export { eqRelayAllowed, EQ_RELAY_HOSTS };
