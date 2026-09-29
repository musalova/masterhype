import { api } from './api';
import { myUserId, isOnline, callRemote } from './remote';
import { IPC } from '../../shared/types';
import type { TrackRef, Playlist, Settings, RemoteLike, LibraryTrack } from '../../shared/types';
import { compactPlOps, overlayPlaylists, pendingTasteResetTs } from './localData';

// Stessa forma del payload di library.listen nel preload
export interface ListenReport {
  trackId?: number; videoId?: string; artist: string; title?: string;
  thumbnail?: string; playedS: number; durationS?: number;
}

// Azioni compiute mentre il PC è spento: restano in coda sul telefono e
// vengono spedite al PC appena torna raggiungibile (drain in onReconnected).
// L'utente non perde like/ascolti fatti fuori casa — come Spotify.
// Multi-utente: ogni profilo ha la sua coda (:u<id>) — un like offline del
// profilo A non finirà mai nel profilo gusti del profilo B.

const K_LIKES = () => `mh-pending-likes:u${myUserId()}`;      // like su videoId (brani non in libreria)
const K_LIB_LIKES = () => `mh-pending-liblikes:u${myUserId()}`; // like su tracce libreria (per id)
const K_EVENTS = () => `mh-pending-events:u${myUserId()}`;    // eventi play/skip/hide con metadati
const K_PICKS = () => `mh-pending-picks:u${myUserId()}`;      // scelte di ricerca (apprendimento)
const K_LISTEN = () => `mh-pending-listen:u${myUserId()}`;    // completamenti ascolto >=30s (gusti v2)
const K_PL = () => `mh-pending-pl:u${myUserId()}`;            // operazioni playlist (FIFO, ordinate)
const K_DL = () => `mh-pending-dl:u${myUserId()}`;            // download da fare sul PC
const K_SET = () => `mh-pending-settings:u${myUserId()}`;     // patch settings (single-slot merged)

interface PendingLike { videoId: string; liked: boolean; t: TrackRef; ts: number; __tries?: number }
interface PendingLibLike { id: number; liked: boolean; ts: number; __tries?: number }
interface PendingEvent { trackId?: number; artist: string; title: string; videoId: string; thumbnail?: string; type: 'play' | 'skip' | 'hide'; ts: number; __tries?: number }
interface PendingPick { query: string; t: TrackRef; ts: number; __tries?: number }
interface PendingListen extends ListenReport { ts: number; __tries?: number }
export interface PendingPlOp {
  // 'createWith' = crea la playlist sul server e ci aggiunge le tracce: serve
  // per operazioni composte offline (es. "salva scaletta CD") dove l'id della
  // playlist non esiste ancora — create+add separati non sarebbero risolvibili.
  // 'libRemove'/'libRestore' = soft-delete/undo della libreria fatto offline.
  // 'tasteSeed' = seed artisti dell'onboarding (args: [string[]]);
  // 'tasteReset' = azzeramento profilo gusti (args: []).
  // 'addRef' = aggiunge un TrackRef qualsiasi (args: [plId, TrackRef]): il PC
  // lo scarica se manca e lo mette in playlist al termine.
  // 'reorder' = asserzione convergente dell'ordine (args: [plId, number[]]):
  // la accoda il drain dopo i 'move' — l'ultimo device che drena vince
  // l'ordinamento, niente mix di spostamenti relativi interallacciati.
  // Playlist create offline hanno id TEMPORANEO negativo (create: args[2],
  // createWith: args[3]); il drain lo rimappa sull'id vero (mh-pl-idmap).
  op: 'create' | 'remove' | 'rename' | 'add' | 'addRef' | 'removeTrack' | 'move' | 'createWith' | 'libRemove' | 'libRestore' | 'tasteSeed' | 'tasteReset' | 'reorder';
  args: unknown[]; ts: number; __tries?: number;
}
interface PendingDl { t: TrackRef; ts: number; __tries?: number }
interface PendingSettings { patch: Partial<Settings>; ts: number; __tries?: number }

function read<T>(k: string): T[] {
  try { return JSON.parse(localStorage.getItem(k) ?? '[]') as T[]; } catch { return []; }
}
function write(k: string, v: unknown[]): void {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ }
}

