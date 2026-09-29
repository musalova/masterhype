import type { MasterHypeApi } from '../../preload/index';
import { isRemote } from './remote';
import { remoteApi } from './remoteApi';

declare global {
  interface Window {
    masterhype?: MasterHypeApi; // assente su telefono/browser → client remoto
  }
}

// Punto unico: desktop (preload IPC) o remoto (HTTP verso il PC) — stessa API.
export const api = (): MasterHypeApi => window.masterhype ?? remoteApi;

// Handle per i test CDP (stesso privilegio della pagina, nessun segreto esposto)
(window as unknown as { __mhApi: typeof api }).__mhApi = api;

export { isRemote, mediaUrl, hasRemoteConf, testConnection, saveRemoteConf, clearRemoteConf, fetchProfiles, myUserId } from './remote';
