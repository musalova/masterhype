import { describe, it, expect } from 'vitest';
import { gsEncode, gsDecode, eqRelayAllowed, EQ_RELAY_HOSTS } from '../src/shared/eqRelay';

// Il relay CORS dell'equalizzatore non deve diventare un proxy aperto:
// accetta solo URL https verso gli host di stream musicali reali.
describe('eqRelay — allowlist', () => {
  it('accetta googlevideo, audius e i loro sottodomini', () => {
    expect(eqRelayAllowed('rr2---sn-abc.googlevideo.com')).toBe(true);
    expect(eqRelayAllowed('googlevideo.com')).toBe(true);
    expect(eqRelayAllowed('audius-content-2.creatornode.audius.co')).toBe(true);
    expect(eqRelayAllowed('youtube.com')).toBe(true);
  });

  it('rifiuta host arbitrari e suffix-spoofing', () => {
    expect(eqRelayAllowed('example.com')).toBe(false);
    expect(eqRelayAllowed('googlevideo.com.evil.it')).toBe(false);
    expect(eqRelayAllowed('notgooglevideo.com')).toBe(false);
    expect(eqRelayAllowed('192.168.1.5')).toBe(false);
    expect(eqRelayAllowed('localhost')).toBe(false);
    expect(eqRelayAllowed('')).toBe(false);
  });
});

describe('eqRelay — encode/decode roundtrip', () => {
  const gv = 'https://rr1---sn-x.googlevideo.com/videoplayback?expire=1&sig=abc%2Fdef+ghi&range=0-100';

  it('l\'encode produce b64url sicuro in path/query (no +, /, =)', () => {
    const enc = gsEncode(gv);
    expect(enc).not.toMatch(/[+/=]/);
    expect(gsDecode(enc)).toBe(gv);
  });

  it('rifiuta http (solo https), host non allowlist, spazzatura', () => {
    expect(gsDecode(gsEncode('http://rr1.googlevideo.com/x'))).toBeNull();
    expect(gsDecode(gsEncode('https://evil.example.com/x'))).toBeNull();
    expect(gsDecode('non-e\'-b64!!!')).toBeNull();
    expect(gsDecode('')).toBeNull();
  });
});

describe('eqRelay — copertura host', () => {
  it('gli host coperti sono quelli attesi', () => {
    expect(EQ_RELAY_HOSTS).toContain('googlevideo.com');
    expect(EQ_RELAY_HOSTS).toContain('audius.co');
  });
});
