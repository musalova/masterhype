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
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
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

// ---- Filtro "canali-compilation" condiviso PC↔telefono ----
// Su YouTube metà dei risultati per query tematiche sono upload di canali
// playlist ("THE GYM BEATS", "Jazz and Blues Experience", "AI-Music",
// "LUNA ITALIANA"): megamix da 30min-3h spacciati per brani. In scaletta è un
// degrado grave ("canzoni belle e coerenti"). Le parole sotto sono scelte per
// NON colpire artisti veri: fuori 'legend' (John Legend), 'experience'
// (Jimi Hendrix Experience), 'central' (Central Cee), 'world' (Third World),
// 'club' (Culture Club), 'sounds' (The Sounds), 'stereo/fm' (Stereo MCs, FM),
// 'disco' (Panic! at the Disco), 'bossa' (Bossa Nostra), 'vintage' (Vintage
// Trouble), 'deluxe', 'sleep'/'study' (Sleep), 'project' (Alan Parsons).
// Parole da canale ovunque nel nome (confini di parola):
const JUNK_ARTIST_WORD = /\b(playlist|megamix|nonstop|non-stop|lounge|vibes?|chill|relax\w*|relaj\w*|motivation|workout|fitness|gym|training|universe|melodies|media|jukebox|vinyl|sessions|café|cafe|productions?|tv|official|channel|karaoke|instrumental|acoustic|ambient|grooves|classics|classical|hits?|lyrics|essentials|jazz|road trip|brain power|tunes|reggaeton)\b/i;
// Suffissi tipici attaccati al nome (CoverSideMusic, alexrainbirdMusic,
// OSOCITYNATION, Latino Mix — "Mix Master Mike" resta salvo: 'mix' in testa):
const JUNK_ARTIST_TAIL = /(music|musik|musica|beats|beatz|covers|nation|holics|records|fm|tv|mix|productions?|italiana|italiano)$/i;
// "The Big 80s Guys", "COUNTRY LEGENDS 1990s" — decennio nel nome del canale:
const JUNK_ARTIST_DECADE = /(^|\s)\d{2,4}s\b/i;
// Lettere matematiche/emoji da canale fake ("𝘀𝗮𝗱 𝘁𝗵𝗶𝗻𝗴𝘀"):
const JUNK_ARTIST_FANCY = /[\u{1D400}-\u{1D7FF}\u{1F000}-\u{1FAFF}]/u;
// Byline generata, non un artista: "Male singer with guitar", "Duet with
// guitar", "Group of singers" — metadato mancante travestito da nome.
const JUNK_ARTIST_GENERIC = /\b(male|female) (singer|vocalist)|\bduet with\b|\bgroup of (singers|musicians)\b|\bwith guitar\b|\bsinger with\b/i;
export const junkArtist = (artist: string): boolean =>
  !!artist && (JUNK_ARTIST_WORD.test(artist) || JUNK_ARTIST_TAIL.test(artist)
    || JUNK_ARTIST_DECADE.test(artist) || JUNK_ARTIST_FANCY.test(artist)
    || JUNK_ARTIST_GENERIC.test(artist));

// Titolo da compilation/upload, non da canzone: "Best of X", "Vol. 2",
// "1 Hour", "Playlist", emoji, separatore '|', "Chill Guitar Music".
// Fuori 'mix' prima di ')' (i remix "(Extended Mix)" sono legittimi),
// 'the best' (Tina Turner), 'relax' (Frankie Goes to Hollywood), 'sleep'/
// 'work out'/'love song' singolare (canzoni vere).
const JUNK_TITLE_RE = /(megamix|nonstop|non-stop|\bplaylist|\bbest of\b|\bgreatest hits\b|\btop \d+|\bvol\.?\s*\d|\bcompilation|\bmedley|\bmashup|\bfull album|\bhits\b|\bclassics\b|\bcollection|\bmost famous\b|\bmasterpieces?\b|\d+\s*(min\b|minutes?\b|hours?\b|h\b)|\||spotify|\bworkout\b|\bgym\b|\bfitness\b|\btraining\b|le più belle|per l'anima|\btribute\b|karaoke|relaxing|relaxation|relaj\w*|\blounge\b|\bchill\b|\blo-?fi\b|\bacoustic guitar\b|slowed|\bsped\b|nightcore|reverb|\b8d\b|bass boosted|oldies|aesthetic|\basmr\b|love songs|\bblues music\b|\bjazz (lounge|music|bar)\b|\bsoul music\b|\bcountry (hits|music)\b|\bparty mix\b|\bdj set\b|\bmixed by\b|\bretrowave\b|\bsynthwave\b|\bphonk\b|\bmix\b(?!\s*\))|\[.*(mix|playlist|compilation|hour|beats|lo-?fi|chill).*\]|motivational|musica per|canzoni italiane)/i;
// Emoji nel titolo = upload YouTube, non metadato di canzone (regex a parte:
// la classe \u{…} esige il flag /u).
const JUNK_TITLE_FANCY = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
// Oltre ~13 min non è quasi mai una canzone: i megamix vanno 30min-3h.
const JUNK_MAX_S = 800;
export const junkTitle = (title: string): boolean => !!title && (JUNK_TITLE_RE.test(title) || JUNK_TITLE_FANCY.test(title));
export const junkTrack = (artist: string, title: string, durationS?: number): boolean =>
  junkArtist(artist) || junkTitle(title) || (durationS != null && durationS > JUNK_MAX_S);
