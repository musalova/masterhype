# MasterHype — note per agenti

## Git / CI

- Repo pubblico `github.com/musalova/masterhype`, branch `main`, remote `origin`
  già configurato. Commit con identità `-c user.name=musalova
  -c user.email=musalova@users.noreply.github.com` (nessun user.name globale
  configurato sulla macchina). Push: PAT in env `GH_TOKEN` (scope
  `public_repo` — NON può pushare file sotto `.github/workflows/`: serve lo
  scope `workflow` oppure crearli dalla UI web GitHub).
- NON in git (vedi `.gitignore`): `resources/bin/*.exe` (yt-dlp/ffmpeg/
  ffprobe/BurnHelper — ffmpeg+ffprobe >100MB file, oltre il limite GitHub;
  fonti in README), `android/keystore.properties` + `android/keystore/`
  (PASSWORD DI FIRMA IN CHIARO — esposte, chiunque pubblica APK come noi),
  `release/`, `out/`, `build/apk/`.
- CI: `.github/workflows/ci.yml` (windows-latest): `npm ci` → `tsc --noEmit`
  → `vitest run` → `electron-vite build`; job parallelo `android-compile`
  (JDK 21 temurin + `gradlew :app:compileReleaseJavaWithJavac`).

## Comandi

- `npm run dev` — avvia in sviluppo (rimuove `ELECTRON_RUN_AS_NODE` via `scripts/run.mjs`)
- `npm run build` / `npm run build:win` — build / installer NSIS
- `npm run release` — release completa: APK (versionCode +1) → EXE con l'APK
  dentro → `release/feed/` + **publish su GitHub Releases** (repo
  `musalova/masterhype`, release `vX.Y.Z` con i 5 asset del feed; serve env
  `GH_TOKEN` = PAT Contents:RW, `GH_REPO` per override). Il feed pubblico è
  `…/releases/latest/download/` (= `DEFAULT_UPDATE_FEED`, cablato nell'app:
  update out-of-box). `MH_FEED_DIR=<dir>` copia il feed anche altrove (share/mount server)
  **A OGNI bump di versione** aggiungere una voce in `src/shared/whatsnew.json`
  (bullet in italiano SEMPLICE, cosa migliora per l'utente — mai tecnicismi):
  WhatsNewCard li mostra una volta dopo l'update (versione corrente vs
  `mh-seen-version`) e build-android li scrive in `app-update.json` → notes
  (la card di aggiornamento li mostra anche prima di installare)
