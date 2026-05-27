import { describe, expect, it } from 'vitest';
import { candidateLabel } from '../src/selector.js';
import type { Selector } from '@hermes/ir';

describe('candidateLabel', () => {
  const cases: Array<[Selector, RegExp]> = [
    [{ kind: 'role', role: 'button', name: 'Save' }, /role: button\[name="Save"\]/],
    [{ kind: 'role', role: 'button' }, /role: button$/],
    [{ kind: 'testid', value: 'submit' }, /testid: submit/],
    [{ kind: 'label', text: 'Email' }, /label: Email/],
    [{ kind: 'text', value: 'Hello, world. '.repeat(10) }, /^text: /],
    [{ kind: 'css', value: '.btn-primary' }, /css: \.btn-primary/],
    [{ kind: 'xpath', value: '//button' }, /xpath: \/\/button/],
    [{ kind: 'url-anchor', pattern: 'https?://example\\.com' }, /url:/],
    [{ kind: 'ax', app: 'com.apple.Notes', role: 'AXButton' }, /ax: com\.apple\.Notes\/AXButton/],
    [
      {
        kind: 'uia',
        processName: 'notepad.exe',
        controlType: 'Edit',
      },
      /uia: notepad\.exe\/Edit/,
    ],
    [{ kind: 'image', assetRef: 'a.png', threshold: 0.9 }, /image: a\.png/],
    [{ kind: 'ocr', text: 'OK', lang: 'eng' }, /ocr: OK/],
    [{ kind: 'coords', x: 10, y: 20, anchor: 'screen' }, /coords: \(10, 20\)/],
  ];

  for (const [sel, re] of cases) {
    it(`labels ${sel.kind}`, () => {
      expect(candidateLabel(sel)).toMatch(re);
    });
  }

  it('truncates long text', () => {
    const long = 'x'.repeat(200);
    const label = candidateLabel({ kind: 'text', value: long });
    expect(label.length).toBeLessThanOrEqual('text: '.length + 40);
  });
});
