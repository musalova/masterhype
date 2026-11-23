import type { TrackRef } from '../../shared/types';
import { trackKey } from '../../shared/taste';

// Operazioni PURE sulla coda di riproduzione — estratte dallo store così sono
// testabili senza zustand/DOM (stesso pattern di shuffle.ts). Invariante:
// queue[queueIndex] è SEMPRE il brano in riproduzione; le operazioni
// ricalibrano l'indice, mai il brano corrente.

type QT = TrackRef & { local?: boolean };

/** Posizione di un brano in coda: dedup su videoId O chiave artist|title. */
export function queueIndexOf(queue: QT[], t: QT): number {
  const k = trackKey(t.artist, t.title);
  return queue.findIndex((x) => x.videoId === t.videoId || trackKey(x.artist, x.title) === k);
}

/**
 * "Riproduci subito dopo": il brano va in posizione queueIndex+1.
 * Se era già in coda non si duplica — si sposta lì (stile Spotify).
 * Ritorna null se il brano È quello in riproduzione (niente da fare).
 */
export function playNextAt(queue: QT[], queueIndex: number, t: QT): { queue: QT[]; queueIndex: number } | null {
  const q = [...queue];
  const old = queueIndexOf(q, t);
  if (old === queueIndex) return null;
  let qi = queueIndex;
  if (old >= 0) { q.splice(old, 1); if (old < qi) qi -= 1; }
  q.splice(qi + 1, 0, t);
  return { queue: q, queueIndex: qi };
}

/**
 * Riordino: sposta l'elemento da `from` a `to` e ricalibra queueIndex —
 * il brano in riproduzione non cambia, cambia solo la sua posizione.
 * Indici fuori range / from==to → coda invariata.
 */
export function movedQueue(queue: QT[], queueIndex: number, from: number, to: number): { queue: QT[]; queueIndex: number } {
  if (from === to || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return { queue, queueIndex };
  const q = [...queue];
  const [item] = q.splice(from, 1);
  q.splice(to, 0, item);
  let qi = queueIndex;
  if (from === qi) qi = to;
  else if (from < qi && to >= qi) qi -= 1;
  else if (from > qi && to <= qi) qi += 1;
  return { queue: q, queueIndex: qi };
}

/**
 * "Svuota coda" stile Spotify: resta solo il brano in riproduzione
 * (la coda è ciò che viene dopo). Se niente suona → coda vuota, indice -1.
 */
export function clearedQueue(queue: QT[], queueIndex: number): { queue: QT[]; queueIndex: number } {
  const cur = queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : undefined;
  return { queue: cur ? [cur] : [], queueIndex: cur ? 0 : -1 };
}