- `npx tsc --noEmit` — typecheck
- `npx vitest run` — test
- `node scripts/make-icon.mjs` — rigenera TUTTE le icone dal logo sorgente `logo/Gemini_*.jpg`
  (crop fisso: centro ~1046,1000 lato 1560): `build/icon.ico` multi-size (≤32px crop stretto
  sulle lettere), `resources/icon.png`, `public/icon-192/512.png` (+ copia in assets APK),
  mipmap Android square/round/`ic_launcher_foreground` (disco sfumato 72%, safe zone 66%),
  splash Android `drawable-*/splash.png` (disco su #0c0a10). `Logo.tsx` e la splash di
  `index.html` usano `./icon-*.png` (path RELATIVI: il desktop carica via file:// —
  `/` assoluto punterebbe alla root del filesystem!) — MAI SVG duplicati del logo
- `node scripts/make-installer-art.mjs` — rigenera le bitmap NSIS `build/installerSidebar.bmp` + `installerHeader.bmp` (logo raster composto via sharp)
- Test UI runtime: lancia `electron out/main/index.js --remote-debugging-port=9222` e usa `scripts/cdp-test.mjs` (helper `ev`/`sleep`/`close`) per valutare JS nel renderer
- `npm run test:e2e` — smoke test CDP su tutte le schermate
- `npm run build:android` — APK Capacitor **release-firmato** se esiste `android/keystore.properties`
  (altrimenti debug + warning — vedi "Firma APK"), JDK 21+: auto-rileva il JBR di Android Studio; SDK in `%LOCALAPPDATA%\Android\Sdk`
- `npm run test:remote` — e2e del client remoto: serve un Chrome con `--remote-debugging-port=9223` aperto su `http://<ip-pc>:48484/?token=<token>`
- `node scripts/audit-offline-boot.mjs` — test Chrome del boot a PC morto (tempo ready, banner, fail-fast, diretto)
- `node scripts/audit-apk-full.mjs [--install] [--dead-conf]` — verifica APK completa su device USB/emulatore via adb+CDP (boot, modalità autonoma, audio reale, selftest)
- `node scripts/audit-apk-away.mjs` — scenario "fuori casa": PC morto + rete → boot, ricerca diretta, stream/play, download sul telefono, playback offline (aereo) del blob
- `node scripts/audit-apk-remote.mjs [--base … --token …]` / `audit-apk-media.mjs` — audit API via PC reale / servizio media nativo (foreground, tasti hardware, schermo spento)
- `src/renderer/src/selftest.ts` — auto-test in-app (Impostazioni → "Verifica dispositivo"): gira codice VERO (IndexedDB, CapacitorHttp, <audio> canplay) e funziona sul telefono senza adb
- `node scripts/audit-standalone.mjs` — audit CDP modalità senza PC (gate, migrazione :u1)
- `node scripts/audit-parity.mjs` — audit CDP parità completa (playlist offline, drain
  reale con `MH_PC`/`MH_TOKEN` verso un server di test, backup device, schermate senza PC)
- `node scripts/tmp/audit-stations-v2.mjs` — audit motore stazioni v2 su user-data-dir
  ISOLATO (sicuro mentre l'app installata gira): pertinenza gusti, filtri fuzzy, seed ~30%, rec:next

## Architettura

- `src/shared/types.ts` — tipi + canali IPC (fonte di verità dei contratti)
- `src/shared/taste.ts` — UNICA fonte per normalizzatori (`normText`/`normTag`),
  chiavi brano (`trackKey` esatta / `trackBaseKey` fuzzy), `baseTitleOf`, pesi
  segnali (`signalWeight`) e classificazione ascolti (`listenClass`/
  `listenTasteWeight`). Importato da main (engine/library/recommend/telemetry)
  E renderer (localData/offlineRec/store) + ytparse: la parità PC↔telefono è
  strutturale. MAI ricopiare una regex di normalizzazione altrove — i test
  golden in `tests/taste-parity.test.ts` bloccano derive su entrambi i lati.
  `localData.trackBaseKey`/`engine.normArtist`/`ytparse.normTxt` sono alias di
  compatibilità verso il condiviso.
- `src/main/` — processo main Electron: `db.ts` (node:sqlite), `settings.ts`, `ipc.ts`, `services/`
- `src/main/services/` — `ytmusic.ts` (youtubei.js), `downloader.ts` (yt-dlp+ffmpeg), `library.ts`,
  `sources.ts` (Deezer/Last.fm/Spotify), `recommend.ts` (scoring+assistente), `trends.ts`, `burner.ts`
- `src/preload/index.ts` — contextBridge `window.masterhype`
- `src/renderer/` — React + Tailwind v4 + Framer Motion + zustand (`store.ts`)
- `tools/BurnHelper.cs` — C# 5 max! (compilato col csc.exe di sistema .NET 4.0): IMAPI2 audio CD + data CD.
  **Rilevamento disco**: `CurrentMediaStatus` restituisce flag `IMAPI_FORMAT2_DATA_MEDIA_STATE`
  (BLANK=2, OVERWRITE_ONLY=1, APPENDABLE=4, FINAL_SESSION=8, poi DAMAGED/ERASE_REQUIRED/
  WRITE_PROTECTED/FINALIZED/UNSUPPORTED da 0x400 in su). MAI testare `status & 1` come "blank"
  (è OVERWRITE_ONLY: un CD-R vergine=2 risulta non-blank — bug reale). `mediaBlank` =
  BLANK|OVERWRITE_ONLY; `mediaState` esporta lo stato decodificato per la UI.
  mediaType è numerico IMAPI_MEDIA_TYPE (2=CD-R, 3=CD-RW) → mappato a stringa in ListDrives.
  **Pre-flight anti-coaster**: burner.ts misura i settori WAV reali (non i metadati)
  vs `freeSectors` del drive e ri-valida present/blank subito prima di scrivere;
  BurnHelper rifà lo stesso check dentro (TAO: `TotalSectorsOnMedia`; DAO: ultimo
  lead-out da READ DISC INFO bytes 17-19; data: `TotalBlocks` dell'immagine).
  `burn:start` fallisce se anche UN SOLO id non si risolve (mai dischi parziali silenti).
  Staging CD MP3: nomi `NN - Artista - Titolo.mp3` (ordine preservato, alfabetico
  sull'autoradio), dedup su collisioni di caratteri rimossi, hardlink→copia fallback.
  `pendingCd` (store) è un Set persistito per-utente (`mh-cd-pending:u<id>`, legacy migrata): il drain al boot/reconnect
  completa gli "aggiungi al CD" di download finiti mentre l'app era chiusa;
  **CD-Text via SPTI/DAO** (SAO + SEND CUE SHEET + WRITE(10) subcanali R-W nel lead-in, porting da cdrdao
  GenericMMC.cc/CdTextEncoder.cc). Comandi extra: `dao-probe` (test SPTI), `cdtext-dump` (dump pack per test).
  Motore a cascata: DAO+CD-Text -> DAO audio-only (lead-in/gap generati dal drive) -> IMAPI2 TAO.
  Capacita drive in %LOCALAPPDATA%MasterHypeurn-caps.txt (line-based "id|cap=0|1").
  VERIFICATO FUNZIONANTE su MATSHITA UJ8C0: DAO audio-only masterizza e finalizza (TOC verify ok);
  IMAPI2 TAO e rotto su quel drive/OS (E_IMAPI_DF2TAO_STREAM_NOT_SUPPORTED), CD-Text rifiutato
  (slimline senza subcanali R-W). Sense 02/04/08 = drive in long-write post-cue abortito -> attesa. Ricompilare:
  `csc -target:exe -platform:anycpu -optimize+ -out:resources\bin\BurnHelper.exe tools\BurnHelper.cs`
- `resources/bin/` — yt-dlp.exe, ffmpeg.exe, ffprobe.exe, BurnHelper.exe

## Multi-utente (profili)

- Ogni dato "personale" è scope-ato per `user_id` lato server: events, playlists,
  burned_cds, taste_profile, remote_likes, track_likes (like per utente su tracce
  condivise), prefs (`u<id>:mh-pref-*`), search_picks (`u<id>|<query>`).
  I file MP3/`tracks` restano CONDIVISI tra i profili — `listTracks(u)` risolve
  `liked` via subquery EXISTS su track_likes.
- **Tutti gli handler in `handlers.ts` ricevono `u` come PRIMO argomento**, iniettato
  dal chiamante: ipc.ts passa `desktopUser()` (settings.currentUser validato),
  remote.ts il profilo AUTENTICATO dal token (vedi sotto). MAI fidarsi di
  un user_id negli args del client. Chi ignora `u` lo dichiara `_u` comunque.
- **Auth remota a due livelli** (`authed()` in remote.ts, tabella `devices`,
  servizio `services/devices.ts`):
  · **codice condiviso** (`settings.remoteToken`, Impostazioni → Telefono) =
    credenziale ADMIN/bootstrap: vive sul PC, non si conserva sui telefoni né
    viaggia più nel QR (che ora porta un codice monouso, vedi Pairing). Da
    remoto può leggere qualsiasi profilo via `X-MH-User` (compatibilità +
    admin) e usare i canali admin-only (`device:*`, `users:remove/rename`,
    `pairing:open`, `pairing:code`).
  · **token per device** (192bit, nel DB solo sha256) mintato da `/pair` o
    `device:register`: legato a UN `user_id`. Il profilo della richiesta è il
    BINDING — `X-MH-User` viene IGNORATO; la risposta porta `X-MH-Bound-User`
    così il client ri-allinea `conf.user` se il PC ha riassegnato il device.
    `user_id NULL` = pairato ma non associato: può solo `users:list`/`users:create`
    (BOOTSTRAP_CHANNELS) e `device:claim`. Un device non legato che chiama un
    canale dati con `X-MH-User` valido fa claim IMPLICITO (compatibilità con
    client pre-claim: stesso livello di fiducia, il token l'ha già consegnato
    il pairing autorizzato dal PC).
  · **claim/rebind**: il primo claim è libero; ri-legare un device già associato
    richiede la finestra «Accoppia telefono» aperta sul PC (403 altrimenti → il
    renderer mostra l'attesa e riprova con `watchClaimWindow`) oppure l'admin
    via `device:setUser`. Revoca = `device:revoke` (DELETE dalla tabella → 401).
    Eliminare un profilo slega i suoi device (`unbindUserDevices`) → tornano
    "da associare", NON ri-pairing.
- `users:setCurrent` è desktop-only (NON nella mappa handlers → 404 da remoto);
  il profilo di un dispositivo remoto è il binding del suo token — `conf.user`
  sul client è solo cache/UI, riallineata da `X-MH-Bound-User`.
- Header `X-MH-User` inesistente/non numerico → 401 'profilo non valido' sulle
  chiamate dati COL CODICE CONDIVISO (il client mostra la SCELTA PROFILO
  conservando il pairing — flag 'mh-pick-profile', NON resetToPairing); header
  assente → profilo legacy 1. Con un device token l'header non vale niente.
  ECCEZIONE: `/api/info` (probe di salute) NON valida il profilo — un client con
  profilo stale deve comunque rilevare che il PC è vivo.
- Lista profili VUOTA dal gate (server legacy senza users:* → 404 → []) →
  fallback compatibilità: si entra come profilo 1, mai vicolo cieco.
- SSE morto ≠ API morta: `es.onerror` NON marca offline (reti mobili tagliano
  le connessioni lunghe) → chiude + scheduleReconnect → il probe /api/info
  decide. `setOnline(false)` solo quando TUTTI gli indirizzi (base+alts)
  falliscono. Watchdog 8s su EventSource in CONNECTING (TCP aperto, mai OPEN).
  `call()` su errore di rete fa setOnline(false) + retryNow() (recovery kick).
  Rate-limit sui fallimenti di auth (`authThrottled` in remote.ts): >30 401/min
  per IP → 429 (401 infiniti gratuiti = brute-force/revoked-loop amichevoli).
  prefsSet rifiuta chiavi fuori da `^mh-pref-[a-z0-9-]{1,48}$` e valori >256KB
  (la queue reale arriva a ~100KB).
- Timeout per-canale (`CALL_TIMEOUTS` in renderer/remote.ts): 10s default decide
  "PC morto"; i canali che fan-out sul PC (search 40s, rec:*/trends 45s,
  assistant 60s, yt:* dettagli 30s) hanno budget proprio. Su timeout il catch fa
  un probe /api/info prima di marcare offline: PC vivo → la chiamata fallisce
  SOLA (niente banner, niente fallback diretto ytCall); PC muto → offline+retry.
- Installer NSIS: l'app è tray-resident (la X nasconde) → `build/installer.nsh`
  (taskkill /F /IM MasterHype.exe in customInit/customInstall/customUn* macros)
  o l'installer trova i file bloccati e fallisce.
- Canali che agiscono sul PC fisico sono bloccati da remoto (deny-list in remote.ts):
  `lib:import` (path arbitrari), `sys:openFolder` (finestre Explorer sull'host).
- Eliminare un profilo: vietato il proprio (guard handler) e l'ultimo rimasto
  (guard servizio). `deleteUser` pulisce TUTTE le tabelle personali + prefs/picks.
- Renderer: `myUserId()` in remote.ts (conf.user su remoto, 'mh-user' su desktop).
  `store.setUser` sequenza obbligata: pushDirty → **claimProfile (device:claim —
  su remoto lo switch è AUTORIZZATO dal server; 'window' → watchClaimWindow
  attende la finestra «Accoppia»)** → archiveDirtyValues → clearLocalPrefs
  → setLocalUserId → api().users.setCurrent → reload. Le code pendingSync e le cache
  (likes/playlists/home) sono namespacizzate `:u<id>`; i valori dirty non partiti
  si archiviano in `mh-dval:u<id>:*` e tornano al prossimo login di quel profilo.
- Gli eventi prefs broadcast portano `u`: filtrati ANCHE server-side — un device
  SSE registrato come `uid` non riceve i broadcast con `u≠uid` (admin vede tutti,
  device non associato solo quelli senza `u`).
- Conf remota (`RemoteConf`): `devBound` marca il token come per-device —
  `ensureDeviceToken()` al boot converte una conf salvata col codice condiviso
  (legacy) in device token via `device:register`+`device:claim`. `remoteIsAdmin()`
  pilota la UI admin-only (rinomina/elimina profili, lista device).
- Audit: `node scripts/audit-users.mjs <token>` (isolamento API + device token,
  ~37 check) + `node scripts/audit-users-ui.mjs` (switch profilo via CDP, 11 check).

## Remoto / Android

- Il PC è il server di casa: `src/main/remote.ts` (HTTP :48484, CORS aperto — l'auth
  è il token: codice condiviso admin `settings.remoteToken` OPPURE token per-device
  dalla tabella `devices`, vedi Multi-utente) e `src/main/handlers.ts` = mappa condivisa IPC↔HTTP
- **Niente TLS su LAN — scelta documentata**: traffico in chiaro su 0.0.0.0.
  TLS self-signed sarebbe PEGGIO: cert warning che allenano a cliccare "ignora",
  e WebView richiederebbe onReceivedSslError-bypass (pinning impossibile: IP
  variabile). WPA2/3 cifra già in aria; resta scoperto un attaccante STESSA-
  RETE — mitigazioni deliberate: token PER-DEVICE revocabili (un token sniffato
  vale solo per UN profilo, finché la riga esiste: `device:revoke`/`revokeAll`
  in Impostazioni → "Scollega tutti"), codice condiviso rotabile a caldo
  ("Rigenera" — `authed()` rilegge le settings a ogni request, niente restart),
  QR monouso, token mai nelle URL (proxy SW /__pc/*). Se serve confidenzialità
  vera fuori casa: Tailscale (già supportato, è una VPN cifrata).
  (NON duplicare logica: aggiungere il canale lì, ipc.ts lo registra e remote.ts lo espone)
- `src/renderer/src/remote.ts` — specchio di `MasterHypeApi` via HTTP+SSE; `api.ts` sceglie
  `window.masterhype ?? remoteApi`
- Preferenze condivise: la tabella `prefs` del DB è lo store unico. Solo le chiavi `mh-pref-*`
  si sincronizzano (hydrate filtra su quel prefisso). `savePref` scrive sempre anche nel DB
  (`api().prefs.set`) su entrambe le piattaforme. IMPORTANTE: `hydratePrefs` deve completare
  PRIMA dell'init dello store zustand — per questo `main.tsx` importa `./App` dinamicamente
  dopo l'await; non tornare a import statici o le pref idratate non verranno applicate
- Sync live + reconnect (persist.ts/remote.ts): ogni `prefs:set` fa broadcast SSE/IPC
  (`remote:prefs:event` → `applyShared` → evento DOM `mh-pref-live` che aggiorna store e
  usePersistedState). `savePref` dispatcha `mh-pref-live` ANCHE per le scritture locali
  (microtask — mai sincrono dentro un updater setState), così chiavi lette da più
  componenti restano allineate in-sessione. Scrittura fallita (offline o errore server,
  su QUALUNQUE piattaforma — desktop incluso) → chiave "dirty" in `mh-pref-dirty:u<id>` →
  `syncPrefs()` la spinge prima dell'hydrate (pushDirty continua sulle altre chiavi:
  niente break), e hydrate NON applica le chiavi dirty (last-writer per-chiave).
  Idem per `settings`: ogni `setSettings` broadcasta `settings:event` (hook in
  index.ts — copre anche le scritture interne) → App lo applica a store +
  `mh-settings-cache`; al reconnect `loadSettings()` rilegge il canonico DOPO
  drainPending (le patch accodate in `mh-pending-settings:u<id>` sono ormai applicate)
- CD condiviso: `mh-pref-cdqueue` = array di track id ricostruito in `loadLibrary`;
  `downloadToCd` accoda il download sul PC e `pendingCd` aggiunge la traccia al 'done'
  (drainato anche al reconnect)
- `media://audio|cover/:id` vale solo in Electron → remoto usa URL media del PC.
  **Proxy SW `/__pc/*`** (`public/sw.js`): se il service worker controlla la
  pagina (APK/PWA — `swControlled()`), mediaUrl/rewriteMedia/EventSource
  emettono URL SAME-ORIGIN `/__pc/…` e il SW inoltra al PC con `X-MH-Token` in
  HEADER (postMessage `mh-pc-auth` a ogni persistConf/controllerchange,
  persistito in IDB `mh-sw` per i restart del SW). Il token non sta più in
  nessuna URL subresource (cronologia, log proxy, Referer). Fallback `?token=`
  dove il SW non si registra (tab browser su http://LAN = contesto non sicuro)
  — è comunque un device token, non la chiave admin. `Referrer-Policy:
  no-referrer` su tutte le risposte remote.ts + meta in index.html: le
  thumbnail esterne (i.ytimg.com) non ricevono mai l'URL di pairing.
  `?token=` in `location` dal QR è comunque strippato subito (replaceState in
  loadConf); il `?user=` SSE è un id profilo, non una credenziale.
  `rewriteMedia` in remote.ts converte gli URL nei JSON
- Musica sul telefono (`phoneLocal.ts`): IndexedDB `mh-phone` per i blob (condivisi tra
  profili: stesso file = stesso contenuto, entry con `u` = proprietario) + indice
  metadati PER-PROFILO `mh-phone-index:u<id>` in localStorage (le righe "solo telefono"
  di un profilo non compaiono nell'altro). MAI `getAll()` per elencare (materializza
  tutti i blob in RAM): usare `phoneReconcile()` (getAllKeys + riconcilia indice).
  Righe presenti solo sul telefono entrano in `library` con `phoneOnly: true` →
  niente azioni lato PC (like/eventi vanno per videoId, mai `library.*(id)`).
  Brani scaricati senza passare dal PC (search/like): `phoneVidId(videoId)` = id
  sintetico NEGATIVO (FNV-1a) — mai in collisione con gli id SQLite.
  `phoneMigrateId(from,to)` (in loadLibrary): brano scaricato con id sintetico che
  entra poi in libreria → il blob segue l'id reale, niente doppi download.
  QUOTA: `mh-phone-lru` (localStorage, cross-profilo: {id,addedAt,size}) traccia
  l'ordine dei download — QuotaExceededError in downloadToPhone →
  `phoneEvictOldest(need)` cancella i più vecchi e riprova UNA volta; lo store
  aggiorna badge/righe phoneOnly. Record legacy pre-LRU sono seedati addedAt:0
  (primi candidati all'eviction, com'è giusto). Proattiva: `navigator.storage.
  estimate()` a inizio download — sotto 64MB liberi l'eviction parte PRIMA.
  INTEGRITÀ: body troncato (TCP RST) → fetchTrackBlob torna null (fallback
  diretto); nel percorso diretto Content-Length≠size o <1KB → errore, MAI
  persistere blob "completi" fasulli. Indice localStorage non transazionale:
  la garanzia è phoneReconcile al boot (meta/`u` sono nel record IDB).
  PLAYBACK: `phoneAudioUrl` restituisce `/__phone/<id>` servito dal SERVICE WORKER
  (`public/sw.js`, già registrato in main.tsx) con Range support — NON un blob: URL.
  Motivo: l'audio mp4 di YouTube oggi arriva frammentato (DASH/fMP4, `ftyp dash` +
  sidx + moof/mdat); `<audio src=blob>` lo rifiuta (MEDIA_ELEMENT_SRC_NOT_SUPPORTED)
  e anche MSE lo scarta su WebView, mentre via HTTP(S) suona — il SW replica
  esattamente il delivery di googlevideo. Fallback a blob: se SW indisponibile
- Modalità autonoma (`renderer/src/direct.ts`): PC giù + telefono online → YouTube diretto
  via youtubei.js **`/web.bundle`** (chunk lazy `browser-*.js`): il dist multi-file
  crea circular import che Rollup appiattisce con ordine errato → TDZ
  "Cannot access 'TabbedFeed' before initialization" a runtime. MAI tornare a
  `import('youtubei.js')` nel renderer — lì dentro usare `youtubei.js/web.bundle`
  (types identici). `Innertube.create({generate_session_locally:false})`: la
  sessione reale (fetch sw.js_data) dà un visitorData emesso da YouTube — quello
  locale viene rifiutato dal GVS. Fetch custom `mhFetch`. Parsing InnerTube
  condiviso in `src/shared/ytparse.ts` (usato da ytmusic.ts e direct.ts — NON
  duplicare): `collect` fa MERGE dei duplicati (le pagine filtrate completano
  durata/album mancanti nel layout base a ItemSection singole), `finalizeSearch`
  (topResult con artist/duration dal sottotitolo, artista top propagato ai brani,
  correctedQuery), `applySearchFilters` (chips Brani/Album/Artisti/Playlist+
  video, cap per categoria), `rankArtists` (ascoltatori mensili > iscritti,
  dedupe per nome), `searchSuggestions` (chiamate `yt:searchSuggest` su IPC e
  `getSearchSuggestions` diretto — le suggestion vivono in sezioni annidate,
  mai iterare `s.contents` come item), `isEmptyPageError` (InnertubeError
  "Could not extract contents"/"tab" = pagina vuota → risultato vuoto onesto,
  NON errore). `search(query, expand=true)`: expand=false per lookup interni
  (stream healing, offlineRec, selftest) che non devono pagare i filtri.
  Fallback in remote.ts via `ytCall(remote, direct)`: scatta SOLO su
  errore di rete (isOnline=false), mai su errori applicativi del server.
  Stream: cascata client `getBasicInfo(id,{client})` — **TV_SIMPLY
  (TVHTML5_SIMPLY) è oggi il client che produce URL videoplayback NON gated**
  (206 anche sull'ultimo byte); ANDROID_VR/IOS/WEB v16-era sono quasi tutti
  gated (sps=2: solo il primo ~1MB servito, range a offset>0 → 403). OGNI URL
  candidato va VALIDATO con `probeStreamUrl` (Range sull'ultimo byte via clen)
  — un URL risolto non è detto che suoni. PoToken: `potoken.ts` (bgutils-js)
  minta content-bound (videoId) e GVS-bound (visitor ID decodificato da
  ProtoUtils.decodeVisitorData — NON il protobuf intero); la VM BotGuard e il
  decipher player (Platform.shim.eval) girano nell'iframe `public/po.html`
  (CSP permissiva scoped: la pagina principale vieta eval) — jintr NON basta
  per BotGuard (usa DOM/trustedTypes) e WebPoMinter.create è inutilizzabile
  cross-realm (instanceof Function): usiamo il minter inline. Diagnostica
  on-device: `window.__poDbg` (stage pipeline) e `window.__ytDbg` (per-client).
  Minter morto = stream gated che muoiono a ~1MB: `potTokenDown()` + evento
  DOM `mh-stream-warn` accendono il chip "stream a rischio" nel player;
  `mh-stream-phase` (resolve/heal/audius) mostra la fase durante il buffering.
  Senza minter la cascata taglia dopo 2 client tutti-probe-fallite (gatedBail):
  niente raffica di richieste Google né minuti di attesa muta.
  CORS: Innertube/googlevideo non mandano ACAO →
  nell'APK `mhFetch` usa `CapacitorHttp` (nativo); input può essere Request|URL|stringa —
  il method sta nel Request, il body in init. In browser il fallback diretto è degradata
  (playback <audio> ok, search/download no). ATTENZIONE alla risposta nativa
  (`HttpRequestHandler.readData`): con `responseType:'arraybuffer'` `data` NON è sempre
  base64 — Content-Type JSON arriva come oggetto GIÀ parsato (riserializzare), errori
  HTTP ≥400 non-JSON arrivano come testo grezzo dall'errorStream (niente atob), e status
  204/205/304 richiedono body null nella Response. Inoltre va SEMPRE rimosso
  `accept-encoding` dagli header inoltrati (youtubei.js dichiara gzip ma lo stack nativo
  non decomprime header espliciti — senza header OkHttp fa gzip trasparente da sé).
- Code offline (`pendingSync.ts`): like lib/remoti + eventi play/skip/hide +
  searchPick + listen(≥30s) + ops playlist (create/remove/rename/add/removeTrack/
  move + `createWith` composta per "salva scaletta") + `mh-pending-dl` (download
  sul PC, dedup per videoId) + `mh-pending-settings` (patch single-slot merged)
  fatti col PC spento restano in localStorage (`mh-pending-*:u<id>`, per profilo,
  last-write-wins, cap 100-300) → `drainPending()` al reconnect SSE prima del reload
  dati (trigger in App.tsx su onReconnected). `drainOne` fa merge anti-race (item
  accodati DURANTE il drain sopravvivono), salta id non risolvibili e droppa dopo
  3 tentativi (`__tries`) — ma il drop NON è più silenzioso: `drainPending`
  ritorna `{sent, dropped, resurrected}` e il toast al reconnect dichiara le
  modifiche perse. `DeadOp` = drop immediato per errori definitivi. Playlist
  LOCAL-FIRST: le playlist create offline hanno id temporaneo NEGATIVO
  (visibili subito in UI via overlay), la mappa `mh-pl-idmap:u<id>` sopravvive
  ai reload e rimappa ANCHE id positivi (playlist resuscitata, vedi sotto);
  al drain il `pl:create` ottiene l'id vero e TUTTE le op successive vengono
  riscritte col remap prima di partire. Le op su brani non in libreria usano
  `pl:addRef` (TrackRef completo: il PC scarica e aggiunge quando pronto via
  `playlist-pending.json` in userData — scadenza 30gg); su PC vecchi senza
  addRef il client ricade su `pl:add`. create+delete offline prima del drain →
  compattazione (le op si annullano e non partono mai).
  CONFLITTI (edit-vs-delete e concorrenza tra device):
  · Op su playlist eliminata sul PC → 'Playlist non trovata': remove/
    removeTrack/move/reorder = successo idempotente (obiettivo già raggiunto);
    rename/add/addRef → `resurrectPlaylist` ricrea la playlist dallo stato
    OVERLAY (cache+coda = ciò che l'utente vede), idMap rimappa le op restanti
    sul nuovo id. Mai più di una resurrezione per playlist per drain.
  · 'move' ±1 sul server divergerebbe sotto edit concorrenti → a fine drain si
    accoda un'op 'reorder' (pl:reorder, id QUEUE per l'overlay) con l'ordine
    snapshot preso AL SEND dell'ultimo move (la coda contiene ancora tutte le
    op → intento completo). Server: righe citate nell'ordine dato + non citate
    in coda — deterministico, l'ultimo drain vince (LWW documentato).
  · 'tasteReset' è un CONFINE TEMPORALE: i segnali gusti (like/eventi/listen)
    si drenano in due fasi — ts ≤ reset prima del reset (saranno azzerati,
    storia conservata), ts > reset dopo (senza sarebbero cancellati pur essendo
    successivi: le code sono separate e senza fasi il reset drenava sempre per
    ultimo). Item senza ts = post-reset (conservativo).
- Telemetria dal campo (`fieldDiag.ts`): `diag.report` fallito per rete giù si
  accoda in `mh-pending-issues` (cap 150) e risale al reconnect insieme a
  `mh-stream-clients` (cap 300 — un campione `{client,ms,ok,device}` per ogni
  tentativo-client della cascata streamUrl). `drainFieldDiag()` (chiamato dal
  resync in App.tsx) replica la semantica pendingSync: stop su errore di rete,
  retry budget ×2 sugli errori applicativi, merge-safe. Server: tabella
  `client_stats` + canale `diag:streamStats`; l'aggregato 7gg per client è in
  `IssueStats.clients` e nell'exportReport ("Client stream") — si legge quale
  client Innertube sta morendo senza aprire __ytDbg. `direct.ts` marca anche
  `stream-dead` quando l'HEAL riesce (il videoId originale entra in
  bad_streams e viene saltato in futuro) e segnala 'cascade' via
  `mh-stream-warn` dopo 3+ risoluzioni fallite di fila (chip "stream a
  rischio" nel player, cooldown 15min). fieldDiag non importa remote
  staticamente (remote→direct→fieldDiag sarebbe ciclo): il drain usa
  `import('./remote')` lazy.
- Fallback funzionalità server-side (`offlineRec.ts`): con PC spento rec.suggest/
  autoplaylist/stazioni/radio/assistente/trends si approssimano da libreria+like
  cachate + directSearch/directCharts/directUpNext. Le scalette generate dal PC
  si conservano in `mh-auto-cache:u<id>:<key>` (prima scelta offline), i trends in
  `mh-trends-cache:u<id>`. `addDownload`/`downloadToCd` a PC spento accodano in
  pendingSync invece di fallire; `settings.set` va in coda merged (toast onesto,
  mai finto successo). Il burn resta PC-only (hardware).
- Boot veloce col PC morto: `call()` ha timeout 10s + FAIL-FAST se `isOnline()===false`
  (mai attendere TCP timeout su host morto). Stato online persistito in `mh-was-online`:
  chi usa il telefono lontano dal PC riparte in modalità autonoma, il probe /api/info
  (timeout 5s) corregge se il PC è tornato. SSE è probe-first (`ensureEvents` →
  `probeRemoteHealth` → `openEvents`): MAI aprire EventSource su host non verificato.
  `syncPrefs()` ha reentrancy guard (boot + reconnect possono correre insieme) e il boot
  in main.tsx la limita a 3.5s. `warmup()` in direct.ts precarica Innertube in idle.
  Backoff reconnect ≤60s + pausa probe mentre `document.hidden` (batteria); se il base
  è CGNAT/Tailscale `probeOrder` riprova gli alts LAN prima (rielezione rotta migliore).
- Cache read-only remoto (`cached()` in remote.ts): `playlists.list` → `mh-pl-cache:u<id>`,
  `remoteLikes` → `mh-likes-cache:u<id>`; libreria → `mh-lib-cache:u<id>` (in store —
  il flag `liked` è per-utente, la chiave legacy non namespaced è migrata); Home →
  `mh-home-cache:u<id>`; settings → `mh-settings-cache`, users → `mh-users-cache`.
  Solo letture: le scritture offline falliscono o vanno in pendingSync.
  Ogni scrittura di cache marca `mh-cache-fresh:u<id>` (`markPcFresh()`/`pcFreshAt()`
  in remote.ts): il banner offline mostra "dati di <N> fa" — lo stato stale del
  boot a PC morto dichiara la sua età invece di fingersi attuale.
- PlayerBar: `srcOf` fa ping Range 0-0 (3s) al file del PC prima di fidarsi (finestra
  probe) e l'heal (`attemptHeal`, 1×/videoId/sessione) ripara ANCHE i filePath su
  remoto via copia telefono → stream diretto (skipPc). Watchdog: 30s senza
  loadedmetadata o 12s di stalled/waiting → heal/skip. Prefetch next-track salta in
  modalità autonoma e se il brano è già sul telefono.
- Protocollo /api/call (`call()` in remote.ts): risposta valida SOLO se contiene `r`
  o `e` — un 200 senza envelope (captive portal, proxy, body non-JSON) è errore di
  RETE (offline+probe), mai `undefined` risolto né 401 fasullo. Senza questo check
  le cache venivano avvelenate con la stringa "undefined" (playlist/like "persi"),
  prefs.set fingeva successo (dirty perso → valore vecchio del PC sovrascriveva la
  modifica → preferenze "perse") e yt.search risolveva undefined → `fast.songs` crash
- 401 tardiva (race): `resetToPairing`/`resetToProfilePick` NON cancellano né
  flaggano se la conf in localStorage ha un token DIVERSO da quello in memoria
  (`confRewritten()`) — una fetch in volo col vecchio token non può buttare un
  pairing più recente scritto nel frattempo
- Failover multi-indirizzo (`remote.ts` renderer): `conf.alts` imparato da `/api/info.alts`
  (il server pubblica TUTTI i suoi IP, LAN prima). Al failover va SEMPRE chiuso l'EventSource
  (`es.close(); es=null`) prima di `ensureEvents()`, altrimenti resta CONNECTING sul base morto
- Dev build lanciata come `electron out/main/index.js` usa userData `%APPDATA%/Electron`
  (nome app "Electron") → token remoto DIVERSO dall'installato (`%APPDATA%/masterhype`)
- Masterizzazione: UNA alla volta (`burnMutex` in burner.ts) — PC e telefono non possono
  avviare due burn insieme. `burn:start` ri-risolve le tracce per id dal DB: i client
  mandano solo metadati, mai fidarsi dei filePath remoti
- Server remoto: stream media SEMPRE con destroy su res 'close' (ogni seek abortisce la
  request → fd leak senza). `/api/prefs` accetta SOLO chiavi `mh-pref-*`
- DB: `PRAGMA foreign_keys = ON` obbligatorio (SQLite lo disattiva per connessione)
- Android: Capacitor 7 (`capacitor.config.ts`, webDir `out/renderer`), progetto in `android/`,
  `usesCleartextTraffic=true` nel manifest (il server LAN è http://). Plugin app-locale
  (non npm): `MediaSessionPlugin` + `PlaybackService` (foreground `mediaPlayback`, wake lock,
  noisy→pause) registrati in `MainActivity.onCreate`. JS: `nativeMedia.ts`
  (`initNativeMedia` in App.tsx, `pushMediaSession` da PlayerBar — solo URL http(s) per
  l'artwork, mai blob:) → azioni notifica/lockscreen/BT arrivano come eventi 'action'
  (seek via evento DOM `mh-media-seek`). Senza il servizio Android uccide il processo
  in background e l'audio si ferma — è la parità col tray-resident del PC.
  MAI richiedere audio focus nel servizio: Chromium/WebView lo gestisce già per <audio>
  e una requestAudioFocus parallela finisce in AUDIOFOCUS_LOSS ~1s dopo il play →
  l'emit('pause') si auto-pausa (bug reale v0.2.2). Chiamate/audiofocus li gestisce
  Chromium, non il servizio.
  VINCOLO STRUTTURALE (documentato, non bug): il decoder vive nella WebView —
  se l'OS uccide il RENDER process l'audio si ferma comunque; il servizio è una
  shell sopravvivenza+controlli, non un player. Mitigazione implementata:
  `onRenderProcessGone` → `renderCrashed` + `recreate()`; il servizio conserva
  l'ultimo stato in statici `last*` (videoId/playing/positionMs, azzerati in
  onDestroy) → `resumeState` plugin → `crashResume()` in App.tsx riparte il
  brano (match su videoId) e `mh-resume-seek` riporta la posizione a
  loadedmetadata. Niente auto-play su avvio normale (crashed si consuma a
  una lettura). Ripresa TOTALE richiederebbe un player nativo (ExoPlayer):
  non pianificato.
- E2E su emulatore: `adb forward tcp:9229 localabstract:webview_devtools_remote_<pid>` → CDP della WebView
- WebView < 99 (es. emulatori Android 12 stock) NON supporta @layer di Tailwind v4 → UI senza stili;
  su device reali la WebView si aggiorna da Play Store
- Tray-resident: chiudere la finestra NON esce (nasconde nel tray — il server resta su per il
  telefono). Uscita vera solo da tray → "Esci". `window-all-closed` non deve chiamare `app.quit()`
- Reconnect SSE (`remote.ts` renderer): `sawOffline` distingue il primo connect (boot) da una
  riconnessione vera — i callback `onReconnected` (syncPrefs, drainPending, reload) scattano SOLO
  se in sessione siamo stati offline, altrimenti il boot farebbe doppio lavoro
- Rete di sicurezza UI: `unhandledrejection` globale in store.ts → toast. Gli errori
  `offline`/`non configurato`/`unauthorized` sono attesi e NON toastano (ci pensa il banner).
  Le azioni utente importanti hanno comunque catch locali con messaggi contestuali
- `direct.ts` (modalità autonoma): `directPlayStream` replica l'auto-riparazione del PC
  (search per artista+titolo su videoId candidati) — non ridurla a streamUrl semplice.
  `mhFetch` (CapacitorHttp) readTimeout 300s perché porta anche i download MP3 interi
- Il filtro `mh-pref-*` è nell'HANDLER (`prefsSet` in handlers.ts), non solo nella route
  `/api/prefs` — `/api/call` e IPC desktop passano dalla stessa mappa

## Modalità "senza PC" (standalone) + auto-aggiornamento APK

- **Standalone**: `mh-standalone` in localStorage (remote.ts). `isStandalone()`
  = flag && nessuna conf — `isOnline()` è `online && !!conf` quindi in standalone
  è SEMPRE false → tutta la macchina offline esistente scatta da sola (ytCall→
  direct, cached()→copie locali, pendingSync accoda). `main.tsx`: `needsPairing`
  = `needsProfilePick() || (!hasRemoteConf() && !isStandalone())` — il gate si
  mostra SOLO al primo avvio vergine e lì "Continua senza PC" (`enterStandalone`)
  è la via di ingresso. Uscita: Impostazioni → "Collega un PC" (`exitStandalone`)
  → torna il gate. `clearRemoteConf` (Scollega) rimuove ANCHE il flag → gate.
- **Profilo virtuale u1**: in standalone `myUserId()`=1 → code/cache/indice
  telefono stanno sotto `:u1`. La migrazione si regge sul marcatore DUREVOLE
  `mh-standalone-era` (settato da enterStandalone, NON tolto da exitStandalone):
  al primo `saveRemoteConf` con profilo ≠1, `migrateStandaloneData` rinomina
  TUTTE le chiavi `:u1`→`:u<id>` (regex `:u1(?=:|$)` — non matcha `:u10`; mai
  sovrascrivere chiavi esistenti) e `mh-was-online`='0' fa sì che il primo SSE
  connect valga come riconnessione (sawOffline) → drainPending spedisce subito
  like/ascolti/playlist/download accumulati. L'era si consuma a ogni
  saveRemoteConf. Se il profilo scelto è 1, niente da migrare (drain comunque).
- **isOnline su desktop**: `isOnline() = isRemote() ? (online && !!conf) : true`
  — su desktop l'api è in-process e DEVE restare true: call site non gated da
  isRemote (store.downloadToPhone, coverUrl) si romperebbero altrimenti.
- **Banner/offline UI**: `OfflineBanner` solo se `isRemote() && hasRemoteConf()`
  (in standalone non c'è nessuno da "ritrovare"). Toast deferred-action usano
  `resyncWhen()` = 'quando colleghi un PC' / 'alla riconnessione'; messaggi di
  fallimento usano `pcGone()` = 'senza PC' / 'PC offline'. Like offline
  sopravvivono al restart: `loadRemoteLikes` mergia `pendingLikesMap()`+
  `pendingLikeEntries()` anche a fetch fallita. Selftest: "Server PC" →
  'senza PC — modalità autonoma' invece di errore. ProfilesCard in standalone
  mostra nota (profili gestiti sul PC). Uscite di sicurezza: `enterStandalone`
  ripulisce SEMPRE conf+`mh-pick-profile` (un profilo eliminato non intrappola),
  e lo step `pickFail` (profilo sparito + PC morto) offre "Continua senza PC".
  Audit: `node scripts/audit-standalone.mjs` (24 check CDP: gate, app diretta,
  like persistente, migrazione chiavi + coda like :u1→:u5, resyncWhen).
- **Auto-update APK**: `update.ts` (store `useUpdate`) interroga TUTTE le
  sorgenti e vince il versionCode più alto: PC pairato (`/update/manifest.json`
  con token), feed pubblico (vedi sotto), e — se il PC pairato è giù — un
  qualsiasi PC MasterHype scoperto in LAN via UDP (route /update pubbliche,
  niente token). Check a boot+reconnect+ogni 6h (silenzioso: 'available' mostra
  UpdateCard, 'uptodate' no) e manuale da Impostazioni. Il manifest serve
  `/update/app.apk` (o `url`/`file` nel json): `servedManifest` ricalcola
  sha256+size dal FILE reale (il json non è trusted); `file` passa da
  Canary anti-degrado (`parseHealth` in ytparse.ts): la ricerca conta gli item
  grezzi con videoId estraibile — pagina piena + zero risultati raccolti =
  parser incompatibile col layout Innertube (non "nessun risultato"): si
  riprova col percorso generico e, se resta vuoto, `SearchResult.degraded`
  (la UI dichiara "ricerca in difficoltà" invece di un vuoto fasullo).
  Vale per PC (ytmusic.search) e telefono (directSearch).
  `basename()` (anti path-traversal). Il plugin nativo scarica su cacheDir in
  streaming (non RAM), verifica sha256 e rifiuta file tronchi/vuoti prima di
  proporre l'install. `dismissUpdate` ricorda il versionCode ignorato
  (`mh-update-dismissed`); `minSupportedCode` > installato → update OBBLIGATORIO
  non ignorabile; `installUpdate` ritorna 'ok'|'permission'|'gone' — 'permission'
  arma un retry automatico al ritorno dalla pagina "installa app sconosciute"
  (visibilitychange, max 1 volta), 'gone' torna a 'available' e riscarica.
  Un check a download/ready in corso NON azzera lo stato; un errore NON fa
  sparire l'update (card 'error' con Riprova). Test E2E HTTP reale in
  tests/update-source.test.ts (manifest JSON, byte APK, 404, traversal).
- **Feed pubblico** (`src/shared/updateFeed.ts`): DEFAULT_UPDATE_FEED =
  GitHub Releases `musalova/masterhype` → `releases/latest/download/` serve
  sempre gli asset della release più recente (latest.yml, Setup.exe+blockmap,
  app-update.json, APK — caricati da release.mjs con GH_TOKEN). Repo PUBBLICO
  obbligatorio (asset privati richiedono auth). `settings.updateUrl` =
  override manuale per feed alternativi (Impostazioni → Aggiornamenti, MAI
  accettato da remoto: `settings:set` lo filtra lato server). Il PC annuncia
  il feed effettivo in `/api/info.updateFeed` → il telefono lo memorizza
  (`FEED_KEY`) e lo usa anche lontano dal PC / senza pairing. Override test:
  `mh-update-url` in localStorage (URL manifest completo).
- **Auto-update EXE** (`src/main/services/appUpdate.ts`, electron-updater):
  stesso feed (`latest.yml` + Setup.exe + .blockmap — il manifest è quello di
  electron-builder, sha512 verificato dalla libreria). Provider `generic`,
  autoDownload + autoInstallOnAppQuit (si installa all'uscita dal tray), check a
  boot+20s e ogni 6h, MAI in dev (`!app.isPackaged` → phase 'disabled' onesto) e
  MAI durante una masterizzazione (installAppUpdate rifiuta se isBurning).
  `app:updInstall` è desktop-only (deny-list remota: riavvia il PC-server).
  Stato broadcast via `app:updEvent` → `useDesktopUpdate` + UpdateCard
  ("Più tardi" = installazione silenziosa alla prossima uscita).
- **Dati locali standalone** (`renderer/src/localData.ts`): store per-profilo
  (`mh-local-*:u<id>`) per gusti, statistiche, recenti, diagnostica e backup del
  dispositivo — popolati dai segnali raccolti offline (like, play) e dai download
  sul telefono; usati dagli schermi quando `cached()` non ha copie dal PC.
- **File sul telefono** (`FilesPlugin.java`, app-locale): saveFile/openFile
  via Storage Access Framework → backup export/import e report diagnostici
  funzionano in standalone senza dialog nativi del PC (`renderer/src/files.ts`
  sceglie plugin nativo vs download browser vs dialog IPC).
- **Coda download PC persistente** (`downloader.ts`): i job queued/in-progress
  sopravvivono al riavvio dell'app (stato serializzato in userData, dedup per
  videoId, job stale/malformati scartati al load).
- **Dati preservati in update**: l'install è update-in-place (ACTION_VIEW +
  FileProvider, stesso applicationId) → Android conserva TUTTO: localStorage
  (conf, standalone flag, code pending, prefs), IndexedDB (download sul
  telefono), service worker. UNICO rischio di wipe: installare un APK firmato
  con chiave DIVERSA (Android rifiuta → serve disinstallazione = dati persi).
  `versionCode` +1 a build impedisce anche il downgrade (rifiutato da Android).
- **Firma APK (`keystore.properties`)**: la release è `assembleRelease` firmata
  da `android/keystore/masterhype-release.keystore` via `android/keystore.properties`
  (entrambi gitignored, NON committare). Il keystore contiene **la stessa chiave
  privata** del `~/.android/debug.keystore` originario (copiata + password/alias
  cambiati — la firma dipende solo dalla chiave) → update seamless dai vecchi
  debug-signed e niente `debuggable` nell'APK distribuito.
  ⚠️ **BACKUP OFF-REPO OBBLIGATORIO**: copiare `android/keystore/` +
  `android/keystore.properties` in un posto sicuro (USB/cloud cifrato). Perderli
  = ogni telefono deve disinstallare e perde IndexedDB/pairing/pref. Se su un
  nuovo PC mancano, `build-android.mjs` ricade su `assembleDebug` (warning
  stampato) — gli update su quella firma FALLISCONO sui telefoni esistenti.
- **Plugin nativo `AppUpdate`** (app-locale come MediaSession): `info` (versionCode
  dal PackageManager), `download` (HttpURLConnection su thread dedicato →
  cacheDir/mh-update.apk, eventi 'progress', verifica sha256 rifiutando file
  tronchi/mismatch — niente install di file corrotti), `install` (FileProvider →
  ACTION_VIEW vnd.android.package-archive; Android 8+ `canRequestPackageInstalls`
  → apre "installa app sconosciute" e risponde needsPermission → l'utente riprova).
  Permesso `REQUEST_INSTALL_PACKAGES` nel manifest; `cache-path` già in
  `file_paths.xml`. Registrato in MainActivity.
- **Build**: `build-android.mjs` auto-bump `versionCode` (+1 a build, è il
  comparatore dell'update) + allinea `versionName` a package.json + pubblica
  APK rinominato `MasterHype-Android.apk` + `app-update.json` in `release/` e
  `%APPDATA%/masterhype/apk` + `%APPDATA%/MasterHype/apk` (dev/installato).
  Serve JDK 21-23.

## Pairing telefono — tre percorsi, zero digitazione obbligatoria

- **Auto-scoperta UDP**: `src/main/discovery.ts` broadcasta `MH1|porta|hostname`
  su :48485 ogni 2.5s (255.255.255.255 + broadcast di ogni sottorete) finché
  `remoteEnabled`; il plugin nativo `DiscoveryPlugin.java` (DatagramSocket +
  MulticastLock — molti driver Wi-Fi filtrano i broadcast senza lock) notifica
  `found {host,port,name}` → ConnectGate mostra il PC trovato. Il pacchetto NON
  contiene il token (un annuncio falsificato porta solo a un handshake fallito).
- **Finestra "Accoppia telefono"** (`src/main/pairing.ts`, puro/testato):
  `POST /pair` è l'UNICA route senza token; consegna `{t: token}` solo se la
  finestra è aperta (90s, da Impostazioni → Telefono o `pairing:open` via
  /api/call — admin-only da remoto: un device non può aprirla da solo per
  ri-legarsi). Il token consegnato è un DEVICE TOKEN fresco (mintato in
  remote.ts, user_id NULL) — NON il codice condiviso. Rate-limit
  2s/IP + max 5 consegne; ogni consegna broadcasta `pairing:used` → toast sul
  PC ("Pixel 8 collegato") = rilevamento pairing estraneo → "Rigenera" nella
  card rigenera il codice condiviso (scollega solo chi lo usa ancora — i
  device col proprio token si revocano singolarmente dalla lista in Impostazioni).
  Se la finestra è chiusa `/pair` risponde 403 e il gate riprova da solo ogni
  2.5s finché l'utente preme il bottone sul PC (max 3min).
- **QR in-app — codice MONOUSO**: il QR è `http://ip:porta/?pair=<code>` dove
  `code` è mintato da `pairing:code` (admin-only, `mintPairCode` in pairing.ts):
  TTL 5min, consumato al primo riscatto, max 3 in vita, solo in memoria. Una
  foto del QR non regala più la credenziale admin. Il telefono riscatta via
  `POST /pair {code}` → device token (finestra non serve: il codice È
  l'autorizzazione). Scansionato dalla fotocamera di sistema apre il browser:
  `redeemPairParam()` in main.tsx riscatta `?pair=` e porta alla scelta
  profilo. `?token=` legacy (codice condiviso) resta accettato da
  `parsePairPayload`/`loadConf` → upgrade immediato a device token.
  `parsePairPayload` accetta `?pair=`/`?p=` + `?token=`/`?t=` legacy —
  un QR arbitrario non può dirottare il pairing. Permesso CAMERA nel manifest;
  `BridgeWebChromeClient` di Capacitor 7 gestisce già onPermissionRequest →
  grant VIDEO_CAPTURE (niente codice Java custom per la camera).
- Manuale (host+codice) resta ripiegato in "Inserimento manuale" — fallback per
  reti con broadcast/AP-isolation (dove però anche /pair fallirebbe → il QR
  è lì per questo). Test: `tests/pairing.test.ts` (finestra, rate-limit,
  parse QR, /pair E2E http vero, broadcast UDP loopback reale).
- `isOnline`/`isStandalone`/migrazione `:u1→u<id>`: invariati — tutti i nuovi
  percorsi convergono su `finishPair` → `upgradeToDeviceToken` (il codice
  condiviso del QR/manuale diventa un device token; quello da /pair lo è già)
  → scelta profilo → `claimOnBase` (device:claim) → `saveRemoteConf` con il
  device token. La gestione dei device (lista, riassegna profilo, revoca) è la
  card DevicesList in Impostazioni → Telefono (desktop/admin).

## Stazioni/radio — list-first (stile Spotify), MAI autoplay al click

- Le card delle stazioni NON avviano la riproduzione: `openStation(sel)` setta
  `store.stationSel` + nav('stations') → Stations.tsx mostra la scaletta
  (StationDetail) con Riproduci/Mescola/Rigenera. Il play è solo esplicito:
  `playStation(tracks)` o la singola riga (`TrackRow radio` prop → `play(...,true)`).
  `startStation`/`startRadio` restano per compat ma non vanno collegati a card.
- `stationSel` copre anche le radio dinamiche: `{kind:'radio', radioKind:'artist'|'genre', value}`.
  Search (radio artista) e Home (poster + quick tile) usano `openStation`, mai play diretto.
- Quick tile Home con `autoId` → `openAutoList(id)` → nav('playlists') +
  `store.autoOpen` consumato da Playlists.tsx (lista autogenerata, no autoplay).
- Freschezza scalette: `stationFilter`/`candOk` (recommend.ts) escludono i ~30
  brani suonati di recente e quelli a saldo negativo, entrambi su titolo BASE
  (un remaster non aggira uno skip); le scalette sono ordinate a finestre
  mescolate (`windowShuffle`) → ogni apertura/Rigenera propone una scaletta
  diversa senza perdere il ranking.
- Motore v2 (recommend.ts): `TasteCtx` = UNO snapshot dei gusti per generazione
  (pesi artista × contesto orario, tag/generi, blocchi fuzzy — "X" blocca anche
  "X feat. Y", affinità per brano). Pipeline: candidati multi-fonte → scoring
  → SOLO i top risolvono videoId via `vid_cache` (DB, TTL 14gg / 2gg per le
  negative) → interlaccio round-robin per artista. `stationForYou` ranka i
  simili da co-ascolti + Deezer + Last.fm; `radioForArtist` tiene ~1/3 di seed
  DISTRIBUITO; `radioForGenre` boosta gli artisti del tag già nei gusti;
  `stationNovita` usa rank chart + tag/co-occorrenze (funziona anche senza
  chiave Last.fm); le stazioni generiche hanno un "tilt" (`STATION_TAGS`):
  artisti del profilo coerenti col tema entrano in scaletta.
- `rec:next` = continuazione radio col contesto: `stationCtx` in PlayerState
  ('station:<id>' | 'radio:artist:<n>' | 'radio:genre:<tag>', settato da
  playStation/startStation/startRadio, azzerato da un play non-stazione) →
  `radioNext` chiama `rec.next` (upNext filtrato sui gusti + ancora al seme),
  fallback `yt.upNext` nudo. Offline: `offlineContinue` (offlineRec.ts) replica
  filtro/ordine con `localTaste` + `localSkipKeys` (localData.ts) — stessa
  chiave `trackBaseKey` per skip/hide/unlike accodati.
- Audit live: `node scripts/audit-stations.mjs` (13 check CDP: lista, no autoplay,
  play esplicito, radio infinita, back, radio genere), `node scripts/audit-spotify.mjs`
  (17 check: liked-list, mix genere, sidebar, enqueue, sleep timer, tile Sfoglia,
  radio default ON) e `node scripts/tmp/audit-stations-v2.mjs` (15 check su
  user-data-dir isolato: pertinenza gusti, blocco fuzzy, seed ~30%, rec:next,
  vid_cache — NON tocca l'istanza installata).

## Feature Spotify-like (dove vivono)

- `autoPlaylist` in recommend.ts accetta: `'top'|'nuove'|'liked'`, `artist:<n>`,
  `genre:<tag>` (mix di genere — i "Daily Mix"). La card "Brani che ti piacciono"
  è pinned in Playlists (`LIKED`) e in sidebar (LibrarySection).
- Sidebar "La tua libreria" (`LibrarySection` in Sidebar.tsx): preferiti pinned +
  playlist → `openAutoList('liked')` / `openPlaylistById(id)` (deep-link: lo store
  porta `autoOpen`/`plSel`, consumati da Playlists.tsx — pattern one-shot: il
  consumer deve resettare a null).
- `enqueue(t)` nello store = "Aggiungi in coda" (dedup su videoId E artist|title).
- Sleep timer: `sleepAt`/`sleepEndOfTrack`/`setSleepTimer` nello store; la pausa
  "a fine brano" è consumata in PlayerBar `onEnded` (se lo aggiungi altrove,
  consuma il flag UNA sola volta). UI: SleepTimer in PlayerBar + MobileSleep in
  NowPlaying (la barra lo nasconde su mobile).
- `player.radio` default ON + persistito in `mh-pref-player` (autoplay Spotify).
  `radioNext` dedup-a e trima la coda (25 brani dietro l'indice).
- Menu ⋮ universale di TrackRow: coda, radio artista, playlist, CD.

## Player/ricerca — trappole risolte in review critica (non reintrodurle)

- **Crossfade vs repeat 'one'**: il fade di coda (onTime, ultimi 6s) chiama
  `playAt(ni)` → con repeat='one' la ripetizione spariva di soppiatto.
  Regola: `repeat==='one'` MAI avvia crossfade in onTime (onEnded riparte da 0).
- **MediaSession/notifica stale**: `stopSession()` DEVE essere chiamato quando
  `player.current` diventa undefined (PlayerBar effect su [videoId,playing]) —
  senza di essa la notifica/lockscreen Android resta appesa al brano morto.
  Anche `navigator.mediaSession.metadata = null` a coda svuotata.
- **Search debounce**: `lastQ.current` si aggiorna DENTRO `doSearch` — se lo
  settano i caller (cronologia/top-artist chips) uno si dimentica e il debounce
  ri-spara la fetch a 450ms. TopResult 'song' NON è detto sia in res.songs
  (dedup YT): `openTop` ha un TrackRef sintetico di fallback — senza, il tap
  su "Risultato principale" non faceva nulla.
- **Pattern touch**: `opacity-0 group-hover:opacity-100` lascia i bottoni
  INVISIBILI MA TAPPABILI su mobile (coda in NowPlaying, swap/togli in
  Assistant, dismiss in Downloads) → su azioni reali aggiungere sempre
  `max-md:opacity-100` (o l'intero pannello `max-md:hidden` di proposito).
- **Onestà messaggi standalone**: un catch di `addDownload`/`importFiles` scatta
  SOLO a PC vivo (offline non rilancia — accoda) → il toast non può dare la
  colpa al PC. Toast bulk ("avviati"/"in preparazione") devono distinguere
  job reali da `pending-*` accodati e non navigare a schermate vuote.
- **Unhandled rejection sweep**: ogni `api().*().then(setX)` vuole il `.catch`
  (a PC morto le call rifiutano); anche nei boundary (diag.report) e nel
  drag&drop import.

## Installer NSIS (build/installer.nsh) — trappole risolte, NON reintrodurle

- **MAI pacchettare node_modules con build intermediates**: `resources\app.asar.unpacked`
  con path >260 char (es. `@capacitor/android\...\*.class`) fa abortire il VECCHIO
  uninstaller in update: `uninstallOldVersion` lo lancia silent → `atomicRMDir` rinomina
  ogni file in `$PLUGINSDIR\old-install` → destinazione >MAX_PATH → `Abort` → exit 2 →
  l'installer riprova 5 volte → dialog "MasterHype non può essere chiuso" in loop
  infinito (messaggio fuorviante: vale per QUALSIASI fallimento, non solo processi).
  `@capacitor/**` è escluso in `files` di electron-builder.yml — mantenerlo.
- `customInit` (in .onInit, PRIMA delle pagine) fa `_mhPrepare $INSTDIR`: taskkill /F
  dell'app (tray-resident: WM_CLOSE non basta) + kill per-path di TUTTO ciò sotto
  INSTDIR (yt-dlp/ffmpeg orfani in resources\bin) + attesa ~15s + pre-delete di
  `app.asar.unpacked` via **robocopy /MIR** (rd/Remove-Item falliscono su path >260).
- `customCheckAppRunning` sostituisce il check electron-builder di default: quello
  originale attende solo ~4s (2 giri) mentre l'albero Electron impiega ~5-6s a morire
  → falso "cannot be closed". La nostra versione kill+attende ~15s, niente dialog.
- `customUnInstallCheck` fa Return senza check d'errore: se il vecchio uninstaller
  esce non-zero l'update prosegue comunque (i file nuovi vengono copiati sopra).
- Diagnostica riusabile in `scripts/`: `diag-installer.ps1`, `diag-locks.ps1`,
  `inspect-installer.ps1`, `inspect-uninstaller.ps1`, `drive-uninst.ps1`,
  `test-update-running.ps1` (update /S con app running — exit 0 atteso).

## Vincoli ambiente

- Windows, Node 24, ffmpeg su PATH; NO python/dotnet SDK/rust
- `ELECTRON_RUN_AS_NODE=1` può essere settato dall'IDE → Electron gira come Node: rimuoverlo sempre
- BurnHelper: solo C# 5 (no `=>` membri, no `$""`, no `?.`)
- Spotify API nuove app: `/recommendations`, `/related-artists`, `/audio-features` vietati → similarità via Last.fm/Deezer
- Masterizzazione testabile solo con masterizzatore USB collegato