// Migrazione code legacy (senza namespace utente) → profilo attuale.
try {
  const legacy: [string, string][] = [
    ['mh-pending-likes', K_LIKES()], ['mh-pending-liblikes', K_LIB_LIKES()],
    ['mh-pending-events', K_EVENTS()], ['mh-pending-picks', K_PICKS()],
    ['mh-pending-listen', K_LISTEN()], ['mh-pending-pl', K_PL()],
    ['mh-pending-dl', K_DL()], ['mh-pending-settings', K_SET()],
  ];
  for (const [from, to] of legacy) {
    const v = localStorage.getItem(from);
    if (v != null) {
      if (localStorage.getItem(to) == null) localStorage.setItem(to, v);
      localStorage.removeItem(from);
    }
  }
} catch { /* */ }

// Tetti delle code: in modalità senza PC sono la memoria di settimane di uso
// (gusti locali, recenti, playlist) → abbastanza ampi da non perdere storia,
// ma entro la quota localStorage (~5MB: ~300B per voce).
const CAP = { likes: 1500, events: 1500, picks: 300, listen: 800, pl: 1500, dl: 300 } as const;

export function queueRemoteLike(t: TrackRef, liked: boolean): void {
  const l = read<PendingLike>(K_LIKES()).filter((x) => x.videoId !== t.videoId); // last-write wins
  l.push({ videoId: t.videoId, liked, t, ts: Date.now() });
  write(K_LIKES(), l.slice(-CAP.likes));
}

export function queueLibLike(id: number, liked: boolean): void {
  // Gli id sintetici (<=0, brani "solo telefono") violano la FK di track_likes
  // sul server: il drain non li evaderebbe MAI → veleno in coda. Non entrano.
  if (!(id > 0)) return;
  const l = read<PendingLibLike>(K_LIB_LIKES()).filter((x) => x.id !== id);
  l.push({ id, liked, ts: Date.now() });
  write(K_LIB_LIKES(), l.slice(-CAP.likes));
}

export function queueEvent(e: Omit<PendingEvent, 'ts'>): void {
  const l = read<PendingEvent>(K_EVENTS());
  l.push({ ...e, ts: Date.now() });
  write(K_EVENTS(), l.slice(-CAP.events));
}

// Apprendimento ricerca: la scelta fatta offline vale la prossima query uguale
export function queueSearchPick(query: string, t: TrackRef): void {
  const l = read<PendingPick>(K_PICKS()).filter((x) => x.query !== query); // last-write per query
  l.push({ query, t, ts: Date.now() });
  write(K_PICKS(), l.slice(-CAP.picks));
}

// Completamento ascolto (motore gusti v2): signal accessorio ma non va perso
export function queueListen(r: ListenReport): void {
  const l = read<PendingListen>(K_LISTEN());
  l.push({ ...r, ts: Date.now() });
  write(K_LISTEN(), l.slice(-CAP.listen));
}

// Operazioni playlist fatte offline: riprodotte IN ORDINE al reconnect e,
// nel frattempo, materializzate da localData.overlayPlaylists (la playlist
// esiste SUBITO sul telefono). Compattate a ogni scrittura: in modalità
// senza PC la coda è il database delle playlist e non deve crescere a vuoto.
let tempSeq = 0;
export function newTempPlaylistId(): number {
  // Negativo e unico anche con più creazioni nello stesso millisecondo
  return -(Date.now() * 10 + (tempSeq++ % 10));
}
export function queuePlOp(op: PendingPlOp['op'], args: unknown[]): void {
  const l = read<PendingPlOp>(K_PL());
  l.push({ op, args, ts: Date.now() });
  write(K_PL(), compactPlOps(l).slice(-CAP.pl));
}

