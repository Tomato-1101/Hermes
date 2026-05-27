/**
 * WebRecorder: attaches to a WebProvider's BrowserContext, captures user
 * actions via the injected page script, and emits IR Steps.
 *
 * Lifecycle:
 *   const r = new WebRecorder();
 *   await r.attach(provider);   // installs the binding + init script
 *   r.start();                   // begin emitting
 *   r.on('step', step => ...);
 *   r.stop();                    // pause without detaching
 *   await r.detach();            // detach completely (optional)
 */
import mitt, { type Emitter } from 'mitt';
import { ulid } from 'ulid';
import type { BrowserContext, Page } from 'playwright-core';
import type { Step, TargetRef } from '@hermes/ir';
import type { WebProvider } from '@hermes/web-provider';
import { buildSelectorCandidates, type ElementSnapshot } from './selector-builder.js';
import { INJECT_SCRIPT } from './inject-script.js';

export type RecorderEventType = 'click' | 'input' | 'navigate' | 'key';

export interface RecorderClickPayload {
  kind: 'click';
  url: string;
  button: 'left' | 'right' | 'middle';
  element: ElementSnapshot;
  ts: number;
}
export interface RecorderInputPayload {
  kind: 'input';
  url: string;
  element: ElementSnapshot;
  value: string | null;
  isSecret: boolean;
  ts: number;
}
export interface RecorderKeyPayload {
  kind: 'key';
  url: string;
  element: ElementSnapshot | null;
  keys: string[];
  ts: number;
}
export interface RecorderNavigatePayload {
  kind: 'navigate';
  url: string;
  ts: number;
}

export type RecorderPayload =
  | RecorderClickPayload
  | RecorderInputPayload
  | RecorderKeyPayload
  | RecorderNavigatePayload;

export interface RecorderEvent {
  step: Step;
  raw: RecorderPayload;
}

type Events = {
  step: RecorderEvent;
};

export class WebRecorder {
  private provider: WebProvider | null = null;
  private context: BrowserContext | null = null;
  private running = false;
  private attached = false;
  private readonly emitter: Emitter<Events> = mitt<Events>();
  private lastUrl: string | null = null;

  async attach(provider: WebProvider): Promise<void> {
    if (this.attached) return;
    if (!provider.isStarted()) throw new Error('WebProvider must be started before attaching recorder');
    this.provider = provider;
    this.context = provider.getContext();

    await this.context.exposeBinding(
      '__hermes_record',
      (_source, payload: unknown) => this.handlePayload(payload as RecorderPayload),
    );
    await this.context.addInitScript({ content: INJECT_SCRIPT });

    // Track navigation per page.
    for (const page of this.context.pages()) this.observePage(page);
    this.context.on('page', (p) => this.observePage(p));

    this.attached = true;
  }

  private observePage(page: Page): void {
    const onNav = (frame: import('playwright-core').Frame) => {
      if (frame !== page.mainFrame()) return;
      if (!this.running) return;
      const url = frame.url();
      if (!url || url.startsWith('about:') || url === this.lastUrl) return;
      this.lastUrl = url;
      this.emitStep(
        this.buildNavigateStep(url),
        { kind: 'navigate', url, ts: Date.now() },
      );
    };
    page.on('framenavigated', onNav);
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async detach(): Promise<void> {
    this.running = false;
    this.attached = false;
    this.provider = null;
    this.context = null;
  }

  on<K extends keyof Events>(type: K, handler: (e: Events[K]) => void): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }

  private handlePayload(payload: RecorderPayload): void {
    if (!this.running) return;
    switch (payload.kind) {
      case 'click':
        this.emitStep(this.buildClickStep(payload), payload);
        return;
      case 'input':
        this.emitStep(this.buildInputStep(payload), payload);
        return;
      case 'key':
        this.emitStep(this.buildKeyStep(payload), payload);
        return;
      default:
        return;
    }
  }

  private emitStep(step: Step, raw: RecorderPayload): void {
    this.emitter.emit('step', { step, raw });
  }

  private buildNavigateStep(url: string): Step {
    return {
      id: ulid(),
      type: 'open_url',
      enabled: true,
      label: shortenUrl(url),
      params: { url, waitUntil: 'load' },
      meta: {
        recordedAt: new Date().toISOString(),
        recordedBy: 'web-recorder',
        origin: 'recorded',
      },
    };
  }

  private buildClickStep(p: RecorderClickPayload): Step {
    const target = elementToTarget(p.element, p.url);
    const step: Step = {
      id: ulid(),
      type: 'click',
      enabled: true,
      target,
      meta: {
        recordedAt: new Date(p.ts).toISOString(),
        recordedBy: 'web-recorder',
        origin: 'recorded',
      },
    };
    const label = p.element.ariaName ?? p.element.text;
    if (label) step.label = `Click "${trim(label, 30)}"`;
    if (p.button !== 'left') step.params = { button: p.button };
    return step;
  }

  private buildInputStep(p: RecorderInputPayload): Step {
    const target = elementToTarget(p.element, p.url);
    const params: Record<string, unknown> = {
      text: p.isSecret ? `\${secrets.${p.element.label ?? p.element.name ?? 'value'}}` : (p.value ?? ''),
      clearFirst: true,
    };
    const step: Step = {
      id: ulid(),
      type: 'type',
      enabled: true,
      target,
      params,
      meta: {
        recordedAt: new Date(p.ts).toISOString(),
        recordedBy: 'web-recorder',
        origin: 'recorded',
      },
    };
    const lbl = p.element.label ?? p.element.placeholder ?? p.element.name ?? 'field';
    step.label = `Type into "${trim(lbl, 30)}"${p.isSecret ? ' (secret)' : ''}`;
    return step;
  }

  private buildKeyStep(p: RecorderKeyPayload): Step {
    const step: Step = {
      id: ulid(),
      type: 'key_combo',
      enabled: true,
      params: { keys: p.keys },
      label: `Press ${p.keys.join('+')}`,
      meta: {
        recordedAt: new Date(p.ts).toISOString(),
        recordedBy: 'web-recorder',
        origin: 'recorded',
      },
    };
    if (p.element) step.target = elementToTarget(p.element, p.url);
    return step;
  }
}

function elementToTarget(snap: ElementSnapshot, url: string): TargetRef {
  const target: TargetRef = {
    layer: 'web',
    candidates: buildSelectorCandidates(snap),
  };
  if (snap.rect) target.region = snap.rect;
  if (url) target.anchor = { description: shortenUrl(url) };
  return target;
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch {
    return url.slice(0, 40);
  }
}
