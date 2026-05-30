/**
 * macOS implementation of DesktopAdapter, talking to the Swift sidecar
 * (hermes-native) via JSON-RPC over Unix Domain Socket.
 *
 * The sidecar process itself is the caller's responsibility — typically
 * apps/hermes/src/main/sidecar.ts spawns it and hands us a connected
 * SidecarClient. The adapter is intentionally side-effect free at
 * construction so tests can substitute a fake client.
 *
 * Scope (Phase 1b):
 *   - Implemented: coords click/doubleClick/rightClick/hover, type,
 *     keyCombo, listApps, getFocusedApp, ensurePermissions, dispose.
 *   - Stubbed: AX selector lookup, focusApp, scroll, drag, screenshot.
 *     These need additional sidecar RPCs (AX tree walk, NSWorkspace
 *     activate, ScreenCaptureKit) that land in a later sub-phase.
 */
import type { AppRef } from '@hermes/ir';
import type {
  AppInfo,
  ClickOpts,
  DesktopAdapter,
  DesktopSelector,
  ElementHandle,
  FindOpts,
  PermissionStatus,
  Point,
  ScreenshotOpts,
  TypeOpts,
  WaitOpts,
} from './index.js';
import { DesktopAdapterError } from './index.js';
import { SidecarClient } from './sidecar-client.js';

type SidecarLike = Pick<SidecarClient, 'call' | 'dispose'>;

const DEFAULT_MOUSE_SPEED_PX_PER_SEC = 800;
// Step bounds tuned for "smoother than display refresh" without burning
// the per-iteration Swift loop budget. At 6ms-per-frame the Swift side
// has ~3-4ms to spare per step for CGEvent + WindowServer post + the
// mach_wait_until wake. Going to 4ms (250fps) actually showed *worse*
// motion because the loop itself slipped under the deadline — see the
// algorithm rewrite in Input.swift:postMouseMoveSmooth.
const DEFAULT_MOUSE_MIN_STEPS = 16;
const DEFAULT_MOUSE_MAX_STEPS = 1200;
// 6ms per frame (~166 fps target). That's a 1.4× over-sample of a
// 120Hz ProMotion display, which is the visual ceiling — beyond this
// extra samples are not visible to the user, only cost CPU.
const DEFAULT_MOUSE_FRAME_INTERVAL_S = 0.006;
const DEFAULT_TYPE_DELAY_MS = 50;

function isPoint(t: ElementHandle | Point): t is Point {
  return typeof (t as Point).x === 'number' && typeof (t as Point).y === 'number'
    && !(t as ElementHandle).bbox;
}

function centerOf(handle: ElementHandle): Point {
  const { x, y, w, h } = handle.bbox;
  return { x: x + w / 2, y: y + h / 2 };
}

function targetPoint(t: ElementHandle | Point): Point {
  return isPoint(t) ? t : centerOf(t);
}

export interface MacosDesktopAdapterOptions {
  client: SidecarLike;
  /** Permissions the runtime caller will require. Defaults to AX+screen. */
  requiredPermissions?: PermissionStatus['required'];
}

export class MacosDesktopAdapter implements DesktopAdapter {
  private readonly client: SidecarLike;
  private readonly required: PermissionStatus['required'];

  constructor(opts: MacosDesktopAdapterOptions) {
    this.client = opts.client;
    this.required = opts.requiredPermissions ?? ['accessibility', 'screen-recording'];
  }

  // --- detection ---------------------------------------------------------

  async findElement(selector: DesktopSelector, _opts?: FindOpts): Promise<ElementHandle | null> {
    if (selector.kind === 'coords') {
      const snap = (await this.client.call('accessibility.elementAtPoint', {
        x: selector.x,
        y: selector.y,
      })) as Record<string, unknown> | null;
      if (!snap) return null;
      return snapshotToHandle(snap, selector);
    }
    // ax / uia / image / ocr require sidecar RPCs that do not exist yet.
    throw new DesktopAdapterError(
      `MacosDesktopAdapter.findElement: selector kind '${selector.kind}' is not yet implemented`,
      'selector_not_found',
    );
  }

  // --- input -------------------------------------------------------------

  async click(target: ElementHandle | Point, opts: ClickOpts = {}): Promise<void> {
    const { x, y } = targetPoint(target);
    if (!opts.instant) {
      await this.moveSmoothlyTo(x, y, opts);
    }
    await this.client.call('mouse.click', {
      x,
      y,
      button: opts.button ?? 'left',
      clickCount: opts.clicks ?? 1,
    });
  }

  async doubleClick(target: ElementHandle | Point, opts: ClickOpts = {}): Promise<void> {
    await this.click(target, { ...opts, clicks: 2 });
  }

  async rightClick(target: ElementHandle | Point, opts: ClickOpts = {}): Promise<void> {
    await this.click(target, { ...opts, button: 'right' });
  }

