// Esegue i test LIVE (rete reale: Deezer, YouTube Music, iTunes, MusicBrainz).
// Sono esclusi dal `vitest run` di default/CI via `describe.skipIf(!MH_LIVE)`:
// qui li forza MH_LIVE=1. Uso: `npm run test:live` oppure
// `node scripts/test-live.mjs tests/assistant-live.test.ts` per un solo file.
import { spawnSync } from 'node:child_process';

const files = process.argv.slice(2);
const args = ['vitest', 'run', ...(files.length ? files : ['tests/assistant-live.test.ts', 'tests/assistant-prompt.test.ts'])];
const r = spawnSync('npx', args, {
  stdio: 'inherit', shell: true,
  env: { ...process.env, MH_LIVE: '1' },
});
process.exit(r.status ?? 1);
