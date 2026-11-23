// Allowlist host per il relay CORS dell'equalizzatore: il relay serve SOLO
// gli stream musicali (googlevideo = YouTube, nodi Audius) — non deve
// diventare un proxy aperto raggiungibile da pagine web sullo stesso device.
export const EQ_RELAY_HOSTS = ['googlevideo.com', 'audius.co', 'youtube.com'];

export const eqRelayAllowed = (hostname: string): boolean =>
  EQ_RELAY_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));

// Target del relay → b64url (renderer) e b64url → target (relay).
export const gsEncode = (url: string): string => {
  const b = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(url)))
    : Buffer.from(url, 'utf8').toString('base64');
  return b.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

export const gsDecode = (b64: string): string | null => {
  try {
    const s = Buffer.from(b64, 'base64url').toString('utf8');
    const u = new URL(s);
    return u.protocol === 'https:' && eqRelayAllowed(u.hostname) ? s : null;
  } catch { return null; }
};
