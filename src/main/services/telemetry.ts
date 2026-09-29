// Telemetria e auto-miglioramento: raccoglie gli errori osservati in
// riproduzione/download/ricerca, marca gli stream difettosi e impara
// quali risultati l'utente sceglie davvero per una data query.
// Tutto in SQLite (vedi db.ts) — niente esce dalla macchina.

import { getDb } from '../db';
import type { IssueStats } from '../../shared/types';
import { normText } from '../../shared/taste';

const MAX_ISSUES = 600; // rotazione: oltre questa soglia si buttano i più vecchi

export const normKey = normText;

export interface IssueData {
  message?: string;
  artist?: string;
  title?: string;
  videoId?: string;
  query?: string;
  healed?: boolean;
}

export function report(kind: string, d: IssueData = {}): void {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO issues (ts, kind, message, artist, title, video_id, query, healed)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(Date.now(), kind, d.message?.slice(0, 400) ?? null, d.artist ?? null,
        d.title ?? null, d.videoId ?? null, d.query ?? null, d.healed ? 1 : 0);
    // Rotazione: tieni gli ultimi MAX_ISSUES
    db.prepare(`DELETE FROM issues WHERE id < (SELECT MIN(id) FROM (SELECT id FROM issues ORDER BY id DESC LIMIT ?))`)
      .run(MAX_ISSUES);
  } catch { /* la telemetria non deve mai rompere il flusso principale */ }
}

// ---- Stream difettosi: videoId che non risolvono o muoiono in play ----

export function markBadStream(videoId: string, artist?: string, title?: string): void {
  try {
    getDb().prepare(`INSERT INTO bad_streams (video_id, artist, title, ts) VALUES (?,?,?,?)
                     ON CONFLICT(video_id) DO UPDATE SET ts=excluded.ts`)
      .run(videoId, artist ?? null, title ?? null, Date.now());
  } catch { /* */ }
}

export function isBadStream(videoId: string): boolean {
  try {
    return !!getDb().prepare('SELECT 1 FROM bad_streams WHERE video_id=?').get(videoId);
  } catch { return false; }
}

export function badIds(): Set<string> {
  try {
    return new Set((getDb().prepare('SELECT video_id FROM bad_streams').all() as { video_id: string }[]).map((r) => r.video_id));
  } catch { return new Set(); }
}

// ---- Apprendimento ricerca: per ogni query ricorda i brani scelti ----
// Le scelte sono gusto personale: la chiave è 'u<userId>|<query normalizzata>'

export function recordPick(query: string, videoId: string, artist?: string, title?: string, u = 1): void {
  const key = normKey(query);
  if (!key || !videoId) return;
  try {
    getDb().prepare(`INSERT INTO search_picks (query_key, video_id, artist, title, picks, ts)
                     VALUES (?,?,?,?,1,?)
                     ON CONFLICT(query_key, video_id) DO UPDATE SET picks=picks+1, ts=excluded.ts`)
      .run(`u${u}|${key}`, videoId, artist ?? null, title ?? null, Date.now());
  } catch { /* */ }
}

// videoId da boostare in testa ai risultati per questa query (più scelti prima)
export function pickBoosts(query: string, u = 1): string[] {
  const key = normKey(query);
  if (!key) return [];
  try {
    return (getDb().prepare(`SELECT video_id FROM search_picks WHERE query_key=? ORDER BY picks DESC, ts DESC LIMIT 4`)
      .all(`u${u}|${key}`) as { video_id: string }[]).map((r) => r.video_id);
  } catch { return []; }
}

// ---- Metriche cascata stream per client Innertube (dal campo) ----
// I dispositivi remoti mandano un campione per tentativo-client; aggregando
// si vede quale client sta morendo (okRate crollato) senza leggere i log.

export interface ClientSampleIn { client?: string; ms?: number; ok?: boolean; device?: string }
const MAX_CLIENT_ROWS = 5000;

export function recordClientStats(rows: ClientSampleIn[]): void {
  if (!Array.isArray(rows) || !rows.length) return;
  try {
    const db = getDb();
    const ins = db.prepare('INSERT INTO client_stats (ts, client, ms, ok, device) VALUES (?,?,?,?,?)');
    const now = Date.now();
    for (const r of rows.slice(0, 400)) {
      const client = String(r.client ?? '').slice(0, 40);
      const ms = Number(r.ms);
      if (!client || !Number.isFinite(ms) || ms < 0 || ms > 600_000) continue;
      ins.run(now, client, Math.round(ms), r.ok ? 1 : 0, String(r.device ?? '').slice(0, 20) || null);
    }
    // Rotazione: tieni gli ultimi MAX_CLIENT_ROWS
    db.prepare(`DELETE FROM client_stats WHERE id < (SELECT MIN(id) FROM (SELECT id FROM client_stats ORDER BY id DESC LIMIT ?))`)
      .run(MAX_CLIENT_ROWS);
  } catch { /* telemetria best-effort */ }
}

