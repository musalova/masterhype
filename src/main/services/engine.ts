// Motore dei gusti — segnali "di seconda generazione" oltre al semplice
// play/like/skip:
//   • completamento: quanto del brano è stato davvero ascoltato (0..1)
//   • contesto: ora del giorno / giorno della settimana degli ascolti
//   • co-occorrenza: artisti ascoltati nella stessa sessione si rafforzano
//   • affinità per brano: saldo pesato con decadimento (play/complete/skip/hide)
//   • esplorazione ε: quota di artisti fuori dal profilo per non chiudere la bolla
//   • cold start: onboarding "scegli gli artisti che ami" → semina il profilo
//   • uso funzioni: quali schermate/azioni vengono davvero usate (solo locale)
// Tutto per utente (`u`), tutto in SQLite, niente esce dal PC.

import { getDb } from '../db';
import { bumpTaste, tasteProfile } from './library';
import { normText, LISTEN_COMPLETE_WEIGHT, listenClass } from '../../shared/taste';
import { charts } from './ytmusic';
import { deezerChart, deezerArtistTop } from './sources';
import { getSettings } from '../settings';
import type { OnboardArtist } from '../../shared/types';

const SESSION_MS = 30 * 60_000; // due play entro 30' = stessa sessione
const HALF_LIFE_DAYS = 40;

// Normalizzatore artisti = shared/taste.normText (unica fonte: stessa funzione
// usata dal renderer — parità strutturale, non più copia a mano).
export const normArtist = normText;

// ---- Contesto + co-occorrenza: chiamati da library.recordEvent ----

