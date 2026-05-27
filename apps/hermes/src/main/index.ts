/**
 * Electron Main entry point.
 *
 * Responsibilities (phase 0):
 *  - Create the browser window with a secure preload bridge.
 *  - Register IPC handlers (ping, appInfo, sidecarPing, permission status).
 *  - Provide the deep links into macOS System Settings for permission grants.
 *
 * Heavier responsibilities (engine wiring, recorder boot, sidecar lifecycle)
 * arrive in later phases.
 */
import { BrowserWindow, app, ipcMain, shell, systemPreferences } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcChannels, IpcContract, type PermissionName } from '../shared/ipc.js';
import { disposeSidecar, pingSidecar } from './sidecar.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const isMac = process.platform === 'darwin';

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.ping, async (_event, raw) => {
    const args = IpcContract[IpcChannels.ping].args.parse(raw);
    return { pong: true as const, echo: args.message ?? 'pong' };
  });

  ipcMain.handle(IpcChannels.appInfo, async () => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    };
  });

  ipcMain.handle(IpcChannels.sidecarPing, async () => {
    return pingSidecar();
  });

  ipcMain.handle(IpcChannels.permissionStatus, async () => {
    if (!isMac) {
      return { required: [], missing: [], granted: [] };
    }
    const required: PermissionName[] = [
      'accessibility',
      'screen-recording',
      'input-monitoring',
    ];
    const granted: PermissionName[] = [];
    const missing: PermissionName[] = [];
    for (const p of required) {
      if (checkMacPermission(p)) granted.push(p);
      else missing.push(p);
    }
    return { required, missing, granted };
  });

  ipcMain.handle(IpcChannels.openSettingsPane, async (_event, raw) => {
    const args = IpcContract[IpcChannels.openSettingsPane].args.parse(raw);
    if (!isMac) return { opened: false };
    const url = settingsDeepLink(args.pane);
    await shell.openExternal(url);
    return { opened: true };
  });
}

function checkMacPermission(name: PermissionName): boolean {
  switch (name) {
    case 'accessibility':
      // askForPermission=false: just query, do not prompt.
      return systemPreferences.isTrustedAccessibilityClient(false);
    case 'screen-recording':
      return systemPreferences.getMediaAccessStatus('screen') === 'granted';
    case 'input-monitoring':
      // No direct API on Electron 33. We treat it as granted until the sidecar
      // performs a real action; the sidecar reports a more accurate status.
      return true;
    case 'automation':
      return true;
  }
}

function settingsDeepLink(pane: PermissionName): string {
  switch (pane) {
    case 'accessibility':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
    case 'screen-recording':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    case 'input-monitoring':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
    case 'automation':
      return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  disposeSidecar();
});
