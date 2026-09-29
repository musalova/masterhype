// Feed pubblico degli aggiornamenti (EXE + APK): una cartella HTTP(S) statica
// con i file di release/feed/. Default = GitHub Releases: `latest/download`
// serve sempre l'asset omonimo della release più recente — latest.yml, il
// Setup .exe (+blockmap), app-update.json e l'APK convivono come 5 asset della
// STESSA release vX.Y.Z (caricati da release.mjs via GH_TOKEN).
// Il repo deve essere PUBBLICO: su repo privato gli asset richiedono auth.
// settings.updateUrl resta override manuale (feed privato, test).
export const DEFAULT_UPDATE_FEED = 'https://github.com/musalova/masterhype/releases/latest/download';

// URL base del feed senza slash finale; '' se non è un http(s) valido.
export function normalizeFeed(raw: string | undefined | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    u.hash = '';
    u.search = '';
    return u.href.replace(/\/+$/, '');
  } catch { return ''; }
}

// Manifest APK dentro il feed (stesso formato servito dal PC su /update)
export function feedApkManifest(feed: string): string {
  const f = normalizeFeed(feed);
  return f ? `${f}/app-update.json` : '';
}
