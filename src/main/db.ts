import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync, existsSync, unlinkSync } from 'fs';

let db: DatabaseSync;

// ---- Migrazioni ordinate via PRAGMA user_version ----
// Regola: un passo pubblicato non si modifica MAI — una correzione è un passo
// NUOVO in coda all'array. Ogni passo è idempotente: i DB pre-versioning hanno
// user_version=0 e rieseguono tutta la lista (i guard colsOf/try-catch/UPDATE
// no-op lo rendono sicuro). Un DB fresco esce già completo dal blocco CREATE
// di initDb: un passo serve solo per trasformare dati o alterare tabelle
// esistenti. Ogni passo gira in transazione: fallimento → rollback → ritentato
// al prossimo boot (idempotenza = retry sicuro).
const MIGRATIONS: (() => void)[] = [
  // 1 — multi-utente + colonne eventi arricchite + bonifica "[object …]"
  // (era la sequenza ad-hoc in try/catch di initDb)
  () => {
    const db = getDb();
    // Primo profilo: i dati esistenti appartenevano all'unico utente → user 1
    const hasUsers = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
    if (!hasUsers) {
      db.prepare('INSERT INTO users (name, color, created_at) VALUES (?,?,?)')
        .run('Utente', '#2dd4bf', Date.now());
    }
    const colsOf = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    // user_id sulle tabelle append-only: ADD COLUMN + backfill a user 1
    for (const t of ['events', 'playlists', 'burned_cds']) {
      if (!colsOf(t).includes('user_id')) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1`);
      }
    }
    // taste_profile: PK (kind,value) non può ospitare due utenti → rebuild con
    // user_id nella chiave primaria
    if (!colsOf('taste_profile').includes('user_id')) {
      db.exec(`
        ALTER TABLE taste_profile RENAME TO taste_profile_old;
        CREATE TABLE taste_profile (
          kind TEXT NOT NULL, value TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL, user_id INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (kind, value, user_id)
        );
        INSERT INTO taste_profile SELECT kind,value,weight,updated_at,1 FROM taste_profile_old;
        DROP TABLE taste_profile_old;
      `);
    }
    // remote_likes: PK video_id → rebuild con (video_id, user_id)
    if (!colsOf('remote_likes').includes('user_id')) {
      db.exec(`
        ALTER TABLE remote_likes RENAME TO remote_likes_old;
        CREATE TABLE remote_likes (
          video_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
          thumbnail TEXT, duration_s INTEGER, ts INTEGER NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (video_id, user_id)
        );
        INSERT INTO remote_likes SELECT video_id,title,artist,thumbnail,duration_s,ts,1 FROM remote_likes_old;
        DROP TABLE remote_likes_old;
      `);
    }
    // Like legacy: tracks.liked → track_likes del primo utente. La guardia è la
    // colonna stessa: dopo il backfill viene droppata (SQLite ≥3.35) così la
    // migrazione non può ri-eseguire su un track_likes svuotato dall'utente.
    if (colsOf('tracks').includes('liked')) {
      db.exec(`INSERT OR IGNORE INTO track_likes (track_id, user_id, ts)
               SELECT id, 1, COALESCE(added_at, 0) FROM tracks WHERE liked = 1;
               ALTER TABLE tracks DROP COLUMN liked`);
    }
    // prefs legacy (mh-pref-*) → namespace 'u1:' (chiavi nuove sono già 'u<n>:…')
    db.exec(`UPDATE prefs SET k = 'u1:' || k WHERE k LIKE 'mh-pref-%'`);
    // search_picks legacy → 'u1|' prefix (scelte di ricerca sono gusto personale)
    db.exec(`UPDATE search_picks SET query_key = 'u1|' || query_key WHERE query_key NOT LIKE 'u%|%'`);
    // Soft-delete per l'undo ("Annulla" dopo eliminazione)
    try { db.exec('ALTER TABLE tracks ADD COLUMN deleted_at INTEGER'); } catch { /* colonna già presente */ }
    // Gli eventi portano anche i dati del brano — gli ascolti da stream
    // remoto (nessun track_id) restano tracciati per "recenti" e segnali negativi.
    for (const col of ['title TEXT', 'video_id TEXT', 'thumbnail TEXT']) {
      try { db.exec(`ALTER TABLE events ADD COLUMN ${col}`); } catch { /* già presente */ }
    }
    // Motore gusti v2 (engine.ts): contesto orario, completamento, co-occorrenza, uso funzioni
    for (const col of ['hour INTEGER', 'dow INTEGER', 'played_s INTEGER', 'duration_s INTEGER']) {
      try { db.exec(`ALTER TABLE events ADD COLUMN ${col}`); } catch { /* già presente */ }
    }
    // Bonifica: un bug del parser YT salvava "[object Object]" come artista —
    // quei segnali inquinerebbero il profilo gusti e la co-occorrenza
    db.exec(`DELETE FROM taste_profile WHERE value LIKE '[object%';
             UPDATE events SET artist=NULL WHERE artist LIKE '[object%';
             DELETE FROM artist_cooc WHERE a LIKE '[object%' OR b LIKE '[object%';
             UPDATE remote_likes SET artist='Sconosciuto' WHERE artist LIKE '[object%';
             UPDATE tracks SET artist='Sconosciuto' WHERE artist LIKE '[object%'`);
  },
];

export function initDb(): void {
  const dir = join(app.getPath('userData'), 'data');
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, 'masterhype.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- FK realmente attive (SQLite le disattiva di default per connessione):
    -- senza questo i CASCADE di playlist_tracks non sono mai girati
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      genre TEXT,
      year INTEGER,
      duration_s INTEGER,
      file_path TEXT NOT NULL,
      cover_path TEXT,
      play_count INTEGER DEFAULT 0,
      added_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'lista',
      created_at INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER,
      artist TEXT,
      genre TEXT,
      type TEXT NOT NULL,
      ts INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 1,
      title TEXT,
      video_id TEXT,
      thumbnail TEXT,
      hour INTEGER,
      dow INTEGER,
      played_s INTEGER,
      duration_s INTEGER
    );
    CREATE TABLE IF NOT EXISTS taste_profile (
      kind TEXT NOT NULL,      -- 'artist' | 'genre' | 'tag'
      value TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (kind, value, user_id)
    );
    CREATE TABLE IF NOT EXISTS artist_tags (
      artist TEXT PRIMARY KEY,
      tags TEXT NOT NULL,      -- JSON array
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trend_cache (
      source TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS burned_cds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      kind TEXT NOT NULL,
      track_count INTEGER,
      ts INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS remote_likes (
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      thumbnail TEXT,
      duration_s INTEGER,
      ts INTEGER NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (video_id, user_id)
    );
    -- Telemetria auto-miglioramento: errori osservati, stream difettosi,
    -- scelte dell'utente nelle ricerche (vedi services/telemetry.ts)
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,       -- 'play' | 'stream-dead' | 'download' | 'search-empty' | 'video' | 'generic'
      message TEXT,
      artist TEXT,
      title TEXT,
      video_id TEXT,
      query TEXT,
      healed INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bad_streams (
      video_id TEXT PRIMARY KEY,
      artist TEXT,
      title TEXT,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS search_picks (
      query_key TEXT NOT NULL,  -- query normalizzata 'u<id>|<testo>'
      video_id TEXT NOT NULL,
      artist TEXT,
      title TEXT,
      picks INTEGER NOT NULL DEFAULT 1,
      ts INTEGER NOT NULL,
      PRIMARY KEY (query_key, video_id)
    );
    -- Loudness misurata per stream remoto: normalizza il volume in anteprima
    CREATE TABLE IF NOT EXISTS loudness (
      video_id TEXT PRIMARY KEY,
      lufs REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    -- Preferenze condivise PC↔telefono (chiavi mh-pref-* del renderer).
    -- Multi-utente: la chiave fisica è 'u<userId>:mh-pref-*' — ogni profilo
    -- ha il proprio namespace, il client vede solo le sue chiavi logiche.
    CREATE TABLE IF NOT EXISTS prefs (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
    -- Profili utente: gusti, preferenze, playlist e like sono PER UTENTE.
    -- I file MP3 della libreria restano condivisi (un solo disco, un solo PC);
    -- ciò che è "personale" (ascolti, preferiti, coda CD, stazioni) no.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2dd4bf',
      created_at INTEGER NOT NULL
    );
    -- Like per utente su tracce condivise: la colonna tracks.liked (legacy,
    -- mono-utente) è migrata qui e non viene più scritta.
    CREATE TABLE IF NOT EXISTS track_likes (
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      PRIMARY KEY (track_id, user_id)
    );
    -- Dispositivi remoti pairati: token per device (hash sha256 — il
    -- plaintext esiste solo nella conf del telefono) legato a UN profilo.
    -- user_id NULL = pairato ma non ancora associato (gate "Chi sei?").
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      name TEXT,
      user_id INTEGER,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    -- Motore gusti v2: artisti ascoltati insieme nella stessa sessione
    CREATE TABLE IF NOT EXISTS artist_cooc (
      user_id INTEGER NOT NULL, a TEXT NOT NULL, b TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL,
      PRIMARY KEY (user_id, a, b)
    );
    -- Contatori uso funzioni (telemetria report)
    CREATE TABLE IF NOT EXISTS usage (
      user_id INTEGER NOT NULL, name TEXT NOT NULL,
      n INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    );
    -- Cache risoluzione videoId per i motori (stazioni/radio/suggerimenti):
    -- "artista|titolo" normalizzato → videoId. video_id='' = irrisolvibile
    -- (cache negativa breve: non ri-cercare ogni volta ciò che YT non ha).
    CREATE TABLE IF NOT EXISTS vid_cache (
      k TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      thumbnail TEXT,
      duration_s INTEGER,
      fetched_at INTEGER NOT NULL
    );
    -- Metriche della cascata stream per client Innertube, raccolte sui
    -- dispositivi remoti e risalite qui al reconnect: si legge quale client
    -- sta morendo senza spulciare i log.
    CREATE TABLE IF NOT EXISTS client_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL, client TEXT NOT NULL,
      ms INTEGER NOT NULL, ok INTEGER NOT NULL,
      device TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_events_user_type ON events(user_id, type);
    CREATE INDEX IF NOT EXISTS idx_client_stats_ts ON client_stats(ts);
  `);
  // Migrazioni ordinate: si applicano i passi da user_version in su; ogni
  // passo in transazione, poi il marcatore avanza (una migrazione riuscita a
  // metà e non marcata viene rieseguita al boot successivo — è idempotente).
  const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = ver; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v]();
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* niente da annullare */ }
      throw e;
    }
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  // Backfill: gli eventi legati a tracce locali recuperano titolo/video_id.
  // Resta a OGNI boot (non è una migrazione): rete di sicurezza per righe
  // inserite senza metadati — su una tabella ora potata la scansione è cheap.
  db.exec(`UPDATE events SET title = (SELECT title FROM tracks WHERE tracks.id = events.track_id),
           video_id = (SELECT video_id FROM tracks WHERE tracks.id = events.track_id)
           WHERE title IS NULL AND track_id IS NOT NULL`);
  // Svuota il cestino della sessione precedente: elimina file + righe soft-deleted
  const gone = db.prepare('SELECT id, file_path, cover_path FROM tracks WHERE deleted_at IS NOT NULL').all() as
    { id: number; file_path: string; cover_path: string | null }[];
  for (const t of gone) {
    for (const p of [t.file_path, t.cover_path]) {
      if (p && existsSync(p)) try { unlinkSync(p); } catch { /* in uso */ }
    }
    db.prepare('DELETE FROM playlist_tracks WHERE track_id=?').run(t.id);
    db.prepare('DELETE FROM tracks WHERE id=?').run(t.id);
  }
  runMaintenance();
}