// Mappa id temporanei (playlist create offline) → id veri del PC: persiste tra
// un drain e l'altro, così un'op fallita dopo la create si risolve al giro dopo.
const K_IDMAP = () => `mh-pl-idmap:u${myUserId()}`;
function idMap(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(K_IDMAP()) ?? '{}') as Record<string, number>; } catch { return {}; }
}
function setIdMap(tmp: number, real: number): void {
  const m = idMap(); m[String(tmp)] = real;
  // Tetto: gli id temporanei vecchi non servono più dopo qualche drain
  const entries = Object.entries(m).slice(-200);
  try { localStorage.setItem(K_IDMAP(), JSON.stringify(Object.fromEntries(entries))); } catch { /* */ }
}
// Id playlist per il server: la mappa vale anche per id POSITIVI — una
// playlist eliminata sul PC e resuscitata dal drain rimappa vecchio→nuovo id.
// Temporaneo non ancora creato → null (op da ritentare dopo la create).
function realPl(id: unknown): number | null {
  const n = Number(id);
  const r = idMap()[String(n)];
  if (r > 0) return r;
  return n > 0 ? n : null;
}

// Download sul PC chiesti a PC spento: riproposti all'accensione. Dedup per
// videoId (last-write wins) — ri-accodare lo stesso brano non duplica il job.
export function queueDownload(t: TrackRef): void {
  if (!t.videoId) return;
  const l = read<PendingDl>(K_DL()).filter((x) => x.t.videoId !== t.videoId);
  l.push({ t, ts: Date.now() });
  write(K_DL(), l.slice(-CAP.dl));
}

// Patch delle impostazioni fatta offline: single-slot, le chiavi scritte per
// ultime vincono. Al reconnect si applica il merge una volta sola.
export function queueSettings(patch: Partial<Settings>): void {
  const cur = read<PendingSettings>(K_SET());
  const merged = cur.reduce((acc, x) => ({ ...acc, ...x.patch }), {} as Partial<Settings>);
  write(K_SET(), [{ patch: { ...merged, ...patch }, ts: Date.now() }]);
}

// Download in attesa del PC — mostrati nella schermata Download come
// "in coda locale", distinguibili dai job veri del downloader.
export function pendingDownloads(): TrackRef[] {
  return read<PendingDl>(K_DL()).map((x) => x.t);
}

// Like pendenti applicati alla vista: il cuore resta acceso anche prima del drain
export function pendingLikesMap(): Map<string, boolean> {
  return new Map(read<PendingLike>(K_LIKES()).map((x) => [x.videoId, x.liked]));
}

// I like accodati offline come righe RemoteLike (metadati dal TrackRef salvato):
// senza PC la lista "Brani che ti piacciono" li deve vedere comunque — non solo
// il cuoricino, anche le raccolte che leggono remoteLikeList.
export function pendingLikeEntries(): RemoteLike[] {
  return read<PendingLike>(K_LIKES())
    .filter((x) => x.liked)
    .map((x) => ({ videoId: x.videoId, title: x.t.title, artist: x.t.artist, thumbnail: x.t.thumbnail, durationS: x.t.durationS, ts: x.ts }));
}

export function pendingCount(): number {
  return read<unknown>(K_LIKES()).length + read<unknown>(K_LIB_LIKES()).length + read<unknown>(K_EVENTS()).length
    + read<unknown>(K_PICKS()).length + read<unknown>(K_LISTEN()).length + read<unknown>(K_PL()).length
    + read<unknown>(K_DL()).length + read<unknown>(K_SET()).length;
}

// Drain di UNA coda con merge anti-race: elementi accodati DURANTE le await
// (utente che mette like mentre il drain gira) non devono essere sovrascritti.
// "Fresh" = tutto ciò che in storage non è IDENTICO a un item originale:
// copre sia gli item nuovi sia le sostituzioni last-write-wins sulla stessa
// chiave (ts diverso → non è il payload originale → va preservato). Un item
// fallito la cui chiave è stata riscritta nel frattempo NON torna in coda:
// la scrittura più recente vince.
// Errore definitivo di un'op: drop immediato e conteggiato — un retry non può
// riuscire (es. playlist eliminata sul PC e non presente nemmeno in cache).
class DeadOp extends Error {}

