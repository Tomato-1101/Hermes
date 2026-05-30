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
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Selector, Step, StepType, TargetRef } from '@hermes/ir';
import type {
  HandlerRegistry,
  RunContext,
  StepHandler,
  StepResult,
} from '@hermes/engine';
import { DesktopProvider } from './desktop-provider.js';
import {
  DesktopAdapterError,
  type ClickOpts,
  type DesktopAdapter,
  type DesktopSelector,
  type OcrObservation,
  type OcrResult,
  type Point,
} from './index.js';

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

/**
 * Build the humanized ClickOpts for a click step from its params + the run's
 * humanize settings. Shared by the desktop and screen click handlers so a
 * click lands the same way regardless of how its target was resolved.
 */
function buildClickOpts(ctx: RunContext, params: Step['params']): ClickOpts {
  const h = humanizeSettings(ctx);
  const button = params?.['button'] as 'left' | 'right' | 'middle' | undefined;
  const clicks = params?.['clickCount'] as 1 | 2 | 3 | undefined;
  const speedOverride = params?.['mouseSpeedPxPerSec'] as number | undefined;
  const instant = params?.['instant'] === true;
  // Set by the flow preprocessor when a preceding `wait` was absorbed into
  // this click's pre-move, so the click lands at the recorded rhythm.
  const moveDurationOverride = params?.['moveDurationMs'] as number | undefined;
  return {
    speedPxPerSec: speedOverride ?? h.mouseSpeedPxPerSec,
    minSteps: h.mouseMinSteps,
    maxSteps: h.mouseMaxSteps,
    ...(instant ? { instant: true } : {}),
    ...(button ? { button } : {}),
    ...(clicks ? { clicks } : {}),
    ...(moveDurationOverride !== undefined
      ? { durationMsOverride: moveDurationOverride }
      : {}),
  };
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
    await adapter(ctx).click(pt, buildClickOpts(ctx, step.params));
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

// ---------------------------------------------------------------------------
// Screen layer — image-template / OCR / coords resolution
// ---------------------------------------------------------------------------

/** Center of a logical-point rect — the natural click target. */
function centerOfBbox(b: { x: number; y: number; w: number; h: number }): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Load an image-selector template. `assetRef` is resolved relative to the
 * run's assets dir (`ctx.vars.__hermes_assets_dir__`, injected by the runner)
 * unless it is already absolute.
 */
async function resolveAssetBytes(ctx: RunContext, assetRef: string): Promise<Buffer> {
  if (isAbsolute(assetRef)) return readFile(assetRef);
  const dir = ctx.vars['__hermes_assets_dir__'];
  if (typeof dir !== 'string' || !dir) {
    throw new DesktopAdapterError(
      `cannot resolve image asset '${assetRef}': no __hermes_assets_dir__ set for this run`,
      'selector_not_found',
    );
  }
  return readFile(join(dir, assetRef));
}

/** First OCR observation whose text matches the selector (substring or regex). */
function ocrFind(
  res: OcrResult,
  sel: Extract<Selector, { kind: 'ocr' }>,
): OcrObservation | null {
  const test = sel.regex
    ? (t: string) => new RegExp(sel.text).test(t)
    : (t: string) => t.includes(sel.text);
  return res.observations.find((o) => test(o.text)) ?? null;
}

/** Resolve a screen-layer target to a click point via the first usable candidate. */
async function resolveScreenPoint(step: Step, ctx: RunContext): Promise<Point> {
  const target = step.target;
  if (!target || target.candidates.length === 0) {
    throw new Error('screen step requires a target with candidates');
  }
  const a = adapter(ctx);
  for (const sel of target.candidates) {
    if (sel.kind === 'coords') {
      return { x: sel.x, y: sel.y };
    }
    if (sel.kind === 'image') {
      const tmpl = await resolveAssetBytes(ctx, sel.assetRef);
      const match = await a.findImageOnScreen(tmpl, {
        threshold: sel.threshold,
        ...(sel.scaleInvariant ? { scaleInvariant: true } : {}),
        ...(target.region ? { region: target.region } : {}),
      });
      if (!match.found || !match.center) {
        throw new DesktopAdapterError(
          `screen image selector '${sel.assetRef}' not found (best score ${match.score.toFixed(2)})`,
          'selector_not_found',
        );
      }
      return match.center;
    }
    if (sel.kind === 'ocr') {
      const res = await a.readScreenText({
        ...(target.region ? { region: target.region } : {}),
        ...(sel.lang ? { languages: [sel.lang] } : {}),
      });
      const obs = ocrFind(res, sel);
      if (!obs) {
        throw new DesktopAdapterError(
          `screen ocr selector text '${sel.text}' not found on screen`,
          'selector_not_found',
        );
      }
      return centerOfBbox(obs.bbox);
    }
  }
  throw new DesktopAdapterError(
    'screen step has no resolvable candidate (need image / ocr / coords)',
    'selector_not_found',
  );
}

export const screenStepHandlers: StepHandler[] = [
  makeHandler('click', async (step, ctx) => {
    const pt = await resolveScreenPoint(step, ctx);
    await adapter(ctx).click(pt, buildClickOpts(ctx, step.params));
    return { outcome: 'completed' };
  }),

  makeHandler('extract', async (step, ctx) => {
    // OCR-read a region (or the whole screen) into a variable. With an `ocr`
    // selector carrying text, narrow to that matching line; otherwise capture
    // all recognized text.
    const target = step.target;
    const sel = target?.candidates.find(
      (c): c is Extract<Selector, { kind: 'ocr' }> => c.kind === 'ocr',
    );
    const res = await adapter(ctx).readScreenText({
      ...(target?.region ? { region: target.region } : {}),
      ...(sel?.lang ? { languages: [sel.lang] } : {}),
    });
    let value = res.text;
    if (sel && sel.text) {
      value = ocrFind(res, sel)?.text ?? '';
    }
    const into = String(step.params?.['into'] ?? '');
    if (into) ctx.vars[into] = value;
    return { outcome: 'completed', data: { value } };
  }),
];

/** Convenience: register every screen handler under the `screen` layer. */
export function registerScreenHandlers(registry: HandlerRegistry): void {
  for (const h of screenStepHandlers) registry.register(h, 'screen');
}
