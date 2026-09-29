import { ev, sleep, close, enableLogs, getLogs } from '../cdp-test.mjs';
await enableLogs();
const out = {};
out.info = await ev(`window.masterhype.app.info().then(JSON.stringify)`);
out.upd = await ev(`window.masterhype.app.updateStatus().then(JSON.stringify)`);
out.check = await ev(`window.masterhype.app.updateCheck().then(JSON.stringify)`);
// playlist: crea + addRef di un brano gia' in libreria + addRef di un brano non in libreria (non avvia davvero se gia' in coda)
out.pl = await ev(`(async () => {
  const api = window.masterhype;
  const lib = await api.library.list();
  const pl = await api.playlists.create('TEST addRef', 'lista');
  const r1 = lib[0] ? await api.playlists.addRef(pl.id, lib[0]) : null;
  const list = await api.playlists.list();
  const got = list.find(p => p.id === pl.id);
  await api.playlists.remove(pl.id);
  return JSON.stringify({ libN: lib.length, r1, n: got?.tracks?.length });
})()`);
out.backupData = await ev(`window.masterhype.backup.data().then(b => b.app + ' v' + b.version + ' pl=' + b.playlists.length)`);
out.report = await ev(`window.masterhype.diag.reportText().then(t => t.slice(0, 60))`);
// Navigazione Impostazioni: la card Aggiornamenti deve rendersi
await ev(`window.__app.getState().nav('settings')`);
await sleep(1500);
out.settingsHas = await ev(`['Aggiornamenti','Server aggiornamenti','I tuoi dati','Importa file audio','App Android per i telefoni'].map(s => s + ':' + document.body.innerText.includes(s)).join(' ')`);
await ev(`window.__app.getState().nav('downloads')`);
await sleep(800);
out.downloads = await ev(`document.body.innerText.includes('Sul telefono')`);
await ev(`window.__app.getState().nav('library')`);
await sleep(800);
out.libImport = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Importa')`);
console.log(JSON.stringify(out, null, 2));
console.log(getLogs().slice(-10).join('\n'));
close();
