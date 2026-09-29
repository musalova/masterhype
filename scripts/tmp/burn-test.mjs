// Lancia una masterizzazione vera via API remota e stampa la risposta.
import http from 'node:http';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TOKEN = 'RMKdIfg3';
const HOST = '192.168.1.129';
const PORT = 48484;

const drives = JSON.parse(execSync('resources\\bin\\BurnHelper.exe list-drives').toString()
  .split('\n').filter(Boolean).pop()).drives;
const drive = drives.find(d => d.mediaPresent);
if (!drive) { console.log('NESSUN DISCO'); process.exit(1); }
console.log('drive:', drive.name, drive.mediaType, drive.mediaState);

const db = new DatabaseSync(process.env.APPDATA + '/MasterHype/data/masterhype.db');
const q = db.prepare("SELECT v FROM prefs WHERE k='u1:mh-pref-cdqueue'").get();
const ids = JSON.parse(q.v);
console.log('tracce:', ids.length);

const body = JSON.stringify({ c: 'burn:start', a: ['audio', drive.id, ids.map(id => ({ id })), 'Il mio CD'] });
const req = http.request({ host: HOST, port: PORT, path: '/api/call', method: 'POST',
  headers: { 'x-mh-token': TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
  res => { let d = ''; res.on('data', c => d += c); res.on('end', () => console.log('RESP', res.statusCode, d)); });
req.on('error', e => console.log('ERR', e.message));
req.write(body); req.end();
setTimeout(() => process.exit(0), 20000);
