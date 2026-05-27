/**
 * Expression evaluator for Flow IR.
 *
 * Uses jsep to parse JS-like syntax, then walks the AST with a strict
 * allow-list. We deliberately do NOT use `eval` / `Function`:
 *  - no member-call other than whitelisted functions
 *  - no assignment, new, throw, sequence, conditional-spread, etc.
 *  - identifiers are resolved against the provided context object only.
 *
 * Supported:
 *   - literals: number, string, boolean, null
 *   - identifiers: var.x.y, ctx.lastResult, env.HOME, secrets.token, item
 *   - binary: + - * / % === !== == != > >= < <= && || ?? &  |  ^
 *   - unary:  + - ! typeof
 *   - member access: a.b, a["b"]
 *   - calls to whitelisted functions only: contains, startsWith, endsWith,
 *                                         length, lower, upper, trim, regexTest,
 *                                         min, max, abs, round, floor, ceil,
 *                                         not, and, or
 *
 * Anything else throws a clear ExprError.
 */

import jsep from 'jsep';

jsep.addBinaryOp('??', 1);

export interface ExprContext {
  var?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  secrets?: Record<string, string | undefined>;
  ctx?: Record<string, unknown>;
  /** Free variables (e.g. `item` inside a forEach loop). */
  locals?: Record<string, unknown>;
}

export class ExprError extends Error {
  constructor(message: string) {
    super(`ExprError: ${message}`);
    this.name = 'ExprError';
  }
}

const ALLOWED_FUNCTIONS: Record<string, (...args: unknown[]) => unknown> = {
  contains: (haystack, needle) =>
    typeof haystack === 'string' && typeof needle === 'string' && haystack.includes(needle),
  startsWith: (s, p) => typeof s === 'string' && typeof p === 'string' && s.startsWith(p),
  endsWith: (s, p) => typeof s === 'string' && typeof p === 'string' && s.endsWith(p),
  length: (s) => {
    if (typeof s === 'string') return s.length;
    if (Array.isArray(s)) return s.length;
    return 0;
  },
  lower: (s) => (typeof s === 'string' ? s.toLowerCase() : s),
  upper: (s) => (typeof s === 'string' ? s.toUpperCase() : s),
  trim: (s) => (typeof s === 'string' ? s.trim() : s),
  regexTest: (s, pattern, flags) => {
    if (typeof s !== 'string' || typeof pattern !== 'string') return false;
    return new RegExp(pattern, typeof flags === 'string' ? flags : '').test(s);
  },
  min: (...nums) => Math.min(...(nums as number[])),
  max: (...nums) => Math.max(...(nums as number[])),
  abs: (n) => Math.abs(Number(n)),
  round: (n) => Math.round(Number(n)),
  floor: (n) => Math.floor(Number(n)),
  ceil: (n) => Math.ceil(Number(n)),
  not: (v) => !v,
  and: (...vs) => vs.every(Boolean),
  or: (...vs) => vs.some(Boolean),
};

// Allowed top-level identifiers map to context keys.
const ALLOWED_ROOTS = new Set(['var', 'env', 'secrets', 'ctx']);

interface AstNode {
  type: string;
  [k: string]: unknown;
}

export function parseExpr(source: string): unknown {
  if (typeof source !== 'string') throw new ExprError('expression must be a string');
  try {
    return jsep(source);
  } catch (e) {
    throw new ExprError(`parse failed: ${(e as Error).message}`);
  }
}

export function evaluateExpr(source: string | { __ast: unknown }, context: ExprContext): unknown {
  const ast =
    typeof source === 'string' ? (parseExpr(source) as AstNode) : (source.__ast as AstNode);
  return walk(ast, context);
}

