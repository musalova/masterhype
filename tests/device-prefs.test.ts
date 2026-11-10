import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regressione del bug "il telefono riproduce ma non si sente": volume e muto
// erano chiavi mh-pref-* condivise PC↔telefono — uno 0 o un muto scritto dal
// PC azzerava l'audio del telefono, dove non esisteva alcun controllo per
// rimediarlo. Ora sono mh-device-* : vivono solo sul dispositivo.

// ---- localStorage stub (identico a persist.test.ts) ----
function mkStorage() {
  const data = new Map<string, string>();
  const store: Record<string | symbol, unknown> = {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
  };
  Object.defineProperty(store, 'length', { get: () => data.size });
  return new Proxy(store, {
    ownKeys: (t) => [...Reflect.ownKeys(t), ...data.keys()],
    getOwnPropertyDescriptor: (t, k) =>
      data.has(k as string)
        ? { enumerable: true, configurable: true, value: data.get(k as string) }
        : Reflect.getOwnPropertyDescriptor(t, k),
    get: (t, k) => {
      if (k === 'length') return data.size;
      if (k in t) return t[k];
      return data.get(k as string) ?? undefined;
    },
    set: (t, k, v) => {
      if (typeof k === 'string' && !(k in t)) { data.set(k, String(v)); return true; }
      t[k] = v; return true;
    },
    deleteProperty: (_t, k) => { data.delete(k as string); return true; },
  });
}

const state = vi.hoisted(() => ({
  db: new Map<string, string>(),          // la tabella prefs del PC
  online: true,
  reconCbs: [] as (() => void)[],
  events: [] as string[],                  // chiavi notificate via mh-pref-live
  setCalls: [] as string[],                // chiavi spinte al server
  user: 1,
}));

vi.mock('../src/renderer/src/remote', () => ({
  isRemote: () => true,
  isOnline: () => state.online,
  myUserId: () => state.user,
  onReconnected: (fn: () => void) => { state.reconCbs.push(fn); return () => {}; },
}));

vi.mock('../src/renderer/src/api', () => ({
  api: () => ({
    prefs: {
      set: (k: string, v: unknown) => {
        if (!state.online) return Promise.reject(new Error('offline'));
        state.setCalls.push(k);
        state.db.set(k, JSON.stringify(v));
        return Promise.resolve();
      },
      getAll: () => {
        if (!state.online) return Promise.reject(new Error('offline'));
        const out: Record<string, unknown> = {};
        for (const [k, v] of state.db) { try { out[k] = JSON.parse(v); } catch { /* */ } }
        return Promise.resolve(out);
      },
      onEvent: (_cb: (p: { k: string; v: unknown; u?: number }) => void) => () => {},
    },
  }),
}));

vi.stubGlobal('localStorage', mkStorage());
vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } });
vi.stubGlobal('window', {
  dispatchEvent: (e: { detail?: unknown }) => { state.events.push(String((e as { detail?: unknown }).detail)); return true; },
  addEventListener: () => {}, removeEventListener: () => {},
});

const persist = await import('../src/renderer/src/persist');
const sp = await import('../src/renderer/src/storePersist');

const LS = localStorage;
const DIRTY = 'mh-pref-dirty:u1';

beforeEach(() => {
  LS.clear();
  state.db.clear();
  state.online = true;
  state.events.length = 0;
  state.setCalls.length = 0;
  state.user = 1;
});

describe('saveDevice — scrive solo sul dispositivo', () => {
  it('localStorage + notifica live, mai il server né la dirty list', async () => {
    persist.saveDevice('mh-device-volume', 0.4);
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(LS.getItem('mh-device-volume')!)).toBe(0.4);
    expect(state.events).toContain('mh-device-volume');
    expect(state.setCalls).toEqual([]);
    expect(state.db.size).toBe(0);
    expect(LS.getItem(DIRTY)).toBeNull();
  });
});

describe('savedVolume — chiave device, seed e clamp', () => {
  it('senza chiave device eredita l ultimo valore condiviso', () => {
    LS.setItem('mh-pref-volume', '0.35');
    expect(sp.savedVolume()).toBe(0.35);
  });
  it('la chiave device vince sul valore condiviso — anche a 0 (scelta vera)', () => {
    LS.setItem('mh-pref-volume', '0.9');
    LS.setItem('mh-device-volume', '0');
    expect(sp.savedVolume()).toBe(0);
  });
  it('uno 0 ereditato dal PC non è una scelta: torna il default (la trappola)', () => {
    LS.setItem('mh-pref-volume', '0');
    expect(sp.savedVolume()).toBe(0.8);
  });
  it('valori corrotti → default, mai NaN né oltre 1', () => {
    LS.setItem('mh-device-volume', '"abc"');
    expect(sp.savedVolume()).toBe(0.8);
    LS.setItem('mh-device-volume', '2');
    expect(sp.savedVolume()).toBe(1);
  });
});

describe('savedMuted — non eredita il muto del PC', () => {
  it('un mh-pref-muted rimasto in locale non muta il dispositivo', () => {
    LS.setItem('mh-pref-muted', 'true');
    expect(sp.savedMuted()).toBe(false);
  });
  it('legge solo la chiave device', () => {
    LS.setItem('mh-device-muted', 'true');
    expect(sp.savedMuted()).toBe(true);
  });
});

describe('isolamento dalle preferenze condivise', () => {
  it('syncPrefs idrata mh-pref-* ma non legge né sovrascrive mh-device-*', async () => {
    LS.setItem('mh-device-volume', '0.6');
    LS.setItem('mh-device-muted', 'false');
    // Il PC ha i valori che rendevano il telefono muto
    state.db.set('mh-pref-volume', '0');
    state.db.set('mh-pref-muted', 'true');
    state.db.set('mh-pref-accent', '"ocean"');
    await persist.syncPrefs();
    // Hydrate è avvenuta per le chiave condivise…
    expect(JSON.parse(LS.getItem('mh-pref-accent')!)).toBe('ocean');
    // …ma lo stato effettivo del dispositivo è intatto
    expect(sp.savedVolume()).toBe(0.6);
    expect(sp.savedMuted()).toBe(false);
  });
  it('clearLocalPrefs (cambio profilo) non porta via le chiavi del dispositivo', () => {
    LS.setItem('mh-device-volume', '0.6');
    LS.setItem('mh-device-muted', 'true');
    LS.setItem('mh-pref-volume', '0.9');
    persist.clearLocalPrefs();
    expect(LS.getItem('mh-device-volume')).not.toBeNull();
    expect(LS.getItem('mh-device-muted')).not.toBeNull();
    expect(LS.getItem('mh-pref-volume')).toBeNull();
  });
});
