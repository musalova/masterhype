import { describe, it, expect, vi, beforeEach } from 'vitest';

// Il sistema di preferenze (persist.ts) è il cuore di "l'APK memorizza le
// preferenze": localStorage immediato per TUTTE le mh-pref-*, push al DB del
// PC solo per la whitelist condivisa (SHARED_PREF_KEYS = tracklist CD),
// dirty list per le scritture condivise offline + hydrate delle sole condivise.

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
        if (v == null) state.db.delete(k); // null = DELETE (come prefsSet server)
        else state.db.set(k, JSON.stringify(v));
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
  it('chiave condivisa: localStorage + push al PC + dirty pulita', async () => {
    persist.savePref('mh-pref-cdqueue', [1, 2]);
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([1, 2]);
    await Promise.resolve(); // flush microtask/promise
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(state.db.get('mh-pref-cdqueue')!)).toEqual([1, 2]);
    expect(dirtyList()).toEqual([]);
  });

  it('chiave del dispositivo: localStorage e basta — niente push né dirty', async () => {
    persist.savePref('mh-pref-libsort', 'title');
    expect(JSON.parse(LS.getItem('mh-pref-libsort')!)).toBe('title');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.db.has('mh-pref-libsort')).toBe(false); // mai arrivata al PC
    expect(dirtyList()).toEqual([]);
  });

  it('PC spento: la condivisa marca dirty, quella del dispositivo resta solo locale', async () => {
    state.online = false;
    persist.savePref('mh-pref-cdqueue', [7]);
    persist.savePref('mh-pref-accent', 'ocean');
    await new Promise((r) => setTimeout(r, 0));
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([7]);
    expect(dirtyList()).toEqual(['mh-pref-cdqueue']);
    expect(JSON.parse(LS.getItem('mh-pref-accent')!)).toBe('ocean');
    expect(dirtyList()).not.toContain('mh-pref-accent'); // le locali non si sporcano
    expect(state.db.size).toBe(0);
  });

  it('la scrittura locale notifica i consumer (mh-pref-live)', async () => {
    persist.savePref('mh-pref-vibe', 'chill');
    await new Promise((r) => setTimeout(r, 0));
    expect(state.events.some((e) => e.k === 'mh-pref-vibe')).toBe(true);
  });
});

describe('syncPrefs — push dirty + hydrate solo delle condivise', () => {
  it('al reconnect spinge la condivisa sporca e idrata la condivisa del PC', async () => {
    // Scrittura condivisa offline
    state.online = false;
    persist.savePref('mh-pref-cdqueue', [3, 4]);
    await new Promise((r) => setTimeout(r, 0));
    expect(dirtyList()).toContain('mh-pref-cdqueue');

    state.online = true;
    await persist.syncPrefs();

    expect(JSON.parse(state.db.get('mh-pref-cdqueue')!)).toEqual([3, 4]);
    expect(dirtyList()).not.toContain('mh-pref-cdqueue');
  });

  it('hydrate NON tocca le chiavi del dispositivo — e ne cancella le copie stale dal PC', async () => {
    // Il telefono ha le SUE scelte; il PC ne ha altre (scritte da una vecchia versione)
    LS.setItem('mh-pref-accent', '"ocean"');
    LS.setItem('mh-pref-libsort', '"title"');
    state.db.set('mh-pref-accent', JSON.stringify('sunset'));
    state.db.set('mh-pref-libsort', JSON.stringify('recent'));
    state.db.set('mh-pref-cdqueue', JSON.stringify([9])); // condivisa: questa sì che vale

    await persist.syncPrefs();

    // Le scelte del dispositivo non sono state sovrascritte da quelle del PC
    expect(JSON.parse(LS.getItem('mh-pref-accent')!)).toBe('ocean');
    expect(JSON.parse(LS.getItem('mh-pref-libsort')!)).toBe('title');
    // La tracklist CD condivisa invece si idrata
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([9]);
    // Le copie stale non condivise sono state spazzate dal DB
    expect(state.db.has('mh-pref-accent')).toBe(false);
    expect(state.db.has('mh-pref-libsort')).toBe(false);
    expect(state.db.has('mh-pref-cdqueue')).toBe(true);
  });

  it('hydrate NON sovrascrive una condivisa sporca col valore vecchio del PC', async () => {
    state.db.set('mh-pref-cdqueue', JSON.stringify([1])); // PC: [1]
    state.online = false;
    persist.savePref('mh-pref-cdqueue', [2]); // noi: [2], mai arrivata
    await new Promise((r) => setTimeout(r, 0));

    state.online = true;
    await persist.syncPrefs();
    // Push prima → il PC ora ha [2] e il locale resta [2]
    expect(JSON.parse(state.db.get('mh-pref-cdqueue')!)).toEqual([2]);
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([2]);
  });

  it('una condivisa rifiutata dal server resta dirty; le non-condivise si liberano', async () => {
    // Dirty list cucita a mano (savePref non sporca più le non-condivise)
    LS.setItem(DIRTY, JSON.stringify(['mh-pref-cdqueue', 'mh-pref-x']));
    LS.setItem('mh-pref-cdqueue', '[5]');
    LS.setItem('mh-pref-x', '3');

    state.failSet.add('mh-pref-cdqueue'); // il server rifiuta la condivisa
    await persist.syncPrefs();

    // cdqueue non è partita e resta dirty per il prossimo giro;
    // x (non condivisa) si è dis-dirty-ata senza push
    expect(state.db.has('mh-pref-cdqueue')).toBe(false);
    expect(state.db.has('mh-pref-x')).toBe(false);
    expect(dirtyList()).toEqual(['mh-pref-cdqueue']);
    // Ma i valori locali non sono stati persi
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([5]);
    expect(JSON.parse(LS.getItem('mh-pref-x')!)).toBe(3);
  });
});

describe('cambio profilo — i valori offline sopravvivono', () => {
  it('archiveDirtyValues + restore al rientro', async () => {
    state.online = false;
    persist.savePref('mh-pref-cdqueue', [8]); // u1, mai partito
    await new Promise((r) => setTimeout(r, 0));

    persist.archiveDirtyValues();            // parcheggia sotto mh-dval:u1:
    persist.clearLocalPrefs();               // svuota la vista (chiavi condivise)
    expect(LS.getItem('mh-pref-cdqueue')).toBeNull();
    expect(dirtyList()).toContain('mh-pref-cdqueue'); // dirty list resta

    // Rientro di u1: il valore archiviato torna e viene spinto al PC
    state.online = true;
    await persist.syncPrefs();
    expect(JSON.parse(LS.getItem('mh-pref-cdqueue')!)).toEqual([8]);
    expect(JSON.parse(state.db.get('mh-pref-cdqueue')!)).toEqual([8]);
    expect(LS.getItem('mh-dval:u1:mh-pref-cdqueue')).toBeNull();
  });

  it('clearLocalPrefs toglie solo le condivise: dispositivo e dirty altrui restano', () => {
    LS.setItem('mh-pref-dirty:u2', JSON.stringify(['mh-pref-x']));
    LS.setItem('mh-pref-cdqueue', '[1]');
    LS.setItem('mh-pref-libsort', '"title"'); // pref del dispositivo: sopravvive
    persist.clearLocalPrefs();
    expect(LS.getItem('mh-pref-cdqueue')).toBeNull();
    expect(JSON.parse(LS.getItem('mh-pref-libsort')!)).toBe('title');
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
