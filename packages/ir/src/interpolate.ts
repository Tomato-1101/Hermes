/**
 * Variable interpolation for `${...}` template strings used in step
 * parameters. Supports four root namespaces:
 *
 *   `${var.foo.bar}`     — runtime variables (RunContext.vars)
 *   `${env.HOME}`        — process env at run time
 *   `${secrets.token}`   — values fetched from the Vault
 *   `${ctx.lastResult}`  — engine-injected context (e.g. previous step output)
 *
 * Unknown root namespaces leave the placeholder unchanged so a user can
 * tell the difference between "secret not set" and "secret reference
 * lost". Unresolved `${var.foo}` returns an empty string and emits no
 * error (mirrors the lenient template approach the planner expects).
 *
 * NOTE: This is intentionally narrower than the full jsep evaluator
 * (`expr.ts`). It only handles dotted property access — no operators,
 * no function calls. Use the jsep evaluator for boolean/control-flow
 * conditions, and `interpolate` for ordinary string params.
 */
export interface InterpolateContext {
  var?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  secrets?: Record<string, string | undefined>;
  ctx?: Record<string, unknown>;
}

const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

const ROOTS = new Set(['var', 'env', 'secrets', 'ctx']);

export function interpolate(input: string, ctx: InterpolateContext): string {
  if (typeof input !== 'string' || input.indexOf('${') < 0) return input;
  return input.replace(PLACEHOLDER_RE, (raw, expr) => {
    const path = String(expr).trim().split('.');
    const root = path[0];
    if (!root || !ROOTS.has(root)) return raw;
    let cur: unknown = (ctx as Record<string, unknown>)[root];
    for (let i = 1; i < path.length; i++) {
      if (cur === null || cur === undefined) return '';
      const key = path[i];
      if (key === undefined) return '';
      cur = (cur as Record<string, unknown>)[key];
    }
    if (cur === undefined || cur === null) return '';
    return String(cur);
  });
}

/** Deep-clone a Step params object with all string values interpolated. */
export function interpolateParams<T extends Record<string, unknown> | undefined>(
  params: T,
  ctx: InterpolateContext,
): T {
  if (!params) return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = interpolateValue(v, ctx);
  }
  return out as T;
}

function interpolateValue(v: unknown, ctx: InterpolateContext): unknown {
  if (typeof v === 'string') return interpolate(v, ctx);
  if (Array.isArray(v)) return v.map((item) => interpolateValue(item, ctx));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = interpolateValue(val, ctx);
    return out;
  }
  return v;
}

/** Find every `${secrets.<name>}` reference in a step's params. */
export function collectSecretRefs(params: unknown): string[] {
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      let m;
      const re = new RegExp(PLACEHOLDER_RE);
      while ((m = re.exec(v))) {
        const expr = m[1]?.trim();
        if (expr?.startsWith('secrets.')) {
          const name = expr.slice('secrets.'.length).split('.')[0];
          if (name) found.add(name);
        }
      }
    } else if (Array.isArray(v)) {
      for (const item of v) visit(item);
    } else if (v && typeof v === 'object') {
      for (const val of Object.values(v)) visit(val);
    }
  };
  visit(params);
  return [...found];
}
