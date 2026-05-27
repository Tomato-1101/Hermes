/**
 * Cross-OS Desktop automation contract.
 *
 * The Engine talks only to this interface. Concrete implementations
 * (macOS via AX/CGEvent/SCK Swift sidecar, Windows via UIA/SendInput
 * C# sidecar) live in separate packages and ship behind the same shape.
 */

import type { AppRef, Rect } from '@hermes/ir';

export type Modifier = 'shift' | 'alt' | 'ctrl' | 'cmd' | 'primary';

export type MouseButton = 'left' | 'right' | 'middle';

export interface Point {
  x: number;
  y: number;
}

export interface ClickOpts {
  button?: MouseButton;
  clicks?: 1 | 2 | 3;
  modifiers?: Modifier[];
}

export interface TypeOpts {
  secret?: boolean;
  intervalMs?: number;
  clearFirst?: boolean;
  /** Paste via clipboard instead of synthesized keystrokes — required for IME / multi-byte. */
  paste?: boolean;
}

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
}

export interface FindOpts {
  timeoutMs?: number;
  region?: Rect;
}

export interface ElementHandle {
  selectorEcho: DesktopSelector;
  bbox: Rect;
  role: string;
  title?: string;
  value?: string;
  identifier?: string;
  app?: AppRef;
}

export interface AppInfo {
  bundleId?: string;
  processName: string;
  pid: number;
  title?: string;
  active: boolean;
}

export type DesktopSelector =
  | {
      kind: 'ax';
      app: string;
      role: string;
      title?: string;
      identifier?: string;
      path?: { role: string; index?: number; title?: string }[];
    }
  | {
      kind: 'uia';
      processName: string;
      automationId?: string;
      controlType: string;
      name?: string;
    }
  | {
      kind: 'image';
      assetRef: string;
      threshold: number;
      scaleInvariant?: boolean;
    }
  | { kind: 'ocr'; text: string; lang: string; regex?: boolean }
  | { kind: 'coords'; x: number; y: number; anchor: 'screen' | 'window' };

export type Permission = 'accessibility' | 'screen-recording' | 'input-monitoring' | 'automation';

export interface PermissionStatus {
  required: Permission[];
  missing: Permission[];
  granted: Permission[];
}

export interface ScreenshotOpts {
  region?: Rect;
  /** retina vs logical pixels. Defaults to logical (false). */
  highDpi?: boolean;
}

/**
 * Engine-facing contract. All methods are async; OS sidecars implement them
 * over JSON-RPC. Errors should carry a `class` string so retry policies can
 * decide whether to retry.
 */
export interface DesktopAdapter {
  // --- detection ---
  findElement(selector: DesktopSelector, opts?: FindOpts): Promise<ElementHandle | null>;

  // --- input ---
  click(target: ElementHandle | Point, opts?: ClickOpts): Promise<void>;
  doubleClick(target: ElementHandle | Point, opts?: ClickOpts): Promise<void>;
  rightClick(target: ElementHandle | Point, opts?: ClickOpts): Promise<void>;
  hover(target: ElementHandle | Point): Promise<void>;
  type(text: string, opts?: TypeOpts): Promise<void>;
  keyCombo(keys: ReadonlyArray<string>): Promise<void>;
  scroll(target: ElementHandle | Point, dx: number, dy: number): Promise<void>;
  drag(from: ElementHandle | Point, to: ElementHandle | Point): Promise<void>;

  // --- observation ---
  screenshot(opts?: ScreenshotOpts): Promise<Buffer>;
  waitForState(
    predicate: () => boolean | Promise<boolean>,
    opts?: WaitOpts,
  ): Promise<void>;

  // --- apps / windows ---
  listApps(): Promise<AppInfo[]>;
  focusApp(ref: AppRef): Promise<void>;
  getFocusedApp(): Promise<AppInfo | null>;

  // --- permissions / lifecycle ---
  ensurePermissions(): Promise<PermissionStatus>;
  dispose(): Promise<void>;
}

/** Errors thrown by adapters should set a `class` for retry classification. */
export class DesktopAdapterError extends Error {
  constructor(
    message: string,
    public readonly errClass: 'selector_not_found' | 'timeout' | 'permission' | 'sidecar' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'DesktopAdapterError';
    (this as unknown as { class: string }).class = errClass;
  }
}
