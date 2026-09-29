import type { AppStats, LibraryTrack, Playlist, TrackRef } from '../../shared/types';
import { signalWeight, listenTasteWeight, trackBaseKey } from '../../shared/taste';
import { myUserId } from './remote';
import { phoneIndex, phoneVidId } from './phoneLocal';
import type { PendingPlOp } from './pendingSync';

// Dati "locali" del telefono quando il PC non c'è (spento o modalità senza PC):
// playlist materializzate da cache + coda operazioni, profilo gusti, ascoltati
// di recente e statistiche ricostruiti dai segnali accodati. Stessa UI e
// stesse funzioni del desktop — la verità torna al PC al primo drain.

const PL_KEY = () => `mh-pending-pl:u${myUserId()}`;
const readJson = <T,>(k: string, fb: T): T => {
  try { const s = localStorage.getItem(k); return s ? (JSON.parse(s) as T) : fb; } catch { return fb; }
};

// Libreria nota al telefono: ultima copia del PC + righe "solo telefono"
function knownLibrary(): LibraryTrack[] {
  const lib = readJson<LibraryTrack[]>(`mh-lib-cache:u${myUserId()}`, []);
  const have = new Set(lib.map((t) => t.id));
  const ix = phoneIndex();
  for (const [k, m] of Object.entries(ix)) {
    const id = Number(k);
    if (!have.has(id) && m) lib.push({ ...m, id, phoneOnly: id <= 0 || undefined });
  }
  return Array.isArray(lib) ? lib : [];
}

// TrackRef qualsiasi → riga di playlist (LibraryTrack): se è in libreria si
// usa quella, altrimenti id sintetico del videoId (stesso id dei download sul
// telefono → se il brano è stato scaricato suona offline dalla riga).
export function refToRow(t: TrackRef, lib: LibraryTrack[] = knownLibrary()): LibraryTrack {
  const hit = (t.id != null ? lib.find((x) => x.id === t.id) : undefined) ?? lib.find((x) => x.videoId === t.videoId);
  if (hit) return hit;
  return {
    ...t, id: t.id ?? phoneVidId(t.videoId), filePath: t.filePath ?? '', addedAt: Date.now(),
    playCount: 0, liked: false, phoneOnly: true,
  } as LibraryTrack;
}

// ---- Compattazione della coda playlist ----
// In modalità senza PC la coda è il "database" delle playlist: senza
// compattazione crescerebbe a ogni gesto. Regole (tutte senza perdita):
//  · rimuovere una playlist creata offline cancella lei e tutte le sue op
//  · rename di una playlist creata offline → nome direttamente nella create
//  · removeTrack che annulla un add/addRef precedente sulla stessa coppia → via entrambi
//  · rename ripetuti sulla stessa playlist → vale l'ultimo
export function compactPlOps(ops: PendingPlOp[]): PendingPlOp[] {
  const out: PendingPlOp[] = [];
  const trackKey = (o: PendingPlOp): string | null => {
    if (o.op === 'add' || o.op === 'removeTrack') return `${o.args[0]}|${o.args[1]}`;
    if (o.op === 'addRef') { const r = o.args[1] as TrackRef | undefined; return r ? `${o.args[0]}|${r.id ?? phoneVidId(r.videoId)}` : null; }
    return null;
  };
  for (const o of ops) {
    const pl = Number(o.args[0]);
    if (o.op === 'remove' && pl < 0) {
      const created = out.some((x) => x.op === 'create' && Number(x.args[2]) === pl);
      if (created) {
        for (let i = out.length - 1; i >= 0; i--) {
          const x = out[i];
          if ((x.op === 'create' && Number(x.args[2]) === pl) || (x.op !== 'create' && x.op !== 'createWith' && Number(x.args[0]) === pl)) out.splice(i, 1);
        }
        continue;
      }
    }
    if (o.op === 'rename') {
      const c = out.find((x) => x.op === 'create' && Number(x.args[2]) === pl);
      if (c) { c.args = [o.args[1], c.args[1], c.args[2]]; continue; }
      const prev = out.findIndex((x) => x.op === 'rename' && Number(x.args[0]) === pl);
      if (prev >= 0) out.splice(prev, 1);
    }
    if (o.op === 'removeTrack') {
      const k = trackKey(o);
      const i = out.findIndex((x) => (x.op === 'add' || x.op === 'addRef') && trackKey(x) === k);
      if (i >= 0) { out.splice(i, 1); continue; }
    }
    out.push({ ...o, args: [...o.args] });
  }
  return out;
}

