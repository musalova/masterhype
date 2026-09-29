// Interpretazione del prompt libero dell'assistente ("compila una tracklist
// per CD"): parole italiane → vibe e tag Last.fm, connettori → nomi artista.
// Estratto da recommend.ts — funzioni pure sul testo, niente stato.

import { normText as norm } from '../../shared/taste';

// Parole italiane → vibe: usate per interpretare il prompt libero
const VIBE_WORDS: [RegExp, string][] = [
  [/(energia|energico|carica|carico|gasat|sping|pump|tirat)/i, 'energico'],
  [/(chill|relax|rilass|tranquill|calm|domenica mattina|lettura)/i, 'chill'],
  [/(viaggio|guida|autostrada|macchina|strada|road|traffico|lavoro)/i, 'viaggio'],
  [/(festa|party|ballare|dance|discoteca|sabato sera|serat)/i, 'festa'],
  [/(anni ?'?90|novanta|nostalgi)/i, 'anni90'],
  [/(allenamento|palestra|corsa|workout|gym|correre|sport)/i, 'allenamento'],
  [/(romantic|amore|cena|dwe|cuore|dedic)/i, 'romantico'],
  [/(sera|notte|tramonto|dopo cena|lounge|jazz|aperitivo)/i, 'sera'],
  [/(italian[aoi]|cantautor|nostra|italia)/i, 'italiana'],
  [/(estate|estivo|mare|spiaggia|sole|agosto|vacanz)/i, 'estate'],
];

// Parole → tag Last.fm aggiuntivi (decenni, generi, scene)
const PROMPT_TAGS: [RegExp, string[]][] = [
  [/anni ?'?80|ottanta/i, ['80s']],
  [/anni ?'?90|novanta/i, ['90s']],
  [/anni ?2000|duemila/i, ['2000s']],
  [/anni ?'?60|sessanta/i, ['60s']],
  [/anni ?'?70|settanta/i, ['70s']],
  [/\brock\b/i, ['rock']],
  [/\bpop\b/i, ['pop']],
  [/\brap|hip ?hop|trap\b/i, ['hip hop', 'rap', 'trap']],
  [/\bindie\b/i, ['indie']],
  [/\bmetal/i, ['metal']],
  [/\bjazz\b/i, ['jazz']],
  [/\bblues\b/i, ['blues']],
  [/\breggae/i, ['reggae']],
  [/\bclassica|orchestra/i, ['classical']],
  [/\btechno|elettronica|elettronico/i, ['electronic', 'techno']],
  [/\blatin[ao]?|reggaeton/i, ['latin', 'reggaeton']],
  [/\bpunk\b/i, ['punk']],
  [/\bsoul|r&b|rnb\b/i, ['soul', 'rnb']],
  [/\bfolk\b|cantautor/i, ['folk', 'singer-songwriter']],
];

// Estrae nomi artista dopo connettori: "con X e Y", "tipo X", "senza X"
function extractNames(text: string, connectors: RegExp): string[] {
  const out: string[] = [];
  const m = new RegExp(connectors.source, 'gi');
  let r: RegExpExecArray | null;
  while ((r = m.exec(text))) {
    // prendi fino a virgola/punto/altro connettore
    const frag = text.slice(r.index + r[0].length).split(/[,;.!]|(?:\s+(?:ma|per|con|senza|tipo|come|stile|alla|che)\b)/i)[0];
    for (const part of frag.split(/\s+e\s+|\s*,\s*/i)) {
      const name = part.trim().replace(/^(l'|il |la |i |gli |le )/i, '');
      if (name.length >= 2 && name.length <= 40 && /^[a-zàèéìòù' 0-9&.-]+$/i.test(name)) out.push(name.trim());
    }
  }
  return [...new Set(out)];
}

// Parole da non trattare come artisti (connettori ambigui: "con calma", "senza fretta")
const NOT_ARTIST = new Set([
  'calma', 'fretta', 'ritmo', 'energia', 'voce', 'bassi', 'amore', 'cuore', 'anima', 'voglia',
  'me', 'te', 'tutto', 'niente', 'musica', 'canzoni', 'brani', 'lente', 'veloci', 'parole',
  'testo', 'testi', 'senso', 'modo', 'tempo', 'cura', 'attenzione', 'entusiasmo', 'grinta',
]);

export function parsePrompt(text: string): { vibe?: string; extraTags: string[]; seeds: string[]; excluded: string[] } {
  const extraTags: string[] = [];
  let vibe: string | undefined;
  for (const [re, v] of VIBE_WORDS) if (re.test(text)) { vibe = v; break; }
  for (const [re, tags] of PROMPT_TAGS) if (re.test(text)) extraTags.push(...tags);
  const seeds = extractNames(text, /(?:\bcon\b|\btipo\b|\bcome\b|\bstile\b|\balla\b)/i)
    .filter((n) => !NOT_ARTIST.has(norm(n)));
  const excluded = extractNames(text, /(?:\bsenza\b|\bno\b|\bescludi\b|\btranne\b|\bniente\b|\bodio\b|\bbasta\b)/i)
    .filter((n) => !NOT_ARTIST.has(norm(n)));
  // Un nome non può essere sia seed che escluso: vince l'esclusione (la parola "senza" è più esplicita)
  const exN = new Set(excluded.map(norm));
  return { vibe, extraTags: [...new Set(extraTags)], seeds: seeds.filter((s) => !exN.has(norm(s))), excluded };
}
