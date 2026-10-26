// Shuffle "a sacchetto" (come Spotify): in un giro ogni brano della coda esce
// UNA volta sola, in ordine casuale. Prima lo shuffle estraeva un indice a
// caso a ogni brano: ripetizioni frequenti, brani mai suonati e una coda che
// non finiva mai (repeat 'off' e radio infinita venivano ignorati).
// Puro: lo stato del giro (chiavi già uscite) lo possiede il chiamante.

export interface ShuffleItem { videoId?: string; artist?: string; title?: string }

// Chiave di un brano nel giro: videoId, o artista|titolo per le righe senza id.
export const shuffleKey = (t: ShuffleItem): string => t.videoId || `${t.artist ?? ''}|${t.title ?? ''}`;

// Prossimo indice casuale tra i brani non ancora usciti nel giro corrente.
// Giro esaurito: con repeatAll ne parte uno nuovo (`played` azzerato, tranne
// il brano corrente — non si ripete subito); altrimenti null = fine coda, il
// chiamante passa alla radio o si ferma. Brani duplicati in coda (stessa
// chiave) contano una volta sola.
export function nextShuffleIndex(
  queue: readonly ShuffleItem[], current: number, played: Set<string>,
  repeatAll: boolean, rnd: () => number = Math.random,
): number | null {
  const cur = queue[current];
  const curKey = cur ? shuffleKey(cur) : null;
  const candidates = (): number[] => {
    const out: number[] = [];
    queue.forEach((t, i) => {
      const k = shuffleKey(t);
      if (i !== current && k !== curKey && !played.has(k)) out.push(i);
    });
    return out;
  };
  let cands = candidates();
  if (!cands.length && repeatAll && queue.length > 1) {
    played.clear();
    if (curKey) played.add(curKey);
    cands = candidates();
  }
  if (!cands.length) return null;
  return cands[Math.min(cands.length - 1, Math.floor(rnd() * cands.length))];
}
