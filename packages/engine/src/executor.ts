import mitt, { type Emitter } from 'mitt';
import type { Flow, Step } from '@hermes/ir';
import {
  evaluateExpr,
  ExprError,
  interpolateParams,
  type ExprContext,
  type InterpolateContext,
} from '@hermes/ir';
import { HandlerRegistry } from './registry.js';
import { nextDelayMs, shouldRetry, sleep } from './retry.js';
import {
  HermesAbortError,
  type ProviderBag,
  type RunContext,
  type RunEvent,
  type RunOptions,
  type StepResult,
  type StepStatus,
} from './types.js';

/**
 * Per-run map of secret names → resolved plaintext values. Populated by
 * the caller (apps/hermes) before run() — the engine itself never
 * touches the Vault, it just substitutes pre-fetched values into
 * `${secrets.<name>}` placeholders at dispatch time.
 */
export type SecretsMap = Record<string, string | undefined>;

type EmitterEvents = { event: RunEvent };

export class StepExecutor {
  private readonly registry: HandlerRegistry;
  private readonly providers: ProviderBag;
  private readonly emitter: Emitter<EmitterEvents>;
  private readonly secrets: SecretsMap;

  constructor(opts: {
    registry: HandlerRegistry;
    providers?: ProviderBag;
    /** Pre-resolved secret values for `${secrets.<name>}` substitution. */
    secrets?: SecretsMap;
  }) {
    this.registry = opts.registry;
    this.providers = opts.providers ?? {};
    this.secrets = opts.secrets ?? {};
    this.emitter = mitt<EmitterEvents>();
  }

