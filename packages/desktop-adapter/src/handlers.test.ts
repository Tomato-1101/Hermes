import { describe, expect, it, vi } from 'vitest';
import { HandlerRegistry, type RunContext, type StepHandler } from '@hermes/engine';
import type { Step } from '@hermes/ir';
import { DesktopProvider } from './desktop-provider.js';
import { desktopStepHandlers, registerDesktopHandlers } from './handlers.js';
import type { DesktopAdapter } from './index.js';

function fakeAdapter(overrides: Partial<DesktopAdapter> = {}): DesktopAdapter {
  return {
    findElement: vi.fn(async () => null),
    click: vi.fn(async () => undefined),
    doubleClick: vi.fn(async () => undefined),
    rightClick: vi.fn(async () => undefined),
    hover: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    keyCombo: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined),
    screenshot: vi.fn(async () => Buffer.alloc(0)),
    waitForState: vi.fn(async () => undefined),
    listApps: vi.fn(async () => []),
    focusApp: vi.fn(async () => undefined),
    getFocusedApp: vi.fn(async () => null),
    ensurePermissions: vi.fn(async () => ({ required: [], granted: [], missing: [] })),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function ctxFor(adapter: DesktopAdapter): RunContext {
  return {
    flow: {} as never,
    vars: {},
    inputs: {},
    outputs: {},
    signal: new AbortController().signal,
    emit: () => {},
    providers: { desktop: new DesktopProvider(adapter) },
  };
}

function getHandler(type: string): StepHandler {
  const h = desktopStepHandlers.find((h) => h.type === type);
  if (!h) throw new Error(`handler ${type} not found`);
  return h;
}

describe('desktop step handlers', () => {
  it('click routes to adapter.click with coords from target', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 's1',
      type: 'click',
      enabled: true,
      target: {
        layer: 'desktop',
        candidates: [{ kind: 'coords', x: 100, y: 200, anchor: 'screen' }],
      },
      params: { button: 'right', clickCount: 2 },
    };
    await getHandler('click').execute(step, ctxFor(adapter));
    expect(adapter.click).toHaveBeenCalledWith(
      { x: 100, y: 200 },
      {
        button: 'right',
        clicks: 2,
        speedPxPerSec: 800,
        minSteps: 16,
        maxSteps: 1200,
      },
    );
  });

  it('type forwards text and clearFirst with the default humanized interval', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 's2',
      type: 'type',
      enabled: true,
      params: { text: 'hello', clearFirst: true },
    };
    await getHandler('type').execute(step, ctxFor(adapter));
    expect(adapter.type).toHaveBeenCalledWith('hello', { clearFirst: true, intervalMs: 50 });
  });

  it('click respects ctx.vars.__hermes_humanize__ overrides', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sov',
      type: 'click',
      enabled: true,
      target: {
        layer: 'desktop',
        candidates: [{ kind: 'coords', x: 10, y: 20, anchor: 'screen' }],
      },
    };
    const ctx = ctxFor(adapter);
    ctx.vars['__hermes_humanize__'] = {
      mouseSpeedPxPerSec: 1500,
      typeDelayMs: 10,
      mouseMinSteps: 4,
      mouseMaxSteps: 90,
    };
    await getHandler('click').execute(step, ctx);
    expect(adapter.click).toHaveBeenCalledWith(
      { x: 10, y: 20 },
      { speedPxPerSec: 1500, minSteps: 4, maxSteps: 90 },
    );
  });

  it('type with instant params overrides delay to 0', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'st0',
      type: 'type',
      enabled: true,
      params: { text: 'paste', intervalMs: 0 },
    };
    await getHandler('type').execute(step, ctxFor(adapter));
    expect(adapter.type).toHaveBeenCalledWith('paste', { clearFirst: false, intervalMs: 0 });
  });

  it('key_combo forwards keys array', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 's3',
      type: 'key_combo',
      enabled: true,
      params: { keys: ['primary', 's'] },
    };
    await getHandler('key_combo').execute(step, ctxFor(adapter));
    expect(adapter.keyCombo).toHaveBeenCalledWith(['primary', 's']);
  });

  it('wait_for resolves when findElement returns a handle', async () => {
    const handle = {
      selectorEcho: { kind: 'coords' as const, x: 0, y: 0, anchor: 'screen' as const },
      bbox: { x: 0, y: 0, w: 10, h: 10 },
      role: 'AXButton',
    };
    const adapter = fakeAdapter({ findElement: vi.fn(async () => handle) });
    const step: Step = {
      id: 's4',
      type: 'wait_for',
      enabled: true,
      target: {
        layer: 'desktop',
        candidates: [{ kind: 'coords', x: 5, y: 5, anchor: 'screen' }],
      },
    };
    const res = await getHandler('wait_for').execute(step, ctxFor(adapter));
    expect(res.outcome).toBe('completed');
  });

  it('wait_for throws selector_not_found when findElement returns null', async () => {
    const adapter = fakeAdapter({ findElement: vi.fn(async () => null) });
    const step: Step = {
      id: 's5',
      type: 'wait_for',
      enabled: true,
      target: {
        layer: 'desktop',
        candidates: [{ kind: 'coords', x: 5, y: 5, anchor: 'screen' }],
      },
    };
    await expect(getHandler('wait_for').execute(step, ctxFor(adapter))).rejects.toMatchObject({
      class: 'selector_not_found',
    });
  });

  it('throws when desktop provider is missing', async () => {
    const ctx = { ...ctxFor(fakeAdapter()), providers: {} } as RunContext;
    const step: Step = {
      id: 's6',
      type: 'click',
      enabled: true,
      target: { layer: 'desktop', candidates: [{ kind: 'coords', x: 0, y: 0, anchor: 'screen' }] },
    };
    await expect(getHandler('click').execute(step, ctx)).rejects.toThrow(/Desktop provider not available/);
  });

  it('registerDesktopHandlers adds entries under the desktop layer', () => {
    const r = new HandlerRegistry();
    registerDesktopHandlers(r);
    expect(r.get('click', 'desktop')).toBeDefined();
    expect(r.get('click')).toBeUndefined(); // no default-layer handler
  });

  it('wait_for kind=desktop.app_focus polls getFocusedApp until bundleId matches', async () => {
    const focusSequence = [
      { bundleId: 'com.apple.Safari', processName: 'Safari', pid: 100, title: 'Safari', active: true },
      { bundleId: 'com.apple.Safari', processName: 'Safari', pid: 100, title: 'Safari', active: true },
      { bundleId: 'com.apple.finder', processName: 'Finder', pid: 200, title: 'Finder', active: true },
    ];
    let i = 0;
    const adapter = fakeAdapter({
      getFocusedApp: vi.fn(async () => focusSequence[Math.min(i++, focusSequence.length - 1)] ?? null),
      waitForState: vi.fn(async (predicate, opts) => {
        const deadline = Date.now() + (opts?.timeoutMs ?? 1000);
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((r) => setTimeout(r, opts?.intervalMs ?? 20));
        }
        throw new Error('timeout');
      }),
    });
    const step: Step = {
      id: 'sf',
      type: 'wait_for',
      enabled: true,
      params: {
        kind: 'desktop.app_focus',
        appBundleId: 'com.apple.finder',
        timeoutMs: 500,
        pollIntervalMs: 10,
      },
    };
    const res = await getHandler('wait_for').execute(step, ctxFor(adapter));
    expect(res.outcome).toBe('completed');
    expect(adapter.getFocusedApp).toHaveBeenCalled();
  });

  it('wait_for kind=desktop.app_focus throws when appBundleId param is missing', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sf2',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'desktop.app_focus' },
    };
    await expect(getHandler('wait_for').execute(step, ctxFor(adapter))).rejects.toThrow(
      /appBundleId/,
    );
  });

  it('wait_for kind=desktop.window_title matches the titlePattern as a regex', async () => {
    const adapter = fakeAdapter({
      getFocusedApp: vi.fn(async () => ({
        bundleId: 'com.apple.finder',
        processName: 'Finder',
        pid: 200,
        title: 'Downloads — Finder',
        active: true,
      })),
      waitForState: vi.fn(async (predicate) => {
        if (!(await predicate())) throw new Error('did not match');
      }),
    });
    const step: Step = {
      id: 'sw',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'desktop.window_title', titlePattern: '^Downloads', timeoutMs: 100 },
    };
    const res = await getHandler('wait_for').execute(step, ctxFor(adapter));
    expect(res.outcome).toBe('completed');
  });

  it('wait_for kind=desktop.screen_stable succeeds when consecutive screenshots match for stableMs', async () => {
    // First two frames differ, then identical frames repeat — the stable
    // window only begins after the second identical frame.
    const a = Buffer.from('AAAA');
    const b = Buffer.from('BBBB');
    const sequence = [a, b, b, b, b, b];
    let i = 0;
    const adapter = fakeAdapter({
      screenshot: vi.fn(async () => sequence[Math.min(i++, sequence.length - 1)] ?? b),
    });
    const step: Step = {
      id: 'ss',
      type: 'wait_for',
      enabled: true,
      params: {
        kind: 'desktop.screen_stable',
        stableMs: 100,
        timeoutMs: 2000,
        pollIntervalMs: 20,
      },
    };
    const res = await getHandler('wait_for').execute(step, ctxFor(adapter));
    expect(res.outcome).toBe('completed');
    expect((adapter.screenshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('wait_for kind=desktop.screen_stable times out when screen never stabilizes', async () => {
    let i = 0;
    const adapter = fakeAdapter({
      screenshot: vi.fn(async () => Buffer.from(String(i++ % 2))),
    });
    const step: Step = {
      id: 'ss2',
      type: 'wait_for',
      enabled: true,
      params: {
        kind: 'desktop.screen_stable',
        stableMs: 200,
        timeoutMs: 200,
        pollIntervalMs: 20,
      },
    };
    await expect(getHandler('wait_for').execute(step, ctxFor(adapter))).rejects.toMatchObject({
      class: 'timeout',
    });
  });

  it('wait_for throws on unsupported kind', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sx',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'desktop.something_made_up' },
    };
    await expect(getHandler('wait_for').execute(step, ctxFor(adapter))).rejects.toThrow(
      /Unsupported/,
    );
  });
});
