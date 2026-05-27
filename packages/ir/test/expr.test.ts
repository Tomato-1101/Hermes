import { describe, expect, it } from 'vitest';
import { ExprError, evaluateExpr } from '../src/expr.js';

const ctx = {
  var: { price: 120, text: 'Hello World', enabled: true, items: [1, 2, 3] },
  env: { HOME: '/Users/tomato' },
  secrets: { token: 'sk-xxx' },
  ctx: { lastResult: 'ok' },
  locals: { item: 42 },
};

describe('evaluateExpr', () => {
  it('handles primitive literals and arithmetic', () => {
    expect(evaluateExpr('1 + 2 * 3', ctx)).toBe(7);
    expect(evaluateExpr('"a" + "b"', ctx)).toBe('ab');
    expect(evaluateExpr('true && !false', ctx)).toBe(true);
  });

  it('resolves identifiers from context', () => {
    expect(evaluateExpr('var.price', ctx)).toBe(120);
    expect(evaluateExpr('env.HOME', ctx)).toBe('/Users/tomato');
    expect(evaluateExpr('ctx.lastResult', ctx)).toBe('ok');
    expect(evaluateExpr('item', ctx)).toBe(42);
  });

  it('compares values', () => {
    expect(evaluateExpr('var.price > 100', ctx)).toBe(true);
    expect(evaluateExpr('var.price >= 120', ctx)).toBe(true);
    expect(evaluateExpr('var.text === "Hello World"', ctx)).toBe(true);
  });

  it('supports whitelisted function calls', () => {
    expect(evaluateExpr('contains(var.text, "World")', ctx)).toBe(true);
    expect(evaluateExpr('startsWith(var.text, "Hello")', ctx)).toBe(true);
    expect(evaluateExpr('length(var.text)', ctx)).toBe(11);
    expect(evaluateExpr('lower(var.text)', ctx)).toBe('hello world');
    expect(evaluateExpr('regexTest(var.text, "wo[rt]ld", "i")', ctx)).toBe(true);
    expect(evaluateExpr('max(1, 5, 3)', ctx)).toBe(5);
  });

  it('handles ternary and array literals', () => {
    expect(evaluateExpr('var.price > 100 ? "expensive" : "cheap"', ctx)).toBe('expensive');
    expect(evaluateExpr('[1, 2, 3]', ctx)).toEqual([1, 2, 3]);
  });

  it('short-circuits ?? and ||', () => {
    expect(evaluateExpr('null ?? 7', ctx)).toBe(7);
    expect(evaluateExpr('0 || "fallback"', ctx)).toBe('fallback');
  });

  it('rejects unknown identifiers', () => {
    expect(() => evaluateExpr('process.env.HOME', ctx)).toThrow(ExprError);
    expect(() => evaluateExpr('global', ctx)).toThrow(ExprError);
    expect(() => evaluateExpr('undefinedVar', ctx)).toThrow(ExprError);
  });

  it('blocks dangerous property access', () => {
    expect(() => evaluateExpr('var.__proto__', ctx)).toThrow(/forbidden/);
    expect(() => evaluateExpr('var.constructor', ctx)).toThrow(/forbidden/);
  });

  it('rejects non-whitelisted function calls', () => {
    expect(() => evaluateExpr('eval("1+1")', ctx)).toThrow(/unknown function/);
    // method calls like `var.text.includes("World")` should fail because callee is a MemberExpression
    expect(() => evaluateExpr('var.text.includes("World")', ctx)).toThrow(
      /only top-level whitelisted function calls are allowed/,
    );
  });
});
