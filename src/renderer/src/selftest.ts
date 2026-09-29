import { Capacitor } from '@capacitor/core';
import { isRemote, remoteBase, remoteToken, hasRemoteConf, resyncWhen } from './remote';
import { mhFetch, directSearch, directStream } from './direct';
import type { LibraryTrack } from '../../shared/types';
import { phonePut, phoneGet, phoneDel, phoneReconcile, phoneFreeMB } from './phoneLocal';
import { pendingCount } from './pendingSync';

// Auto-test del dispositivo: gira DENTRO l'app (APK o browser), quindi funziona
// sul telefono reale senza adb/emulatore. Ogni voce prova il percorso vero del
// codice — non mock — e riporta ok/ms/dettaglio. Il risultato serve sia a noi
// per verificare la modalità autonoma sia all'utente per diagnosticare "non
// sento la musica fuori casa".
export interface SelfTestRow { name: string; ok: boolean | null; ms: number; detail: string }
export interface SelfTestReport { rows: SelfTestRow[]; at: number }

async function step(name: string, fn: () => Promise<string>): Promise<SelfTestRow> {
  const t0 = performance.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Math.round(performance.now() - t0), detail };
  } catch (e) {
    return { name, ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : String(e) };
  }
}

// Carica l'URL stream in un <audio> reale e attende canplay: è la prova che la
// musica PARTIRÀ quando l'utente preme play (readyState≥3 = dati decodificabili).
function audioProbe(url: string): Promise<string> {
  return new Promise((res, rej) => {
    const a = new Audio();
    const to = setTimeout(() => { a.src = ''; rej(new Error('timeout caricamento stream')); }, 15_000);
    a.oncanplay = () => {
      clearTimeout(to);
      const d = isFinite(a.duration) ? `${Math.round(a.duration)}s` : 'stream';
      // Tentativo di play vero (muto, breve): su Android il tap sul bottone del
      // test è ancora attivazione utente, quindi di solito parte davvero.
      a.muted = true;
      a.play().then(() => {
        setTimeout(() => { a.pause(); a.src = ''; res(`canplay + play ok (durata ${d})`); }, 1200);
      }).catch(() => { a.src = ''; res(`canplay ok (durata ${d}) — play richiede il tap dell'utente`); });
    };
    a.onerror = () => { clearTimeout(to); rej(new Error(`audio error ${a.error?.code ?? '?'}`)); };
    a.preload = 'auto';
    a.src = url;
  });
}

