import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { openPairingWindow, pairingOpenLeft, tryPair, mintPairCode, PAIR_WINDOW_MS, PAIR_CODE_TTL_MS } from '../src/main/pairing';
import { startDiscovery, stopDiscovery, announcePayload, broadcastAddrs, DISCOVERY_PORT } from '../src/main/discovery';
import { parsePairPayload } from '../src/shared/paircode';

// Pairing guidato: la finestra "Accoppia telefono" è l'unico momento in cui
// /pair consegna il token. Chiusa → mai. Rate-limit + cap per finestra.

describe('pairing window', () => {
  beforeEach(() => { openPairingWindow(0); }); // reset: finestra scaduta subito

  it('chiusa → niente token', () => {
    expect(tryPair('1.2.3.4', 'Pixel', 'TOK')).toEqual({ ok: false, reason: 'closed' });
  });

  it('aperta → consegna il token; closed fuori finestra', () => {
    openPairingWindow(500);
    expect(pairingOpenLeft()).toBeGreaterThan(0);
    expect(tryPair('1.2.3.4', 'Pixel', 'TOK')).toEqual({ ok: true, token: 'TOK' });
  });

  it('rate-limit: stesso IP entro 2s → limited', () => {
    openPairingWindow();
    expect(tryPair('1.2.3.4', 'a', 'TOK').ok).toBe(true);
    expect(tryPair('1.2.3.4', 'b', 'TOK')).toEqual({ ok: false, reason: 'limited' });
    expect(tryPair('5.6.7.8', 'c', 'TOK').ok).toBe(true); // altro IP ok
  });

  it('cap consegne: max 5 per finestra', () => {
    openPairingWindow();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now); // salta il rate-limit temporale
    const ips = ['1', '2', '3', '4', '5'];
    for (const ip of ips) expect(tryPair(ip, 'x', 'TOK').ok).toBe(true);
    expect(tryPair('6', 'x', 'TOK').ok).toBe(false);
    vi.restoreAllMocks();
  });

  it('riaprire la finestra resetta cap e rate-limit', () => {
    openPairingWindow(0);
    expect(tryPair('9.9.9.9', 'x', 'TOK').ok).toBe(false);
    openPairingWindow(60_000);
    expect(tryPair('9.9.9.9', 'x', 'TOK').ok).toBe(true);
  });
});

describe('codici monouso QR (?pair=)', () => {
  beforeEach(() => { openPairingWindow(0); }); // finestra chiusa

  it('il codice autorizza da solo, senza finestra aperta', () => {
    const code = mintPairCode();
    expect(tryPair('1.2.3.4', 'Pixel', 'TOK', code)).toEqual({ ok: true, token: 'TOK' });
  });

  it('monouso: il secondo riscatto fallisce anche col codice giusto', () => {
    const code = mintPairCode();
    expect(tryPair('1.2.3.4', 'a', 'TOK', code).ok).toBe(true);
    expect(tryPair('5.6.7.8', 'b', 'TOK', code).ok).toBe(false); // consumato
  });

  it('codice inventato/scaduto → closed; il rate-limit non brucia un codice valido', () => {
    expect(tryPair('1.2.3.4', 'a', 'TOK', 'codice-inesistente').ok).toBe(false);
    const code = mintPairCode(50);
    // scade tra 50ms
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(tryPair('9.9.9.9', 'a', 'TOK', code).ok).toBe(false); // scaduto
      const fresh = mintPairCode();
      // raffica dallo stesso IP: prima ok, seconda 'limited' ma codice intatto
      expect(tryPair('2.2.2.2', 'a', 'TOK', fresh).ok).toBe(true);
      resolve();
    }, 60));
  });

  it('TTL: mintPairCode con scadenza passata non riscatta', () => {
    const dead = mintPairCode(0);
    expect(tryPair('3.3.3.3', 'a', 'TOK', dead).ok).toBe(false);
    void PAIR_CODE_TTL_MS;
  });
});

