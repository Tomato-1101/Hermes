/**
 * Preload bridge.
 *
 * Exposes a narrow, typed surface on `window.hermes` for the renderer. The
 * renderer never gets `ipcRenderer` directly — every call goes through one
 * of the wrappers below, and each wrapper maps to exactly one channel name
 * defined in `../shared/ipc.ts`.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels } from '../shared/ipc.js';

const api = {
  // System
  ping: (message?: string) => ipcRenderer.invoke(IpcChannels.ping, { message }),
  appInfo: () => ipcRenderer.invoke(IpcChannels.appInfo),
  sidecarPing: () => ipcRenderer.invoke(IpcChannels.sidecarPing),
  permissionStatus: () => ipcRenderer.invoke(IpcChannels.permissionStatus),
  openSettingsPane: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.openSettingsPane, { pane }),

  // Flow CRUD
  flowList: () => ipcRenderer.invoke(IpcChannels.flowList),
  flowCreate: (name: string) => ipcRenderer.invoke(IpcChannels.flowCreate, { name }),
  flowOpen: (id: string) => ipcRenderer.invoke(IpcChannels.flowOpen, { id }),
  flowSave: (flow: unknown) => ipcRenderer.invoke(IpcChannels.flowSave, { flow }),

  // Recorder
  recorderStart: (flowId: string, startUrl?: string) =>
    ipcRenderer.invoke(IpcChannels.recorderStart, { flowId, startUrl }),
  recorderStop: () => ipcRenderer.invoke(IpcChannels.recorderStop),

  // Runner
  runStart: (flowId: string, inputs?: Record<string, unknown>) =>
    ipcRenderer.invoke(IpcChannels.runStart, { flowId, inputs }),
  runStop: () => ipcRenderer.invoke(IpcChannels.runStop),

  // Event subscription
  onEvent: (handler: (event: unknown) => void) => {
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => handler(payload);
    ipcRenderer.on(IpcChannels.eventPush, wrapped);
    return (): void => {
      ipcRenderer.off(IpcChannels.eventPush, wrapped);
    };
  },
} as const;

export type HermesApi = typeof api;

contextBridge.exposeInMainWorld('hermes', api);
