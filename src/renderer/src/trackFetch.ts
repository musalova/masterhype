// Helper blob/durata per i download sul telefono — estratti da store.ts.

// Durata di un file audio locale (metadata del browser), undefined se illeggibile
export function audioDuration(f: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(f);
    const a = new Audio();
    const done = (d?: number) => { URL.revokeObjectURL(url); resolve(d && Number.isFinite(d) ? Math.round(d) : undefined); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(a.duration);
    a.onerror = () => done();
    setTimeout(() => done(), 5000);
    a.src = url;
  });
}

// Download progressivo dal PC con deadline: 20s agli header, 30s senza byte
// sul corpo → abort (il chiamante ripiega sullo stream diretto). Progresso
// 0..1 via onPct quando Content-Length è noto.
export async function fetchTrackBlob(url: string, onPct?: (pct: number) => void): Promise<Blob | null> {
  const ctl = new AbortController();
  const dead = (ms: number) => setTimeout(() => ctl.abort(), ms);
  let timer = dead(20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal }).catch(() => null);
    if (!res?.ok || !res.body) return null;
    const total = Number(res.headers.get('content-length') ?? 0);
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      clearTimeout(timer); timer = dead(30_000); // stallo: byte fermi → abort
      chunks.push(value);
      got += value.length;
      if (total > 0 && onPct) onPct(Math.min(1, got / total));
    }
    // Corpo troncato (TCP RST a metà download): MAI persistere un blob
    // "completo" fasullo — null → il chiamante ripiega sullo stream diretto.
    if (!got || (total > 0 && got !== total)) return null;
    return new Blob(chunks, { type: res.headers.get('content-type') ?? 'audio/mpeg' });
  } catch { return null; } // abort/rete: il chiamante decide il fallback
  finally { clearTimeout(timer); }
}
