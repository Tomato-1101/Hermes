import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandlerRegistry, type RunContext, type StepHandler } from '@hermes/engine';
import type { Step } from '@hermes/ir';
import { DesktopProvider } from './desktop-provider.js';
import {
  desktopStepHandlers,
  registerDesktopHandlers,
  registerScreenHandlers,
  screenStepHandlers,
} from './handlers.js';
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
    findImageOnScreen: vi.fn(async () => ({ found: false, score: 0 })),
    readScreenText: vi.fn(async () => ({ text: '', observations: [] })),
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

  it('scroll routes to adapter.scroll with coords and dx/dy', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'ss',
      type: 'scroll',
      enabled: true,
      target: { layer: 'desktop', candidates: [{ kind: 'coords', x: 50, y: 60, anchor: 'screen' }] },
      params: { dx: 0, dy: -120 },
    };
    await getHandler('scroll').execute(step, ctxFor(adapter));
    expect(adapter.scroll).toHaveBeenCalledWith({ x: 50, y: 60 }, 0, -120);
  });

  it('drag routes to adapter.drag with from-target and params.to', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sd',
      type: 'drag',
      enabled: true,
      target: { layer: 'desktop', candidates: [{ kind: 'coords', x: 10, y: 20, anchor: 'screen' }] },
      params: { to: { x: 300, y: 400 } },
    };
    await getHandler('drag').execute(step, ctxFor(adapter));
    expect(adapter.drag).toHaveBeenCalledWith({ x: 10, y: 20 }, { x: 300, y: 400 });
  });

  it('drag throws when params.to is missing or malformed', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sd2',
      type: 'drag',
      enabled: true,
      target: { layer: 'desktop', candidates: [{ kind: 'coords', x: 10, y: 20, anchor: 'screen' }] },
      params: {},
    };
    await expect(getHandler('drag').execute(step, ctxFor(adapter))).rejects.toThrow(/params\.to/);
    expect(adapter.drag).not.toHaveBeenCalled();
  });

  it('click with action=hover routes to adapter.hover (no press)', async () => {
    const adapter = fakeAdapter();
    const step: Step = {
      id: 'sh',
      type: 'click',
      enabled: true,
      target: { layer: 'desktop', candidates: [{ kind: 'coords', x: 70, y: 80, anchor: 'screen' }] },
      params: { action: 'hover' },
    };
    await getHandler('click').execute(step, ctxFor(adapter));
    expect(adapter.hover).toHaveBeenCalledWith(
      { x: 70, y: 80 },
      { speedPxPerSec: 800, minSteps: 16, maxSteps: 1200 },
    );
    expect(adapter.click).not.toHaveBeenCalled();
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

function getScreenHandler(type: string): StepHandler {
  const h = screenStepHandlers.find((h) => h.type === type);
  if (!h) throw new Error(`screen handler ${type} not found`);
  return h;
}

describe('screen step handlers', () => {
  it('click via image selector finds the template and clicks its center', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-screen-'));
    try {
      const asset = join(dir, 'btn.png');
      await writeFile(asset, Buffer.from('fake-png-bytes'));
      const adapter = fakeAdapter({
        findImageOnScreen: vi.fn(async () => ({
          found: true,
          score: 0.95,
          center: { x: 150, y: 250 },
          bbox: { x: 100, y: 200, w: 100, h: 100 },
        })),
      });
      const step: Step = {
        id: 'sc1',
        type: 'click',
        enabled: true,
        target: {
          layer: 'screen',
          candidates: [{ kind: 'image', assetRef: asset, threshold: 0.8 }],
        },
      };
      await getScreenHandler('click').execute(step, ctxFor(adapter));
      // The absolute assetRef is read and forwarded as the template buffer.
      expect(adapter.findImageOnScreen).toHaveBeenCalledWith(
        Buffer.from('fake-png-bytes'),
        { threshold: 0.8 },
      );
      expect(adapter.click).toHaveBeenCalledWith(
        { x: 150, y: 250 },
        { speedPxPerSec: 800, minSteps: 16, maxSteps: 1200 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('image selector resolves a relative assetRef against __hermes_assets_dir__', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-assets-'));
    try {
      await writeFile(join(dir, 'icon.png'), Buffer.from('icon'));
      const adapter = fakeAdapter({
        findImageOnScreen: vi.fn(async () => ({
          found: true,
          score: 0.9,
          center: { x: 10, y: 20 },
          bbox: { x: 0, y: 0, w: 20, h: 40 },
        })),
      });
      const step: Step = {
        id: 'sc2',
        type: 'click',
        enabled: true,
        target: {
          layer: 'screen',
          candidates: [{ kind: 'image', assetRef: 'icon.png', threshold: 0.9 }],
        },
      };
      const ctx = ctxFor(adapter);
      ctx.vars['__hermes_assets_dir__'] = dir;
      await getScreenHandler('click').execute(step, ctx);
      expect(adapter.findImageOnScreen).toHaveBeenCalledWith(Buffer.from('icon'), {
        threshold: 0.9,
      });
      expect(adapter.click).toHaveBeenCalledWith({ x: 10, y: 20 }, expect.anything());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('click throws selector_not_found when the image is not on screen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-screen-'));
    try {
      const asset = join(dir, 'missing.png');
      await writeFile(asset, Buffer.from('x'));
      const adapter = fakeAdapter({
        findImageOnScreen: vi.fn(async () => ({ found: false, score: 0.3 })),
      });
      const step: Step = {
        id: 'sc3',
        type: 'click',
        enabled: true,
        target: {
          layer: 'screen',
          candidates: [{ kind: 'image', assetRef: asset, threshold: 0.8 }],
        },
      };
      await expect(getScreenHandler('click').execute(step, ctxFor(adapter))).rejects.toMatchObject({
        class: 'selector_not_found',
      });
      expect(adapter.click).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('click via ocr selector clicks the center of the matching line', async () => {
    const adapter = fakeAdapter({
      readScreenText: vi.fn(async () => ({
        text: 'Cancel\nSubmit',
        observations: [
          { text: 'Cancel', confidence: 0.9, bbox: { x: 0, y: 0, w: 60, h: 20 } },
          { text: 'Submit', confidence: 0.95, bbox: { x: 0, y: 40, w: 60, h: 20 } },
        ],
      })),
    });
    const step: Step = {
      id: 'sc4',
      type: 'click',
      enabled: true,
      target: { layer: 'screen', candidates: [{ kind: 'ocr', text: 'Submit', lang: 'en' }] },
    };
    await getScreenHandler('click').execute(step, ctxFor(adapter));
    expect(adapter.click).toHaveBeenCalledWith({ x: 30, y: 50 }, expect.anything());
  });

  it('extract reads all OCR text into the target variable', async () => {
    const adapter = fakeAdapter({
      readScreenText: vi.fn(async () => ({
        text: 'Total: 42',
        observations: [{ text: 'Total: 42', confidence: 0.99, bbox: { x: 0, y: 0, w: 80, h: 20 } }],
      })),
    });
    const step: Step = {
      id: 'sc5',
      type: 'extract',
      enabled: true,
      params: { into: 'amount' },
    };
    const ctx = ctxFor(adapter);
    const res = await getScreenHandler('extract').execute(step, ctx);
    expect(ctx.vars['amount']).toBe('Total: 42');
    expect(res.data).toEqual({ value: 'Total: 42' });
  });

  it('extract with an ocr selector narrows to the matching line', async () => {
    const adapter = fakeAdapter({
      readScreenText: vi.fn(async () => ({
        text: 'Name: Bob\nTotal: 42',
        observations: [
          { text: 'Name: Bob', confidence: 0.9, bbox: { x: 0, y: 0, w: 80, h: 20 } },
          { text: 'Total: 42', confidence: 0.95, bbox: { x: 0, y: 40, w: 80, h: 20 } },
        ],
      })),
    });
    const step: Step = {
      id: 'sc6',
      type: 'extract',
      enabled: true,
      target: { layer: 'screen', candidates: [{ kind: 'ocr', text: 'Total', lang: 'en' }] },
      params: { into: 'total' },
    };
    const ctx = ctxFor(adapter);
    await getScreenHandler('extract').execute(step, ctx);
    expect(ctx.vars['total']).toBe('Total: 42');
  });

  it('registerScreenHandlers adds click + extract under the screen layer', () => {
    const r = new HandlerRegistry();
    registerScreenHandlers(r);
    expect(r.get('click', 'screen')).toBeDefined();
    expect(r.get('extract', 'screen')).toBeDefined();
    expect(r.get('click')).toBeUndefined(); // no default-layer handler
  });
});