export async function runSelfTest(): Promise<SelfTestReport> {
  const rows: SelfTestRow[] = [];

  // 0. Piattaforma — informativo, non un test
  rows.push({
    name: 'Piattaforma', ok: null, ms: 0,
    detail: `${Capacitor.isNativePlatform() ? 'APK nativa' : 'browser/PWA'} · ${Capacitor.getPlatform()} · client ${isRemote() ? 'remoto' : 'desktop'}`,
  });

  // 1. Storage telefono: roundtrip IndexedDB (blob + metadati + reconcile)
  rows.push(await step('Storage telefono (IndexedDB)', async () => {
    const TEST_ID = -2_000_000_001; // fuori dal range degli id sintetici reali
    const blob = new Blob([new Uint8Array(4096).fill(7)], { type: 'audio/mpeg' });
    const meta = { id: TEST_ID, videoId: 'selftest', title: 'selftest', artist: 'mh', duration: 1, thumbnail: '' } as unknown as LibraryTrack;
    await phonePut({ id: TEST_ID, blob, meta, size: 4096, addedAt: Date.now() });
    const got = await phoneGet(TEST_ID);
    await phoneDel(TEST_ID);
    const after = await phoneGet(TEST_ID);
    if (!got || got.blob.size !== 4096) throw new Error('lettura blob fallita');
    if (after) throw new Error('delete non ha rimosso il record');
    const rec = await phoneReconcile();
    const free = await phoneFreeMB();
    return `${rec.ids.length} brani presenti${free != null ? ` · ~${free}MB liberi` : ''}`;
  }));

  // 2. Preferenze locali persistenti
  rows.push(await step('Preferenze locali', async () => {
    const k = 'mh-pref-selftest';
    localStorage.setItem(k, '42');
    const ok = localStorage.getItem(k) === '42';
    localStorage.removeItem(k);
    if (!ok) throw new Error('localStorage non persistente');
    return 'scrittura/lettura ok';
  }));

  // 3. Internet: generate_204 — su APK passa da CapacitorHttp (status reale),
  //    in browser no-cors (opaque: conta solo che la fetch risolva)
  rows.push(await step('Connessione internet', async () => {
    if (Capacitor.isNativePlatform()) {
      const r = await mhFetch('https://www.google.com/generate_204');
      if (r.status !== 204) throw new Error(`status ${r.status}`);
      return '204 da google (HTTP nativo)';
    }
    await fetch('https://www.google.com/generate_204', { mode: 'no-cors' });
    return 'richiesta risolta (browser)';
  }));

  // 4. PC raggiungibile: probe reale su /api/info col token salvato
  if (isRemote() && !hasRemoteConf()) {
    // Modalità senza PC: non è un test superato — è informativo (grigio),
    // il PC non esiste proprio nella configurazione dell'utente.
    rows.push({ name: 'Server PC (casa)', ok: null, ms: 0, detail: 'senza PC — modalità autonoma attiva' });
  } else {
  rows.push(await step('Server PC (casa)', async () => {
    if (!isRemote()) return 'desktop: il PC è locale';
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      const r = await fetch(`${remoteBase()}/api/info`, { headers: { 'X-MH-Token': remoteToken() }, signal: ac.signal });
      if (r.status === 401) throw new Error('token rifiutato — ri-pairing necessario');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return `raggiungibile su ${remoteBase()}`;
    } finally { clearTimeout(t); }
  }));
  }

  // 5. YouTube diretto: init client + ricerca reale
  let probeVid = ''; // il risultato reale pilota lo step stream: niente id cablato
  rows.push(await step('YouTube diretto: ricerca', async () => {
    const r = await directSearch('vasco rossi', false); // selftest: basta la fase veloce
    if (!r.songs.length) throw new Error('0 risultati');
    probeVid = r.songs[0].videoId;
    return `${r.songs.length} brani — "${r.songs[0].title}"`;
  }));

  // 6. Stream diretto: URL googlevideo + fetch range (prova che l'audio è
  //    scaricabile). Prima il videoId della ricerca vera; se la ricerca era
  //    fallita (o quel video non ha stream), candidati noti a rotazione — un
  //    video hardcoded morto non deve falsare il test per sempre.
  let streamUrl = '';
  rows.push(await step('YouTube diretto: stream URL', async () => {
    let lastErr: unknown = new Error('nessun candidato');
    for (const v of [probeVid, 'dQw4w9WgXcQ', '60ItHLz5WEA', 'e-ORhEE9VVg']) {
      if (!v) continue;
      try {
        const u = await directStream(v);
        const host = new URL(u).host;
        if (!host.includes('googlevideo')) throw new Error(`host inatteso: ${host}`);
        streamUrl = u;
        return `url risolto (${host.split('.')[0]})`;
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }));

  // 7. I primi byte dello stream si scaricano davvero?
  if (streamUrl) {
    rows.push(await step('Stream: download byte audio', async () => {
      const r = await mhFetch(streamUrl, { headers: { Range: 'bytes=0-2047' } });
      if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status}`);
      const n = (await r.arrayBuffer()).byteLength;
      if (n < 1024) throw new Error(`solo ${n} byte`);
      return `${n} byte ok (HTTP ${r.status})`;
    }));
    // 8. L'<audio> lo carica davvero? (la prova del "fa sentire la musica")
    rows.push(await step('Riproduzione <audio> reale', () => audioProbe(streamUrl)));
  }

  // 9. Media Session (controlli lockscreen/notifica) — informativo
  rows.push({
    name: 'Controlli lockscreen', ok: 'mediaSession' in navigator ? true : null, ms: 0,
    detail: 'mediaSession' in navigator ? 'Media Session API presente' : 'Media Session API assente su questa WebView',
  });

  // 10. Coda sincronizzazione verso il PC
  const pend = pendingCount();
  rows.push({
    name: 'Sync pendente verso PC', ok: null, ms: 0,
    detail: pend ? `${pend} azioni in coda — si sincronizzano ${resyncWhen()}` : 'nessuna azione in coda',
  });

  return { rows, at: Date.now() };
}

// Stato di salute sintetico per il titolo del bottone
export function selfTestVerdict(rep: SelfTestReport): string {
  const fails = rep.rows.filter((r) => r.ok === false);
  if (!fails.length) return 'Tutto ok';
  return `${fails.length} problem${fails.length === 1 ? 'a' : 'i'}: ${fails.map((f) => f.name).join(', ')}`;
}
