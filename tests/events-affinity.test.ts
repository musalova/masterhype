import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DB reale su cartella temporanea (pattern di devices.test.ts): la cecità di
// trackAffinity si vede solo leggendo la tabella events scritta davvero.
const TMP = mkdtempSync(join(tmpdir(), 'mh-affinity-'));
vi.mock('electron', () => ({ app: { getPath: () => TMP } }));

import { initDb, getDb } from '../src/main/db';
import { initSettings } from '../src/main/settings';
import { addTrack, setLiked, likeRemote, recordBurn, recordEvent } from '../src/main/services/library';
import { trackAffinity } from '../src/main/services/engine';
import { normText as norm } from '../src/shared/taste';

// Regressione (bug reale): setLiked/likeRemote/recordBurn/download passavano
// meta=undefined a recordEvent → events.title NULL → trackAffinity scartava
// la riga (WHERE title IS NOT NULL). I locali guarivano solo al backfill del
// boot; i like REMOTI (track_id NULL) restavano ciechi per sempre.
const mkUser = () =>
  Number(getDb().prepare('INSERT INTO users (name,color,created_at) VALUES (?,?,?)')
    .run('T', '#fff', Date.now()).lastInsertRowid);

describe('trackAffinity: gli eventi devono portare il titolo', () => {
  beforeAll(() => { initDb(); initSettings(); });

  it('like locali/remoti, burn e download contano subito nel saldo brano', () => {
    const u = mkUser();
    const t = addTrack({ videoId: 'vLocal', title: 'Albachiara', artist: 'Vasco Rossi', filePath: 'x.mp3' });
    setLiked(t.id, true, u);
    likeRemote({ videoId: 'vRem', title: 'Everlong', artist: 'Foo Fighters' }, true, u);
    recordBurn('CD test', 'audio', [t], u);
    recordEvent(t.id, t.artist, 'download', undefined, u); // meta dimenticato: la cintura lo colma da tracks
    const aff = trackAffinity(u);
    const k = (a: string, ti: string) => `${norm(a)}|${norm(ti)}`;
    // Vasco: like +3 · burn +1.5 · download +1 → ~5.5 (ts=ora: decadimento ~nullo)
    expect(aff.get(k('Vasco Rossi', 'Albachiara'))).toBeGreaterThan(5);
    // Foo Fighters: solo like remoto — prima era invisibile PER SEMPRE
    expect(aff.get(k('Foo Fighters', 'Everlong'))).toBeGreaterThan(2.5);
  });

  it('unlike resta un segnale negativo leggibile dal motore', () => {
    const u = mkUser();
    const t = addTrack({ videoId: 'vNeg', title: 'Song 2', artist: 'Blur', filePath: 'y.mp3' });
    setLiked(t.id, true, u);
    setLiked(t.id, false, u);
    const aff = trackAffinity(u);
    // +3 e -3 stesso peso/decadimento → saldo ~0, mai positivo.
    // (toBeDefined: sul codice buggato la coppia like+unlike era invisibile
    // e la chiave mancava proprio dalla mappa.)
    const v = aff.get(`${norm('Blur')}|${norm('Song 2')}`);
    expect(v).toBeDefined();
    expect(v!).toBeLessThan(0.5);
  });
});