  async hover(target: ElementHandle | Point, opts: ClickOpts = {}): Promise<void> {
    const { x, y } = targetPoint(target);
    if (opts.instant) {
      await this.client.call('mouse.move', { x, y });
      return;
    }
    await this.moveSmoothlyTo(x, y, opts);
  }

  async type(text: string, opts: TypeOpts = {}): Promise<void> {
    if (opts.clearFirst) {
      await this.keyCombo(['primary', 'a']);
      await this.keyCombo(['delete']);
    }
    await this.client.call('keyboard.type', {
      text,
      intervalMs: opts.intervalMs ?? DEFAULT_TYPE_DELAY_MS,
    });
  }

  /**
   * Read the current cursor position from the sidecar, work out a step count
   * and duration that matches the requested px-per-second, and ask the
   * sidecar to interpolate the move in-process. Falling back to a single
   * `mouse.move` when the start position isn't available keeps us from
   * stalling if the new RPC isn't deployed yet.
   */
  private async moveSmoothlyTo(
    x: number,
    y: number,
    opts: ClickOpts,
  ): Promise<void> {
    const speed = opts.speedPxPerSec ?? DEFAULT_MOUSE_SPEED_PX_PER_SEC;
    const minSteps = opts.minSteps ?? DEFAULT_MOUSE_MIN_STEPS;
    const maxSteps = opts.maxSteps ?? DEFAULT_MOUSE_MAX_STEPS;
    let from: { x: number; y: number } | null = null;
    try {
      const pos = (await this.client.call('mouse.position')) as {
        x?: number;
        y?: number;
      } | null;
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        from = { x: pos.x, y: pos.y };
      }
    } catch {
      from = null;
    }
    if (!from) {
      await this.client.call('mouse.move', { x, y });
      return;
    }
    const dx = x - from.x;
    const dy = y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1) return;
    const safeSpeed = Math.max(50, speed);
    // durationMsOverride wins over the distance/speed computation. The
    // flow preprocessor uses this to fold the move into a preceding
    // wait, so the click lands at the recorded time. When the override
    // forces a faster effective speed than the user's setting, the step
    // count still targets DEFAULT_MOUSE_FRAME_INTERVAL_S frames so the
    // motion stays smooth — we don't drop frames just because we're
    // moving faster.
    const naturalDurationMs = Math.max(16, Math.round((distance / safeSpeed) * 1000));
    const durationMs =
      opts.durationMsOverride !== undefined
        ? Math.max(16, Math.round(opts.durationMsOverride))
        : naturalDurationMs;
    // Aim for one waypoint every DEFAULT_MOUSE_FRAME_INTERVAL_S seconds.
    // Step count tracks the EFFECTIVE speed (distance / durationMs), not
    // the configured speed, so a duration-overridden faster move still
    // gets enough samples to look smooth.
    const effectiveSpeed = distance / (durationMs / 1000);
    const rawSteps = Math.ceil(distance / Math.max(1, effectiveSpeed * DEFAULT_MOUSE_FRAME_INTERVAL_S));
    const steps = Math.min(maxSteps, Math.max(minSteps, rawSteps));
    // The default sidecar timeout is 5s — way too short for a long
    // ease-in-out move at the user's chosen speed. Give the call the
    // full duration plus a healthy buffer for JSON-RPC round-trip and
    // CGEvent processing latency.
    const timeoutMs = durationMs + 4000;
    const result = (await this.client.call(
      'mouse.move_smooth',
      { toX: x, toY: y, durationMs, steps },
      timeoutMs,
    )) as
      | { actualFps?: number; maxSlipMs?: number; steps?: number; durationMs?: number }
      | null;
    // Surface measured fps when it falls below the 70% threshold of
    // the requested cadence. This is the only way to spot scheduler
    // contention / QoS demotion from outside the Swift process — without
    // it the user sees "stutter" but no log entry. We deliberately log
    // to stdout (visible in the Electron main process console) rather
    // than throwing, because slipping is a quality issue, not a failure.
    if (
      result &&
      typeof result.actualFps === 'number' &&
      typeof result.maxSlipMs === 'number'
    ) {
      const targetFps = 1 / DEFAULT_MOUSE_FRAME_INTERVAL_S;
      if (result.actualFps < targetFps * 0.7 || result.maxSlipMs > 4) {
        // eslint-disable-next-line no-console
        console.warn(
          `[hermes:mouse] move_smooth slipping: actualFps=${result.actualFps.toFixed(0)} ` +
            `target=${targetFps.toFixed(0)} maxSlip=${result.maxSlipMs.toFixed(1)}ms ` +
            `steps=${result.steps ?? steps} dur=${result.durationMs?.toFixed(0) ?? durationMs}/${durationMs}ms`,
        );
      }
    }
  }

  async keyCombo(keys: ReadonlyArray<string>): Promise<void> {
    await this.client.call('keyboard.combo', { keys: Array.from(keys) });
  }

  async scroll(_target: ElementHandle | Point, _dx: number, _dy: number): Promise<void> {
    throw new DesktopAdapterError(
      'MacosDesktopAdapter.scroll: not yet implemented (needs sidecar scroll RPC)',
      'unknown',
    );
  }

  async drag(_from: ElementHandle | Point, _to: ElementHandle | Point): Promise<void> {
    throw new DesktopAdapterError(
      'MacosDesktopAdapter.drag: not yet implemented (needs sidecar drag RPC)',
      'unknown',
    );
  }

  // --- observation -------------------------------------------------------

  async screenshot(opts?: ScreenshotOpts): Promise<Buffer> {
    const params: Record<string, unknown> = {};
    if (opts?.region) {
      params['region'] = {
        x: opts.region.x,
        y: opts.region.y,
        w: opts.region.w,
        h: opts.region.h,
      };
    }
    const res = (await this.client.call('screen.capture', params)) as {
      data?: string;
      format?: string;
    } | null;
    if (!res || typeof res.data !== 'string') {
      throw new DesktopAdapterError('screen.capture returned no data', 'unknown');
    }
    return Buffer.from(res.data, 'base64');
  }

  async waitForState(
    predicate: () => boolean | Promise<boolean>,
    opts: WaitOpts = {},
  ): Promise<void> {
    const timeout = opts.timeoutMs ?? 5_000;
    const interval = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeout;
    // Loop runs in Node — no sidecar call needed. The predicate is a
    // caller-side check (e.g. "did the file appear?").
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new DesktopAdapterError('waitForState: predicate did not become true within timeout', 'timeout');
  }

  // --- apps / windows ----------------------------------------------------

  async listApps(): Promise<AppInfo[]> {
    const result = (await this.client.call('accessibility.listApps')) as { apps: unknown[] };
    return (result.apps as Record<string, unknown>[]).map((a) => ({
      bundleId: (a.bundleId as string) || undefined,
      processName: (a.name as string) ?? '',
      pid: Number(a.pid ?? 0),
      title: undefined,
      active: Boolean(a.active),
    }));
  }

  async focusApp(_ref: AppRef): Promise<void> {
    throw new DesktopAdapterError(
      'MacosDesktopAdapter.focusApp: not yet implemented (needs NSWorkspace.activate RPC)',
      'unknown',
    );
  }

  async getFocusedApp(): Promise<AppInfo | null> {
    const result = (await this.client.call('accessibility.frontmostApp')) as
      | Record<string, unknown>
      | null;
    if (!result || typeof result !== 'object') return null;
    const info: AppInfo = {
      bundleId: (result.bundleId as string) || undefined,
      processName: (result.name as string) ?? '',
      pid: Number(result.pid ?? 0),
      active: true,
    };
    const title = result['windowTitle'];
    if (typeof title === 'string' && title) info.title = title;
    return info;
  }

  // --- permissions / lifecycle -------------------------------------------

  async ensurePermissions(): Promise<PermissionStatus> {
    const ax = (await this.client.call('accessibility.status')) as { granted: boolean };
    // For Phase 1, we only have a status check for Accessibility. Screen
    // Recording / Input Monitoring will be added when ScreenCaptureKit /
    // CGEventTap RPCs land. Treat them as missing until then so callers
    // can prompt the user.
    const granted: PermissionStatus['granted'] = [];
    const missing: PermissionStatus['missing'] = [];
    for (const p of this.required) {
      if (p === 'accessibility') {
        if (ax.granted) granted.push(p);
        else missing.push(p);
      } else {
        // unknown — caller should prompt the user via System Settings.
        missing.push(p);
      }
    }
    return { required: this.required, granted, missing };
  }

  async dispose(): Promise<void> {
    this.client.dispose();
  }
}

function snapshotToHandle(
  snap: Record<string, unknown>,
  echo: DesktopSelector,
): ElementHandle {
  const pos = (snap.position as { x?: number; y?: number } | undefined) ?? {};
  const size = (snap.size as { w?: number; h?: number } | undefined) ?? {};
  const app = snap.app as { bundleId?: string; name?: string; pid?: number } | undefined;
  return {
    selectorEcho: echo,
    bbox: {
      x: Number(pos.x ?? 0),
      y: Number(pos.y ?? 0),
      w: Number(size.w ?? 0),
      h: Number(size.h ?? 0),
    },
    role: (snap.role as string) ?? '',
    title: (snap.title as string) || undefined,
    value: (snap.value as string) || undefined,
    identifier: (snap.identifier as string) || undefined,
    app: app
      ? {
          bundleId: app.bundleId || undefined,
          processName: app.name || undefined,
        }
      : undefined,
  };
}
