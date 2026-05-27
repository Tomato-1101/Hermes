/**
 * Preload bridge.
 *
 * Exposes a narrow, typed surface on `window.hermes` for the renderer. The
 * renderer never gets `ipcRenderer` directly — every call goes through one
 * of the wrappers below, and each wrapper maps to exactly one channel name
 * defined in `../shared/ipc.ts`. That keeps the attack surface flat and
 * lets the Main process do schema validation on the args.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels } from '../shared/ipc.js';

const api = {
  ping: (message?: string) => ipcRenderer.invoke(IpcChannels.ping, { message }),
  appInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),
  sidecarPing: () => ipcRenderer.invoke(IpcChannels.sidecarPing),
  permissionStatus: () => ipcRenderer.invoke(IpcChannels.permissionStatus),
  openSettingsPane: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.openSettingsPane, { pane }),
} as const;

export type HermesApi = typeof api;

contextBridge.exposeInMainWorld('hermes', api);
