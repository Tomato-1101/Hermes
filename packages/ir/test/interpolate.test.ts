import { describe, expect, it } from 'vitest';
import { collectSecretRefs, interpolate, interpolateParams } from '../src/interpolate.js';

describe('interpolate', () => {
  it('replaces var.<path>', () => {
    expect(interpolate('hello ${var.name}', { var: { name: 'world' } })).toBe('hello world');
  });

  it('handles nested member access', () => {
    expect(
      interpolate('${var.user.email}', {
        var: { user: { email: 'a@example.com' } },
      }),
    ).toBe('a@example.com');
  });

  it('returns empty string for missing var', () => {
    expect(interpolate('hello ${var.missing}', { var: {} })).toBe('hello ');
  });

  it('preserves unknown roots', () => {
    expect(interpolate('${unknown.x}', {})).toBe('${unknown.x}');
  });

  it('replaces secrets.<name> from context', () => {
    expect(
      interpolate('Bearer ${secrets.token}', {
        secrets: { token: 'abc' },
      }),
    ).toBe('Bearer abc');
  });

  it('returns input as-is when there is no placeholder', () => {
    expect(interpolate('plain text', { var: { x: 1 } })).toBe('plain text');
  });

  it('handles multiple placeholders in one string', () => {
    expect(
      interpolate('${var.a}-${var.b}', { var: { a: 'foo', b: 'bar' } }),
    ).toBe('foo-bar');
  });

  it('non-string input passes through', () => {
    // @ts-expect-error  intentionally testing runtime guard
    expect(interpolate(42, {})).toBe(42);
  });
});

describe('interpolateParams', () => {
  it('walks nested objects and arrays', () => {
    const out = interpolateParams(
      { text: 'hi ${var.name}', list: ['${var.name}', 'lit'], nested: { value: '${var.n}' } },
      { var: { name: 'sam', n: 42 } },
    );
    expect(out).toEqual({ text: 'hi sam', list: ['sam', 'lit'], nested: { value: '42' } });
  });
});

describe('collectSecretRefs', () => {
  it('returns the unique names of secrets referenced', () => {
    expect(collectSecretRefs({ a: 'Bearer ${secrets.token}', b: '${secrets.api_key}' })).toEqual(
      expect.arrayContaining(['token', 'api_key']),
    );
  });

  it('ignores non-secret placeholders', () => {
    expect(collectSecretRefs({ a: '${var.x}', b: 'literal' })).toEqual([]);
  });
});
