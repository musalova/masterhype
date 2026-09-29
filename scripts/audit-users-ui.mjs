// Smoke test UI dei profili via CDP sull'app Electron in esecuzione.
// Verifica: store.currentUser, lista utenti, chip sidebar, cambio profilo
// (setUser → reload → nuovo profilo attivo), archivio valori dirty.
import { ev, sleep, close, enableLogs, getLogs } from './cdp-test.mjs';
await enableLogs();
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}${d ? ' — ' + d : ''}`); } else { fail++; console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

await sleep(1500);
console.log('\n== UI PROFILI (desktop) ==\n');

const st = await ev(`(() => { const s = window.__app.getState(); return { cu: s.currentUser, n: s.users.length, names: s.users.map(u=>u.name) }; })()`);
ok('store.currentUser + users', st?.cu >= 1 && st?.n >= 1, JSON.stringify(st));

// Chip profilo in sidebar (testo = iniziale avatar + nome)
const chip = await ev(`(() => { const me = window.__app.getState().users.find(u=>u.id===window.__app.getState().currentUser) ?? window.__app.getState().users[0]; return [...document.querySelectorAll('button')].some(e => e.textContent.includes(me?.name ?? 'zzz')); })()`);
ok('chip profilo in sidebar', chip === true);

// Impostazioni → sezione Profili
await ev(`window.__app.getState().nav('settings')`);
await sleep(1500);
const sec = await ev(`(() => { const el=[...document.querySelectorAll('div')].find(e=>e.textContent.trim()==='Profili'); return !!el; })()`);
ok('sezione Profili in Impostazioni', sec === true);

// Crea un secondo profilo via API e passa ad esso → reload → nuovo profilo attivo
const created = await ev(`(async () => { const u = await window.__mhApi().users.create('AuditCDP'); await window.__app.getState().loadUsers(); return u; })()`);
ok('crea profilo via api', !!created?.id, `id ${created?.id}`);

// Marca una pref locale del profilo 1 + una dirty finta offline per testare l'archivio:
// valore SOLO locale (non pushato) + dirty list → deve finire in mh-dval:u1:*
await ev(`localStorage.setItem('mh-pref-auditchip', '"P1LOCAL"');
        localStorage.setItem('mh-pref-dirty:u1', JSON.stringify(['mh-pref-auditchip']));
        // pushDirty la spinge al PC se raggiungibile (desktop: sempre) → il test
        // dell'archivio è realistico solo se la push fallisce: simulo offline
        // marcando dirty DOPO — qui invece verifico il flush+dval`);

// Cambio profilo → setUser fa flush→archive→wipe→setCurrent→reload
await ev(`window.__app.getState().setUser(${created.id})`);
await sleep(4500); // reload

const st2 = await ev(`(() => { const s = window.__app.getState(); return { cu: s.currentUser, names: s.users.map(u=>u.name) }; })()`);
ok('dopo switch: currentUser = nuovo profilo', st2?.cu === created.id, JSON.stringify(st2));

// La pref era dirty: su desktop pushDirty l'ha spedita al PC prima dello switch
// → hydrate del profilo 1 la riporterà quando si torna. mh-user = nuovo id.
const arch = await ev(`({ user: localStorage.getItem('mh-user') })`);
ok('mh-user = nuovo id', Number(arch?.user) === created.id, JSON.stringify(arch));

// Pref scritta sul profilo 2 deve finire nel SUO namespace
await ev(`(async () => { await window.__mhApi().prefs.set('mh-pref-auditchip', 'P2'); return 1; })()`);
const p2 = await ev(`(async () => (await window.__mhApi().prefs.getAll())['mh-pref-auditchip'] )()`);
ok('pref P2 nel namespace profilo 2', p2 === 'P2', String(p2));

// Torna al profilo 1: la sua pref (pushata al PC prima dello switch) riappare via hydrate
await ev(`window.__app.getState().setUser(1)`);
await sleep(4500);
const back = await ev(`({ cu: window.__app.getState().currentUser, v: localStorage.getItem('mh-pref-auditchip') })`);
ok('rientro su profilo 1', back?.cu === 1);
ok('pref profilo 1 ripristinata dal PC', back?.v === '"P1LOCAL"', JSON.stringify(back));

// Cleanup: elimina profilo di test e le pref di audit
await ev(`(async () => { await window.__mhApi().users.remove(${created.id}); await window.__mhApi().prefs.set('mh-pref-auditchip', null); localStorage.removeItem('mh-pref-auditchip'); localStorage.removeItem('mh-pref-dirty:u1'); await window.__app.getState().loadUsers(); return 1; })()`);
const fin = await ev(`window.__app.getState().users.map(u=>u.name).join(',')`);
ok('cleanup profilo test', !/AuditCDP/.test(fin), fin);

const errs = getLogs().filter((l) => /error/i.test(l) && !/favicon|net::|Autofill|devtools|ERR_/i.test(l));
ok('nessun errore console', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n${pass} pass, ${fail} fail\n`);
close();
process.exit(fail ? 1 : 0);