// Aggregato ultimi 7 giorni per client: quanti tentativi, % successo, latenza media.
export function clientStats(): NonNullable<IssueStats['clients']> {
  try {
    const rows = getDb().prepare(
      `SELECT client, COUNT(*) n, AVG(ok) okRate, AVG(ms) avgMs,
              GROUP_CONCAT(DISTINCT device) devices
       FROM client_stats WHERE ts > ? GROUP BY client ORDER BY n DESC`)
      .all(Date.now() - 7 * 86400_000) as { client: string; n: number; okRate: number; avgMs: number; devices: string | null }[];
    return rows.map((r) => ({
      client: r.client, n: r.n,
      okRate: Math.round(r.okRate * 100) / 100,
      avgMs: Math.round(r.avgMs),
      devices: String(r.devices ?? '').split(',').filter(Boolean),
    }));
  } catch { return []; }
}

// ---- Diagnostica aggregata per la schermata Impostazioni ----

export function stats(): IssueStats {
  const db = getDb();
  const byKind: Record<string, number> = {};
  try {
    for (const r of db.prepare('SELECT kind, COUNT(*) c FROM issues GROUP BY kind').all() as { kind: string; c: number }[])
      byKind[r.kind] = r.c;
  } catch { /* */ }
  const healed = (db.prepare('SELECT COUNT(*) c FROM issues WHERE healed=1').get() as { c: number }).c;
  const bad = (db.prepare('SELECT COUNT(*) c FROM bad_streams').get() as { c: number }).c;
  const picks = (db.prepare('SELECT COUNT(*) c FROM search_picks').get() as { c: number }).c;
  const topFailing = db.prepare(
    `SELECT COALESCE(artist,'?') artist, COALESCE(title,'?') title, COUNT(*) c
     FROM issues WHERE kind IN ('play','stream-dead','download') AND (artist IS NOT NULL OR title IS NOT NULL)
     GROUP BY artist, title ORDER BY c DESC LIMIT 8`).all() as { artist: string; title: string; c: number }[];
  const recent = db.prepare(
    `SELECT ts, kind, message, artist, title, video_id as videoId, query, healed
     FROM issues ORDER BY id DESC LIMIT 12`).all() as unknown as IssueStats['recent'];
  return { byKind, healed, bad, picks, topFailing, recent, clients: clientStats() };
}

export function clearAll(): void {
  const db = getDb();
  db.exec('DELETE FROM issues; DELETE FROM bad_streams; DELETE FROM search_picks;');
}

// Report testuale esportabile (condividibile per capire dove concentrarci)
export function exportReport(): string {
  const s = stats();
  const lines: string[] = [
    `MasterHype — report diagnostica ${new Date().toLocaleString('it-IT')}`,
    '',
    `Riparazioni automatiche: ${s.healed} · stream difettosi noti: ${s.bad} · scelte imparate: ${s.picks}`,
    '',
    'Errori per tipo:',
    ...Object.entries(s.byKind).map(([k, c]) => `  ${k}: ${c}`),
    '',
    'Brani con più problemi:',
    ...s.topFailing.map((t) => `  ${t.c}× ${t.artist} — ${t.title}`),
    '',
    'Client stream (7 giorni, dai dispositivi):',
    ...(s.clients?.length
      ? s.clients.map((c) => `  ${c.client}: ${Math.round(c.okRate * 100)}% ok · ~${c.avgMs}ms · ${c.n} tentativi${c.devices.length ? ` · [${c.devices.join(',')}]` : ''}`)
      : ['  (nessun dato)']),
    '',
    'Ultimi eventi:',
    ...s.recent.map((r) => `  [${new Date(r.ts).toLocaleString('it-IT')}] ${r.kind}${r.healed ? ' (riparato)' : ''} — ${[r.artist, r.title].filter(Boolean).join(' — ') || r.query || ''} ${r.message ?? ''}`.trim()),
    '',
    'Funzioni usate (tutti i profili, solo conteggi — nessun dato personale):',
    ...usageLines(),
  ];
  return lines.join('\n');
}

function usageLines(): string[] {
  try {
    const rows = getDb().prepare('SELECT name, SUM(n) n FROM usage GROUP BY name ORDER BY n DESC LIMIT 40').all() as { name: string; n: number }[];
    return rows.length ? rows.map((r) => `  ${r.n}× ${r.name}`) : ['  (ancora nessun dato)'];
  } catch { return []; }
}