describe('discovery UDP broadcaster', () => {
  it('payload nel formato MH1|porta|host', () => {
    expect(announcePayload(48484, 'DESKTOP-X').toString()).toBe('MH1|48484|DESKTOP-X');
  });
  it('calcola i broadcast di sottorete (192.168.x.255 ecc.)', () => {
    const addrs = broadcastAddrs();
    expect(addrs[0]).toBe('255.255.255.255');
    expect(addrs.every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))).toBe(true);
  });
  // Loopback broadcast su Windows arriva ai socket locali bindati sulla porta:
  // prova end-to-end del lato PC (lato telefono = DiscoveryPlugin.java).
  it('un listener sulla 48485 riceve l\'annuncio', async () => {
    const rx = createSocket({ type: 'udp4', reuseAddr: true });
    const got = new Promise<string | null>((resolve) => {
      const to = setTimeout(() => resolve(null), 4000);
      rx.on('message', (m) => { clearTimeout(to); resolve(m.toString()); });
      rx.on('error', () => { clearTimeout(to); resolve(null); });
    });
    await new Promise<void>((r) => rx.bind(DISCOVERY_PORT, r));
    try {
      startDiscovery(() => 48484, undefined, () => 'TESTPC');
      const pkt = await got;
      stopDiscovery();
      expect(pkt).toMatch(/^MH1\|48484\|TESTPC$/);
    } finally {
      stopDiscovery();
      rx.close();
    }
  }, 8000);
});

describe('parsePairPayload (QR)', () => {
  it('URL http del QR monouso (?pair=)', () => {
    expect(parsePairPayload('http://192.168.1.20:48484/?pair=Ab3_xYz9'))
      .toEqual({ base: 'http://192.168.1.20:48484', pair: 'Ab3_xYz9', token: undefined });
  });
  it('URL http del QR legacy ?token= (codice condiviso)', () => {
    expect(parsePairPayload('http://192.168.1.20:48484/?token=Ab3_xYz9'))
      .toEqual({ base: 'http://192.168.1.20:48484', pair: undefined, token: 'Ab3_xYz9' });
  });
  it('mh://pair deep-link (p= monouso, t= legacy)', () => {
    expect(parsePairPayload('mh://pair?h=192.168.1.20:48484&p=Ab3_xYz9'))
      .toEqual({ base: 'http://192.168.1.20:48484', pair: 'Ab3_xYz9', token: undefined });
    expect(parsePairPayload('mh://pair?h=192.168.1.20:48484&t=Ab3_xYz9'))
      .toEqual({ base: 'http://192.168.1.20:48484', pair: undefined, token: 'Ab3_xYz9' });
  });
  it('rifiuta QR arbitrari / senza token / schemi strani', () => {
    expect(parsePairPayload('https://youtube.com/watch?v=x')).toBeNull();
    expect(parsePairPayload('http://192.168.1.20:48484/')).toBeNull();
    expect(parsePairPayload('javascript:alert(1)')).toBeNull();
    expect(parsePairPayload('ciao')).toBeNull();
    expect(parsePairPayload('')).toBeNull();
    expect(parsePairPayload('file:///etc/passwd?token=abcdef')).toBeNull();
    expect(parsePairPayload('mh://pair?h=javascript:evil&t=abcdef')).toBeNull();
  });
});

// E2E reale: la route /pair è dentro createServer di remote.ts (Electron) —
// qui si replica la stessa logica montata su un http server vero per
// verificare il contratto wire (200 {t} / 403 / 429) che il client consuma.
describe('route /pair (contratto HTTP)', () => {
  it('consegna il token solo a finestra aperta', async () => {
    openPairingWindow(0);
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (d) => { data += d; });
      req.on('end', () => {
        const body = JSON.parse(data || '{}') as { name?: string };
        const r = tryPair(req.socket.remoteAddress ?? '?', body.name, 'TOK42');
        res.writeHead(r.ok ? 200 : r.reason === 'closed' ? 403 : 429,
          { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.ok ? { t: r.token } : { e: 'pairing chiuso' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const post = () => fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pixel 8' }),
    });
    try {
      let res = await post();
      expect(res.status).toBe(403); // chiusa
      openPairingWindow(PAIR_WINDOW_MS);
      res = await post();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ t: 'TOK42' });
      res = await post();
      expect(res.status).toBe(429); // rate-limit stesso IP
    } finally {
      server.close();
    }
  });
});
