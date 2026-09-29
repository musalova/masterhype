import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import { createServer } from 'http';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { IPC } from '../shared/types';
import * as library from './services/library';
import * as sources from './services/sources';
import * as telemetry from './services/telemetry';
import * as users from './services/users';
import { getSettings, setSettings } from './settings';
import { exportBackup } from './services/backup';
import { handlers, desktopOnlyChannels, importBackupFromFile, desktopUser } from './handlers';

// Tutti i canali condivisi con il server remoto (handlers.ts) vengono registrati
// dalla mappa — UNICA sorgente di verità. Le eccezioni desktop (dialoghi
// nativi, OAuth) sono in desktopOnlyChannels e registrate sotto a mano.
// Il primo argomento degli handler è `u`: sul desktop è il profilo attivo
// (settings.currentUser), su remoto quello dell'header X-MH-User.
export function registerIpc(): void {
  for (const [ch, fn] of Object.entries(handlers)) {
    if (desktopOnlyChannels.has(ch)) continue;
    ipcMain.handle(ch, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(desktopUser(), ...args));
  }

  // ---- Varianti desktop con dialoghi nativi ----

  ipcMain.handle(IPC.playlistExport, (e, id: number) => exportM3u(e, id));

  // Cambio profilo sul PC: solo desktop (un telefono non deve poter
  // dirottare il profilo del PC). Il renderer poi fa reload.
  ipcMain.handle(IPC.usersSetCurrent, (_e, id: number) => {
    if (!users.userExists(id)) throw new Error('Profilo non trovato');
    setSettings({ currentUser: id });
    return getSettings().currentUser;
  });

  ipcMain.handle(IPC.issuesExport, async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(w!, {
      title: 'Esporta report diagnostica',
      defaultPath: join(app.getPath('documents'), 'masterhype-report.txt'),
      filters: [{ name: 'Report', extensions: ['txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, telemetry.exportReport(), 'utf-8');
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });

  ipcMain.handle(IPC.backupExport, async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(w!, {
      title: 'Esporta profilo MasterHype',
      defaultPath: join(app.getPath('documents'), 'masterhype-backup.json'),
      filters: [{ name: 'Backup MasterHype', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, JSON.stringify(exportBackup(desktopUser()), null, 2), 'utf-8');
    shell.showItemInFolder(r.filePath);
    return r.filePath;
  });
  ipcMain.handle(IPC.backupImport, async (e, data?: unknown) => {
    // Dato già letto (es. backup del telefono passato dal renderer): niente dialogo
    if (data != null) return handlers[IPC.backupImport](desktopUser(), data);
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, {
      title: 'Importa profilo MasterHype',
      filters: [{ name: 'Backup MasterHype', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importBackupFromFile(r.filePaths[0], desktopUser());
  });

  ipcMain.handle(IPC.pickFolder, async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(w!, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle(IPC.spotifyAuth, () => spotifyOAuthFlow());
}

async function exportM3u(e: Electron.IpcMainInvokeEvent, id: number): Promise<string | null> {
  const pl = library.listPlaylists(desktopUser()).find((p) => p.id === id);
  if (!pl?.tracks?.length) return null;
  const w = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(w!, {
    title: 'Esporta playlist',
    defaultPath: join(app.getPath('documents'), `${pl.name.replace(/[^\wàèéìòù -]/gi, '')}.m3u8`),
    filters: [{ name: 'Playlist M3U', extensions: ['m3u8', 'm3u'] }],
  });
  if (r.canceled || !r.filePath) return null;
  const lines = ['#EXTM3U', `#PLAYLIST:${pl.name}`];
  for (const t of pl.tracks) {
    if (!t.filePath) continue;
    lines.push(`#EXTINF:${Math.round(t.durationS ?? 0)},${t.artist} - ${t.title}`);
    lines.push(t.filePath);
  }
  writeFileSync(r.filePath, lines.join('\r\n'), 'utf-8');
  shell.showItemInFolder(r.filePath);
  return r.filePath;
}

// OAuth PKCE: server loopback temporaneo su 127.0.0.1, apre il browser.
function spotifyOAuthFlow(): Promise<boolean> {
  return new Promise((resolve) => {
    let port = 0;
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/callback') {
        const ok = await sources.spotifyExchangeCode(u.searchParams.get('code') ?? '', u.searchParams.get('state') ?? '', port);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok
          ? '<h2 style="font-family:sans-serif">MasterHype: Spotify collegato. Puoi chiudere questa finestra.</h2>'
          : '<h2 style="font-family:sans-serif">Errore di collegamento Spotify.</h2>');
        server.close();
        resolve(ok);
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.on('listening', () => {
      port = (server.address() as { port: number }).port;
      const url = sources.spotifyAuthUrl(port);
      if (url) shell.openExternal(url);
      else { server.close(); resolve(false); }
    });
    server.on('error', () => { try { server.close(); } catch { /* */ } resolve(false); });
    // porta fissa 8888: da registrare come redirect URI nell'app Spotify
    server.listen(8888, '127.0.0.1');
    setTimeout(() => { try { server.close(); } catch { /* */ } resolve(false); }, 180_000);
  });
}
