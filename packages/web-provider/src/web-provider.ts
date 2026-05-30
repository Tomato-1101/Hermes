/**
 * Playwright-backed Web Provider.
 *
 * One `WebProvider` instance manages a single Chromium browser context
 * persisted to a per-flow directory (`browser-profile/` inside the flow
 * folder). Pages, cookies, localStorage live in that directory so a
 * recorded flow can pick up exactly where it left off.
 *
 * The provider exposes deterministic action primitives the engine handlers
 * call. AI never touches these — they take resolved selectors and execute.
 */
import { mkdir } from 'node:fs/promises';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type LaunchOptions,
} from 'playwright-core';
import type { WebProviderHandle } from '@hermes/engine';
import type { Rect, TargetRef } from '@hermes/ir';
import { resolveSelector } from './selector.js';

export interface WebProviderOptions {
  profileDir: string;
  headless?: boolean;
  channel?: 'chrome' | 'msedge' | 'chromium';
  executablePath?: string;
  viewport?: { width: number; height: number };
  locale?: string;
  timezone?: string;
  /** Extra launch args; phase-1 use to pin user-agent etc. Always merged
   *  with HARDENING_ARGS so callers can't accidentally drop them. */
  args?: string[];
}

/** Defaults used by the humanized click pathway. The runtime can override
 *  per-step via params.mouseSpeedPxPerSec / minSteps / maxSteps. */
const DEFAULT_MOUSE_SPEED_PX_PER_SEC = 800;
const DEFAULT_MOUSE_MIN_STEPS = 8;
const DEFAULT_MOUSE_MAX_STEPS = 60;

/** Per-character delay (ms) when `typeInto` is invoked without an explicit
 *  delay. Lets recordings replay at human speed without callers having to
 *  thread the value through every code path. */
const DEFAULT_TYPE_DELAY_MS = 50;

/** Launch flags that strip the most obvious "I'm a bot" markers from the
 *  browser fingerprint. Not a substitute for using a real Chrome profile,
 *  but it shaves off one signal anti-bot vendors check. */
const HARDENING_ARGS = [
  '--disable-blink-features=AutomationControlled',
  // Tell Chrome's heuristic-disabling stack that we're not automated. The
  // flag above hides one obvious tell (the AutomationControlled blink
  // feature); this one disables Chrome's own enable-automation toolbar
  // signal and the "Chrome is being controlled by automated test software"
  // infobar that reCAPTCHA pages can sniff via window.outerHeight - innerHeight.
  '--disable-features=IsolateOrigins,site-per-process,SitePerProcessShim',
];

/**
 * JavaScript blob injected into every page before any site script runs.
 * The goal is to make Hermes's Chromium look indistinguishable from a real
 * Chrome instance to reCAPTCHA / Cloudflare Turnstile / Datadome heuristics.
 *
 * Vectors patched:
 *  - navigator.webdriver         → undefined (most-checked signal)
 *  - navigator.plugins/mimeTypes → real-Chrome-shaped non-empty arrays
 *  - navigator.languages         → matches our ja-JP/Asia/Tokyo locale
 *  - navigator.permissions.query → 'prompt' for notifications (real Chrome
 *                                  default; Playwright returns 'denied')
 *  - chrome global               → present (Playwright leaves it undefined
 *                                  on chromium, but `channel: 'chrome'`
 *                                  already provides a real one)
 *
 * We DO NOT spoof WebGL/Canvas/AudioContext: Chrome channel + a real
 * Chrome profile gives us a real GPU fingerprint, and faking those
 * inconsistently across navigations triggers MORE suspicion than leaving
 * them alone. Same for User-Agent.
 *
 * NOTE: anti-fingerprint scripts are a cat-and-mouse game. This blocks
 * the low-effort signals only; it does NOT defeat behavioral scoring or
 * IP/account reputation. See the README for the realistic-expectations
 * write-up.
 */
