// Audit multi-utente end-to-end contro il server remoto reale (:48484).
// Verifica l'isolamento dei dati personali tra profili: like, preferenze,
// eventi, playlist, validazione X-MH-User, protezioni delete, deny-list.
// Uso: node scripts/audit-users.mjs <token>  (token = Impostazioni → Telefono)
const TOKEN = process.argv[2];
const BASE = process.argv[3] || 'http://127.0.0.1:48484';
if (!TOKEN) { console.log('uso: node scripts/audit-users.mjs <token>'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

async function call(c, a = [], u = 1) {
  const res = await fetch(`${BASE}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MH-Token': TOKEN, 'X-MH-User': String(u) },
    body: JSON.stringify({ c, a }),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, r: j.r, e: j.e };
}

console.log('\n== ISOLAMENTO MULTI-UTENTE ==\n');

// 1) lista profili — la migrazione deve aver creato l'utente 1
const list0 = await call('users:list');
ok('users:list', list0.status === 200 && Array.isArray(list0.r) && list0.r.length >= 1, `${list0.r?.length} profili`);
const u1 = list0.r[0].id;

// 2) crea due profili
const mk = async (n) => (await call('users:create', [n], u1)).r;
const marco = await mk(`AuditMarco${Date.now() % 100000}`);
const sara = await mk(`AuditSara${Date.now() % 100000}`);
ok('users:create x2', !!marco?.id && !!sara?.id && marco.id !== sara.id, `id ${marco?.id}, ${sara?.id}`);
const u2 = marco.id, u3 = sara.id;

// 3) like remoti isolati
const vA = { videoId: `aud${Date.now()}`, title: 'Brano Audit A', artist: 'Artista A' };
await call('lib:likeRemote', [vA, true], u1);
const likes1 = (await call('lib:remoteLikes', [], u1)).r ?? [];
const likes2 = (await call('lib:remoteLikes', [], u2)).r ?? [];
ok('like u1 visibile a u1', likes1.some((l) => l.videoId === vA.videoId), `${likes1.length} like`);
ok('like u1 INVISIBILE a u2', !likes2.some((l) => l.videoId === vA.videoId));
await call('lib:likeRemote', [vA, false], u1); // cleanup

// 4) preferenze isolate (namespacing server-side)
await call('remote:prefs:set', ['mh-pref-auditx', 'UNO'], u1);
const p1 = (await call('remote:prefs:get', [], u1)).r ?? {};
const p2 = (await call('remote:prefs:get', [], u2)).r ?? {};
ok('pref u1 visibile a u1', p1['mh-pref-auditx'] === 'UNO');
ok('pref u1 INVISIBILE a u2', !('mh-pref-auditx' in p2));
// chiave arbitraria rifiutata (anche via /api/call)
const bad = await call('remote:prefs:set', ['evil-key', 'x'], u2);
ok('pref non mh-pref-* rifiutata', bad.status === 500 && !!bad.e, bad.e ?? '');

// 5) playlist isolate
const plRes = await call('pl:create', ['Playlist Audit', 'lista'], u1);
const pl = plRes.r;
const pls2 = (await call('pl:list', [], u2)).r ?? [];
ok('playlist u1 creata', !!pl?.id, `id ${pl?.id} ${plRes.e ?? ''}`);
ok('playlist u1 INVISIBILE a u2', !pls2.some((p) => p.id === pl?.id));
// u2 non può modificare/rinominare playlist di u1
if (pl?.id) {
  await call('pl:rename', [pl.id, 'HACKED'], u2);
  const pls1 = (await call('pl:list', [], u1)).r ?? [];
  ok('u2 non rinomina playlist di u1', pls1.find((p) => p.id === pl.id)?.name === 'Playlist Audit');
  const del2try = await call('pl:delete', [pl.id], u2);
  const pls1b = (await call('pl:list', [], u1)).r ?? [];
  ok('u2 non elimina playlist di u1', pls1b.some((p) => p.id === pl.id), del2try.e ?? '');
  await call('pl:delete', [pl.id], u1); // cleanup
}

// 6) eventi/gusto isolati
await call('lib:remoteEvent', [{ artist: 'ArtistaAudit', title: 'T', videoId: 'ev1', type: 'play' }], u1);
const rec1 = (await call('lib:recent', [10], u1)).r ?? [];
const rec2 = (await call('lib:recent', [10], u2)).r ?? [];
ok('evento u1 in recenti di u1', rec1.some((t) => t.videoId === 'ev1'), `${rec1.length} recenti`);
ok('evento u1 NON in recenti di u2', !rec2.some((t) => t.videoId === 'ev1'));

// 7) X-MH-User invalido → 401
const badUser = await call('users:list', [], 99999);
ok('X-MH-User inesistente → 401', badUser.status === 401, badUser.e ?? '');
const badUser2 = await call('users:list', [], 'abc');
ok('X-MH-User non numerico → 401', badUser2.status === 401);

// 8) protezioni delete
const selfDel = await call('users:remove', [u2], u2);
ok('no delete profilo in uso', selfDel.status === 500 && /stai usando/.test(selfDel.e ?? ''), selfDel.e ?? '');

// 9) canali PC-only bloccati da remoto
const imp = await call('lib:import', [['C:\\Windows\\System32\\drivers\\etc\\hosts']], u2);
ok('lib:import remoto → 403', imp.status === 403, imp.e ?? '');
const opf = await call('sys:openFolder', ['C:\\'], u2);
ok('sys:openFolder remoto → 403', opf.status === 403);
const setCur = await call('users:setCurrent', [u3], u2);
ok('users:setCurrent non esposto → 404', setCur.status === 404);

// 10) header assente → profilo legacy 1
const noHdr = await fetch(`${BASE}/api/call`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-MH-Token': TOKEN },
  body: JSON.stringify({ c: 'users:current', a: [] }),
});
const noHdrJ = await noHdr.json();
ok('no header → utente legacy 1', noHdrJ.r === 1, `r=${noHdrJ.r}`);

// 11) delete ok da altro profilo → dati personali spariti (il profilo diventa 401)
await call('lib:likeRemote', [{ videoId: 'sara1', title: 'T', artist: 'A' }, true], u3);
const del = await call('users:remove', [u3], u1);
ok('delete da altro profilo', del.status === 200, del.e ?? '');
const likes3 = await call('users:list', [], u3);
ok('profilo eliminato → 401', likes3.status === 401);
const listF = (await call('users:list')).r ?? [];
ok('lista aggiornata', !listF.some((u) => u.id === u3), `${listF.length} profili`);

// 12) delete ultimo profilo vietato (guard COUNT<=1 lato servizio)
const del2 = await call('users:remove', [u2], u1);
ok('delete marco', del2.status === 200);
// resta solo u1: un "altro" profilo non esiste → il self-check lo blocca comunque
const delLast = await call('users:remove', [u1], u1);
ok('delete ultimo/proprio profilo vietato', delLast.status === 500, delLast.e ?? '');

// 13) TOKEN PER DISPOSITIVO: register minta un token proprio legato a UN
// profilo — X-MH-User diverso viene IGNORATO (il binding decide, non il client)
const reg = await call('device:register', [`AuditPhone${Date.now() % 100000}`], u1);
const devTok = reg.r?.token;
ok('device:register (admin) minta token', typeof devTok === 'string' && devTok.length > 16);

async function dcall(c, a = [], u) {
  const headers = { 'Content-Type': 'application/json', 'X-MH-Token': devTok };
  if (u != null) headers['X-MH-User'] = String(u);
  const res = await fetch(`${BASE}/api/call`, { method: 'POST', headers, body: JSON.stringify({ c, a }) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, r: j.r, e: j.e, bound: res.headers.get('x-mh-bound-user') };
}

// device non associato: i canali dati richiedono profilo (o claim implicito);
// gli esistenziali (users:list) restano aperti per il gate "Chi sei?"
const unboundData = await dcall('users:current');
ok('device non legato, no header → 401', unboundData.status === 401, unboundData.e ?? '');
const unboundList = await dcall('users:list');
ok('device non legato: users:list ok (gate)', unboundList.status === 200 && Array.isArray(unboundList.r));

// claim: il device si lega a un profilo
const marco2 = (await call('users:create', [`AuditDev${Date.now() % 100000}`], u1)).r;
const sara2 = (await call('users:create', [`AuditDevB${Date.now() % 100000}`], u1)).r;
const claim = await dcall('device:claim', [marco2.id]);
ok('device:claim lega al profilo', claim.status === 200, claim.e ?? '');

// ISOLAMENTO: like di marco2; il device chiede esplicitamente l'altro profilo
// via X-MH-User — deve ricevere comunque i dati del SUO binding
await call('lib:likeRemote', [{ videoId: 'devA', title: 'T', artist: 'A' }, true], marco2.id);
const likesDev = await dcall('lib:remoteLikes', [], sara2.id); // header sara2!
ok('device: header altrui ignorato → like del SUO profilo', likesDev.r?.some((l) => l.videoId === 'devA'), `bound=${likesDev.bound}`);
ok('X-MH-Bound-User riporta il profilo legato', likesDev.bound === String(marco2.id), `bound=${likesDev.bound}`);

// re-bind senza finestra «Accoppia telefono» aperta → vietato
const rebind = await dcall('device:claim', [sara2.id]);
ok('rebind senza finestra → 403', rebind.status === 403, rebind.e ?? '');

// canali admin-only col device token → 403
const adm1 = await dcall('device:list');
ok('device:list da device → 403', adm1.status === 403);
const adm2 = await dcall('users:remove', [sara2.id]);
ok('users:remove da device → 403', adm2.status === 403);
const adm3 = await dcall('pairing:open');
ok('pairing:open da device → 403', adm3.status === 403);

// riassegnazione admin dal PC: il device passa all'altro profilo
const devList = (await call('device:list', [], u1)).r ?? [];
const devRow = devList.find((d) => d.name?.startsWith('AuditPhone'));
ok('device:list (admin) mostra il device', !!devRow, `${devList.length} device`);
if (devRow) {
  await call('device:setUser', [devRow.id, sara2.id], u1);
  const likesAfter = await dcall('lib:remoteLikes');
  ok('setUser admin rilega → vede il nuovo profilo', likesAfter.status === 200 && !likesAfter.r?.some((l) => l.videoId === 'devA'));
  // revoca: il token muore alla prossima richiesta
  await call('device:revoke', [devRow.id], u1);
  const dead = await dcall('users:list');
  ok('device revocato → 401', dead.status === 401, dead.e ?? '');
}

// profili di test eliminati
await call('users:remove', [marco2.id], u1);
await call('users:remove', [sara2.id], u1);

// cleanup prefs audit
await call('remote:prefs:set', ['mh-pref-auditx', null], u1);

console.log(`\n${pass} pass, ${fail} fail\n`);
process.exit(fail ? 1 : 0);
