import { getDb } from '../db';
import { getSettings } from '../settings';
import { charts } from './ytmusic';
import { deezerChart, lastfmChart, spotifyNewReleases, lastfmArtistTags } from './sources';
import { tasteProfile } from './library';
import { mapLimit } from './util';
import type { TrendItem } from '../../shared/types';

// Trend Radar: scansiona chart multi-fonte, deduplica, marca "nicchia".

const CACHE_MS = 6 * 3600_000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9àèéìòù ]/gi, '').trim();

export async function getTrends(u: number, refresh = false): Promise<TrendItem[]> {
  const db = getDb();
  const src = `merged:u${u}`; // il flag "nicchia" dipende dai gusti → cache per utente
  const cached = db.prepare('SELECT payload, fetched_at FROM trend_cache WHERE source=?').get(src) as
    { payload: string; fetched_at: number } | undefined;
  if (!refresh && cached && Date.now() - cached.fetched_at < CACHE_MS) {
    try {
      const parsed = JSON.parse(cached.payload);
      if (Array.isArray(parsed)) return parsed as TrendItem[];
    } catch { /* cache corrotta: ricalcola */ }
  }
  const items = await scanTrends(u);
  db.prepare('INSERT OR REPLACE INTO trend_cache (source,payload,fetched_at) VALUES (?,?,?)')
    .run(src, JSON.stringify(items), Date.now());
  return items;
}

export async function scanTrends(u: number): Promise<TrendItem[]> {
  const country = getSettings().country || 'IT';
  const [yt, dz, lf, sp] = await Promise.allSettled([
    charts(country),
    deezerChart(),
    lastfmChart(),
    spotifyNewReleases(),
  ]);

  const acc = new Map<string, TrendItem & { ranks: number[] }>();
  const push = (title: string, artist: string, rank: number, source: string, extra?: { videoId?: string; thumbnail?: string }) => {
    if (!title || !artist) return;
    const k = `${norm(artist)}|${norm(title)}`;
    const e = acc.get(k);
    if (e) {
      if (!e.sources.includes(source)) e.sources.push(source);
      e.ranks.push(rank);
      e.rank = Math.min(e.rank, rank);
      if (!e.videoId && extra?.videoId) e.videoId = extra.videoId;
      if (!e.thumbnail && extra?.thumbnail) e.thumbnail = extra.thumbnail;
    } else {
      acc.set(k, { title, artist, rank, ranks: [rank], sources: [source], niche: false, ...extra });
    }
  };

  if (yt.status === 'fulfilled') yt.value.forEach((t, i) => push(t.title, t.artist, i + 1, 'ytmusic', { videoId: t.videoId, thumbnail: t.thumbnail }));
  if (dz.status === 'fulfilled') dz.value.forEach((t) => push(t.title, t.artist, t.rank, 'deezer', { thumbnail: t.cover }));
  if (lf.status === 'fulfilled') lf.value.forEach((t) => push(t.title, t.artist, t.rank, 'lastfm'));
  if (sp.status === 'fulfilled') sp.value.forEach((t, i) => push(t.title, t.artist, i + 1, 'spotify'));

  // Nicchia: compare in una sola fonte OPPURE bassa popolarità ma affine ai gusti
  const topArtists = new Set(tasteProfile(u, 'artist').slice(0, 10).map((r) => r.value));
  const items = [...acc.values()];
  await mapLimit(items.slice(0, 60), 6, async (it) => {
    if (it.sources.length === 1 && it.rank > 20) it.niche = true;
    else if (topArtists.has(norm(it.artist))) {
      const tags = await lastfmArtistTags(it.artist);
      if (!it.sources.includes('ytmusic') || it.rank > 40) it.niche = tags.length > 0;
    }
  });

  return items
    .sort((a, b) => (a.rank - b.rank) || (b.sources.length - a.sources.length))
    .map(({ ranks: _r, ...rest }) => rest);
}
