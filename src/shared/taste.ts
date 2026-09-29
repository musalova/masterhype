// GUSTI — unica fonte di verità per normalizzatori, chiavi brano e pesi dei
// segnali. Importato sia dal main (engine/library/recommend) sia dal renderer
// (localData/offlineRec): la parità PC↔telefono è strutturale, non un test
// manuale. Chi modifica un comportamento lo cambia QUI, una volta sola.

// Forma canonica per confronti su artisti/titoli: lowercase, senza diacritici
// ("Måneskin" = "maneskin"), solo a-z0-9 e spazi ("AC/DC" = "ac dc").
export const normText = (s: string): string => (s ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // combining diacritics U+0300-U+036F
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

// Genere/tag: separatori e punteggiatura diventano SPAZI, non spariscono
// ("hip-hop" ID3 = "hip hop" Last.fm, "R&B" = "r b").
export const normTag = (s: string): string => (s ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// Chiave esatta brano — dedup candidati/coda: stessa canzone anche se il
// videoId cambia (topic channel, re-upload con stesso titolo).
export const trackKey = (artist: string, title: string): string =>
  `${normText(artist)}|${normText(title)}`;

// Titolo "base" per filtri gusto: "(feat. X)", "[Live]", "- Remaster 2011"
// non devono produrre una chiave diversa per lo stesso brano — uno skip su
// "Song" copre anche "Song (Remastered)" e "Song - Live".
export const baseTitleOf = (t: string): string => normText(
  (t ?? '')
    .replace(/\s*[\(\[][^)\]]*[\)\]]/g, ' ')
    .replace(/\s+-\s+(?:remaster(?:ed)?|live|remix|acoustic|deluxe|mono|stereo|radio edit|single version|edit|version)\b.*$/i, ' '));

// Chiave fuzzy per i filtri gusto (brani skippati/nascosti, blocchi artista).
export const trackBaseKey = (artist: string, title: string): string =>
  `${normText(artist)}|${baseTitleOf(title)}`;

// Segnale esplicito → peso sul profilo gusti (taste_profile.weight).
// Usata da recordEvent (PC) e localTaste (telefono). 'hide' = dislike
// deliberato: pesa più di uno skip, meno di un unlike esplicito.
export const SIGNAL_WEIGHT: Record<string, number> = {
  like: 3, download: 2.5, burn: 2, play: 1, skip: -1, hide: -2, unlike: -3,
};
export const signalWeight = (type: string): number => SIGNAL_WEIGHT[type] ?? 0;

// Completamento ascolto → peso gusto. Stessa regola su PC e telefono:
// ≥85% della durata (o ≥4 min senza durata nota) = ascolto completo (+1.2,
// come un mezzo like); ≥25% E ≥30s = parziale (evento registrato, gusto 0);
// sotto = troppo poco per contare.
export const LISTEN_COMPLETE_WEIGHT = 1.2;
export const LISTEN_MIN_S = 30;
export const listenClass = (playedS: number, durationS?: number): 'complete' | 'partial' | null => {
  const dur = durationS && durationS > 0 ? durationS : undefined;
  const ratio = dur ? playedS / dur : (playedS >= 240 ? 1 : 0);
  if (ratio >= 0.85 || playedS >= 240) return 'complete';
  if (ratio >= 0.25 && playedS >= LISTEN_MIN_S) return 'partial';
  return null;
};
export const listenTasteWeight = (playedS: number, durationS?: number): number =>
  listenClass(playedS, durationS) === 'complete' ? LISTEN_COMPLETE_WEIGHT : 0;

// Il segnale sull'artista gocciola su tag Last.fm / genere ID3 al 35%.
export const TAG_SPILL = 0.35;
