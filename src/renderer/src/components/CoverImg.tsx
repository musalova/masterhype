import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Disc3 } from 'lucide-react';
import { useApp } from '../store';
import { phoneCoverUrl, phoneVidId } from '../phoneLocal';

// Varianti note dei thumbnail YouTube, dalla più alta alla più sicura:
// maxresdefault/sddefault spesso non esistono per i video musicali (404),
// mqdefault/default ci sono praticamente sempre. Se `src` non è ytimg ma
// c'è un videoId, le varianti si ricostruiscono lo stesso dal videoId.
function ytFallbacks(src: string | null | undefined, videoId?: string): string[] {
  const cur = /\/(maxresdefault|sddefault|hqdefault|mqdefault|default)(?:\.|_live\.)/.exec(src ?? '')?.[1];
  const vid = /i\.ytimg\.com\/vi(?:_webp)?\/([^/?]+)\//.exec(src ?? '')?.[1]
    ?? (videoId && !videoId.includes(':') ? videoId : undefined);
  if (!vid) return [];
  return ['hqdefault', 'mqdefault', 'default']
    .filter((n) => n !== cur)
    .map((n) => `https://i.ytimg.com/vi/${vid}/${n}.jpg`);
}

// Copertina con fallback a catena: mai l'icona "immagine rotta" del browser.
//   1. cover salvata sul telefono (IndexedDB) — funziona anche a PC spento
//      e senza rete, batte sempre l'URL remota;
//   2. src com'è (media:// sul desktop, /media/… o ytimg su remoto);
//   3. varianti i.ytimg.com a risoluzione più bassa (o ricostruite dal
//      videoId — utile anche quando src è un /media/cover morto);
//   4. icona di ripiego (disc), o null se `icon={null}`.
export function CoverImg({ src, trackId, videoId, alt = '', className = '', icon, eager }: {
  src?: string | null;
  trackId?: number | null;   // id libreria o sintetico: cover telefono se presente
  videoId?: string;          // alimenta la catena di fallback i.ytimg.com
  alt?: string;
  className?: string;
  icon?: ReactNode | null;   // fallback finale (default: Disc3); null = niente
  eager?: boolean;           // copertina "hero": niente lazy loading
}) {
  const pid = trackId ?? (videoId ? phoneVidId(videoId) : null);
  const onPhone = useApp((s) => (pid != null && s.phoneIds.has(pid)));
  const [phoneCover, setPhoneCover] = useState<string | null>(null);
  useEffect(() => {
    if (!onPhone || pid == null) { setPhoneCover(null); return; }
    let live = true;
    void phoneCoverUrl(pid).then((u) => { if (live) setPhoneCover(u); });
    return () => { live = false; };
  }, [onPhone, pid]);

  const [step, setStep] = useState(0);
  useEffect(() => setStep(0), [src, videoId, phoneCover]);

  const chain = [...new Set([phoneCover, src, ...ytFallbacks(src, videoId)].filter((x): x is string => !!x))];
  const cur = chain[step];
  if (!cur) {
    if (icon === null) return null;
    return <div className="w-full h-full flex items-center justify-center">{icon ?? <Disc3 size={18} className="text-dim" />}</div>;
  }
  return (
    <img src={cur} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async"
      className={className} onError={() => setStep((s) => s + 1)} />
  );
}