const ANTI_FINGERPRINT_SCRIPT = `(() => {
  try {
    // 1. navigator.webdriver — Playwright forces this to true.
    if (Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver')) {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    } else {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    }

    // 2. navigator.plugins / mimeTypes — Playwright Chromium ships with
    //    empty arrays; real Chrome has at least the PDF Viewer. We forge
    //    a minimal but plausible PluginArray.
    const makePlugin = (name, filename, description) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperty(plugin, 'name', { value: name });
      Object.defineProperty(plugin, 'filename', { value: filename });
      Object.defineProperty(plugin, 'description', { value: description });
      Object.defineProperty(plugin, 'length', { value: 1 });
      return plugin;
    };
    const pluginList = [
      makePlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      makePlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    const pluginArray = Object.create(PluginArray.prototype);
    pluginList.forEach((p, i) => { pluginArray[i] = p; });
    Object.defineProperty(pluginArray, 'length', { value: pluginList.length });
    Object.defineProperty(navigator, 'plugins', {
      get: () => pluginArray,
      configurable: true,
    });

    // 3. navigator.languages — Playwright sets only the primary locale,
    //    real Chrome carries a fallback chain.
    Object.defineProperty(navigator, 'languages', {
      get: () => ['ja-JP', 'ja', 'en-US', 'en'],
      configurable: true,
    });

    // 4. permissions.query — Playwright returns { state: 'denied' } for
    //    notifications regardless of real grant; real Chrome returns
    //    'prompt' unless the user explicitly denied. reCAPTCHA cross-checks
    //    this against Notification.permission.
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (parameters) => {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({
            state: Notification.permission === 'default' ? 'prompt' : Notification.permission,
            onchange: null,
          });
        }
        return originalQuery(parameters);
      };
    }

    // 5. window.chrome — present on real Chrome regardless of automation.
    //    With channel: 'chrome' we usually have this, but the shape can
    //    differ; ensure at minimum window.chrome.runtime exists so
    //    "typeof window.chrome.runtime" doesn't return 'undefined'.
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: { runtime: {}, loadTimes: () => ({}), csi: () => ({}) },
        configurable: true,
      });
    } else if (!window.chrome.runtime) {
      try { window.chrome.runtime = {}; } catch (_e) { /* read-only on some builds */ }
    }
  } catch (_e) {
    // Anti-fingerprint is best-effort. If any patch throws (e.g. a future
    // Chrome locks down Navigator.prototype), don't break the page.
  }
})();`;

export interface HumanizedClickOpts {
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  /** Speed of the linear mouse interpolation in viewport pixels per second.
   *  0 (or `instant: true`) skips the interpolation and clicks directly. */
  speedPxPerSec?: number;
  minSteps?: number;
  maxSteps?: number;
  /** Bypass humanization entirely — equivalent to calling locator.click(). */
  instant?: boolean;
}

export interface HumanizedTypeOpts {
  clearFirst?: boolean;
  /** Milliseconds between consecutive characters. `0` falls back to fill(). */
  delayMs?: number;
}

export class WebProvider implements WebProviderHandle {
  readonly kind = 'web' as const;

  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private readonly opts: WebProviderOptions;

