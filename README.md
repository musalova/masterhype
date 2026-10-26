# MasterHype

*A self-hosted home music system — an Electron PC app that is the server of the house, plus an Android client that keeps working even when the PC is off.*

MasterHype è un sistema musicale domestico auto-ospitato: il PC (Electron) è il server di casa — libreria, download, gusti, masterizzatore CD — e l'app Android ci si accoppia via QR. Il telefono funziona anche a PC spento o fuori casa: ricerca diretta su YouTube, streaming, download sul dispositivo, playlist e gusti ricostruiti in locale e risincronizzati al ritorno.

## Funzionalità

- **Libreria YouTube Music** con download in MP3, copertine, testi, loudness
- **Motore gusti v2**: completamenti d'ascolto, skip/hide, co-occorrenze artisti, contesto orario → stazioni, radio artista/genere, autoplaylist, assistente conversazionale
- **Telefono senza PC**: ricerca/stream/download diretti (Innertube + PoToken), cache locale, code offline con drain al reconnect (conflitti playlist risolti: resurrezione + reorder convergente, `tasteReset` a confine temporale)
- **Sicurezza**: token per-device legati a un profilo (SHA-256 nel DB), QR monouso ~5min, revoca singola/globale, proxy service-worker `/__pc/*` per tenere i token fuori dalle URL
- **Aggiornamenti automatici**: EXE via `electron-updater` da GitHub Releases (`latest.yml` + sha512 + blockmap differenziale), APK via `app-update.json` (sha256, `minSupportedCode`) dallo stesso feed o dal PC in LAN
- **Masterizzazione CD**: audio CD con CD-Text via SPTI/DAO, data CD, cascata DAO→TAO, pre-flight anti-coaster
- **MediaSession nativa Android**: foreground service, lockscreen/Bluetooth/tasti hardware, ripresa dopo render-process death

## Architettura

```
src/main/       Electron main — db (node:sqlite), remote.ts (HTTP :48484),
                handlers.ts (mappa IPC↔HTTP), services/ (ytmusic, downloader,
                recommend, engine gusti, burner)
src/renderer/   React + Tailwind v4 + zustand — gira sia in Electron sia
                nella WebView Capacitor del telefono (stesso codice)
src/shared/     tipi + contratti IPC (types.ts = fonte di verità)
android/        Capacitor 7 + plugin nativi app-locali (MediaSession,
                PlaybackService, AppUpdate, Discovery, Files)
public/sw.js    service worker: proxy /__pc/* col token in header, serve
                /__phone/<id> con Range per i download sul telefono
tests/          vitest (parser, gusti, sync offline, auth remota, …)
```

Il PC espone HTTP su `0.0.0.0:48484` **in chiaro per scelta** (LAN domestica): la confidenzialità vera fuori casa è affidata a Tailscale. Le mitigazioni deliberate sono token per-device revocabili, codice QR monouso e nessun token nelle URL.

## Sviluppo

```bash
npm ci
npm run dev            # Electron in sviluppo
npm run check          # typecheck + lint + test (lo stesso gate della CI)
npm run lint           # solo ESLint
npm run build          # bundle main+preload+renderer (renderer minificato)
npm run build:android  # APK (release-firmato se presente keystore.properties)
```

### Qualità e verifica

- **CI** (GitHub Actions, Windows): typecheck → ESLint → vitest → build →
  `npm audit --omit=dev` (le dipendenze del prodotto restano a 0 vulnerabilità
  note) + compilazione del progetto Android.
- **Test**: vitest su logica pura e su server/DB reali (SQLite in-memory, HTTP
  vero su loopback): gusti, sync offline, auth remota, pairing, update, shuffle,
  scritture atomiche, import.
- **Audit UI isolati** (Electron con profilo temporaneo, non toccano l'app
  installata) dopo `npm run build`: `node scripts/audit-appearance.mjs`
  (temi, 5 viewport, movimento ridotto) e `node scripts/audit-loading.mjs`
  (splash, skeleton, errori di chunk con recupero).

### Binari degli strumenti (`resources/bin/`, non in git)

| File | Fonte |
|---|---|
| `yt-dlp.exe` | https://github.com/yt-dlp/yt-dlp/releases |
| `ffmpeg.exe`, `ffprobe.exe` | https://www.gyan.dev/ffmpeg/builds/ (build full) |
| `BurnHelper.exe` | compilato da `tools/BurnHelper.cs`: `csc -target:exe -platform:anycpu -optimize+ -out:resources\bin\BurnHelper.exe tools\BurnHelper.cs` |

### Firma APK (non in git)

`android/keystore.properties` + `android/keystore/masterhype-release.keystore` — senza di essi `build:android` produce una build **debug** con warning.

## Release

```bash
npm run release        # APK (versionCode+1) → EXE con APK embeddato →
                       # release/feed/ → publish su GitHub Releases (serve GH_TOKEN)
node scripts/release.mjs --publish-only   # ripubblica il feed già costruito
```

Gli update out-of-box puntano a `releases/latest/download` di questo repo. `settings.updateUrl` resta un override manuale.

Vedi `AGENTS.md` per le note operative complete (audit CDP, pairing, offline).
