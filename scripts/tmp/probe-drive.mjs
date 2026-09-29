import { execFileSync } from 'node:child_process';
const H = 'resources/bin/BurnHelper.exe';
const id = JSON.parse(execFileSync(H, ['list-drives']).toString().split('\n').filter(Boolean).pop()).drives[0].id;
for (let i = 0; i < 5; i++) {
  const out = execFileSync(H, ['dao-probe', '--drive', id]).toString().trim();
  console.log(new Date().toISOString().slice(11, 19), out);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
}
