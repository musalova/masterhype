import { describe, it, expect, vi, beforeEach } from 'vitest';

// Il sistema di preferenze condivise (persist.ts) è il cuore di "l'APK
// memorizza le preferenze": localStorage immediato + push al DB del PC +
// dirty list per le scritture offline + hydrate che non clobbera il dirty.

// ---- localStorage stub (Object.keys compatibile) ----
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

// ---- api/remote mock: il "PC" è una prefs-map in memoria ----
const state = vi.hoisted(() => ({
  db: new Map<string, string>(),          // la tabella prefs del PC
  failSet: new Set<string>(),             // chiavi che il server rifiuta
  online: true,
  reconCbs: [] as (() => void)[],
  events: [] as { k: string; v: unknown }[],
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
        if (state.failSet.has(k)) return Promise.reject(new Error('chiave non valida'));
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
// window/CustomEvent minimi: savePref notifica i consumer via 'mh-pref-live'
vi.stubGlobal('CustomEvent', class { type: string; detail: unknown; constructor(t: string, i?: { detail?: unknown }) { this.type = t; this.detail = i?.detail; } });
vi.stubGlobal('window', {
  dispatchEvent: (e: { detail?: unknown }) => { state.events.push({ k: String((e as { detail?: unknown }).detail), v: null }); return true; },
  addEventListener: () => {}, removeEventListener: () => {},
});

const persist = await import('../src/renderer/src/persist');
const pending = await import('../src/renderer/src/pendingSync');

const LS = localStorage;
const DIRTY = 'mh-pref-dirty:u1';
const dirtyList = (): string[] => JSON.parse(LS.getItem(DIRTY) ?? '[]') as string[];

beforeEach(() => {
  LS.clear();
  state.db.clear();
  state.failSet.clear();
  state.online = true;
  state.events.length = 0;
  state.user = 1;
});

describe('savePref — la preferenza si memorizza SEMPRE', () => {
  it('online: localStorage + push al PC + dirty pulita', async () => {
    persist.savePref('mh-pref-volume', 0.5);
    expect(JSON.parse(LS.getItem('mh-pref-volume')!)).toBe(0.5);
    await Promise.resolve(); // flush microtask/promise
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(state.db.get('mh-pref-volume')!)).toBe(0.5);
    expect(dirtyList()).toEqual([]);
  });

  it('PC spento: scrive in locale e marca dirty — nessuna perdita', async () => {
    state.online = false;
    persist.savePref('mh-pref-accent', 'ocean');
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(LS.getItem('mh-pref-accent')!)).toBe('ocean');
    expect(dirtyList()).toContain('mh-pref-accent');
    expect(state.db.has('mh-pref-accent')).toBe(false);
  });

  it('la scrittura locale notifica i consumer (mh-pref-live)', async () => {
    persist.savePref('mh-pref-vibe', 'chill');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.events.some((e) => e.k === 'mh-pref-vibe')).toBe(true);
  });
});

describe('syncPrefs — push dirty + hydrate senza clobber', () => {
  it('al reconnect spinge le chiavi sporche e idrata le altre', async () => {
    // Scrittura offline
    state.online = false;
    persist.savePref('mh-pref-volume', 0.3);
    await new Promise((r) => setTimeout(r, 0));
    expect(dirtyList()).toContain('mh-pref-volume');

    // Nel frattempo il PC ha un valore diverso per un'altra chiave
    state.db.set('mh-pref-accent', JSON.stringify('midnight'));

    // PC torna: sync = push dirty + hydrate
    state.online = true;
    await persist.syncPrefs();

    // Il nostro volume offline ha vinto (è stato pushato)
    expect(JSON.parse(state.db.get('mh-pref-volume')!)).toBe(0.3);
    expect(dirtyList()).not.toContain('mh-pref-volume');
    // E l'accent del PC è arrivato in locale
    expect(JSON.parse(LS.getItem('mh-pref-accent')!)).toBe('midnight');
  });

  it('hydrate NON sovrascrive una chiave sporca col valore vecchio del PC', async () => {
    state.db.set('mh-pref-motion', JSON.stringify('off')); // PC: off
    state.online = false;
    persist.savePref('mh-pref-motion', 'on'); // noi: on, mai arrivata
    await new Promise((r) => setTimeout(r, 0));

    state.online = true;
    await persist.syncPrefs();
    // Push prima → il PC ora ha 'on' e il locale resta 'on'
    expect(JSON.parse(state.db.get('mh-pref-motion')!)).toBe('on');
    expect(JSON.parse(LS.getItem('mh-pref-motion')!)).toBe('on');
  });

  it('una chiave rifiutata dal server non affama le altre (no break)', async () => {
    state.online = false;
    persist.savePref('mh-pref-a', 1);
    persist.savePref('mh-pref-bad', 2);
    persist.savePref('mh-pref-c', 3);
    await new Promise((r) => setTimeout(r, 0));

    state.online = true;
    state.failSet.add('mh-pref-bad'); // il server rifiuta questa chiave
    await persist.syncPrefs();

    // a e c sono partite comunque; bad resta dirty per il prossimo giro
    expect(state.db.has('mh-pref-a')).toBe(true);
    expect(state.db.has('mh-pref-c')).toBe(true);
    expect(dirtyList()).toEqual(['mh-pref-bad']);
    // Ma il valore locale di bad non è stato perso
    expect(JSON.parse(LS.getItem('mh-pref-bad')!)).toBe(2);
  });
});

describe('cambio profilo — i valori offline sopravvivono', () => {
  it('archiveDirtyValues + restore al rientro', async () => {
    state.online = false;
    persist.savePref('mh-pref-volume', 0.9); // u1, mai partito
    await new Promise((r) => setTimeout(r, 0));

    persist.archiveDirtyValues();            // parcheggia sotto mh-dval:u1:
    persist.clearLocalPrefs();               // svuota la vista (chiavi logiche)
    expect(LS.getItem('mh-pref-volume')).toBeNull();
    expect(dirtyList()).toContain('mh-pref-volume'); // dirty list resta

    // Rientro di u1: il valore archiviato torna e viene spinto al PC
    state.online = true;
    await persist.syncPrefs();
    expect(JSON.parse(LS.getItem('mh-pref-volume')!)).toBe(0.9);
    expect(JSON.parse(state.db.get('mh-pref-volume')!)).toBe(0.9);
    expect(LS.getItem('mh-dval:u1:mh-pref-volume')).toBeNull();
  });

  it('clearLocalPrefs non tocca le dirty list degli altri profili', () => {
    LS.setItem('mh-pref-dirty:u2', JSON.stringify(['mh-pref-x']));
    LS.setItem('mh-pref-volume', '0.4');
    persist.clearLocalPrefs();
    expect(LS.getItem('mh-pref-volume')).toBeNull();
    expect(LS.getItem('mh-pref-dirty:u2')).not.toBeNull();
  });
});

describe('queueSettings — patch impostazioni offline', () => {
  it('single-slot merged: le chiavi scritte per ultime vincono', () => {
    pending.queueSettings({ audioQuality: '320' });
    pending.queueSettings({ normalizeAudio: true });
    pending.queueSettings({ audioQuality: '192' }); // riscrive la prima
    const q = JSON.parse(LS.getItem('mh-pending-settings:u1')!) as { patch: Record<string, unknown> }[];
    expect(q).toHaveLength(1);
    expect(q[0].patch).toEqual({ audioQuality: '192', normalizeAudio: true });
  });
});