function walk(node: AstNode, ctx: ExprContext): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;

    case 'Identifier': {
      const name = node.name as string;
      if (ALLOWED_ROOTS.has(name)) {
        return (ctx as Record<string, unknown>)[name] ?? {};
      }
      if (ctx.locals && Object.prototype.hasOwnProperty.call(ctx.locals, name)) {
        return ctx.locals[name];
      }
      throw new ExprError(`unknown identifier "${name}"`);
    }

    case 'MemberExpression': {
      const obj = walk(node.object as AstNode, ctx);
      let key: PropertyKey;
      if (node.computed) {
        const computed = walk(node.property as AstNode, ctx);
        if (typeof computed !== 'string' && typeof computed !== 'number') {
          throw new ExprError(`member key must be string or number`);
        }
        key = computed;
      } else {
        const prop = node.property as AstNode;
        if (prop.type !== 'Identifier') throw new ExprError(`unsupported member access`);
        key = prop.name as string;
      }
      if (obj == null) return undefined;
      // Block access to special keys to prevent escape.
      if (
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype' ||
        key === 'toString' ||
        key === 'valueOf'
      ) {
        throw new ExprError(`forbidden property access "${String(key)}"`);
      }
      return (obj as Record<PropertyKey, unknown>)[key];
    }

    case 'BinaryExpression':
    case 'LogicalExpression': {
      const op = node.operator as string;
      const left = walk(node.left as AstNode, ctx);
      // Short-circuit for logical operators.
      if (op === '&&') return left ? walk(node.right as AstNode, ctx) : left;
      if (op === '||') return left ? left : walk(node.right as AstNode, ctx);
      if (op === '??') return left ?? walk(node.right as AstNode, ctx);
      const right = walk(node.right as AstNode, ctx);
      return applyBinary(op, left, right);
    }

    case 'UnaryExpression': {
      const op = node.operator as string;
      const arg = walk(node.argument as AstNode, ctx);
      if (op === '!') return !arg;
      if (op === '+') return +Number(arg);
      if (op === '-') return -Number(arg);
      if (op === 'typeof') return typeof arg;
      throw new ExprError(`unsupported unary operator "${op}"`);
    }

    case 'CallExpression': {
      const callee = node.callee as AstNode;
      if (callee.type !== 'Identifier') {
        throw new ExprError('only top-level whitelisted function calls are allowed');
      }
      const name = callee.name as string;
      const fn = ALLOWED_FUNCTIONS[name];
      if (!fn) throw new ExprError(`unknown function "${name}"`);
      const args = (node.arguments as AstNode[]).map((a) => walk(a, ctx));
      return fn(...args);
    }

    case 'ConditionalExpression': {
      const test = walk(node.test as AstNode, ctx);
      return test ? walk(node.consequent as AstNode, ctx) : walk(node.alternate as AstNode, ctx);
    }

    case 'ArrayExpression':
      return (node.elements as AstNode[]).map((e) => walk(e, ctx));

    default:
      throw new ExprError(`unsupported node type "${node.type}"`);
  }
}

function applyBinary(op: string, a: unknown, b: unknown): unknown {
  switch (op) {
    case '+':
      if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
      return Number(a) + Number(b);
    case '-':
      return Number(a) - Number(b);
    case '*':
      return Number(a) * Number(b);
    case '/':
      return Number(a) / Number(b);
    case '%':
      return Number(a) % Number(b);
    case '===':
      return a === b;
    case '!==':
      return a !== b;
    case '==':
      // eslint-disable-next-line eqeqeq
      return a == b;
    case '!=':
      // eslint-disable-next-line eqeqeq
      return a != b;
    case '>':
      return (a as number) > (b as number);
    case '>=':
      return (a as number) >= (b as number);
    case '<':
      return (a as number) < (b as number);
    case '<=':
      return (a as number) <= (b as number);
    case '&':
      return (Number(a) & Number(b)) >>> 0;
    case '|':
      return (Number(a) | Number(b)) >>> 0;
    case '^':
      return (Number(a) ^ Number(b)) >>> 0;
    default:
      throw new ExprError(`unsupported binary operator "${op}"`);
  }
}
