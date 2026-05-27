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
    expect(adapter.click).toHaveBeenCalledWith({ x: 100, y: 200 }, { button: 'right', clicks: 2 });
  });

  it('type forwards text and clearFirst', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 's2',
      type: 'type',
      enabled: true,
      params: { text: 'hello', clearFirst: true },
    };
    await getHandler('type').execute(step, ctxFor(adapter));
    expect(adapter.type).toHaveBeenCalledWith('hello', { clearFirst: true });
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
});
