// Avvia la build out/ in Electron con CDP 9222, senza ELECTRON_RUN_AS_NODE.
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const p = spawn(electron, ['out/main/index.js', '--remote-debugging-port=9222', ...process.argv.slice(2)], { env, stdio: 'inherit' });
p.on('exit', (c) => process.exit(c ?? 0));
