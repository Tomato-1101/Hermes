import mitt, { type Emitter } from 'mitt';
import type { Flow, Step } from '@hermes/ir';
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

type EmitterEvents = { event: RunEvent };

export class StepExecutor {
  private readonly registry: HandlerRegistry;
  private readonly providers: ProviderBag;
  private readonly emitter: Emitter<EmitterEvents>;

  constructor(opts: { registry: HandlerRegistry; providers?: ProviderBag }) {
    this.registry = opts.registry;
    this.providers = opts.providers ?? {};
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
    // Structural step types are handled here directly.
    switch (step.type) {
      case 'if':
        return this.executeIf(step, ctx, cursor);
      case 'loop':
        return this.executeLoop(step, ctx, cursor);
      case 'try':
        return this.executeTry(step, ctx, cursor);
      case 'log':
        ctx.emit({
          type: 'log',
          level: (step.params?.level as 'debug' | 'info' | 'warn' | 'error') ?? 'info',
          message: String(step.params?.message ?? ''),
        });
        return { outcome: 'completed' };
      default: {
        const handler = this.registry.get(step.type, step.target?.layer);
        if (!handler) {
          const layerSuffix = step.target?.layer ? ` (layer="${step.target.layer}")` : '';
          throw new Error(`No handler registered for step type "${step.type}"${layerSuffix}`);
        }
        const promise = handler.execute(step, ctx);
        return await withTimeout(promise, step.timeoutMs ?? ctx.flow.defaults.timeoutMs, ctx.signal);
      }
    }
  }

  private async executeIf(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    // For now: rely on branches[0].condition being truthy. Expression evaluation
    // is wired in by callers (engine doesn't depend on @hermes/ir/expr to keep
    // the boundary clean). The expression evaluator lives in @hermes/ir and is
    // invoked by app-level orchestration before passing the resolved boolean.
    const branches = step.branches ?? [];
    const condValue = step.params?.['condition'];
    const passing = branches.find((b, idx) => {
      if (idx === 0) return Boolean(condValue);
      return false;
    });
    if (passing) {
      await this.runSteps(passing.steps, ctx, `${cursor}.branches[0].steps`);
    } else if (step.children && step.children.length > 0) {
      // children acts as "else"
      await this.runSteps(step.children, ctx, `${cursor}.children`);
    }
    return { outcome: 'completed' };
  }

  private async executeLoop(step: Step, ctx: RunContext, cursor: string): Promise<StepResult> {
    const kind = (step.params?.['kind'] as string) ?? 'for';
    const count = Number(step.params?.['count'] ?? 0);
    const children = step.children ?? [];
    if (kind === 'for') {
      for (let i = 0; i < count; i++) {
        this.assertNotAborted(ctx);
        await this.runSteps(children, ctx, `${cursor}.children[${i}]`);
      }
    } else if (kind === 'forEach') {
      const items = (step.params?.['items'] as unknown[]) ?? [];
      const asVar = (step.params?.['asVar'] as string) ?? 'item';
      for (let i = 0; i < items.length; i++) {
        this.assertNotAborted(ctx);
        ctx.vars[asVar] = items[i];
        await this.runSteps(children, ctx, `${cursor}.children[${i}]`);
      }
    } else {
      throw new Error(`Unsupported loop kind "${kind}" (while requires expr evaluation provided by caller)`);
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
