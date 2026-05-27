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

  async hover(target: ElementHandle | Point): Promise<void> {
    const { x, y } = targetPoint(target);
    await this.client.call('mouse.move', { x, y });
  }

  async type(text: string, opts: TypeOpts = {}): Promise<void> {
    if (opts.clearFirst) {
      await this.keyCombo(['primary', 'a']);
      await this.keyCombo(['delete']);
    }
    await this.client.call('keyboard.type', {
      text,
      intervalMs: opts.intervalMs ?? 0,
    });
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

  async screenshot(_opts?: ScreenshotOpts): Promise<Buffer> {
    throw new DesktopAdapterError(
      'MacosDesktopAdapter.screenshot: not yet implemented (needs ScreenCaptureKit RPC)',
      'unknown',
    );
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
    return {
      bundleId: (result.bundleId as string) || undefined,
      processName: (result.name as string) ?? '',
      pid: Number(result.pid ?? 0),
      title: undefined,
      active: true,
    };
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
