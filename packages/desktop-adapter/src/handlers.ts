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

/**
 * Mirror of the web-handler resolver. RunController stuffs the AppSettings
 * humanize block into `ctx.vars.__hermes_humanize__` at run start; per-step
 * overrides come straight from `step.params` and are layered on top.
 */
function humanizeSettings(ctx: RunContext): {
  mouseSpeedPxPerSec: number;
  typeDelayMs: number;
  mouseMinSteps: number;
  mouseMaxSteps: number;
} {
  const raw = (ctx.vars['__hermes_humanize__'] as Record<string, unknown> | undefined) ?? {};
  return {
    mouseSpeedPxPerSec: Number(raw['mouseSpeedPxPerSec'] ?? 800),
    typeDelayMs: Number(raw['typeDelayMs'] ?? 50),
    // Defaults target ~6ms per waypoint (~166 fps), the cadence the
    // Swift loop can actually hit with CGEvent re-use + delta-stamped
    // post + .userInteractive QoS. See macos.ts for why finer was
    // worse, and Input.swift for the four optimisations.
    mouseMinSteps: Number(raw['mouseMinSteps'] ?? 16),
    mouseMaxSteps: Number(raw['mouseMaxSteps'] ?? 1200),
  };
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
    // 'hover' is a move-only click variant: position the cursor on the target
    // without pressing. Lets a recording or hand-edit express hover without a
    // dedicated step type.
    if (step.params?.['action'] === 'hover') {
      const hh = humanizeSettings(ctx);
      await adapter(ctx).hover(pt, {
        speedPxPerSec: (step.params?.['mouseSpeedPxPerSec'] as number | undefined) ?? hh.mouseSpeedPxPerSec,
        minSteps: hh.mouseMinSteps,
        maxSteps: hh.mouseMaxSteps,
        ...(step.params?.['instant'] === true ? { instant: true } : {}),
      });
      return { outcome: 'completed' };
    }
    const button = step.params?.['button'] as 'left' | 'right' | 'middle' | undefined;
    const clicks = step.params?.['clickCount'] as 1 | 2 | 3 | undefined;
    const speedOverride = step.params?.['mouseSpeedPxPerSec'] as number | undefined;
    const instant = step.params?.['instant'] === true;
    // Set by the flow preprocessor when a preceding `wait` was absorbed
    // into this click's pre-move. Forces the move to take exactly this
    // many ms so the click lands at the recorded rhythm.
    const moveDurationOverride = step.params?.['moveDurationMs'] as number | undefined;
    const h = humanizeSettings(ctx);
    await adapter(ctx).click(pt, {
      speedPxPerSec: speedOverride ?? h.mouseSpeedPxPerSec,
      minSteps: h.mouseMinSteps,
      maxSteps: h.mouseMaxSteps,
      ...(instant ? { instant: true } : {}),
      ...(button ? { button } : {}),
      ...(clicks ? { clicks } : {}),
      ...(moveDurationOverride !== undefined
        ? { durationMsOverride: moveDurationOverride }
        : {}),
    });
    return { outcome: 'completed' };
  }),

  makeHandler('type', async (step, ctx) => {
    const text = String(step.params?.['text'] ?? '');
    const clearFirst = step.params?.['clearFirst'] === true;
    const intervalOverride = (step.params?.['intervalMs'] ?? step.params?.['delayMs']) as
      | number
      | undefined;
    const intervalMs = intervalOverride ?? humanizeSettings(ctx).typeDelayMs;
    await adapter(ctx).type(text, {
      clearFirst,
      intervalMs,
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

  makeHandler('scroll', async (step, ctx) => {
    const pt = coordsFromTarget(step.target);
    const dx = Number(step.params?.['dx'] ?? 0);
    const dy = Number(step.params?.['dy'] ?? 0);
    await adapter(ctx).scroll(pt, dx, dy);
    return { outcome: 'completed' };
  }),

  makeHandler('drag', async (step, ctx) => {
    const from = coordsFromTarget(step.target);
    const to = step.params?.['to'] as { x?: unknown; y?: unknown } | undefined;
    if (!to || typeof to.x !== 'number' || typeof to.y !== 'number') {
      throw new Error('drag step requires params.to = { x, y }');
    }
    await adapter(ctx).drag(from, { x: to.x, y: to.y });
    return { outcome: 'completed' };
  }),

  makeHandler('wait_for', async (step, ctx) => {
    const params = step.params ?? {};
    const explicitKind = params['kind'] as string | undefined;
    const kind = explicitKind ?? 'desktop.element';
    const a = adapter(ctx);
    const timeoutMs = Math.max(
      0,
      Number(params['timeoutMs'] ?? step.timeoutMs ?? 10_000),
    );
    const intervalMs = Math.max(50, Number(params['pollIntervalMs'] ?? 100));

    if (kind === 'desktop.element') {
      const sel = selectorFromTarget(step.target);
      const handle = await a.findElement(sel, { timeoutMs });
      if (!handle) {
        throw Object.assign(new Error('desktop wait_for: element not found'), {
          class: 'selector_not_found',
        });
      }
      return { outcome: 'completed' };
    }

    if (kind === 'desktop.app_focus') {
      const bundleId = String(params['appBundleId'] ?? '');
      if (!bundleId) {
        throw new Error('wait_for kind=desktop.app_focus requires params.appBundleId');
      }
      await a.waitForState(
        async () => {
          const app = await a.getFocusedApp();
          return app?.bundleId === bundleId;
        },
        { timeoutMs, intervalMs },
      );
      return { outcome: 'completed' };
    }

    if (kind === 'desktop.window_title') {
      const pattern = String(params['titlePattern'] ?? '');
      if (!pattern) {
        throw new Error('wait_for kind=desktop.window_title requires params.titlePattern');
      }
      const re = new RegExp(pattern);
      await a.waitForState(
        async () => {
          const app = await a.getFocusedApp();
          return Boolean(app?.title && re.test(app.title));
        },
        { timeoutMs, intervalMs },
      );
      return { outcome: 'completed' };
    }

    if (kind === 'desktop.screen_stable') {
      // Hold "no change" for `stableMs` consecutive ms while polling
      // screenshots. The comparison is exact-buffer equality — adequate for
      // macOS ScreenCaptureKit / CGWindowListCreateImage output where a
      // truly idle screen yields byte-identical PNGs frame-over-frame, and
      // any animation/cursor blink reliably perturbs the bytes.
      const stableMs = Math.max(100, Number(params['stableMs'] ?? 500));
      const region = params['region'] as
        | { x: number; y: number; w: number; h: number }
        | undefined;
      const start = Date.now();
      let lastChange = start;
      let prev: Buffer | null = null;
      while (Date.now() - start < timeoutMs) {
        const shot = await a.screenshot(region ? { region } : undefined);
        if (prev) {
          if (!prev.equals(shot)) lastChange = Date.now();
          else if (Date.now() - lastChange >= stableMs) {
            return { outcome: 'completed' };
          }
        }
        prev = shot;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw Object.assign(
        new Error(`wait_for screen_stable: not stable within ${timeoutMs}ms`),
        { class: 'timeout' },
      );
    }

    throw new Error(`Unsupported desktop wait_for kind: ${kind}`);
  }),
];

/** Convenience: register every desktop handler under the `desktop` layer. */
export function registerDesktopHandlers(registry: HandlerRegistry): void {
  for (const h of desktopStepHandlers) registry.register(h, 'desktop');
}