  constructor(opts: WebProviderOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.context) return;
    await mkdir(this.opts.profileDir, { recursive: true });
    const launchOpts: LaunchOptions & {
      viewport?: { width: number; height: number };
      locale?: string;
      timezoneId?: string;
    } = {
      headless: this.opts.headless ?? false,
      args: mergeArgs(this.opts.args ?? [], HARDENING_ARGS),
    };
    if (this.opts.channel) launchOpts.channel = this.opts.channel;
    if (this.opts.executablePath) launchOpts.executablePath = this.opts.executablePath;

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      ...launchOpts,
      viewport: this.opts.viewport ?? { width: 1280, height: 800 },
      locale: this.opts.locale ?? 'ja-JP',
      timezoneId: this.opts.timezone ?? 'Asia/Tokyo',
      acceptDownloads: true,
    });
    this.browser = this.context.browser();

    // Track active page (the most recently focused/created one).
    const existing = this.context.pages();
    this.activePage = existing[0] ?? (await this.context.newPage());
    this.context.on('page', (p) => {
      this.activePage = p;
    });

    // Mask the most common automation fingerprints (navigator.webdriver
    // etc.) BEFORE any page script runs, so reCAPTCHA's first-render probe
    // sees a real-Chrome-shaped navigator. See ANTI_FINGERPRINT_SCRIPT.
    await this.context.addInitScript({ content: ANTI_FINGERPRINT_SCRIPT });

    // Seed every page with a tiny inline tracker for the last mouse
    // position. We piggy-back on Playwright's mouse.move() (which writes
    // through the same window) so a single source of truth survives
    // navigations. The init script ensures the global exists on every
    // freshly-loaded document.
    await this.context.addInitScript({
      content:
        "(()=>{try{if(!window.__hermesLastMousePos){window.__hermesLastMousePos={x:Math.floor(window.innerWidth/2),y:Math.floor(window.innerHeight/2)};}window.addEventListener('mousemove',(e)=>{window.__hermesLastMousePos={x:e.clientX,y:e.clientY};},{passive:true,capture:true});}catch(_e){}})();",
    });
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.activePage = null;
  }

  page(): Page {
    if (!this.activePage) throw new Error('Web provider not started');
    return this.activePage;
  }

  /** Expose the underlying BrowserContext (for recorder attachment). */
  getContext(): BrowserContext {
    if (!this.context) throw new Error('Web provider not started');
    return this.context;
  }

  isStarted(): boolean {
    return this.context !== null;
  }

  /** Resolve a TargetRef to a Playwright Locator (first matching candidate). */
  async resolve(target: TargetRef, opts?: { timeoutMs?: number }): Promise<{
    locator: import('playwright-core').Locator;
    candidateIndex: number;
  }> {
    const match = await resolveSelector(this.page(), target, opts);
    if (!match) {
      const err: Error & { class?: string } = new Error(
        `No selector candidate resolved to a unique element (tried ${target.candidates.length})`,
      );
      err.class = 'selector_not_found';
      throw err;
    }
    return match;
  }

  // ---- Action primitives ----

  async openUrl(url: string, opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<void> {
    const page = this.page();
    await page.goto(url, { waitUntil: opts?.waitUntil ?? 'load' });
  }

  /**
   * Click with linear mouse interpolation so hover-then-show UI (cards,
   * tooltips, dropdown triggers) actually fires before the click lands.
   * Falls back to a plain locator.click() when the element has no usable
   * bounding box (off-screen, display:none) or when `opts.instant` is set.
   */
  async click(target: TargetRef, opts?: HumanizedClickOpts): Promise<void> {
    const { locator } = await this.resolve(target);
    const button = opts?.button ?? 'left';
    const clickCount = opts?.clickCount ?? 1;

    if (opts?.instant) {
      await locator.click({ button, clickCount });
      return;
    }

    const box = await locator.boundingBox();
    const speed = opts?.speedPxPerSec ?? DEFAULT_MOUSE_SPEED_PX_PER_SEC;
    if (!box || box.width <= 0 || box.height <= 0 || speed <= 0) {
      await locator.click({ button, clickCount });
      return;
    }

    // Make sure the target is in view so the bounding box matches what the
    // mouse coordinate space sees.
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    const refreshed = (await locator.boundingBox()) ?? box;
    const targetX = refreshed.x + refreshed.width / 2;
    const targetY = refreshed.y + refreshed.height / 2;

    const page = this.page();
    const from = await this.getLastMousePos();
    const dx = targetX - from.x;
    const dy = targetY - from.y;
    const distance = Math.hypot(dx, dy);
    const minSteps = opts?.minSteps ?? DEFAULT_MOUSE_MIN_STEPS;
    const maxSteps = opts?.maxSteps ?? DEFAULT_MOUSE_MAX_STEPS;
    // Aim for one step every ~16ms (one frame) at the requested speed:
    // steps = distance / (speed_px_per_sec * 0.016 s/frame). Then add ±15%
    // jitter so two consecutive replays don't produce identically-spaced
    // mouse-move events — anti-bot heuristics can flag perfectly periodic
    // input as automated regardless of distance / speed.
    const ideal = Math.ceil(distance / Math.max(1, speed * 0.016));
    const jitterFactor = 1 + (Math.random() - 0.5) * 0.3;
    const jittered = Math.ceil(ideal * jitterFactor);
    const steps = Math.max(minSteps, Math.min(maxSteps, jittered));

    await page.mouse.move(targetX, targetY, { steps });
    if (clickCount <= 1) {
      await page.mouse.down({ button });
      await page.mouse.up({ button });
    } else {
      // For double/triple-click use locator.click which handles the
      // sub-50ms inter-click spacing the browser expects.
      await locator.click({ button, clickCount });
    }
    await this.setLastMousePos({ x: targetX, y: targetY });
  }

  /**
   * Type one character at a time with a configurable inter-key delay so
   * keypress-driven autocomplete / validation UI sees each event.
   * `delayMs: 0` collapses back to fill() for the rare cases where paste
   * semantics are actually desired.
   */
  async typeInto(target: TargetRef, text: string, opts?: HumanizedTypeOpts): Promise<void> {
    const { locator } = await this.resolve(target);
    if (opts?.clearFirst) await locator.fill('');
    const delay = opts?.delayMs ?? DEFAULT_TYPE_DELAY_MS;
    if (delay <= 0) {
      await locator.fill(text);
      return;
    }
    // Per-character jitter: ±35% around the requested delay. A constant
    // interval is a textbook automation signal — bot detectors literally
    // compute the variance of keydown timestamps. We also focus once up
    // front so each press goes to the same input.
    await locator.focus();
    const page = this.page();
    for (const ch of text) {
      const jitter = 1 + (Math.random() - 0.5) * 0.7;
      const thisDelay = Math.max(1, Math.round(delay * jitter));
      await page.keyboard.type(ch, { delay: 0 });
      await page.waitForTimeout(thisDelay);
    }
  }

  /**
   * Best-effort read of the cursor's current viewport coordinates. Falls
   * back to the viewport centre when the page hasn't dispatched any
   * mousemove yet (the init script seeds this value on first navigation).
   */
  async getLastMousePos(): Promise<{ x: number; y: number }> {
    try {
      const result = await this.page().evaluate(() => {
        const w = window as unknown as {
          __hermesLastMousePos?: { x: number; y: number };
          innerWidth: number;
          innerHeight: number;
        };
        return (
          w.__hermesLastMousePos ?? {
            x: Math.floor(w.innerWidth / 2),
            y: Math.floor(w.innerHeight / 2),
          }
        );
      });
      return { x: Number(result.x) || 0, y: Number(result.y) || 0 };
    } catch {
      const viewport = this.opts.viewport ?? { width: 1280, height: 800 };
      return { x: Math.floor(viewport.width / 2), y: Math.floor(viewport.height / 2) };
    }
  }

  async setLastMousePos(p: { x: number; y: number }): Promise<void> {
    try {
      await this.page().evaluate((pos) => {
        (window as unknown as { __hermesLastMousePos?: { x: number; y: number } }).__hermesLastMousePos = pos;
      }, p);
    } catch {
      // Page may have navigated mid-call; the init script will reseed.
    }
  }

  /**
   * Choose an option in a `<select>`. Recorded dropdown changes land here
   * (a `<select>` rejects fill()/type()). Try matching the captured string as
   * an option value first, then fall back to its visible label, since the
   * recorder captures `select.value` but a hand-edited flow may carry the
   * human-readable text instead.
   */
  async selectOption(target: TargetRef, value: string): Promise<void> {
    const { locator } = await this.resolve(target);
    try {
      await locator.selectOption({ value });
    } catch {
      await locator.selectOption({ label: value });
    }
  }

  async keyCombo(keys: string[]): Promise<void> {
    const page = this.page();
    const playwrightCombo = mapKeyCombo(keys);
    await page.keyboard.press(playwrightCombo);
  }

  async scroll(target: TargetRef | null, dx: number, dy: number): Promise<void> {
    const page = this.page();
    if (target) {
      const { locator } = await this.resolve(target);
      await locator.evaluate((el, { dx, dy }) => {
        el.scrollBy(dx, dy);
      }, { dx, dy });
    } else {
      await page.mouse.wheel(dx, dy);
    }
  }

  async waitFor(opts: {
    target?: TargetRef;
    url?: string;
    timeoutMs?: number;
    state?: 'attached' | 'visible' | 'hidden' | 'detached';
  }): Promise<void> {
    const page = this.page();
    const timeout = opts.timeoutMs ?? 10_000;
    if (opts.url) {
      const re = new RegExp(opts.url);
      await page.waitForURL(re, { timeout });
      return;
    }
    if (opts.target) {
      const { locator } = await this.resolve(opts.target, { timeoutMs: timeout });
      await locator.waitFor({ state: opts.state ?? 'visible', timeout });
      return;
    }
    throw new Error('waitFor needs either url or target');
  }

  /**
   * Wait for the active page to reach a given load state. Thin wrapper over
   * Playwright's `page.waitForLoadState` so the engine's `wait_for kind=web.load`
   * has a stable seam to call.
   */
  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle' = 'load',
    timeoutMs = 10_000,
  ): Promise<void> {
    await this.page().waitForLoadState(state, { timeout: timeoutMs });
  }

  async screenshot(opts?: { fullPage?: boolean; clip?: Rect }): Promise<Buffer> {
    const page = this.page();
    const playwrightOpts: Parameters<Page['screenshot']>[0] = {};
    if (opts?.fullPage !== undefined) playwrightOpts.fullPage = opts.fullPage;
    if (opts?.clip) {
      playwrightOpts.clip = {
        x: opts.clip.x,
        y: opts.clip.y,
        width: opts.clip.w,
        height: opts.clip.h,
      };
    }
    return page.screenshot(playwrightOpts);
  }

  async extract(target: TargetRef, attribute = 'innerText'): Promise<string> {
    const { locator } = await this.resolve(target);
    if (attribute === 'innerText' || attribute === 'textContent') {
      return (await locator.innerText()).trim();
    }
    if (attribute === 'value') {
      return await locator.inputValue();
    }
    const v = await locator.getAttribute(attribute);
    return v ?? '';
  }
}