async function drainOne<T>(
  key: string, same: (a: T, b: T) => boolean,
  send: (x: T) => Promise<void>, skip?: (x: T) => boolean,
  defer?: (x: T) => boolean,
): Promise<{ sent: number; dropped: number }> {
  const orig = read<T>(key);
  const failed: T[] = [];
  let sent = 0, dropped = 0;
  let netDown = false;
  for (const item of orig) {
    // PC caduto durante il drain: il resto resta in coda INTATTO (niente
    // tentativo consumato) — un fallimento di rete non dice nulla sull'item,
    // e 3 boot a PC spento non devono buttare like/playlist dell'utente.
    if (netDown) { failed.push(item); continue; }
    if (skip?.(item)) continue; // item legacy invaldabile: scartato, non ritentato
    // Fase non matura (segnali post-reset in attesa del tasteReset): resta in
    // coda senza consumare un tentativo — sarà mandato nella seconda passata.
    if (defer?.(item)) { failed.push(item); continue; }
    try { await send(item); sent++; }
    catch (e) {
      if (e instanceof DeadOp) { dropped++; continue; }
      if (!isOnline()) { netDown = true; failed.push(item); continue; }
      // Max 3 drain per item: un'op diventata invalida (playlist eliminata,
      // traccia sparita) non deve restare in coda a ritentare per sempre —
      // ma non sparisce più in silenzio: 'dropped' finisce nel toast.
      const tries = (item as { __tries?: number }).__tries ?? 0;
      if (tries < 2) failed.push({ ...(item as object), __tries: tries + 1 } as T);
      else dropped++;
    }
  }
  const origJson = new Set(orig.map((x) => JSON.stringify(x)));
  const fresh = read<T>(key).filter((x) => !origJson.has(JSON.stringify(x)));
  write(key, [...failed.filter((f) => !fresh.some((x) => same(x, f))), ...fresh]);
  return { sent, dropped };
}

// pl:addRef su un PC di versione precedente (canale assente → 'metodo
// sconosciuto'): ripiego sull'add per id se il brano è già in libreria.
async function addRefCompat(plId: number, t: TrackRef): Promise<void> {
  try { await callRemote(IPC.playlistAddRef, plId, t); }
  catch (e) {
    if (!/metodo sconosciuto/.test(e instanceof Error ? e.message : String(e))) throw e;
    const lib = (await callRemote<LibraryTrack[]>(IPC.libraryList)).find((x) => x.videoId === t.videoId);
    if (!lib) throw e;
    await callRemote(IPC.playlistAdd, plId, lib.id);
  }
}

// Playlist eliminata sul PC ma modificata qui mentre era offline: si ricrea
// con lo stato che l'utente VEDE (overlay = cache + intera coda — intento
// completo, non lo stato PC pre-delete). Le op successive rimappano via idMap
// e si riapplicano idempotenti (add=INSERT OR IGNORE, removeTrack=no-op,
// move→converge il reorder finale). L'utente la rivede e può ri-eliminarla:
// meglio di una modifica persa in silenzio.
async function resurrectPlaylist(qid: number): Promise<number | null> {
  const cur = overlayPlaylists(read<Playlist>(`mh-pl-cache:u${myUserId()}`)).find((p) => p.id === qid);
  if (!cur?.name) return null; // mai vista da questo telefono: non ricreabile
  const created = await callRemote<Playlist>(IPC.playlistCreate, cur.name, cur.kind);
  setIdMap(qid, created.id);
  for (const t of cur.tracks ?? []) {
    try {
      if (t.id > 0) await callRemote(IPC.playlistAdd, created.id, t.id);
      else if (t.videoId) await addRefCompat(created.id, t);
    } catch { /* traccia sparita o rete: best effort, le op in coda colmano */ }
  }
  return created.id;
}

export interface DrainResult { sent: number; dropped: number; resurrected: number }

