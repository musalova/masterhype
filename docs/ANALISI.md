# MasterHype — Analisi completa del prodotto

**Versione:** 0.5.8 · **Piattaforme:** Windows (Electron, server di casa) + Android/Web (client Capacitor) · **Codebase:** ~30.000 righe TS/TSX + plugin Java + C# · **Stato:** in produzione, auto-aggiornante via GitHub Releases

> Doc aggiornato a ottobre 2026. Per le note operative dettagliate (audit CDP,
> pairing, sync offline, trappole risolte) vedere `AGENTS.md`.

---

## 1. Che cos'è MasterHype

MasterHype è un **sistema musicale domestico auto-ospitato**: il PC Windows è il server di casa (libreria MP3, motore gusti, yt-dlp/ffmpeg, masterizzatore CD, API HTTP :48484); l'app Android — o qualsiasi browser in LAN — è un client della stessa UI React.

Fa una cosa che nessun mainstream fa più: **ricerca → streaming → download MP3 320 con tag e copertina → organizzazione → masterizzazione CD (audio con CD-Text o dati MP3) per l'auto**, in un'unica app in italiano. In più:

- il telefono funziona **anche a PC spento o fuori casa** (ricerca/stream/download diretti su YouTube via Innertube + PoToken, code offline con drain al reconnect, modalità "senza PC" autonoma);
- **multi-profilo**: gusti, like, playlist e preferenze separati per persona, con token per-device legati a un profilo;
- **auto-aggiornamento** end-to-end: EXE via electron-updater (feed GitHub Releases, sha512 + blockmap), APK via app-update.json (sha256 + pinning della firma), yt-dlp aggiornato in background con verifica SHA-256.

## 2. Anatomia

| Area | File chiave | Cosa fa |
|---|---|---|
| Main Electron | `src/main/db.ts` | node:sqlite: schema + migrazioni `PRAGMA user_version`, pruning 18 mesi, WAL |
| | `src/main/remote.ts` | Server HTTP LAN: /api/call (mappa condivisa IPC), /media con Range, SSE per-utente, /pair (unica route senza token), /update/*, upload audio |
| | `src/main/handlers.ts` | Mappa canale→handler: unica sorgente per IPC desktop e API remota; `u` iniettato dal chiamante |
| | `src/main/services/` | ytmusic (youtubei.js), downloader (yt-dlp+ffmpeg, auto-riparazione stream, loudness ReplayGain), library, recommend (motore gusti v2: contesto orario, co-occorrenze, affinità decadute), sources (Deezer/Last.fm/Spotify/LRCLIB/Audius), trends, burner (IMAPI2/DAO/CD-Text via BurnHelper.cs), updater (yt-dlp), appUpdate (electron-updater), backup, devices, users, telemetry, engine |
| | `tools/BurnHelper.cs` | C# 5 su .NET 4: IMAPI2 TAO + DAO via SPTI con CD-Text |
| Preload | `src/preload/index.ts` | contextBridge `window.masterhype`, tipizzato |
| Renderer | `src/renderer/src/` | React 19 + Tailwind v4 + zustand: stessa UI per desktop, browser LAN e WebView Android |
| | `remote.ts` / `remoteApi.ts` | Client HTTP verso il PC: failover multi-indirizzo (LAN↔Tailscale), SSE probe-first, timeout per-canale, cache per-profilo |
| | `pendingSync.ts` / `localData.ts` | Code offline per-utente con drain convergente (resurrezione playlist, reorder LWW, tasteReset a confine temporale) |
| | `direct.ts` / `potoken.ts` | Modalità autonoma: Innertube nel renderer, PoToken via BotGuard in iframe, cascata client hot-fixabile dal feed |
| | `phoneLocal.ts` + `public/sw.js` | Blob su IndexedDB (LRU+quota), service worker: proxy `/__pc/*` col token in header, `/__phone/*` con Range |
| Shared | `src/shared/` | types.ts (contratti IPC), taste.ts (normalizzatori/pesi UNICI PC↔telefono), ytparse.ts, updateFeed.ts |
| Android | `android/` | Capacitor 7 + plugin app-locali Java: MediaSession/PlaybackService (foreground), Discovery (UDP), AppUpdate (sha256+firma), Files (SAF) |
| Test | `tests/` | 227 test vitest: gusti, sync, auth remota, pairing, update, engine |

## 3. Sicurezza (modello LAN)

- Auth a due livelli: codice condiviso admin (resta sul PC) → convertito subito in **token per-device** (192 bit, solo sha256 nel DB) legato a un profilo; revoca singola o globale; ri-binding solo con finestra "Accoppia" aperta sul PC.
- QR monouso (TTL 5 min, max 3 in vita); token mai nelle URL subresource (proxy SW `/__pc/*` con `X-MH-Token` in header); `Referrer-Policy: no-referrer`.
- Segreti (`remoteToken`, chiavi Spotify/Last.fm) redatti verso tutti i remoti; impostazioni desktop-only filtrate lato server; rate-limit sui 401; rate-limit + finestra 90s su `/pair`.
- Integrità update: sha512 (EXE), sha256+signature pinning (APK), SHA2-256SUMS (yt-dlp); feed solo https (http solo loopback).
- HTTP in chiaro su LAN = scelta documentata e mitigata; confidenzialità vera via Tailscale (supportata in modo nativo, CGNAT rilevato).

## 4. La concorrenza

Nessun competitor copre l'intera catena. Spotify/YT Music: scoperta+streaming ma niente MP3 liberi né CD. Nero/ImgBurn: solo burning. yt-dlp GUI/siti: download senza tag/libreria/burning e pieni di ads. MediaMonkey/MusicBee: libreria+CD ma UI datata e niente discovery. Feishin/Nuclear: player YT senza download organizzato, CD-Text o motore gusti.

**Il punto forte:** unica app che copre *tutta* la catena con UX moderna **e** un client telefono che sopravvive al PC spento.

## 5. Residui noti / rischi (onestà tecnica)

- **Dipendenza da YouTube/yt-dlp**: corsa gatto-e-topo mitigata da cascata client hot-fixabile via feed, auto-riparazione stream, telemetria — non eliminabile.
- **Zona grigia ToS**: il download da YouTube viola i ToS del servizio; rischio di distribuzione.
- **Solo Windows per il server** (BurnHelper è IMAPI2); il client gira ovunque ci sia una WebView.
- **Burning non testabile in CI** (serve un drive fisico); audit reali via script CDP/adb manuali.
- Vulnerabilità dev-deps residue (Electron/vitest versioni dev-only): non nel prodotto finale, fix = bump major da pianificare.

## 6. Direzione futura (roadmap motivata)

1. Equalizzatore audio (Web Audio su file locali) — credibile per un'app "car audio".
2. Portata macOS/Linux del server (BurnHelper dietro interfaccia → `drutil`/`cdrdao`).
3. Bump major Electron (45) e vitest (5) dopo audit delle breaking changes.
4. Sorgenti legali extra (Jamendo/FMA oltre ad Audius già integrato).
5. Sync cloud opzionale del profilo gusti (oggi: backup export/import già presente).
