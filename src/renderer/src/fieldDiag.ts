// Telemetria "dal campo": errori e metriche di stream raccolti sul telefono
// mentre il PC è giù. Vivono in localStorage (come le code di pendingSync) e
// risalgono al primo reconnect — prima i report morivano nei .catch(() => {}).
// Il drain usa import LAZY di ./remote: remote.ts importa direct.ts che
// importa questo modulo — un import statico creerebbe un ciclo.

import { Capacitor } from '@capacitor/core';
import { IPC } from '../../shared/types';

const ISSUE_KEY = 'mh-pending-issues';
const CLIENT_KEY = 'mh-stream-clients';
// Cap FIFO: la telemetria non deve mai mangiare lo storage dei dati veri.
const MAX_ISSUES = 150;
const MAX_SAMPLES = 300;

const readQ = <T,>(key: string): T[] => {
  try { return JSON.parse(localStorage.getItem(key) ?? '[]') as T[]; } catch { return []; }
};
const writeQ = (key: string, v: unknown[]): void => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ }
};

export interface QueuedIssue {
  kind: string;
  d: { message?: string; artist?: string; title?: string; videoId?: string; query?: string };
  ts: number;
  tries?: number;
}

export function enqueueIssue(kind: string, d: QueuedIssue['d']): void {
  const q = readQ<QueuedIssue>(ISSUE_KEY);
  q.push({ kind, d, ts: Date.now() });
  writeQ(ISSUE_KEY, q.slice(-MAX_ISSUES));
}

export interface ClientSample { client: string; ms: number; ok: boolean; device?: string }

// Un campione per tentativo-client della cascata streamUrl: con queste righe
// aggregate sul PC si vede QUALE client Innertube sta morendo (es. WEB 0% ok
// mentre TV_SIMPLY resta sano) invece di dover leggere i log di __ytDbg.
export function noteClientSample(client: string, ms: number, ok: boolean): void {
  const q = readQ<ClientSample>(CLIENT_KEY);
  q.push({ client, ms: Math.round(ms), ok, device: Capacitor.getPlatform() });
  writeQ(CLIENT_KEY, q.slice(-MAX_SAMPLES));
}

export function pendingDiagCount(): number {
  return readQ(ISSUE_KEY).length + readQ(CLIENT_KEY).length;
}

// Stessa semantica di drainPending: si ferma al primo errore di rete (il resto
// resta per il drain successivo); gli errori applicativi ritentano con budget
// e poi scartano (un item avvelenato non blocca la coda).
export async function drainFieldDiag(): Promise<{ sent: number }> {
  const { callRemote, isOnline } = await import('./remote');
  if (!isOnline()) return { sent: 0 };
  let sent = 0;
  // Prima le metriche in un solo POST batch, poi i report singoli in ordine.
  const samples = readQ<ClientSample>(CLIENT_KEY);
  if (samples.length) {
    try {
      await callRemote<unknown>(IPC.streamStats, samples);
      // Merge-safe: conserva i campioni accodati durante il POST
      writeQ(CLIENT_KEY, readQ(CLIENT_KEY).slice(samples.length));
      sent += samples.length;
    } catch { if (!isOnline()) return { sent }; /* server vecchio: riprova al prossimo drain */ }
  }
  const cur = readQ<QueuedIssue>(ISSUE_KEY);
  const rest: QueuedIssue[] = [];
  for (let i = 0; i < cur.length; i++) {
    const it = cur[i];
    try { await callRemote<unknown>(IPC.issuesReport, it.kind, it.d); sent++; }
    catch {
      if (!isOnline()) { rest.push(it, ...cur.slice(i + 1)); break; } // rete giù: stop
      if ((it.tries ?? 0) < 2) rest.push({ ...it, tries: (it.tries ?? 0) + 1 });
    }
  }
  // Merge-safe: gli item accodati DURANTE il drain sono in coda allo snapshot
  // (push in coda) → si conservano attaccandoli dopo i superstiti.
  writeQ(ISSUE_KEY, [...rest, ...readQ<QueuedIssue>(ISSUE_KEY).slice(cur.length)]);
  return { sent };
}
