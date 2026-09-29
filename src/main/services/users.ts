// Profili utente: ogni utente ha gusti, preferenze, playlist e like propri.
// La libreria di file MP3 resta condivisa; i dati "personali" sono scope-ati
// per user_id lato server (mai filtrati solo in UI).

import { getDb } from '../db';
import { unbindUserDevices } from './devices';
import type { MhUser } from '../../shared/types';

const USER_COLORS = ['#2dd4bf', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#4ade80', '#f97316'];

interface UserRow { id: number; name: string; color: string; created_at: number }

const toUser = (r: UserRow): MhUser => ({ id: r.id, name: r.name, color: r.color, createdAt: r.created_at });

export function listUsers(): MhUser[] {
  return (getDb().prepare('SELECT * FROM users ORDER BY id').all() as unknown as UserRow[]).map(toUser);
}

export function userExists(id: number): boolean {
  return !!(getDb().prepare('SELECT id FROM users WHERE id=?').get(id) as { id: number } | undefined);
}

export function createUser(name: string): MhUser {
  const n = name.trim().slice(0, 30);
  if (!n) throw new Error('Nome profilo vuoto');
  const count = (getDb().prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  const color = USER_COLORS[count % USER_COLORS.length];
  const r = getDb().prepare('INSERT INTO users (name, color, created_at) VALUES (?,?,?)')
    .run(n, color, Date.now());
  return { id: Number(r.lastInsertRowid), name: n, color, createdAt: Date.now() };
}

export function renameUser(id: number, name: string): void {
  const n = name.trim().slice(0, 30);
  if (!n) throw new Error('Nome profilo vuoto');
  getDb().prepare('UPDATE users SET name=? WHERE id=?').run(n, id);
}

// Elimina un profilo con TUTTI i suoi dati personali. Vietato eliminare
// l'ultimo profilo rimasto (resterebbe un'installazione senza identità).
export function deleteUser(id: number): void {
  if ((getDb().prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c <= 1)
    throw new Error('Non puoi eliminare l\'ultimo profilo');
  // playlist_tracks cascada via FK; il resto è per utente
  getDb().prepare('DELETE FROM playlists WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM events WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM taste_profile WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM remote_likes WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM track_likes WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM burned_cds WHERE user_id=?').run(id);
  getDb().prepare('DELETE FROM prefs WHERE k LIKE ?').run(`u${id}:%`);
  getDb().prepare('DELETE FROM search_picks WHERE query_key LIKE ?').run(`u${id}|%`);
  // I device legati a questo profilo NON vengono revocati: restano pairati,
  // tornano "da associare" e ri-scelgono un profilo al prossimo accesso.
  unbindUserDevices(id);
  getDb().prepare('DELETE FROM users WHERE id=?').run(id);
}
