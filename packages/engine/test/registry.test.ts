import { describe, expect, it } from 'vitest';
import type { StepHandler } from '../src/index.js';
import { HandlerRegistry } from '../src/index.js';

function fakeHandler(label: string): StepHandler {
  return {
    type: 'click',
    execute: async () => ({ outcome: 'completed', data: { label } }),
  } as StepHandler;
}

describe('HandlerRegistry layer-aware lookup', () => {
  it('default-layer handler is used when no layer is provided', () => {
    const r = new HandlerRegistry();
    r.register(fakeHandler('default'));
    expect(r.get('click')).toBeDefined();
    expect(r.get('click', 'web')).toBeDefined(); // fallback
  });

  it('layered handler takes precedence over default', async () => {
    const r = new HandlerRegistry();
    r.register(fakeHandler('default'));
    r.register(fakeHandler('desktop'), 'desktop');
    const ctx = {} as never;
    const defaultRes = await r.get('click')?.execute({} as never, ctx);
    const desktopRes = await r.get('click', 'desktop')?.execute({} as never, ctx);
    expect(defaultRes?.data).toEqual({ label: 'default' });
    expect(desktopRes?.data).toEqual({ label: 'desktop' });
  });

  it('layer-specific lookup falls back to default when not registered', async () => {
    const r = new HandlerRegistry();
    r.register(fakeHandler('default'));
    const res = await r.get('click', 'web')?.execute({} as never, {} as never);
    expect(res?.data).toEqual({ label: 'default' });
  });

  it('refuses duplicate registrations within the same layer', () => {
    const r = new HandlerRegistry();
    r.register(fakeHandler('a'));
    expect(() => r.register(fakeHandler('b'))).toThrow(/already registered/);
  });

  it('allows same type to register in different layers', () => {
    const r = new HandlerRegistry();
    r.register(fakeHandler('a'));
    expect(() => r.register(fakeHandler('b'), 'desktop')).not.toThrow();
  });
});