// Arricchisce l'ultimo evento inserito con ora/giorno e, se è un play,
// aggiorna la co-occorrenza con il play precedente della stessa sessione.
export function enrichEvent(eventId: number | bigint, type: string, artist: string | null, u: number): void {
  try {
    const db = getDb();
    const d = new Date();
    db.prepare('UPDATE events SET hour=?, dow=? WHERE id=?').run(d.getHours(), d.getDay(), eventId);
    if (type !== 'play' || !artist) return;
    const prev = db.prepare(
      `SELECT artist FROM events WHERE user_id=? AND type='play' AND id<? AND ts>? AND artist IS NOT NULL
       ORDER BY id DESC LIMIT 1`).get(u, eventId, Date.now() - SESSION_MS) as { artist: string } | undefined;
    if (!prev) return;
    const a = normArtist(prev.artist), b = normArtist(artist);
    if (!a || !b || a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    db.prepare(`INSERT INTO artist_cooc (user_id,a,b,n,ts) VALUES (?,?,?,1,?)
      ON CONFLICT(user_id,a,b) DO UPDATE SET n=n+1, ts=excluded.ts`).run(u, x, y, Date.now());
  } catch { /* segnali accessori: mai rompere il flusso */ }
}

// ---- Completamento: quanto del brano è stato ascoltato davvero ----

export interface ListenReport {
  trackId?: number; videoId?: string; artist: string; title?: string; thumbnail?: string;
  playedS: number; durationS?: number;
}

// Regola: ≥85% (o ≥4 min) = 'complete' (+1.2 sull'artista, come un mezzo like).
// 25-85% = 'partial' (registrato, peso 0: informa l'affinità del brano).
// <25% con meno di 30s = già coperto dallo 'skip' del renderer: qui si ignora.
export function recordListen(r: ListenReport, u: number): void {
  const dur = r.durationS && r.durationS > 0 ? r.durationS : undefined;
  const type = listenClass(r.playedS, dur);
  if (!type) return;
  const db = getDb();
  const res = db.prepare(
    `INSERT INTO events (track_id, artist, type, title, video_id, thumbnail, ts, user_id, played_s, duration_s)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(r.trackId ?? null, r.artist, type, r.title ?? null, r.videoId ?? null, r.thumbnail ?? null, Date.now(), u,
      Math.round(r.playedS), dur ?? null);
  enrichEvent(res.lastInsertRowid, type, r.artist, u);
  if (type === 'complete') bumpTaste('artist', r.artist, LISTEN_COMPLETE_WEIGHT, u);
}

// ---- Contesto orario: cosa ascolti di solito a quest'ora ----

// Ritorna artista → boost (0..1) per la fascia oraria corrente (±2h, stesso
// tipo di giorno feriale/festivo). Serve per ordinare la "stazione per te".
export function contextBoosts(u: number, now = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const h = now.getHours();
    const weekend = now.getDay() === 0 || now.getDay() === 6;
    const rows = getDb().prepare(
      `SELECT artist, COUNT(*) n FROM events
       WHERE user_id=? AND type IN ('play','complete') AND artist IS NOT NULL AND hour IS NOT NULL
         AND ((hour - ? + 24) % 24 <= 2 OR (? - hour + 24) % 24 <= 2)
         AND (CASE WHEN dow IN (0,6) THEN 1 ELSE 0 END) = ?
         AND ts > ?
       GROUP BY artist ORDER BY n DESC LIMIT 30`)
      .all(u, h, h, weekend ? 1 : 0, Date.now() - 120 * 86_400_000) as { artist: string; n: number }[];
    const max = rows[0]?.n ?? 0;
    if (max < 2) return out; // troppo pochi dati: nessun bias
    for (const r of rows) out.set(normArtist(r.artist), r.n / max);
  } catch { /* colonne assenti su DB vecchissimo */ }
  return out;
}

// ---- Co-occorrenza: artisti che ascolti insieme ----

export function cooccurring(u: number, artist: string, limit = 6): string[] {
  const a = normArtist(artist);
  if (!a) return [];
  try {
    const rows = getDb().prepare(
      `SELECT CASE WHEN a=? THEN b ELSE a END AS other, n FROM artist_cooc
       WHERE user_id=? AND (a=? OR b=?) ORDER BY n DESC, ts DESC LIMIT ?`).all(a, u, a, a, limit) as { other: string }[];
    return rows.map((r) => r.other);
  } catch { return []; }
}

// ---- Affinità per brano: saldo con decadimento ----

// key "artista|titolo" normalizzato → punteggio. Positivo = brano che ami,
// negativo = che salti. Usato per ordinare preferiti/top e per l'assistente.
export function trackAffinity(u: number): Map<string, number> {
  const out = new Map<string, number>();
  const W: Record<string, number> = { play: 0.6, complete: 1.4, partial: 0.2, like: 3, skip: -1.5, hide: -3, unlike: -3, burn: 1.5, download: 1 };
  try {
    const rows = getDb().prepare(
      `SELECT artist, title, type, ts FROM events
       WHERE user_id=? AND title IS NOT NULL AND artist IS NOT NULL AND ts > ?`)
      .all(u, Date.now() - 365 * 86_400_000) as { artist: string; title: string; type: string; ts: number }[];
    const now = Date.now();
    for (const r of rows) {
      const w = W[r.type];
      if (!w) continue;
      const days = (now - r.ts) / 86_400_000;
      const k = `${normArtist(r.artist)}|${normArtist(r.title)}`;
      out.set(k, (out.get(k) ?? 0) + w * Math.pow(0.5, days / HALF_LIFE_DAYS));
    }
  } catch { /* */ }
  return out;
}

// ---- Esplorazione: artisti fuori dal profilo ma vicini ai suoi generi ----

// Ritorna il set di artisti "noti" (peso > 0) per capire cosa è esplorazione.
export function knownArtists(u: number): Set<string> {
  return new Set(tasteProfile(u, 'artist').filter((r) => r.weight > 0).map((r) => r.value));
}

// ---- Cold start: onboarding ----

// Artisti proposti al primo avvio: dalle classifiche (YT Music + Deezer) del
// paese, dedup, con thumbnail. Il profilo nuovo sceglie quelli che ama.
export async function onboardArtists(): Promise<OnboardArtist[]> {
  const [yt, dz] = await Promise.all([
    charts(getSettings().country).catch(() => []),
    deezerChart().catch(() => [] as { title: string; artist: string; cover?: string }[]),
  ]);
  const seen = new Map<string, OnboardArtist>();
  for (const t of yt) {
    const k = normArtist(t.artist);
    if (k && !seen.has(k)) seen.set(k, { name: t.artist, thumbnail: t.thumbnail });
  }
  for (const t of dz) {
    const k = normArtist(t.artist);
    if (k && !seen.has(k)) seen.set(k, { name: t.artist, thumbnail: t.cover });
  }
  // Classici sempre presenti (l'onboarding non deve essere solo "chart di oggi")
  for (const name of ['Vasco Rossi', 'Ligabue', 'Coldplay', 'Queen', 'Eminem', 'Tiziano Ferro', 'Pink Floyd', 'Rihanna', 'Måneskin', 'Lucio Battisti', 'Daft Punk', 'Adele']) {
    const k = normArtist(name);
    if (!seen.has(k)) seen.set(k, { name });
  }
  return [...seen.values()].slice(0, 36);
}

// Semina il profilo: ogni artista scelto pesa come 2 like. I tag Last.fm
// arrivano tramite bumpTaste→recordEvent no: qui bumpiamo direttamente e
// lasciamo che gli ascolti successivi affinino i tag.
export async function seedTaste(names: string[], u: number): Promise<void> {
  for (const n of names.slice(0, 20)) {
    if (!n?.trim()) continue;
    bumpTaste('artist', n, 6, u);
    // Un top brano per artista come "like remoto" no — solo profilo. Ma i tag
    // dell'artista arricchiscono i generi (import dinamico: evita il ciclo).
    void import('./sources').then((s) => s.lastfmArtistTags(n))
      .then((tags) => { for (const t of tags.slice(0, 3)) bumpTaste('tag', t, 2, u); })
      .catch(() => {});
  }
  // Riscalda la cache dei top brani: la prima "stazione per te" è istantanea
  void Promise.all(names.slice(0, 6).map((n) => deezerArtistTop(n).catch(() => []))).catch(() => {});
}

// ---- Uso funzioni (solo locale): cosa viene usato davvero ----

export function trackUsage(name: string, u: number): void {
  if (!name || name.length > 60) return;
  try {
    getDb().prepare(`INSERT INTO usage (user_id,name,n,ts) VALUES (?,?,1,?)
      ON CONFLICT(user_id,name) DO UPDATE SET n=n+1, ts=excluded.ts`).run(u, name, Date.now());
  } catch { /* */ }
}

export function usageStats(): { name: string; n: number }[] {
  try {
    return getDb().prepare('SELECT name, SUM(n) n FROM usage GROUP BY name ORDER BY n DESC LIMIT 40').all() as { name: string; n: number }[];
  } catch { return []; }
}
