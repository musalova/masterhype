// Wrapper: l'IDE imposta ELECTRON_RUN_AS_NODE=1 che farebbe girare Electron
// come semplice Node. Lo rimuoviamo prima di lanciare electron-vite.
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = await import('node:child_process');
const args = process.argv.slice(2);
const bin = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite';
const p = spawn(bin, args, { stdio: 'inherit', shell: true, env: process.env });
p.on('close', (code) => process.exit(code ?? 0));
