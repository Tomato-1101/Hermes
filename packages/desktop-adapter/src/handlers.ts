/**
 * Step handlers for desktop-layer Steps.
 *
 * The handlers expect `ctx.providers.desktop` to be a DesktopProvider
 * wrapping a DesktopAdapter implementation. They translate IR Steps into
 * adapter calls; coordinate / target resolution happens inside the
 * adapter, not here.
 *
 * Registered under the `desktop` HandlerLayer so they take precedence for
 * Steps whose target.layer === 'desktop', while the web handlers continue
 * to serve the default layer.
 */
import type { Step, StepType, TargetRef } from '@hermes/ir';
import type {
  HandlerRegistry,
  RunContext,
  StepHandler,
  StepResult,
} from '@hermes/engine';
import { DesktopProvider } from './desktop-provider.js';
import { DesktopAdapterError, type DesktopAdapter, type DesktopSelector, type Point } from './index.js';

function adapter(ctx: RunContext): DesktopAdapter {
  const p = ctx.providers.desktop;
  if (!p) throw new Error('Desktop provider not available in this run');
  if (!(p instanceof DesktopProvider)) {
    throw new Error('providers.desktop is not a DesktopProvider instance');
  }
  return p.adapter;
}

function makeHandler<T extends StepType>(
  type: T,
  execute: (step: Step, ctx: RunContext) => Promise<StepResult<Record<string, unknown>>>,
): StepHandler {
  return { type, execute };
}

/** Pull a coords-style point out of a TargetRef, or throw. */
function coordsFromTarget(target: TargetRef | undefined): Point {
  if (!target) throw new Error('desktop step requires a target');
  const coord = target.candidates.find((c) => c.kind === 'coords');
  if (!coord || coord.kind !== 'coords') {
    throw new DesktopAdapterError(
      'desktop step currently requires a coords selector candidate',
      'selector_not_found',
    );
  }
  return { x: coord.x, y: coord.y };
}

/** First candidate is the canonical one used for findElement. */
function selectorFromTarget(target: TargetRef | undefined): DesktopSelector {
  if (!target || target.candidates.length === 0) {
    throw new Error('desktop step requires a target with candidates');
  }
  const c = target.candidates[0]!;
  return c as unknown as DesktopSelector;
}

export const desktopStepHandlers: StepHandler[] = [
  makeHandler('click', async (step, ctx) => {
    const pt = coordsFromTarget(step.target);
    const button = step.params?.['button'] as 'left' | 'right' | 'middle' | undefined;
    const clicks = step.params?.['clickCount'] as 1 | 2 | 3 | undefined;
    await adapter(ctx).click(pt, {
      ...(button ? { button } : {}),
      ...(clicks ? { clicks } : {}),
    });
    return { outcome: 'completed' };
  }),

  makeHandler('type', async (step, ctx) => {
    const text = String(step.params?.['text'] ?? '');
    const clearFirst = step.params?.['clearFirst'] === true;
    const intervalMs = step.params?.['intervalMs'] as number | undefined;
    await adapter(ctx).type(text, {
      clearFirst,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    });
    return { outcome: 'completed' };
  }),

  makeHandler('key_combo', async (step, ctx) => {
    const keys = step.params?.['keys'];
    if (!Array.isArray(keys) || keys.length === 0)
      throw new Error('key_combo requires params.keys[]');
    await adapter(ctx).keyCombo(keys.map(String));
    return { outcome: 'completed' };
  }),

  makeHandler('wait_for', async (step, ctx) => {
    const sel = selectorFromTarget(step.target);
    const timeoutMs = (step.timeoutMs ?? step.params?.['timeoutMs']) as number | undefined;
    const handle = await adapter(ctx).findElement(sel, timeoutMs ? { timeoutMs } : undefined);
    if (!handle) {
      throw Object.assign(new Error('desktop wait_for: element not found'), {
        class: 'selector_not_found',
      });
    }
    return { outcome: 'completed' };
  }),
];

/** Convenience: register every desktop handler under the `desktop` layer. */
export function registerDesktopHandlers(registry: HandlerRegistry): void {
  for (const h of desktopStepHandlers) registry.register(h, 'desktop');
}
