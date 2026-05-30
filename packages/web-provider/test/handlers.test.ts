import { describe, expect, it, vi } from 'vitest';
import { HandlerRegistry } from '@hermes/engine';
import type { RunContext, StepHandler } from '@hermes/engine';
import type { Step } from '@hermes/ir';
import { registerWebHandlers, webStepHandlers } from '../src/handlers.js';
import { WebProvider } from '../src/web-provider.js';

describe('webStepHandlers', () => {
  it('registers the expected web step types', () => {
    const reg = new HandlerRegistry();
    registerWebHandlers(reg);
    const types = reg.list();
    expect(types).toContain('open_url');
    expect(types).toContain('click');
    expect(types).toContain('type');
    expect(types).toContain('key_combo');
    expect(types).toContain('scroll');
    expect(types).toContain('wait_for');
    expect(types).toContain('wait');
    expect(types).toContain('screenshot');
    expect(types).toContain('extract');
    expect(types).toContain('set_var');
  });

  it('refuses double registration', () => {
    const reg = new HandlerRegistry();
    registerWebHandlers(reg);
    expect(() => reg.register(webStepHandlers[0]!)).toThrow();
  });
});

function findHandler(type: string): StepHandler {
  const h = webStepHandlers.find((x) => x.type === type);
  if (!h) throw new Error(`handler not found for ${type}`);
  return h;
}

function fakeProvider(): WebProvider {
  // Construct without start(): no chromium boot, just the surface needed
  // to spy on the wait-for-related methods.
  const p = new WebProvider({ profileDir: '/tmp/hermes-web-test-fake' });
  vi.spyOn(p, 'waitForLoadState').mockResolvedValue(undefined);
  vi.spyOn(p, 'waitFor').mockResolvedValue(undefined);
  return p;
}

function fakeCtx(provider: WebProvider): RunContext {
  return {
    flowId: 'f',
    runId: 'r',
    signal: new AbortController().signal,
    providers: { web: provider },
    vars: {},
    secrets: {},
    inputs: {},
    outputs: {},
    layer: 'web',
    log: () => undefined,
  } as unknown as RunContext;
}

describe('wait_for handler kind dispatch', () => {
  const waitFor = findHandler('wait_for');

  it('kind=web.load calls provider.waitForLoadState with state and timeout', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'web.load', state: 'networkidle', timeoutMs: 1234 },
    };
    await waitFor.execute(step, fakeCtx(p));
    expect(p.waitForLoadState).toHaveBeenCalledWith('networkidle', 1234);
  });

  it('kind=web.load defaults state to "load" and timeout to 10000', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'web.load' },
    };
    await waitFor.execute(step, fakeCtx(p));
    expect(p.waitForLoadState).toHaveBeenCalledWith('load', 10_000);
  });

  it('kind=web.url forwards url and timeout to waitFor', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'web.url', url: 'https://example.com/done', timeoutMs: 500 },
    };
    await waitFor.execute(step, fakeCtx(p));
    expect(p.waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/done', timeoutMs: 500 }),
    );
  });

  it('kind=web.url without url throws', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      params: { kind: 'web.url' },
    };
    await expect(waitFor.execute(step, fakeCtx(p))).rejects.toThrow(/url/);
  });

  it('kind=web.element forwards target and state to waitFor', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      target: { layer: 'web', candidates: [{ kind: 'css', value: '#go' }] },
      params: { kind: 'web.element', state: 'visible', timeoutMs: 800 },
    };
    await waitFor.execute(step, fakeCtx(p));
    expect(p.waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'visible', timeoutMs: 800 }),
    );
  });

  it('kind absent + target present falls through to waitFor (legacy behavior)', async () => {
    const p = fakeProvider();
    const step: Step = {
      id: 's1',
      type: 'wait_for',
      enabled: true,
      target: { layer: 'web', candidates: [{ kind: 'css', value: '#go' }] },
      params: {},
    };
    await waitFor.execute(step, fakeCtx(p));
    expect(p.waitFor).toHaveBeenCalled();
  });
});
