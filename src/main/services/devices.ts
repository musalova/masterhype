// Dispositivi remoti pairati (telefoni/tablet): ognuno ha un TOKEN proprio,
// legato a UN solo profilo utente. È il confine di sicurezza dei profili:
// un device token vede e modifica solo i dati del suo user_id — l'header
// X-MH-User viene ignorato (lo decide il binding, non il client).
//
//   · token  = 192 bit casuali, nel DB solo l'hash sha256 (una leak del DB
//     non consegna i token; il plaintext vive solo nella conf del device)
//   · user_id NULL = pairato ma non ancora associato: può solo leggere la
//     lista profili e fare claim (il gate "Chi sei?"); il primo claim è
//     libero perché il pairing stesso è già stato autorizzato dal PC
//   · ri-legare un device a un altro profilo richiede la finestra
//     "Accoppia telefono" aperta sul PC (verifica in remote.ts) oppure
//     l'admin: il codice di pairing condiviso (remoteToken) resta il
//     token onnicomprensivo, usato solo per pairing/bootstrap — i device
//     lo convertono subito in un device token e non lo conservano.
//
// Puro e senza dipendenze Electron: testabile in vitest.

import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db';
import type { MhDevice } from '../../shared/types';

interface DeviceRow { id: number; token_hash: string; name: string | null; user_id: number | null; created_at: number; last_seen: number | null }

const toDevice = (r: DeviceRow): MhDevice => ({
  id: r.id, name: r.name ?? '', userId: r.user_id, createdAt: r.created_at, lastSeen: r.last_seen ?? 0,
});

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

// Mint di un nuovo device (user_id NULL: il profilo si sceglie dopo, al gate).
// Il token in chiaro è ritornato UNA volta — il DB conserva solo l'hash.
export function mintDevice(name?: string): { id: number; token: string } {
  const token = randomBytes(24).toString('base64url');
  const r = getDb().prepare('INSERT INTO devices (token_hash, name, user_id, created_at) VALUES (?,?,NULL,?)')
    .run(hashToken(token), (name ?? '').trim().slice(0, 60) || null, Date.now());
  return { id: Number(r.lastInsertRowid), token };
}

// Risolve un token in ingresso → riga device (o null = token sconosciuto/revocato).
// last_seen si aggiorna al massimo una volta al minuto: una write a richiesta
// non serve, e su SQLite ogni write è un fsync.
export function deviceByToken(token: string): MhDevice | null {
  const r = getDb().prepare('SELECT * FROM devices WHERE token_hash=?').get(hashToken(token)) as DeviceRow | undefined;
  if (!r) return null;
  const now = Date.now();
  if ((r.last_seen ?? 0) < now - 60_000) {
    try { getDb().prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, r.id); } catch { /* */ }
  }
  return toDevice(r);
}

// Associa il device a un profilo (primo claim) o lo ri-lega a un altro
// (solo su autorizzazione del PC: la verifica "finestra aperta" è del chiamante).
export function bindDevice(id: number, userId: number): void {
  getDb().prepare('UPDATE devices SET user_id=? WHERE id=?').run(userId, id);
}

export function listDevices(): MhDevice[] {
  return (getDb().prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as DeviceRow[]).map(toDevice);
}

// Revoca: il token smette di funzionare alla prossima richiesta → il device
// torna al gate di pairing. Revocare è l'unico modo di scollegare un telefono.
export function revokeDevice(id: number): void {
  getDb().prepare('DELETE FROM devices WHERE id=?').run(id);
}

// "Ho sniffato/ho perso un device" → scollega TUTTI i telefoni in un colpo
// (i device token valgono finché la riga esiste). Il codice condiviso va
// rigenerato a parte (Settings → Rigenera).
export function revokeAllDevices(): number {
  return Number(getDb().prepare('DELETE FROM devices').run().changes);
}

// Riassegnazione dal PC (admin): userId null = slega → il device dovrà
// ri-scegliere il profilo (401 'profilo non valido' → gate).
export function setDeviceUser(id: number, userId: number | null): void {
  getDb().prepare('UPDATE devices SET user_id=? WHERE id=?').run(userId, id);
}

// Profilo eliminato: i device ad esso legati restano pairati ma tornano
// "da associare" — alla prossima chiamata ricevono 401 'profilo non valido'
// e il client mostra di nuovo la scelta del profilo.
export function unbindUserDevices(userId: number): void {
  getDb().prepare('UPDATE devices SET user_id=NULL WHERE user_id=?').run(userId);
}
