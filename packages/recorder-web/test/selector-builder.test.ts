import { describe, expect, it } from 'vitest';
import { buildSelectorCandidates, type ElementSnapshot } from '../src/selector-builder.js';

describe('buildSelectorCandidates', () => {
  it('emits role+name first when both present', () => {
    const cs = buildSelectorCandidates({
      tag: 'button',
      role: 'button',
      ariaName: 'Save',
      cssPath: 'button.btn',
      xpath: '/html/body/button[1]',
    });
    expect(cs[0]).toEqual({ kind: 'role', role: 'button', name: 'Save', exact: true });
  });

  it('includes testid candidate', () => {
    const cs = buildSelectorCandidates({ tag: 'button', testid: 'submit-btn' });
    expect(cs.some((c) => c.kind === 'testid' && c.value === 'submit-btn')).toBe(true);
  });

  it('escapes weird id characters in css candidate', () => {
    const cs = buildSelectorCandidates({ tag: 'div', id: 'foo:bar' });
    const css = cs.find((c) => c.kind === 'css') as { kind: 'css'; value: string } | undefined;
    expect(css?.value).toBe('#foo\\:bar');
  });

  it('drops empty text values', () => {
    const cs = buildSelectorCandidates({ tag: 'span', text: '' });
    expect(cs.some((c) => c.kind === 'text')).toBe(false);
  });

  it('rejects extremely long text', () => {
    const cs = buildSelectorCandidates({ tag: 'p', text: 'x'.repeat(200) });
    expect(cs.some((c) => c.kind === 'text')).toBe(false);
  });

  it('dedupes equivalent candidates', () => {
    const snap: ElementSnapshot = {
      tag: 'a',
      id: 'foo',
      cssPath: '#foo',
    };
    const cs = buildSelectorCandidates(snap);
    const keys = cs.map((c) => JSON.stringify(c));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('emits in the documented priority order when many candidates exist', () => {
    const cs = buildSelectorCandidates({
      tag: 'button',
      role: 'button',
      ariaName: 'OK',
      testid: 'ok',
      id: 'ok',
      label: 'OK',
      text: 'OK',
      cssPath: 'button.ok',
      xpath: '//button[1]',
    });
    const order = cs.map((c) => c.kind);
    // role first, then testid, then label, then id-as-css, then text...
    expect(order[0]).toBe('role');
    expect(order[1]).toBe('testid');
    expect(order[2]).toBe('label');
    expect(order).toContain('xpath');
  });
});
