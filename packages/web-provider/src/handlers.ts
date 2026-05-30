/**
 * Step handlers for web-layer Steps. Each handler reads its params from the
 * Step, resolves the TargetRef where applicable, and dispatches to the
 * WebProvider instance pulled from RunContext.providers.web.
 *
 * Handlers throw `Error & { class }` with a small set of error classes so
 * the engine retry policy can match against them ('selector_not_found',
 * 'timeout', 'network', 'any').
 */
import type { Step, StepType } from '@hermes/ir';
import type { HandlerRegistry } from '@hermes/engine';
import type { RunContext, StepHandler, StepResult } from '@hermes/engine';
import { WebProvider } from './web-provider.js';

function provider(ctx: RunContext): WebProvider {
  const p = ctx.providers.web;
  if (!p) throw new Error('Web provider not available in this run');
  if (!(p instanceof WebProvider)) {
    throw new Error('providers.web is not a WebProvider instance');
  }
  return p;
}

/**
 * Resolve humanization settings for the current run, falling back through
 * step.params → ctx.vars.__hermes_humanize__ (set by RunController from
 * AppSettings) → hard-coded defaults. Keeping this in one place means a
 * UI-level slider only has to write the vars entry once at run start.
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
    mouseMinSteps: Number(raw['mouseMinSteps'] ?? 8),
    mouseMaxSteps: Number(raw['mouseMaxSteps'] ?? 60),
  };
}

function makeHandler<T extends StepType>(
  type: T,
  execute: (step: Step, ctx: RunContext) => Promise<StepResult<Record<string, unknown>>>,
): StepHandler {
  return { type, execute };
}

export const webStepHandlers: StepHandler[] = [
  makeHandler('open_url', async (step, ctx) => {
    const url = String(step.params?.['url'] ?? '');
    if (!url) throw new Error('open_url requires params.url');
    const waitUntil = step.params?.['waitUntil'] as
      | 'load'
      | 'domcontentloaded'
      | 'networkidle'
      | undefined;
    await provider(ctx).openUrl(url, waitUntil ? { waitUntil } : undefined);
    return { outcome: 'completed' };
  }),

  makeHandler('click', async (step, ctx) => {
    if (!step.target) throw new Error('click requires target');
    const button = step.params?.['button'] as 'left' | 'right' | 'middle' | undefined;
    const clickCount = step.params?.['clickCount'] as number | undefined;
    const speedOverride = step.params?.['mouseSpeedPxPerSec'] as number | undefined;
    const instant = step.params?.['instant'] === true;
    const h = humanizeSettings(ctx);
    const args: {
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      speedPxPerSec?: number;
      minSteps?: number;
      maxSteps?: number;
      instant?: boolean;
    } = {
      speedPxPerSec: speedOverride ?? h.mouseSpeedPxPerSec,
      minSteps: h.mouseMinSteps,
      maxSteps: h.mouseMaxSteps,
    };
    if (button !== undefined) args.button = button;
    if (clickCount !== undefined) args.clickCount = clickCount;
    if (instant) args.instant = true;
    await provider(ctx).click(step.target, args);
    return { outcome: 'completed' };
  }),

  makeHandler('type', async (step, ctx) => {
    if (!step.target) throw new Error('type requires target');
    const text = String(step.params?.['text'] ?? '');
    const clearFirst = step.params?.['clearFirst'] === true;
    const delayOverride = step.params?.['delayMs'] as number | undefined;
    const args: { clearFirst?: boolean; delayMs?: number } = { clearFirst };
    args.delayMs = delayOverride ?? humanizeSettings(ctx).typeDelayMs;
    await provider(ctx).typeInto(step.target, text, args);
    return { outcome: 'completed' };
  }),

  makeHandler('key_combo', async (step, ctx) => {
    const keys = step.params?.['keys'];
    if (!Array.isArray(keys) || keys.length === 0)
      throw new Error('key_combo requires params.keys[]');
    await provider(ctx).keyCombo(keys.map(String));
    return { outcome: 'completed' };
  }),

  makeHandler('scroll', async (step, ctx) => {
    const dx = Number(step.params?.['dx'] ?? 0);
    const dy = Number(step.params?.['dy'] ?? 0);
    await provider(ctx).scroll(step.target ?? null, dx, dy);
    return { outcome: 'completed' };
  }),

  makeHandler('wait_for', async (step, ctx) => {
    const params = step.params ?? {};
    const kind = params['kind'] as string | undefined;
    const url = params['url'] as string | undefined;
    const state = params['state'] as
      | 'attached'
      | 'visible'
      | 'hidden'
      | 'detached'
      | undefined;
    const timeoutMs = (step.timeoutMs ?? params['timeoutMs']) as number | undefined;

    // `kind=web.load` waits for the document load state — does not need a
    // target. The other web kinds reuse the existing `waitFor` shape.
    if (kind === 'web.load') {
      const loadState = (params['state'] as 'load' | 'domcontentloaded' | 'networkidle' | undefined) ??
        'load';
      await provider(ctx).waitForLoadState(loadState, timeoutMs ?? 10_000);
      return { outcome: 'completed' };
    }

    const args: {
      target?: typeof step.target;
      url?: string;
      timeoutMs?: number;
      state?: 'attached' | 'visible' | 'hidden' | 'detached';
    } = {};
    if (kind === 'web.url' || (!kind && url)) {
      if (!url) throw new Error('wait_for kind=web.url requires params.url');
      args.url = url;
    } else {
      // kind=web.element OR legacy (kind absent + target present)
      if (!step.target) throw new Error('wait_for kind=web.element requires target');
      args.target = step.target;
      if (state !== undefined) args.state = state;
    }
    if (timeoutMs !== undefined) args.timeoutMs = timeoutMs;
    await provider(ctx).waitFor(args);
    return { outcome: 'completed' };
  }),

  makeHandler('wait', async (step, _ctx) => {
    const ms = Number(step.params?.['ms'] ?? 0);
    await new Promise<void>((res) => setTimeout(res, ms));
    return { outcome: 'completed' };
  }),

  makeHandler('screenshot', async (step, ctx) => {
    const fullPage = step.params?.['fullPage'] === true;
    const buf = await provider(ctx).screenshot({ fullPage });
    const assetRef = step.meta?.screenshotRef ?? `step-${step.id}.png`;
    ctx.emit({ type: 'screenshot', cursor: step.id, assetRef });
    // Defer file IO to the orchestrator; emit only the asset ref and the
    // base64 payload so apps/hermes can persist it where it wants.
    ctx.vars[`__screenshot_${step.id}__`] = buf.toString('base64');
    return { outcome: 'completed' };
  }),

  makeHandler('extract', async (step, ctx) => {
    if (!step.target) throw new Error('extract requires target');
    const attr = String(step.params?.['attribute'] ?? 'innerText');
    const value = await provider(ctx).extract(step.target, attr);
    const into = String(step.params?.['into'] ?? '');
    if (into) ctx.vars[into] = value;
    return { outcome: 'completed' };
  }),

  makeHandler('set_var', async (step, ctx) => {
    const name = String(step.params?.['name'] ?? '');
    if (!name) throw new Error('set_var requires params.name');
    ctx.vars[name] = step.params?.['value'];
    return { outcome: 'completed' };
  }),
];

/**
 * Convenience: register every web handler with an existing registry.
 *
 * Registers under the `default` layer so steps without an explicit
 * target.layer (open_url, wait, set_var) and steps with target.layer ===
 * 'web' both dispatch here. Desktop handlers can then register under the
 * `desktop` layer and take precedence for desktop-layer targets.
 */
export function registerWebHandlers(registry: HandlerRegistry): void {
  for (const h of webStepHandlers) registry.register(h);
}
