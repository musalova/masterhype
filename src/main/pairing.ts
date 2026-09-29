// Finestra di pairing "premi sul PC, tocca sul telefono" (modello WPS/KDE
// Connect): l'utente preme "Accoppia telefono" in Impostazioni → per ~90s la
// route POST /pair (l'UNICA non autenticata, vedi remote.ts) consegna un token
// a chi chiede. Zero digitazione sul telefono.
// Il token consegnato NON è il codice condiviso: remote.ts minta un token
// per-dispositivo (tabella devices) che poi si lega a UN profilo — il codice
// admin non esce mai dal PC via questa route.
//
// Limiti deliberati (senza PIN il token è in chiaro sulla LAN per la durata
// della finestra — accettabile su rete domestica, modello push-button):
// - la finestra si apre SOLO per azione esplicita su un device già fidato;
// - rate-limit per IP (2s) + max 5 consegne per finestra;
// - ogni consegna notifica il PC (pairing:used) — un pairing estraneo è
//   visibile subito e il codice si rigenera da Impostazioni.
//
// Puro e senza dipendenze Electron: testabile in vitest.

import { randomBytes } from 'node:crypto';

export const PAIR_WINDOW_MS = 90_000;
const MIN_INTERVAL_MS = 2_000;
const MAX_GRANTS = 5;

let pairUntil = 0;
let grants = 0;
const lastByIp = new Map<string, number>();

type NotifyFn = (info: { name?: string; ip: string }) => void;
let notify: NotifyFn = () => {};
// index.ts registra il broadcast verso finestra desktop + client remoti (SSE)
export function setPairNotifier(fn: NotifyFn): void { notify = fn; }

// ---- Codici monouso del QR ----
// Il QR in Impostazioni NON porta più il codice condiviso (credenziale admin
// persistente, spendibile da chiunque lo fotografi): codifica un codice a
// consumo singolo con TTL — l'atto di MOSTRARE il QR è l'autorizzazione, la
// finestra "Accoppia" non serve. Riscattato → si consuma; scaduto → 403.
// In memoria e mai persistiti: un reboot li invalida tutti (bene).
export const PAIR_CODE_TTL_MS = 5 * 60_000;
const MAX_PAIR_CODES = 3; // QR aperti su più schermi: ogni mint nuovo butta il più vecchio
const pairCodes = new Map<string, number>(); // code → expiresAt

export function mintPairCode(ttlMs = PAIR_CODE_TTL_MS): string {
  const now = Date.now();
  for (const [c, exp] of pairCodes) if (exp <= now) pairCodes.delete(c);
  while (pairCodes.size >= MAX_PAIR_CODES) { const oldest = pairCodes.keys().next().value; if (oldest == null) break; pairCodes.delete(oldest); }
  const code = randomBytes(18).toString('base64url'); // 144 bit: inindovinabile
  pairCodes.set(code, now + ttlMs);
  return code;
}

// Apre la finestra: ritorna quanti ms restano validi
export function openPairingWindow(ms = PAIR_WINDOW_MS): number {
  pairUntil = Date.now() + ms;
  grants = 0;
  lastByIp.clear();
  return ms;
}

export function pairingOpenLeft(): number {
  return Math.max(0, pairUntil - Date.now());
}

export type PairReply =
  | { ok: true; token: string }
  | { ok: false; reason: 'closed' | 'limited' };

// Decide se consegnare il token. `ip` serve al rate-limit e alla notifica.
// `name` è cosmetico (mostrato sul PC: "Dispositivo collegato").
// `code` = codice monouso dal QR: se valido autorizza DA SOLO (la finestra
// non serve) e si consuma — un retry rate-limited NON lo brucia.
export function tryPair(ip: string, name: string | undefined, token: string, code?: string): PairReply {
  const now = Date.now();
  const codeExp = code ? pairCodes.get(code) : undefined;
  const codeOk = codeExp != null && codeExp > now;
  if (!codeOk && (!token || now >= pairUntil)) return { ok: false, reason: 'closed' };
  const last = lastByIp.get(ip) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return { ok: false, reason: 'limited' };
  lastByIp.set(ip, now);
  if (codeOk) {
    pairCodes.delete(code!);
  } else {
    if (grants >= MAX_GRANTS) return { ok: false, reason: 'limited' };
    grants++;
  }
  notify({ name, ip });
  return { ok: true, token };
}
