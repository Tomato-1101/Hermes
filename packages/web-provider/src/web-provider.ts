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
  /** Extra launch args; phase-1 use to pin user-agent etc. */
  args?: string[];
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
      args: this.opts.args ?? [],
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

  async click(target: TargetRef, opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void> {
    const { locator } = await this.resolve(target);
    await locator.click({
      button: opts?.button ?? 'left',
      clickCount: opts?.clickCount ?? 1,
    });
  }

  async typeInto(target: TargetRef, text: string, opts?: { clearFirst?: boolean; delayMs?: number }): Promise<void> {
    const { locator } = await this.resolve(target);
    if (opts?.clearFirst) await locator.fill('');
    if (opts?.delayMs && opts.delayMs > 0) {
      await locator.pressSequentially(text, { delay: opts.delayMs });
    } else {
      await locator.fill(text);
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