// ---- Playlist offline: cache del PC + coda operazioni applicata in ordine ----
export function overlayPlaylists(base: Playlist[] | null | undefined): Playlist[] {
  const lib = knownLibrary();
  const byId = (id: number) => lib.find((t) => t.id === id);
  const pls: Playlist[] = (Array.isArray(base) ? base : []).map((p) => ({ ...p, tracks: [...(p.tracks ?? [])] }));
  const find = (id: unknown) => pls.find((p) => p.id === Number(id));
  for (const o of readJson<PendingPlOp[]>(PL_KEY(), [])) {
    const a = o.args;
    switch (o.op) {
      case 'create':
        pls.unshift({ id: Number(a[2]) || -o.ts, name: String(a[0]), kind: (a[1] as Playlist['kind']) ?? 'lista', createdAt: o.ts, tracks: [] });
        break;
      case 'createWith':
        pls.unshift({
          id: Number(a[3]) || -o.ts, name: String(a[0]), kind: (a[1] as Playlist['kind']) ?? 'lista', createdAt: o.ts,
          tracks: ((a[2] as number[]) ?? []).map(byId).filter((t): t is LibraryTrack => !!t),
        });
        break;
      case 'remove': { const i = pls.findIndex((p) => p.id === Number(a[0])); if (i >= 0) pls.splice(i, 1); break; }
      case 'rename': { const p = find(a[0]); if (p) p.name = String(a[1]); break; }
      case 'add': {
        const p = find(a[0]); const t = byId(Number(a[1]));
        if (p && t && !p.tracks!.some((x) => x.id === t.id)) p.tracks!.push(t);
        break;
      }
      case 'addRef': {
        const p = find(a[0]); const r = a[1] as TrackRef | undefined;
        if (p && r?.videoId) {
          const row = refToRow(r, lib);
          if (!p.tracks!.some((x) => x.id === row.id || x.videoId === row.videoId)) p.tracks!.push(row);
        }
        break;
      }
      case 'removeTrack': { const p = find(a[0]); if (p) p.tracks = p.tracks!.filter((t) => t.id !== Number(a[1])); break; }
      case 'move': {
        const p = find(a[0]); if (!p) break;
        const i = p.tracks!.findIndex((t) => t.id === Number(a[1])); const j = i + Number(a[2]);
        if (i >= 0 && j >= 0 && j < p.tracks!.length) [p.tracks![i], p.tracks![j]] = [p.tracks![j], p.tracks![i]];
        break;
      }
      // Riordino convergente accodato dal drain (op 'reorder'): l'ordine citato
      // vince, le righe non citate restano in coda — stessa semantica del server.
      case 'reorder': {
        const p = find(a[0]); if (!p) break;
        const rank = new Map((a[1] as number[]).map((id, i) => [Number(id), i]));
        const cited = p.tracks!.filter((t) => rank.has(t.id)).sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);
        p.tracks = [...cited, ...p.tracks!.filter((t) => !rank.has(t.id))];
        break;
      }
      default: break;
    }
  }
  return pls;
}

// ---- Segnali locali (coda eventi/ascolti/like) → gusti, recenti, stats ----
// Pesi e chiavi: shared/taste.ts — la stessa tabella di recordEvent (PC).
interface Ev { artist?: string; title?: string; videoId?: string; thumbnail?: string; type?: string; ts?: number; trackId?: number; playedS?: number; durationS?: number }

type TasteRow = { kind: string; value: string; weight: number };

