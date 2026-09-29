# MasterHype — Analisi completa del prodotto

**Versione:** 0.1.0 · **Piattaforma:** Windows (Electron) · **Codebase:** ~7.700 righe TypeScript/React · **Stato:** funzionante, installer firmato

---

## 1. Che cos'è MasterHype

MasterHype è un desktop player musicale che fa una cosa che nessun mainstream fa più: **ricerca → ascolto in streaming → download MP3 320kbps → organizzazione → masterizzazione su CD per l'auto**, il tutto in un'unica app con interfaccia moderna in italiano.

Il posizionamento è una nicchia concreta: chi ha un'autoradio con lettore CD (o CD-MP3) e vuole compilare compilation aggiornate senza destreggiarsi tra siti di download, convertitori online e software di burning separati.

### Flusso d'uso tipo

1. Cerco un brano (o apro una stazione, un trend, una playlist autogenerata)
2. Lo ascolto subito in streaming — senza scaricare nulla
3. Metto like → il motore impara
4. "+ CD" → download automatico in MP3 320 con tag e copertina
5. CD Builder → "Masterizza" → CD audio con CD-Text o CD MP3

---

## 2. Anatomia — componente per componente

### Processo main (`src/main/`)

| Modulo | LOC | Cosa fa | Stato |
|---|---|---|---|
| `db.ts` | 135 | SQLite (node:sqlite) — tracks, playlist, eventi, profilo gusti, tag artisti, trend cache, CD masterizzati, like remoti, **telemetria** | Solido, con migrazioni e soft-delete/undo |
| `settings.ts` | 48 | settings.json persistente | Ok |
| `ipc.ts` | 208 | ~40 canali IPC tipizzati | Ok; la ricerca qui **filtra stream difettosi e boosta le scelte passate** |
| `services/ytmusic.ts` | 431 | InnerTube (youtubei.js) — ricerca, artisti, album, playlist, charts, upNext | Parsing difensivo, dedup, topResult, "forse cercavi" |
| `services/downloader.ts` | 438 | yt-dlp+ffmpeg: download → loudnorm → MP3 320 + tag + cover; stream/video URL; **playStream auto-riparante**; import file locali | Robusto, 2 job paralleli, retry client alternativo |
| `services/library.ts` | 339 | Libreria, like locali/remoti, eventi gusto, playlist, M3U export | Ok |
| `services/recommend.ts` | 624 | Motore gusti: scoring multi-segnale, stazioni, radio artista/genere, assistente NL, autogenerate | Il cuore "cynic" dell'app |
| `services/sources.ts` | 322 | Deezer, Last.fm (cache 7gg), Spotify OAuth PKCE, testi LRCLIB | Ok |
| `services/trends.ts` | 75 | Trend radar Italia (Deezer/Last.fm/YT) | Ok |
| `services/telemetry.ts` | 126 | **Auto-miglioramento**: log errori, stream difettosi, scelte di ricerca | Nuovo |
| `services/burner.ts` | 200 | IMAPI2 via BurnHelper.exe (C#5/.NET4) — audio CD + CD-Text + data CD + erase | Testabile solo con drive USB |

### Renderer (`src/renderer/src/`)

| Componente | LOC | Note |
|---|---|---|
| `store.ts` | 444 | Zustand: player (queue/shuffle/repeat/radio/crossfade), download, CD, like, contesto ricerca; preferenze tutte persistenti |
| `App.tsx` | 170 | Shell, lazy-screen + prefetch chunk, drag&drop, shortcut, media keys |
| `PlayerBar.tsx` | 476 | Doppio `<audio>` per crossfade reale (fine brano + manuale), seek, radio infinita, auto-riparazione on-error, coda |
| `NowPlaying.tsx` | 228 | Video muto sync ≤720p + testi LRCLIB karaoke cliccabili + tab coda |
| `Shelf.tsx`, `TrackRow.tsx`, `Sidebar.tsx`, `Backdrop.tsx` | ~380 | Poster Netflix-style con hover-zoom, righe ottimizzate a selettori, ambient discoteca GPU-friendly |
| Schermate | ~2.300 | Home (hero + shelf), Stazioni (24 card), Cerca (live+recenti+gusti), Libreria (lista/griglia), Playlist (+autogenerate), CD Builder, Trend Radar, Assistente NL, Download, Impostazioni (+profilo gusti + diagnostica) |

### Stack

React 19 · TypeScript 5.9 · Tailwind v4 · Framer Motion · Zustand · Electron 38 · youtubei.js · yt-dlp/ffmpeg/ffprobe bundled · node:sqlite · NSIS installer firmato.

---

## 3. La concorrenza

Non esiste **un** competitor diretto che copra tutto il flusso. La concorrenza è frammentata per fase:

| Concorrente | Dove compete | Dove perde contro MasterHype |
|---|---|---|
| **Spotify / YouTube Music / Apple Music** | Scoperta, streaming, gusti, radio | Non scaricano MP3 liberi, non masterizzano, catalogo chiuso in DRM |
| **iTunes / Apple Music Win / Windows Media Player** | Libreria + burning CD audio | Esperienza datata, niente discovery moderna, WMP deprecato |
| **Nero / CDBurnerXP / ImgBurn** | Masterizzazione | Zero musica dentro: devi procurarti i file altrove |
| **yt-dlp GUI / convertitori online (YTMP3 ecc.)** | Download da YouTube | Siti pieni di ads/malware, niente tag/cover/libreria, niente burning |
| **Telegram bot / app downloader varie** | MP3 veloci | Qualità incerta, zero gestione, zona grigia |
| **Feishin / Nuclear / Harmony** | Streaming YouTube desktop open-source | Ottimi player ma niente download organizzato né burning né CD-Text né motore gusti italiano |
| **MediaMonkey / MusicBee** | Libreria potente + burning | UI anni 2000, curva d'apprendimento, niente streaming discovery |

**Il punto forte competitivo di MasterHype:** è l'unico che copre *tutta* la catena con UX moderna. Spotify ti fa scoprire, Nero ti fa masterizzare, yt-dlp ti fa scaricare — MasterHype fa tutte e tre le cose in un click continuo.

---

## 4. Pro e contro a confronto

### PRO (vs concorrenza)

- **Catena completa unica** — streaming → download 320 → tag+cover → CD-Text → burn, senza uscire dall'app
- **Motore gusti "cinico"** — pesi positivi/negativi da like, dislike, skip, play, download, CD masterizzati; penalizza davvero (non solo positività come molti recommender deboli); artisti penalizzati visibili e azzerabili
- **Stazioni e radio vere** — 24 stazioni per mood/genere/decennio + radio per artista e genere infinite via Last.fm/Deezer
- **Playlist autogenerate** stile Spotify (mix personale, più ascoltate, scoperte, nuove uscite, mix per artista) rigenerate sui gusti
- **Assistente in italiano** — prompt libero "rock anni 90 per un viaggio con Ligabue, senza Jovanotti" → tracklist con durata target CD e quota scoperte
- **Auto-miglioramento reale** — telemetria su errori, stream difettosi auto-riparati con ricerca alternativa, ricerca che impara le scelte e filtra i videoId rotti
- **Now Playing** con video sincronizzato muto + karaoke LRCLIB cliccabile
- **Preferenze tutte persistenti**, performance curate (selettori Zustand, lazy loading, code-split, animazioni solo transform/opacity, reduced-motion)
- **Installer NSIS firmato** con grafica dedicata, splash animato

### CONTRO (onestà tecnica)

- **Dipendenza da yt-dlp/InnerTube** — YouTube cambia le API di continuo; è una corsa gatto-e-topo. Mitigato da fallback multi-client e auto-riparazione, ma un aggiornamento yt-dlp richiede un rilascio
- **Zona grigia ToS** — scaricare da YouTube viola i suoi termini di servizio (uso personale, ma è un rischio di distribuzione)
- **Solo Windows** — niente macOS/Linux
- **Streaming a bassa qualità percepita** — l'anteprima usa `bestaudio` (~128-160kbps opus); ok per scegliere, meno per ascolto esigente
- **Niente account/cloud sync** — profilo gusti e libreria vivono solo sul PC (pro privacy, contro multi-device)
- **Electron** — ~200MB di RAM idle; accettabile ma non nativo
- **Copertura test** — 43 test sui servizi core, ma zero test E2E UI automatici (verifiche via CDP manuali/script)
- **Burner non testabile in CI** — richiede drive ottico fisico
- **Niente playlist collaborative/social**, niente podcast, niente offline mode "vero" per le tracce remote

---

## 5. Come migliorarlo (priorità motivata)

### P0 — Impatto alto, sforzo basso

1. **Auto-update yt-dlp** — scaricare l'ultimo yt-dlp.exe al primo avvio o su check settimanale → riduce drasticamente i "problemi di riproduzione" senza nuove release dell'app. *Perché:* è la fonte n.1 di fragilità.
2. **Gapless/stream qualità alta per i brani in libreria** già c'è (file locale); per lo streaming si potrebbe preferire formati opus ~160k espliciti. *Perché:* percezione qualità.
3. **Undo/cestino per playlist** e conferma su azioni distruttive — già c'è per i file, estenderlo.
4. **Error boundary React** — un errore in una schermata oggi può piantare la shell. *Perché:* robustezza percepita.

### P1 — Impatto alto, sforzo medio

5. **Rilevamento autoradio MP3 vs audio CD** — suggerire "CD MP3" automaticamente se la tracklist sfora 80 min. *Perché:* errore d'uso più comune.
6. **Normalizzazione loudness anche in preview** — volume costante tra stream diversi (oggi varia per traccia).
7. **Export/backup profilo gusti + libreria** in file → portabilità tra PC e reinstallazioni. *Perché:* il profilo è il vero asset accumulato.
8. **Test E2E automatizzati** (Playwright-Electron o gli script CDP già scritti resi stabili in CI) — *Perché:* regressioni silenti su 10 schermate sono già capitate (navigazione congelata).

### P2 — Impatto medio-alto

9. **Modalità "CD in un click"** — dall'assistente direttamente a burn con conferma unica.
10. **Equalizzatore audio reale** (Web Audio API sui file locali) — credibile per un'app "car audio".
11. **macOS/Linux** — l'unica parte Windows-specifica è BurnHelper (IMAPI2): astrarre dietro interfaccia (`drutil`/`cdrdao`) apre le piattaforme.
12. **Telemetria opt-in aggregata** — se il progetto cresce, capire dove falliscono gli stream *sul campo* (oggi è solo locale).

### P3 — Lungo termine

13. **Sorgenti alternative a YouTube** (Jamendo, Audius, Free Music Archive) — riduce la dipendenza singola e il rischio ToS.
14. **Companion mobile / QR share** della scaletta.
15. **ReplayGain tags** nei MP3 per autoradio che lo supportano.

---

## 6. Verdetto

MasterHype è **tecnicamente più completo di ogni alternativa nella sua nicchia**: nessun'altra app unisce discovery moderna, motore gusti con penalizzazioni, download MP3 curato e burning con CD-Text. I punti deboli reali sono la dipendenza da componenti esterni che YouTube può rompere (mitigata ma non eliminata), la mono-piattaforma e la zona grigia ToS. La direzione migliore è investire in **resilienza** (auto-update yt-dlp, sorgenti alternative) e **portabilità del profilo** — il valore accumulato dell'utente sta nel suo profilo gusti, non nel catalogo.
