import { createSocket, Socket } from 'node:dgram';
import { networkInterfaces, hostname } from 'node:os';

// Auto-discovery LAN: il PC annuncia "sono qui" via broadcast UDP ogni 2.5s.
// Il telefono (plugin nativo Discovery) ascolta la porta 48485 e mostra il PC
// nella schermata di pairing senza digitare nessun indirizzo.
//
//   pacchetto: MH1|<portaHttp>|<hostname>   (es. "MH1|48484|DESKTOP-MARIA")
//
// In chiaro deliberatamente: NON contiene il token — il pairing vero passa
// dalla finestra /pair o dal QR. Un annuncio falsificato porta al massimo un
// tap verso un host che poi fallisce l'handshake /pair o la verifica
// /api/info (testConnection): il telefono non può essere "pairato" a un
// server estraneo senza il token vero.
//
// Si invia a 255.255.255.255 E ai broadcast di ogni sottorete: alcuni router
// non inoltrano il broadcast globale tra interfacce.
//
// Nessuna dipendenza Electron: porta e hostname arrivano dal chiamante
// (remote.ts) → il modulo è testabile in vitest con un socket UDP reale.

export const DISCOVERY_PORT = 48485;
const INTERVAL_MS = 2_500;
const MAGIC = 'MH1';

let sock: Socket | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function announcePayload(port: number, host: string): Buffer {
  return Buffer.from(`${MAGIC}|${port}|${host}`, 'utf8');
}

export function broadcastAddrs(): string[] {
  const addrs = ['255.255.255.255'];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family !== 'IPv4' || n.internal || !n.netmask) continue;
      const ip = n.address.split('.').map(Number);
      const mask = n.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some((x) => !Number.isInteger(x))) continue;
      addrs.push(ip.map((o, i) => o | (255 - mask[i])).join('.'));
    }
  }
  return [...new Set(addrs)];
}

export function startDiscovery(getPort: () => number, onErr?: (e: unknown) => void, getHost: () => string = hostname): void {
  if (sock) return;
  const announce = () => {
    if (!sock) return;
    const msg = announcePayload(getPort(), getHost());
    for (const addr of broadcastAddrs()) {
      try { sock.send(msg, DISCOVERY_PORT, addr); } catch { /* interfaccia giù */ }
    }
  };
  try {
    sock = createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { stopDiscovery(); onErr?.(e); });
    sock.bind(() => {
      try { sock?.setBroadcast(true); } catch { /* */ }
      announce();
      timer = setInterval(announce, INTERVAL_MS);
    });
  } catch (e) {
    onErr?.(e);
    sock = null;
  }
}

export function stopDiscovery(): void {
  if (timer) { clearInterval(timer); timer = null; }
  try { sock?.close(); } catch { /* */ }
  sock = null;
}