let draining = false;
// Resoconto del drain (toast: consegnate, playlist ripristinate, op perse).
export async function drainPending(): Promise<DrainResult> {
  if (draining) return { sent: 0, dropped: 0, resurrected: 0 };
  draining = true;
  const out: DrainResult = { sent: 0, dropped: 0, resurrected: 0 };
  const add = (r: { sent: number; dropped: number }) => { out.sent += r.sent; out.dropped += r.dropped; };
  try {
    // tasteReset vive nella coda PL: i segnali che toccano i gusti si drenano
    // in due fasi sul suo confine temporale — quelli accodati PRIMA partono
    // subito (il reset li azzererà, come da semantica) e quelli DOPO solo a
    // reset applicato, o verrebbero cancellati pur essendo successivi.
    // Item senza ts (legacy) contano come post-reset: sopravvivere a un reset
    // fallito è meno grave che perdere un segnale legittimo.
    const resetTs = pendingTasteResetTs();
    const isPreReset = (x: { ts?: number }) => resetTs > 0 && (x.ts ?? 0) > 0 && (x.ts ?? 0) <= resetTs;
    const tasteSignals = async (defer?: (x: { ts?: number }) => boolean) => {
      add(await drainOne<PendingLike>(K_LIKES(),
        (a, b) => a.videoId === b.videoId,
        (l) => api().library.likeRemote(l.t, l.liked).then(() => {}), undefined, defer));

      add(await drainOne<PendingLibLike>(K_LIB_LIKES(),
        (a, b) => a.id === b.id,
        (l) => api().library.like(l.id, l.liked).then(() => {}),
        (l) => !(l.id > 0), defer)); // id sintetici: mai evadibili

      add(await drainOne<PendingEvent>(K_EVENTS(),
        (a, b) => a.ts === b.ts && a.videoId === b.videoId,
        ({ ts: _ts, __tries: _x, ...e }) => api().library.remoteEvent({
          ...e,
          // trackId sintetici/negativi (brani solo-telefono): evento per videoId
          trackId: e.trackId != null && e.trackId > 0 ? e.trackId : undefined,
        }).then(() => {}), undefined, defer));

      add(await drainOne<PendingListen>(K_LISTEN(),
        (a, b) => a.ts === b.ts && a.videoId === b.videoId,
        ({ ts: _ts, __tries: _tries, ...r }) => api().library.listen(r).then(() => {}), undefined, defer));
    };
    await tasteSignals(resetTs > 0 ? (x) => !isPreReset(x) : undefined);

    add(await drainOne<PendingPick>(K_PICKS(),
      (a, b) => a.query === b.query,
      (p) => api().yt.searchPick(p.query, p.t).then(() => {})));

    // Playlist con 'move' consegnati: a fine passata si accoda un 'reorder'
    // convergente. Lo snapshot dell'ordine va preso AL SEND del move: la coda
    // contiene ancora tutte le op (incluse le successive) → overlay = intento
    // finale completo. A drain finito l'overlay ha già perso le op drenate.
    // Resurrezioni già tentate: se anche la playlist nuova sparisce mid-drain
    // l'op muore, non loop.
    const intentOrder = new Map<number, number[]>();
    const resurrectTried = new Set<number>();
    const snapshotOrder = (qid: number): void => {
      const cur = overlayPlaylists(read<Playlist>(`mh-pl-cache:u${myUserId()}`)).find((p) => p.id === qid);
      if (cur) intentOrder.set(qid, (cur.tracks ?? []).map((t) => t.id).filter((id) => id > 0));
    };
    const applyPlOp = async (o: PendingPlOp, allowResurrect = true): Promise<void> => {
      const a = o.args;
      // Playlist create offline: id temporaneo → id vero (o attesa della create)
      const pl = (): number => {
        const r = realPl(a[0]);
        if (r == null) throw new Error('playlist non ancora creata sul PC');
        return r;
      };
      // callRemote: niente local-first qui — se la rete cade l'op resta in coda
      try {
        switch (o.op) {
          case 'create': {
            const p = await callRemote<Playlist>(IPC.playlistCreate, a[0], a[1]);
            if (Number(a[2]) < 0) setIdMap(Number(a[2]), p.id);
            break;
          }
          case 'remove': await callRemote(IPC.playlistDelete, pl()); break;
          case 'rename': await callRemote(IPC.playlistRename, pl(), a[1]); break;
          case 'add': await callRemote(IPC.playlistAdd, pl(), a[1]); break;
          case 'addRef': await addRefCompat(pl(), a[1] as TrackRef); break;
          case 'removeTrack': await callRemote(IPC.playlistRemove, pl(), a[1]); break;
          case 'move': await callRemote(IPC.playlistMove, pl(), a[1], a[2]); snapshotOrder(Number(a[0])); break;
          case 'reorder': await callRemote(IPC.playlistReorder, pl(), a[1]); break;
          case 'createWith': {
            const p = await callRemote<Playlist>(IPC.playlistCreate, a[0], a[1]);
            if (Number(a[3]) < 0) setIdMap(Number(a[3]), p.id);
            for (const id of a[2] as number[]) await callRemote(IPC.playlistAdd, p.id, id);
            break;
          }
          case 'libRemove': await api().library.remove(a[0] as number); break;
          case 'libRestore': await api().library.restore(a[0] as number); break;
          case 'tasteSeed': await api().library.tasteSeed(a[0] as string[]); break;
          case 'tasteReset': await api().library.tasteReset(); break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/playlist non trovata/i.test(msg)) throw e;
        // La playlist è stata eliminata sul PC mentre il telefono era offline.
        const qid = Number(a[0]);
        if (!Number.isFinite(qid) || qid === 0) throw e;
        // Rimozione/spostamento su playlist sparita: lo stato finale è già
        // quello voluto → successo idempotente, niente retry né perdita.
        if (o.op === 'remove' || o.op === 'removeTrack' || o.op === 'move' || o.op === 'reorder') return;
        // rename/add/addRef portano un intento reale → resurrezione + retry.
        if (!allowResurrect || resurrectTried.has(qid)) throw new DeadOp(msg);
        resurrectTried.add(qid);
        const nid = await resurrectPlaylist(qid);
        if (nid == null) throw new DeadOp(msg);
        out.resurrected++;
        return applyPlOp(o, false);
      }
    };
    // Ops con id non risolvibili (tracce "solo telefono" per id, argomenti
    // corrotti): scartate una volta, non veleno permanente. Gli id playlist
    // NEGATIVI sono validi (temporanei): li risolve il drain o li ritenta.
    const invalidPlOp = (o: PendingPlOp): boolean => {
      if (o.op === 'tasteReset') return false;
      if (o.op === 'create') return typeof o.args[0] !== 'string' || !o.args[0];
      if (o.op === 'reorder')
        return !Array.isArray(o.args[1]) || !Number.isFinite(Number(o.args[0])) || Number(o.args[0]) === 0;
      if (o.op === 'tasteSeed')
        return !Array.isArray(o.args[0]) || !(o.args[0] as string[]).length
          || (o.args[0] as unknown[]).some((n) => typeof n !== 'string' || !n);
      if (o.op === 'createWith')
        return typeof o.args[0] !== 'string' || !o.args[0]
          || !Array.isArray(o.args[2]) || !(o.args[2] as number[]).length
          || (o.args[2] as number[]).some((id) => !(Number(id) > 0));
      if (o.op === 'libRemove' || o.op === 'libRestore') return !(Number(o.args[0]) > 0);
      if (!Number.isFinite(Number(o.args[0])) || Number(o.args[0]) === 0) return true;
      if (o.op === 'addRef') return !(o.args[1] as TrackRef | undefined)?.videoId;
      if ((o.op === 'add' || o.op === 'removeTrack' || o.op === 'move') && !(Number(o.args[1]) > 0)) return true;
      return false;
    };
    const samePlOp = (a: PendingPlOp, b: PendingPlOp) => a.ts === b.ts;
    add(await drainOne<PendingPlOp>(K_PL(), samePlOp, applyPlOp, invalidPlOp));

    // Loop bounded: la passata extra può consegnare anche op fresche accodate
    // DURANTE il drain (utente che riordina mentre sincronizza) — se portano
    // move, quella playlist vuole un altro reorder. Al più 3 giri.
    for (let rounds = 0; rounds < 3 && intentOrder.size && isOnline(); rounds++) {
      const batch = [...intentOrder];
      intentOrder.clear();
      for (const [qid, ids] of batch) queuePlOp('reorder', [qid, ids]);
      // I reorder accodati partono subito; a rete caduta restano in coda e
      // valgono al prossimo drain (id QUEUE: l'overlay li applica in locale).
      add(await drainOne<PendingPlOp>(K_PL(), samePlOp, applyPlOp, invalidPlOp));
    }

    if (resetTs > 0) await tasteSignals((x) => isPreReset(x));

    add(await drainOne<PendingDl>(K_DL(),
      (a, b) => a.t.videoId === b.t.videoId,
      (d) => api().downloads.enqueue(d.t).then(() => {}),
      (d) => !d.t.videoId));

    add(await drainOne<PendingSettings>(K_SET(),
      (a, b) => a.ts === b.ts,
      (s) => api().settings.set(s.patch).then(() => {})));
  } finally { draining = false; }
  return out;
}
