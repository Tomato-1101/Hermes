import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '@hermes/engine';
import { registerWebHandlers, webStepHandlers } from '../src/handlers.js';

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
