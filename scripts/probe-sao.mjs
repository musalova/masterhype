// Probe: MODE SENSE p05 -> MODE SELECT SAO -> stato drive. Non scrive nulla.
import { execFileSync } from 'node:child_process';

const helper = new URL('../resources/bin/BurnHelper.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// usa cdtext-dump solo per compilare? no — aggiungiamo un comando dedicato nel helper.
// Per ora: verifichiamo lo stato via dao-probe ripetuto nel tempo.
for (let i = 0; i < 6; i++) {
  try {
    const out = execFileSync(helper, ['dao-probe', '--drive', process.argv[2] || 'D:\\'], { encoding: 'utf8', timeout: 30000 });
    console.log(new Date().toISOString().slice(11, 19), out.trim().split('\n').pop());
  } catch (e) { console.log('err', e.message.slice(0, 200)); }
  await new Promise(r => setTimeout(r, 5000));
}
