// Payload del QR di pairing mostrato sul PC (Impostazioni → Telefono).
//
// Il QR codifica `http://<ip>:<porta>/?pair=<codice>` — un codice MONOUSO con
// TTL (mintato da pairing:code, vedi pairing.ts): il codice condiviso admin
// non esce più dal PC nemmeno dentro il QR. Il formato resta doppio-uso:
// scansionato con la fotocamera di sistema apre il browser del telefono (il
// server riscatta il codice e serve la UI), scansionato dallo scanner in-app
// dà base+codice per l'APK. `?token=…` resta accettato per i QR/stampa legacy
// (è il codice admin → upgrade immediato a device token).
// Accettato anche `mh://pair?h=host:port&p=…` (&t= per il token legacy).
//
// Ritorna null su qualunque input non riconducibile al nostro formato:
// lo scanner chiama questa funzione a ogni frame e NON deve mai produrre
// un pairing verso URL arbitrari (un QR qualsiasi puntato davanti alla
// camera non deve poter dirottare il dispositivo su un server estraneo).
export interface PairPayload { base: string; pair?: string; token?: string }

export function parsePairPayload(text: string): PairPayload | null {
  const s = (text ?? '').trim();
  if (!s || s.length > 400) return null;
  try {
    const u = new URL(s);
    const validCode = (t: string | null): t is string => !!t && /^[\w-]{4,80}$/.test(t);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const pair = u.searchParams.get('pair') ?? u.searchParams.get('p');
      const token = u.searchParams.get('token') ?? u.searchParams.get('t');
      if (!u.hostname || (!validCode(pair) && !validCode(token))) return null;
      return { base: u.origin, pair: pair ?? undefined, token: token ?? undefined };
    }
    if (u.protocol === 'mh:' || u.protocol === 'masterhype:') {
      const h = u.searchParams.get('h') ?? '';
      const pair = u.searchParams.get('p') ?? u.searchParams.get('pair');
      const token = u.searchParams.get('t') ?? u.searchParams.get('token');
      // host: solo caratteri da indirizzo (niente javascript:/path strani)
      if (!/^[\w.-]+(:\d{1,5})?$/.test(h) || (!validCode(pair) && !validCode(token))) return null;
      return { base: `http://${h}`, pair: pair ?? undefined, token: token ?? undefined };
    }
    return null;
  } catch { return null; }
}