  on(listener: (e: RunEvent) => void): () => void {
    const wrapped = (e: RunEvent): void => listener(e);
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  async run(flow: Flow, options: RunOptions = {}): Promise<'success' | 'failure' | 'aborted'> {
    const signal = options.signal ?? new AbortController().signal;
    const ctx: RunContext = {
      flow,
      vars: this.initialVars(flow, options.inputs),
      inputs: options.inputs ?? {},
      outputs: {},
      signal,
      emit: (event) => this.emitter.emit('event', event),
      providers: this.providers,
    };

    ctx.emit({ type: 'run:start', flowId: flow.id });

    try {
      await this.runSteps(flow.steps, ctx, 'steps');
      ctx.emit({ type: 'run:end', flowId: flow.id, outcome: 'success' });
      return 'success';
    } catch (e) {
      const aborted = e instanceof HermesAbortError || (e as Error).message === 'aborted';
      const outcome = aborted ? 'aborted' : 'failure';
      ctx.emit({ type: 'run:end', flowId: flow.id, outcome });
      if (!aborted) {
        ctx.emit({
          type: 'log',
          level: 'error',
          message: `Run failed: ${(e as Error).message}`,
        });
      }
      return outcome;
    }
  }

  private initialVars(flow: Flow, inputs?: Record<string, unknown>): Record<string, unknown> {
    const vars: Record<string, unknown> = {};
    for (const decl of flow.variables) {
      if (decl.defaultValue !== undefined) vars[decl.name] = decl.defaultValue;
    }
    if (inputs) Object.assign(vars, inputs);
    return vars;
  }

  private async runSteps(steps: Step[], ctx: RunContext, cursorPrefix: string): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (!step.enabled) continue;
      this.assertNotAborted(ctx);
      await this.runStep(step, ctx, `${cursorPrefix}[${i}]`);
    }
  }

  private async runStep(step: Step, ctx: RunContext, cursor: string): Promise<void> {
    ctx.emit({ type: 'step:start', cursor, step });

    const policy = step.retry ?? ctx.flow.defaults.retry;
    const attempts = Math.max(1, policy.attempts);
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const result = await this.executeOnce(step, ctx, cursor);
        ctx.emit({ type: 'step:end', cursor, step, outcome: result.outcome });
        return;
      } catch (e) {
        lastError = e as Error;
        const errorClass = (e as { class?: string }).class;
        const canRetry = attempt < attempts - 1 && shouldRetry(policy, errorClass);
        if (!canRetry) break;
        const delay = nextDelayMs(policy, attempt);
        ctx.emit({
          type: 'log',
          level: 'warn',
          message: `step ${cursor} failed (attempt ${attempt + 1}/${attempts}): ${lastError.message}; retrying in ${delay}ms`,
        });
        await sleep(delay, ctx.signal);
      }
    }

    // All attempts exhausted; consult onError policy.
    const policyOnError = step.onError ?? 'fail';
    if (policyOnError === 'continue') {
      ctx.emit({ type: 'step:end', cursor, step, outcome: 'skipped', error: lastError?.message });
      return;
    }
    const status: StepStatus = 'failed';
    ctx.emit({ type: 'step:end', cursor, step, outcome: status, error: lastError?.message });
    throw lastError ?? new Error(`step ${cursor} failed`);
  }

  private async executeOnce(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    // Resolve ${var.x} / ${secrets.x} / ${env.X} / ${ctx.x} in params for
    // *every* step type, including structural ones — otherwise variables
    // are silently empty inside if conditions, loop counts, log messages, etc.
    const resolved = this.resolveStep(step, ctx);

    switch (resolved.type) {
      case 'if':
        return this.executeIf(resolved, ctx, cursor);
      case 'loop':
        return this.executeLoop(resolved, ctx, cursor);
      case 'try':
        return this.executeTry(resolved, ctx, cursor);
      case 'log':
        ctx.emit({
          type: 'log',
          level: (resolved.params?.level as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
          message: String(resolved.params?.message ?? ''),
        });
        return { outcome: 'completed' };
      default: {
        const handler = this.registry.get(resolved.type, resolved.target?.layer);
        if (!handler) {
          const layerSuffix = resolved.target?.layer ? ` (layer="${resolved.target.layer}")` : '';
          throw new Error(`No handler registered for step type "${resolved.type}"${layerSuffix}`);
        }
        const promise = handler.execute(resolved, ctx);
        return await withTimeout(promise, resolved.timeoutMs ?? ctx.flow.defaults.timeoutMs, ctx.signal);
      }
    }
  }

  /**
   * Evaluate a string from an if/loop condition. The string is first treated
   * as a jsep expression — but to keep simple cases ergonomic, if parsing
   * fails or the result is a string we also fall back to a plain truthy
   * check (so `condition: ""` still means false and `condition: "yes"` still
   * means true). Editor wires put a literal `"true"` or `"${var.x}"` here.
   */
  private evalCondition(condition: unknown, ctx: RunContext): boolean {
    if (condition === undefined || condition === null) return false;
    if (typeof condition === 'boolean') return condition;
    if (typeof condition === 'number') return condition !== 0;
    if (typeof condition !== 'string') return Boolean(condition);
    const trimmed = condition.trim();
    if (!trimmed) return false;
    try {
      const exprCtx: ExprContext = {
        var: ctx.vars,
        env: process.env,
        secrets: {},
        ctx: ctx.outputs,
      };
      const result = evaluateExpr(trimmed, exprCtx);
      return Boolean(result);
    } catch (e) {
      // Fall back to truthy on plain strings that aren't valid expressions —
      // matches what a non-technical user typing "yes" would expect.
      if (e instanceof ExprError) return Boolean(trimmed);
      throw e;
    }
  }

  private async executeIf(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    // step.params.condition is parsed as a jsep expression (with truthy
    // fall-back for plain strings). branches[0].steps runs on true,
    // step.children acts as the else branch.
    const branches = step.branches ?? [];
    const passed = this.evalCondition(step.params?.['condition'], ctx);
    if (passed) {
      const then = branches[0];
      if (then) await this.runSteps(then.steps, ctx, `${cursor}.branches[0].steps`);
    } else if (step.children && step.children.length > 0) {
      await this.runSteps(step.children, ctx, `${cursor}.children`);
    }
    return { outcome: 'completed' };
  }

  private async executeLoop(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    const kind = (step.params?.['kind'] as string) ?? 'for';
    const children = step.children ?? [];
    if (kind === 'for') {
      const count = Number(step.params?.['count'] ?? 0);
      for (let i = 0; i < count; i++) {
        this.assertNotAborted(ctx);
        await this.runSteps(children, ctx, `${cursor}.children[${i}]`);
      }
    } else if (kind === 'forEach') {
      // items can be a JSON array literal or a `${var.x}` reference that the
      // interpolator already resolved to the actual array.
      const items = (step.params?.['items'] as unknown[]) ?? [];
      const asVar = (step.params?.['asVar'] as string) ?? 'item';
      if (!Array.isArray(items)) {
        throw new Error(`loop forEach: params.items must be an array, got ${typeof items}`);
      }
      for (let i = 0; i < items.length; i++) {
        this.assertNotAborted(ctx);
        ctx.vars[asVar] = items[i];
        await this.runSteps(children, ctx, `${cursor}.children[${i}]`);
      }
    } else if (kind === 'while') {
      const condition = step.params?.['condition'];
      const maxIter = Number(step.params?.['maxIterations'] ?? 1000);
      let i = 0;
      while (this.evalCondition(condition, ctx)) {
        this.assertNotAborted(ctx);
        if (i >= maxIter) {
          throw new Error(`loop while: exceeded maxIterations (${maxIter})`);
        }
        await this.runSteps(children, ctx, `${cursor}.children[${i}]`);
        i++;
      }
    } else {
      throw new Error(`Unsupported loop kind "${kind}"`);
    }
    return { outcome: 'completed' };
  }

  private async executeTry(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    const children = step.children ?? [];
    const branches = step.branches ?? [];
    const catchBranch = branches.find((b) => b.name === 'catch');
    const finallyBranch = branches.find((b) => b.name === 'finally');
    try {
      await this.runSteps(children, ctx, `${cursor}.children`);
    } catch (e) {
      if (catchBranch) {
        ctx.vars['__error__'] = (e as Error).message;
        await this.runSteps(catchBranch.steps, ctx, `${cursor}.catch`);
      } else {
        throw e;
      }
    } finally {
      if (finallyBranch) {
        await this.runSteps(finallyBranch.steps, ctx, `${cursor}.finally`);
      }
    }
    return { outcome: 'completed' };
  }

  private assertNotAborted(ctx: RunContext): void {
    if (ctx.signal.aborted) throw new HermesAbortError();
  }

  /**
   * Return a copy of `step` with all `${var.*}` / `${secrets.*}` /
   * `${env.*}` / `${ctx.*}` placeholders in `params` replaced. The
   * original step in the Flow is left untouched so we never persist a
   * resolved secret back to disk.
   */
  private resolveStep(step: Step, ctx: RunContext): Step {
    if (!step.params) return step;
    const interpCtx: InterpolateContext = {
      var: ctx.vars,
      env: process.env,
      secrets: this.secrets,
      ctx: ctx.outputs,
    };
    return { ...step, params: interpolateParams(step.params, interpCtx) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  if (!ms || ms <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error(`step timed out after ${ms}ms`), { class: 'timeout' }));
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new HermesAbortError());
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}