// ---- Manutenzione periodica: pruning + checkpoint ----
// Senza questo events/artist_cooc/usage crescono per sempre. Il pruning è
// throttlato a 1 volta/giorno (marcatore in prefs 'sys:last-prune' — chiave
// fuori dal prefisso mh-pref-*, non sincronizzata né modificabile da remoto);
// il checkpoint WAL gira a OGNI boot (cheap: fonde il -wal nel file principale)
// e il VACUUM parte solo se il pruning ha davvero cancellato righe.
const RETENTION_MS = 548 * 86_400_000; // ~18 mesi

function runMaintenance(): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best-effort */ }
  try {
    const last = Number(
      (db.prepare(`SELECT v FROM prefs WHERE k='sys:last-prune'`).get() as { v: string } | undefined)?.v ?? 0);
    if (Date.now() - last < 86_400_000) return;
    db.prepare(`INSERT INTO prefs (k,v) VALUES ('sys:last-prune',?)
      ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(Date.now()));
    const cutoff = Date.now() - RETENTION_MS;
    let deleted = 0;
    db.exec('BEGIN');
    try {
      // Gli eventi di ascolto (play/partial/complete) sono i voluminosi e il
      // loro peso sui gusti decade a ~0 ben prima dei 18 mesi (half-life
      // ~45gg in tasteProfile/trackAffinity): potati. ECCEZIONE: i play di
      // brani con skip/hide storici restano — negativeTracks confronta
      // skip vs play su tutta la storia e potarli romperebbe il rapporto.
      // I segnali espliciti (like/unlike/skip/hide/download/burn) non sono
      // potati: rari, e sono la memoria a lungo termine dei gusti.
      deleted += Number(db.prepare(
        `DELETE FROM events WHERE ts < ? AND type IN ('play','partial','complete')
         AND (title IS NULL OR NOT EXISTS (
           SELECT 1 FROM events e2
           WHERE e2.user_id = events.user_id AND e2.type IN ('skip','hide') AND e2.ts < ?
             AND e2.artist IS events.artist AND e2.title IS events.title))`)
        .run(cutoff, cutoff).changes);
      deleted += Number(db.prepare('DELETE FROM artist_cooc WHERE ts < ?').run(cutoff).changes);
      deleted += Number(db.prepare('DELETE FROM usage WHERE ts < ?').run(cutoff).changes);
      db.exec('COMMIT');
    } catch {
      try { db.exec('ROLLBACK'); } catch { /* niente da annullare */ }
    }
    // VACUUM solo se il pruning ha liberato pagine (reclama lo spazio su disco)
    if (deleted > 0) try { db.exec('VACUUM'); } catch { /* non fatale */ }
  } catch { /* la manutenzione non deve mai rompere il boot */ }
}

export function getDb(): DatabaseSync {
  return db;
}