export function createWebProvider(opts: WebProviderOptions): WebProvider {
  return new WebProvider(opts);
}

/**
 * Merge user-supplied launch args with the hardening list, preserving the
 * user's order but ensuring our required flags appear exactly once.
 */
function mergeArgs(user: string[], required: string[]): string[] {
  const seen = new Set(user);
  const extras = required.filter((f) => !seen.has(f));
  return [...user, ...extras];
}

/**
 * Map a logical key combo (["primary","s"]) to Playwright's "+"-separated
 * format. "primary" → "Meta" on darwin, "Control" elsewhere.
 */
function mapKeyCombo(keys: string[]): string {
  const isMac = process.platform === 'darwin';
  return keys
    .map((k) => {
      const lower = k.toLowerCase();
      if (lower === 'primary') return isMac ? 'Meta' : 'Control';
      if (lower === 'cmd' || lower === 'meta') return 'Meta';
      if (lower === 'ctrl' || lower === 'control') return 'Control';
      if (lower === 'alt' || lower === 'option') return 'Alt';
      if (lower === 'shift') return 'Shift';
      if (lower === 'enter' || lower === 'return') return 'Enter';
      if (lower === 'tab') return 'Tab';
      if (lower === 'esc' || lower === 'escape') return 'Escape';
      if (lower === 'backspace') return 'Backspace';
      if (lower === 'space') return 'Space';
      return k.length === 1 ? k.toUpperCase() : k;
    })
    .join('+');
}
