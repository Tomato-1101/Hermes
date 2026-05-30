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
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, shell, systemPreferences } from 'electron';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcChannels, IpcContract, type PermissionName } from '../shared/ipc.js';
import { disposeSidecar, pingSidecar } from './sidecar.js';
import { RunController } from './run-controller.js';
import { defaultChromeUserDataDir } from './chrome-process.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const isMac = process.platform === 'darwin';

let mainWindow: BrowserWindow | null = null;
const controller = new RunController();

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

  // Tell the renderer what platform it's running on so CSS can offset the
  // left pane header by ~80px to clear macOS's traffic-light buttons (we
  // run with titleBarStyle: 'hiddenInset', so the dots overlap the header
  // text otherwise). did-finish-load fires after React has mounted, so
  // body always exists by the time this runs.
  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents.executeJavaScript(
      `document.body.classList.add('platform-${process.platform}')`,
    );
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  controller.attachWindow(mainWindow);
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

  ipcMain.handle(IpcChannels.flowList, async () => {
    const flows = await controller.listFlows();
    return { flows };
  });

  ipcMain.handle(IpcChannels.flowCreate, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowCreate].args.parse(raw);
    const flow = await controller.createFlow(args.name);
    return { flow };
  });

  ipcMain.handle(IpcChannels.flowOpen, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowOpen].args.parse(raw);
    const flow = await controller.openFlow(args.id);
    return { flow };
  });

  ipcMain.handle(IpcChannels.flowSave, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowSave].args.parse(raw);
    await controller.saveFlow(args.flow as Parameters<typeof controller.saveFlow>[0]);
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.flowDelete, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowDelete].args.parse(raw);
    await controller.deleteFlow(args.id);
    return { deleted: true };
  });

  ipcMain.handle(IpcChannels.flowDuplicate, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowDuplicate].args.parse(raw);
    const flow = await controller.duplicateFlow(args.id, args.name);
    return { flow };
  });

  ipcMain.handle(IpcChannels.flowRename, async (_event, raw) => {
    const args = IpcContract[IpcChannels.flowRename].args.parse(raw);
    const flow = await controller.renameFlow(args.id, args.name);
    return { flow };
  });

  ipcMain.handle(IpcChannels.settingsGet, async () => {
    const settings = await controller.getSettings();
    return { settings };
  });

  ipcMain.handle(IpcChannels.settingsSet, async (_event, raw) => {
    const args = IpcContract[IpcChannels.settingsSet].args.parse(raw);
    await controller.setSettings(args.settings);
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.settingsPickChromeProfile, async () => {
    if (!mainWindow) return { picked: false };
    const defaultPath = defaultChromeUserDataDir() ?? undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Chrome プロファイルフォルダを選択',
      message: '"Default" または "Profile 1" などのフォルダを選んでください。',
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { picked: false };
    }
    const picked = result.filePaths[0]!;
    return { picked: true, path: picked, name: basename(picked) };
  });

  ipcMain.handle(IpcChannels.recorderStart, async (_event, raw) => {
    const args = IpcContract[IpcChannels.recorderStart].args.parse(raw);
    await controller.startRecording(args.flowId, args.startUrl, args.layer);
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.recorderStop, async () => {
    await controller.stopRecording();
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.recorderSetRecordWaits, async (_event, raw) => {
    const args = IpcContract[IpcChannels.recorderSetRecordWaits].args.parse(raw);
    controller.setRecordWaits(args.enabled);
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.runStart, async (_event, raw) => {
    const args = IpcContract[IpcChannels.runStart].args.parse(raw);
    const runId = await controller.startRun(args.flowId, args.inputs);
    return { runId };
  });

  ipcMain.handle(IpcChannels.runStop, async () => {
    await controller.stopRun();
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.vaultList, async () => {
    const entries = await controller.vaultList();
    return { entries };
  });

  ipcMain.handle(IpcChannels.vaultSet, async (_event, raw) => {
    const args = IpcContract[IpcChannels.vaultSet].args.parse(raw);
    await controller.vaultSet(args.account, args.value);
    return { ok: true as const };
  });

  ipcMain.handle(IpcChannels.vaultDelete, async (_event, raw) => {
    const args = IpcContract[IpcChannels.vaultDelete].args.parse(raw);
    const deleted = await controller.vaultDelete(args.account);
    return { deleted };
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

function registerStopHotkey(): void {
  // System-wide kill switch: during desktop replay Hermes is in the
  // background while the cursor drives ANOTHER app, so a renderer-side
  // keyboard listener can't catch this. globalShortcut survives focus
  // loss. Cmd+Shift+Esc is unclaimed on macOS (Cmd+Opt+Esc is Force
  // Quit; Cmd+Shift+Esc is free).
  const accel = 'CommandOrControl+Shift+Escape';
  const ok = globalShortcut.register(accel, () => {
    void controller.stopRun().catch(() => undefined);
    mainWindow?.webContents.send(IpcChannels.eventPush, {
      type: 'log',
      level: 'warn',
      message: '⌘⇧Esc で再生を停止しました',
    });
  });
  if (!ok) {
    console.warn(`[hermes] failed to register global stop hotkey: ${accel}`);
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();
  registerStopHotkey();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', async () => {
  disposeSidecar();
  await controller.dispose().catch(() => undefined);
});
