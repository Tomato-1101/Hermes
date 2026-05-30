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
  it('translates click into mouse.click RPC (with instant skipping humanization)', async () => {
    const client = makeFakeClient({
      'mouse.click': () => ({ ok: true }),
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click({ x: 100, y: 200 }, { clicks: 2, instant: true });
    expect(client.call).toHaveBeenCalledWith('mouse.click', {
      x: 100,
      y: 200,
      button: 'left',
      clickCount: 2,
    });
    // instant should NOT touch position/move_smooth
    expect(client.call).toHaveBeenCalledTimes(1);
  });

  it('uses element center when handle is passed', async () => {
    const client = makeFakeClient({ 'mouse.click': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click(
      {
        selectorEcho: { kind: 'coords', x: 0, y: 0, anchor: 'screen' },
        bbox: { x: 10, y: 20, w: 40, h: 80 },
        role: 'button',
      },
      { instant: true },
    );
    expect(client.call).toHaveBeenCalledWith('mouse.click', {
      x: 30,
      y: 60,
      button: 'left',
      clickCount: 1,
    });
  });

  it('humanized click: position → move_smooth → click', async () => {
    const order: string[] = [];
    const client = makeFakeClient({
      'mouse.position': () => {
        order.push('mouse.position');
        return { x: 0, y: 0 };
      },
      'mouse.move_smooth': (params) => {
        order.push('mouse.move_smooth');
        const p = params as Record<string, unknown>;
        expect(p['toX']).toBe(800);
        expect(p['toY']).toBe(600);
        expect(typeof p['steps']).toBe('number');
        expect(typeof p['durationMs']).toBe('number');
        return { ok: true };
      },
      'mouse.click': () => {
        order.push('mouse.click');
        return { ok: true };
      },
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click({ x: 800, y: 600 }, { speedPxPerSec: 800 });
    expect(order).toEqual(['mouse.position', 'mouse.move_smooth', 'mouse.click']);
  });

  it('humanized click falls back to plain mouse.move when position lookup throws', async () => {
    const order: string[] = [];
    const client = makeFakeClient({
      'mouse.position': () => {
        order.push('mouse.position');
        throw new Error('not implemented');
      },
      'mouse.move': () => {
        order.push('mouse.move');
        return { ok: true };
      },
      'mouse.click': () => {
        order.push('mouse.click');
        return { ok: true };
      },
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.click({ x: 100, y: 100 });
    expect(order).toEqual(['mouse.position', 'mouse.move', 'mouse.click']);
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
    // Default humanized typing interval is 50ms/char.
    expect(calls[2]?.p).toEqual({ text: 'hello', intervalMs: 50 });
  });

  it('type with explicit intervalMs preserves the caller value', async () => {
    const captured: Record<string, unknown>[] = [];
    const client = makeFakeClient({
      'keyboard.type': (p) => {
        captured.push(p as Record<string, unknown>);
        return { ok: true };
      },
    });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.type('hi', { intervalMs: 5 });
    expect(captured[0]).toEqual({ text: 'hi', intervalMs: 5 });
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

  it('scroll translates into mouse.scroll RPC at the target point', async () => {
    const client = makeFakeClient({ 'mouse.scroll': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.scroll({ x: 120, y: 240 }, 0, -30);
    expect(client.call).toHaveBeenCalledWith('mouse.scroll', { x: 120, y: 240, dx: 0, dy: -30 });
  });

  it('scroll uses element center when a handle is passed', async () => {
    const client = makeFakeClient({ 'mouse.scroll': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.scroll(
      {
        selectorEcho: { kind: 'coords', x: 0, y: 0, anchor: 'screen' },
        bbox: { x: 10, y: 20, w: 40, h: 80 },
        role: 'list',
      },
      5,
      10,
    );
    expect(client.call).toHaveBeenCalledWith('mouse.scroll', { x: 30, y: 60, dx: 5, dy: 10 });
  });

  it('drag translates into mouse.drag RPC with from/to endpoints', async () => {
    const client = makeFakeClient({ 'mouse.drag': () => ({ ok: true }) });
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.drag({ x: 10, y: 20 }, { x: 200, y: 300 });
    expect(client.call).toHaveBeenCalledWith('mouse.drag', {
      fromX: 10,
      fromY: 20,
      toX: 200,
      toY: 300,
    });
  });

  it('focusApp still throws not-yet-implemented', async () => {
    const client = makeFakeClient({});
    const adapter = new MacosDesktopAdapter({ client });
    await expect(adapter.focusApp({ bundleId: 'x' })).rejects.toBeInstanceOf(DesktopAdapterError);
  });

  it('screenshot calls screen.capture and returns a Buffer of the decoded PNG', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const client = makeFakeClient({
      'screen.capture': () => ({ data: pngBytes.toString('base64'), w: 100, h: 50, format: 'png' }),
    });
    const adapter = new MacosDesktopAdapter({ client });
    const buf = await adapter.screenshot();
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(pngBytes)).toBe(true);
    expect(client.call).toHaveBeenCalledWith('screen.capture', expect.any(Object));
  });

  it('dispose forwards to client', async () => {
    const client = makeFakeClient({});
    const adapter = new MacosDesktopAdapter({ client });
    await adapter.dispose();
    expect(client.dispose).toHaveBeenCalled();
  });
});
