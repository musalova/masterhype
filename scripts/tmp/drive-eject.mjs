import { execFileSync } from 'node:child_process';
const H = 'resources/bin/BurnHelper.exe';
const out = execFileSync(H, ['list-drives']).toString();
const d = JSON.parse(out.split('\n').filter(Boolean).pop()).drives[0];
console.log('stato:', JSON.stringify({ present: d.mediaPresent, blank: d.mediaBlank, type: d.mediaType, state: d.mediaState }));
const cmd = process.argv[2] || 'eject';
try {
  console.log(execFileSync(H, [cmd, '--drive', d.id, ...(process.argv[3] === 'load' ? ['--load'] : [])]).toString());
} catch (e) { console.log('esito:', (e.stdout || '').toString()); }