// Azzeramento gusti fatto offline (op 'tasteReset' in coda): i segnali
// precedenti non contano più, come sul PC dopo il drain.
export function pendingTasteResetTs(): number {
  let ts = 0;
  for (const o of readJson<PendingPlOp[]>(PL_KEY(), [])) if (o.op === 'tasteReset' && o.ts > ts) ts = o.ts;
  return ts;
}

// signalsOnly: solo i segnali accodati (da sommare ai gusti già calcolati dal
// PC); altrimenti anche like/ascolti della libreria nota (modalità senza PC).
export function localTaste(kind?: string, signalsOnly = false): TasteRow[] {
  const u = myUserId();
  const resetTs = pendingTasteResetTs();
  const w = new Map<string, number>();
  const bump = (artist: string | undefined, d: number) => {
    const a = artist?.trim().toLowerCase();
    if (a && !a.startsWith('[object')) w.set(a, (w.get(a) ?? 0) + d);
  };
  const after = (x: { ts?: number }) => (x.ts ?? 0) > resetTs;
  for (const e of readJson<Ev[]>(`mh-pending-events:u${u}`, []).filter(after)) bump(e.artist, signalWeight(e.type ?? ''));
  // Completamenti: stessa regola del PC — +1.2 solo se ≥85% (o ≥4 min), i
  // parziali contano come evento ma non muovono i gusti.
  for (const e of readJson<Ev[]>(`mh-pending-listen:u${u}`, []).filter(after)) bump(e.artist, listenTasteWeight(e.playedS ?? 0, e.durationS));
  for (const l of readJson<{ liked: boolean; t?: TrackRef; ts?: number }[]>(`mh-pending-likes:u${u}`, []).filter(after)) bump(l.t?.artist, signalWeight(l.liked ? 'like' : 'unlike'));
  const lib = signalsOnly || resetTs ? [] : knownLibrary();
  for (const t of lib) { if (t.liked) bump(t.artist, signalWeight('like')); if (t.playCount) bump(t.artist, Math.min(5, t.playCount * 0.3)); }
  const artists = [...w.entries()].map(([value, weight]) => ({ kind: 'artist', value, weight }));
  const g = new Map<string, number>();
  for (const t of lib) if (t.genre) g.set(t.genre.toLowerCase(), (g.get(t.genre.toLowerCase()) ?? 0) + 1 + (t.liked ? 2 : 0));
  const genres = [...g.entries()].map(([value, weight]) => ({ kind: 'genre', value, weight }));
  const all = [...artists, ...genres].sort((a, b) => b.weight - a.weight);
  return kind ? all.filter((x) => x.kind === kind) : all;
}

// Gusti del PC (ultima copia) + segnali raccolti offline dopo quella copia.
export function mergeTaste(base: TasteRow[] | null | undefined, kind?: string): TasteRow[] {
  const reset = pendingTasteResetTs() > 0;
  const m = new Map<string, TasteRow>();
  for (const r of reset ? [] : base ?? []) m.set(`${r.kind}|${r.value}`, { ...r });
  for (const r of localTaste(kind, true)) {
    const k = `${r.kind}|${r.value}`;
    const cur = m.get(k);
    if (cur) cur.weight += r.weight; else m.set(k, { ...r });
  }
  return [...m.values()].sort((a, b) => b.weight - a.weight);
}

// Chiavi "artista|titolo-base" dei brani con segnale negativo offline
// (skip/hide/unlike): le stazioni locali li escludono come fa il PC col
// filtro cinico — uno skip "Song" copre anche "Song (Remastered)".
// La chiave è shared/taste.trackBaseKey — identica al server.
export { trackBaseKey };

export function localSkipKeys(): Set<string> {
  const u = myUserId();
  const resetTs = pendingTasteResetTs();
  const out = new Set<string>();
  for (const e of readJson<Ev[]>(`mh-pending-events:u${u}`, [])) {
    if ((e.type === 'skip' || e.type === 'hide') && (e.ts ?? 0) > resetTs && e.artist && e.title) {
      out.add(trackBaseKey(e.artist, e.title));
    }
  }
  for (const l of readJson<{ liked: boolean; t?: TrackRef; ts?: number }[]>(`mh-pending-likes:u${u}`, [])) {
    if (!l.liked && l.t && (l.ts ?? 0) > resetTs) out.add(trackBaseKey(l.t.artist, l.t.title));
  }
  return out;
}

