import { describe, expect, it, vi } from 'vitest';
import { DesktopAdapterError } from './index.js';
import { MacosDesktopAdapter } from './macos.js';

function makeFakeClient(handlers: Record<string, (params: unknown) => unknown>) {
  return {
    call: vi.fn(async (method: string, params?: unknown) => {
      const fn = handlers[method];
      if (!fn) throw new Error(`unexpected method: ${method}`);
      return fn(params);
    }),
    dispose: vi.fn(),
  };
}

describe('MacosDesktopAdapter', () => {
  it('translates click into mouse.click RPC', async () => {
    const client = makeFakeClient({
      'mouse.click': () => ({ ok: true }),
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click({ x: 100, y: 200 }, { clicks: 2 });
    expect(client.call).toHaveBeenCalledWith('mouse.click', {
      x: 100,
      y: 200,
      button: 'left',
      clickCount: 2,
    });
  });

  it('uses element center when handle is passed', async () => {
    const client = makeFakeClient({ 'mouse.click': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click({
      selectorEcho: { kind: 'coords', x: 0, y: 0, anchor: 'screen' },
      bbox: { x: 10, y: 20, w: 40, h: 80 },
      role: 'button',
    });
    expect(client.call).toHaveBeenCalledWith('mouse.click', {
      x: 30,
      y: 60,
      button: 'left',
      clickCount: 1,
    });
  });

  it('keyCombo forwards arrays', async () => {
    const client = makeFakeClient({ 'keyboard.combo': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.keyCombo(['primary', 's']);
    expect(client.call).toHaveBeenCalledWith('keyboard.combo', { keys: ['primary', 's'] });
  });

  it('type with clearFirst issues cmd+a then delete then type', async () => {
    const calls: { m: string; p: unknown }[] = [];
    const client = makeFakeClient({
      'keyboard.combo': (p) => {
        calls.push({ m: 'keyboard.combo', p });
        return { ok: true };
      },
      'keyboard.type': (p) => {
        calls.push({ m: 'keyboard.type', p });
        return { ok: true };
      },
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.type('hello', { clearFirst: true });
    expect(calls.map((c) => c.m)).toEqual([
      'keyboard.combo',
      'keyboard.combo',
      'keyboard.type',
    ]);
    expect(calls[0]?.p).toEqual({ keys: ['primary', 'a'] });
    expect(calls[1]?.p).toEqual({ keys: ['delete'] });
    expect(calls[2]?.p).toEqual({ text: 'hello', intervalMs: 0 });
  });

  it('findElement with coords returns ElementHandle', async () => {
    const client = makeFakeClient({
      'accessibility.elementAtPoint': () => ({
        role: 'AXButton',
        title: 'Save',
        position: { x: 12, y: 34 },
        size: { w: 80, h: 24 },
        app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit', pid: 1234 },
      }),
    });
    const adapter = new MacosDesktopAdapter({ client });
    const handle = await adapter.findElement({ kind: 'coords', x: 50, y: 50, anchor: 'screen' });
    expect(handle).not.toBeNull();
    expect(handle?.role).toBe('AXButton');
    expect(handle?.title).toBe('Save');
    expect(handle?.bbox).toEqual({ x: 12, y: 34, w: 80, h: 24 });
    expect(handle?.app?.bundleId).toBe('com.apple.TextEdit');
  });

  it('findElement rejects unsupported selector kinds', async () => {
    const client = makeFakeClient({});
    const adapter = new MacosDesktopAdapter({ client });
    await expect(
      adapter.findElement({ kind: 'ax', app: 'TextEdit', role: 'AXButton' }),
    ).rejects.toBeInstanceOf(DesktopAdapterError);
  });

  it('ensurePermissions reports accessibility status from sidecar', async () => {
    const client = makeFakeClient({
      'accessibility.status': () => ({ granted: true }),
    });
    const adapter = new MacosDesktopAdapter({
      client,
      requiredPermissions: ['accessibility', 'screen-recording'],
    });
    const status = await adapter.ensurePermissions();
    expect(status.granted).toContain('accessibility');
    expect(status.missing).toContain('screen-recording');
  });

  it('listApps maps sidecar response to AppInfo[]', async () => {
    const client = makeFakeClient({
      'accessibility.listApps': () => ({
        apps: [
          { bundleId: 'com.apple.finder', name: 'Finder', pid: 100, active: true },
          { bundleId: 'com.apple.Safari', name: 'Safari', pid: 200, active: false },
        ],
      }),
    });
    const adapter = new MacosDesktopAdapter({ client });
    const apps = await adapter.listApps();
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ bundleId: 'com.apple.finder', processName: 'Finder', pid: 100, active: true });
    expect(apps[1]?.active).toBe(false);
  });

  it('scroll/drag/screenshot/focusApp throw not-yet-implemented errors', async () => {
    const client = makeFakeClient({});
    const adapter = new MacosDesktopAdapter({ client });
    await expect(adapter.scroll({ x: 0, y: 0 }, 0, 10)).rejects.toBeInstanceOf(DesktopAdapterError);
    await expect(adapter.drag({ x: 0, y: 0 }, { x: 0, y: 1 })).rejects.toBeInstanceOf(DesktopAdapterError);
    await expect(adapter.screenshot()).rejects.toBeInstanceOf(DesktopAdapterError);
    await expect(adapter.focusApp({ bundleId: 'x' })).rejects.toBeInstanceOf(DesktopAdapterError);
  });

  it('dispose forwards to client', async () => {
    const client = makeFakeClient({});
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.dispose();
    expect(client.dispose).toHaveBeenCalled();
  });
});
