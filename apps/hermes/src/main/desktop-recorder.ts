/**
 * DesktopRecorder — TS-side counterpart of the Swift CGEventTap recorder.
 *
 * Subscribes to the hermes-native sidecar via JSON-RPC: starts a global
 * mouse / modifier-key recording, polls every 150ms for new events, and
 * emits them as IR Steps (`click` / `key_combo`) tagged with layer
 * 'desktop'. The Step shape mirrors what WebRecorder emits so the
 * orchestrator in RunController can route both through the same
 * `recorder:step` event channel.
 *
 * The sidecar pushes events via the recorder. Selector candidates we can
 * derive here:
 *   - `coords` — always (raw screen x/y reported by the tap)
 *   - `ax`     — when the AX snapshot is available (role / title / id)
 * The engine's desktop handlers currently click via `coords`; the `ax`
 * candidate is kept so a later phase can resolve elements semantically.
 */
import { EventEmitter } from 'node:events';
import { newId, type Step, type TargetRef } from '@hermes/ir';
import { getSidecarClient } from './sidecar.js';

type AxSnapshot = {
  role?: string;
  subrole?: string;
  title?: string;
  description?: string;
  value?: string;
  identifier?: string;
  app?: { bundleId?: string; name?: string; pid?: number };
  position?: { x: number; y: number };
  size?: { w: number; h: number };
};

type SidecarRecordingEvent =
  | {
      seq: number;
      kind: 'click';
      button: 'left' | 'right' | 'middle';
      x: number;
      y: number;
      ts: number;
      element?: AxSnapshot;
    }
  | {
      seq: number;
      kind: 'key';
      keys: string[];
      ts: number;
    }
  | {
      seq: number;
      kind: 'type';
      text: string;
      ts: number;
    };

export type DesktopRecorderEvents = {
  step: { step: Step; raw: SidecarRecordingEvent };
  error: { message: string };
};

const POLL_INTERVAL_MS = 150;

export class DesktopRecorder {
  private readonly client = getSidecarClient();
  private readonly emitter = new EventEmitter();
  private pollTimer: NodeJS.Timeout | null = null;
  private active = false;
  private polling = false;
  private lastSeq = 0;

  async start(): Promise<void> {
    if (this.active) return;
    await this.client.call('recording.start', null, 5000);
    this.active = true;
    this.pollTimer = setInterval(() => {
      // Guard against overlapping polls if the sidecar is slow.
      if (this.polling) return;
      this.polling = true;
      void this.pollOnce().finally(() => {
        this.polling = false;
      });
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    // Flush any remaining events before disabling the tap so we don't
    // lose the last click.
    await this.pollOnce().catch(() => undefined);
    await this.client.call('recording.stop', null, 5000).catch(() => undefined);
  }

  isRunning(): boolean {
    return this.active;
  }

  on<K extends keyof DesktopRecorderEvents>(
    type: K,
    handler: (e: DesktopRecorderEvents[K]) => void,
  ): () => void {
    this.emitter.on(type, handler);
    return () => {
      this.emitter.off(type, handler);
    };
  }

  private async pollOnce(): Promise<void> {
    let result: { events?: SidecarRecordingEvent[]; active?: boolean };
    try {
      result = (await this.client.call('recording.poll', null, 3000)) as typeof result;
    } catch (err) {
      this.emitter.emit('error', { message: (err as Error).message });
      return;
    }
    const events = result.events ?? [];
    for (const ev of events) {
      // Sidecar uses a monotonic sequence — skip stragglers from a previous
      // session that arrived after a stop / start.
      if (ev.seq <= this.lastSeq) continue;
      this.lastSeq = ev.seq;
      const step = this.toStep(ev);
      if (step) this.emitter.emit('step', { step, raw: ev });
    }
  }

  private toStep(ev: SidecarRecordingEvent): Step | null {
    if (ev.kind === 'click') return this.buildClickStep(ev);
    if (ev.kind === 'key') return this.buildKeyStep(ev);
    if (ev.kind === 'type') return this.buildTypeStep(ev);
    return null;
  }

  private buildTypeStep(ev: Extract<SidecarRecordingEvent, { kind: 'type' }>): Step {
    // The desktop type handler relies on OS focus at replay time, not on a
    // resolved selector. We still ship a layer='desktop' target so the
    // engine routes the step to the desktop handler instead of the web one;
    // the candidate is a screen-anchored placeholder that no one reads.
    const target: TargetRef = {
      layer: 'desktop',
      candidates: [{ kind: 'coords', x: 0, y: 0, anchor: 'screen' }],
    };
    return {
      id: newId(),
      type: 'type',
      enabled: true,
      target,
      params: { text: ev.text, clearFirst: false },
      label: `Type "${trim(ev.text, 30)}"`,
      meta: {
        recordedAt: new Date(ev.ts * 1000).toISOString(),
        recordedBy: 'desktop-recorder',
        origin: 'recorded',
      },
    };
  }

  private buildClickStep(ev: Extract<SidecarRecordingEvent, { kind: 'click' }>): Step {
    const candidates: TargetRef['candidates'] = [];
    if (ev.element) {
      const e = ev.element;
      const ax: { kind: 'ax'; app: string; role: string; title?: string; identifier?: string } = {
        kind: 'ax',
        app: e.app?.bundleId ?? e.app?.name ?? '',
        role: e.role ?? '',
      };
      if (e.title) ax.title = e.title;
      if (e.identifier) ax.identifier = e.identifier;
      candidates.push(ax);
    }
    candidates.push({
      kind: 'coords',
      x: ev.x,
      y: ev.y,
      anchor: 'screen',
    });

    const target: TargetRef = {
      layer: 'desktop',
      candidates,
    };
    const step: Step = {
      id: newId(),
      type: 'click',
      enabled: true,
      target,
      meta: {
        recordedAt: new Date(ev.ts * 1000).toISOString(),
        recordedBy: 'desktop-recorder',
        origin: 'recorded',
      },
    };
    const labelSrc = ev.element?.title ?? ev.element?.value ?? ev.element?.role;
    if (labelSrc) step.label = `Click "${trim(labelSrc, 30)}"`;
    else step.label = `Click @ (${Math.round(ev.x)}, ${Math.round(ev.y)})`;
    if (ev.button !== 'left') step.params = { button: ev.button };
    return step;
  }

  private buildKeyStep(ev: Extract<SidecarRecordingEvent, { kind: 'key' }>): Step {
    // Tag the step as desktop-layer so the engine routes to the desktop
    // adapter's key_combo handler instead of falling back to the web one
    // (which assumes a Playwright page is available).
    const target: TargetRef = {
      layer: 'desktop',
      candidates: [{ kind: 'coords', x: 0, y: 0, anchor: 'screen' }],
    };
    return {
      id: newId(),
      type: 'key_combo',
      enabled: true,
      target,
      params: { keys: ev.keys },
      label: `Press ${ev.keys.join('+')}`,
      meta: {
        recordedAt: new Date(ev.ts * 1000).toISOString(),
        recordedBy: 'desktop-recorder',
        origin: 'recorded',
      },
    };
  }
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s;
}