export function localRecent(limit = 10): TrackRef[] {
  const out: TrackRef[] = [];
  const seen = new Set<string>();
  const evs = readJson<Ev[]>(`mh-pending-events:u${myUserId()}`, []).filter((e) => e.type === 'play' && e.videoId);
  for (const e of evs.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
    if (seen.has(e.videoId!)) continue;
    seen.add(e.videoId!);
    out.push({ videoId: e.videoId!, title: e.title ?? '', artist: e.artist ?? '', thumbnail: e.thumbnail, source: 'ytmusic' });
    if (out.length >= limit) break;
  }
  return out;
}

export function localStats(base?: AppStats | null): AppStats {
  const lib = knownLibrary();
  const taste = localTaste();
  const pls = overlayPlaylists(readJson<Playlist[]>(`mh-pl-cache:u${myUserId()}`, []));
  return {
    trackCount: base?.trackCount ?? lib.length,
    totalMinutes: base?.totalMinutes ?? Math.round(lib.reduce((s, t) => s + (t.durationS ?? 0), 0) / 60),
    playlistCount: pls.length,
    burnedCount: base?.burnedCount ?? 0,
    topArtists: base?.topArtists?.length ? base.topArtists : taste.filter((t) => t.kind === 'artist' && t.weight > 0).slice(0, 8).map((t) => ({ artist: t.value, weight: t.weight })),
    topGenres: base?.topGenres?.length ? base.topGenres : taste.filter((t) => t.kind === 'genre').slice(0, 8).map((t) => ({ genre: t.value, weight: t.weight })),
  };
}

// ---- Backup del dispositivo (modalità senza PC / trasloco su un telefono nuovo) ----
// Tutto lo stato locale mh-* tranne il pairing (token del PC) e le cache
// rigenerabili pesanti. I brani scaricati (IndexedDB) non entrano: pesano GB —
// l'indice sì, e le righe senza file vengono ripulite al primo reconcile.
const SKIP_KEYS = /^(mh-remote-conf|mh-was-online|mh-update-|mh-home-cache|mh-trends-cache|mh-auto-cache)/;
export interface DeviceBackup { app: 'masterhype-device'; version: 1; exportedAt: number; user: number; keys: Record<string, string> }
export function exportDeviceBackup(): DeviceBackup {
  const keys: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('mh-') || SKIP_KEYS.test(k)) continue;
    const v = localStorage.getItem(k);
    if (v != null) keys[k] = v;
  }
  return { app: 'masterhype-device', version: 1, exportedAt: Date.now(), user: myUserId(), keys };
}
// Merge conservativo: le chiavi già presenti sul dispositivo vincono, tranne le
// code pending che vengono UNITE (sono segnali, non stato: duplicarle è innocuo
// grazie al dedup del drain, perderle no).
export function importDeviceBackup(raw: unknown): number {
  const b = raw as Partial<DeviceBackup>;
  if (b?.app !== 'masterhype-device' || !b.keys || typeof b.keys !== 'object') throw new Error('backup del telefono non valido');
  let n = 0;
  for (const [k, v] of Object.entries(b.keys)) {
    if (!k.startsWith('mh-') || SKIP_KEYS.test(k) || typeof v !== 'string') continue;
    const cur = localStorage.getItem(k);
    if (cur == null) { localStorage.setItem(k, v); n++; continue; }
    if (k.startsWith('mh-pending-')) {
      try {
        const a = JSON.parse(cur) as unknown[]; const bb = JSON.parse(v) as unknown[];
        if (Array.isArray(a) && Array.isArray(bb)) {
          const seen = new Set(a.map((x) => JSON.stringify(x)));
          const merged = [...bb.filter((x) => !seen.has(JSON.stringify(x))), ...a];
          localStorage.setItem(k, JSON.stringify(merged)); n++;
        }
      } catch { /* chiave corrotta: si tiene quella del dispositivo */ }
    }
  }
  return n;
}
