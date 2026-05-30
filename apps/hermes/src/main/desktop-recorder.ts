/**
 * DesktopRecorder — TS-side counterpart of the Swift CGEventTap recorder.
 *
 * Subscribes to the hermes-native sidecar via JSON-RPC: starts a global
 * mouse / modifier-key recording, polls every 150ms for new events, and
 * emits them as IR Steps (`click` / `key_combo` / `type` / `scroll` / `drag`)
 * tagged with layer 'desktop'. The Step shape mirrors what WebRecorder emits so the
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
    }
  | {
      seq: number;
      kind: 'scroll';
      x: number;
      y: number;
      dx: number;
      dy: number;
      ts: number;
    }
  | {
      seq: number;
      kind: 'drag';
      x: number;
      y: number;
      toX: number;
      toY: number;
      ts: number;
      element?: AxSnapshot;
    };

export type DesktopRecorderEvents = {
  step: { step: Step; raw: SidecarRecordingEvent };
  error: { message: string };
};

const POLL_INTERVAL_MS = 150;
const DEFAULT_MIN_RECORDED_WAIT_MS = 200;

export class DesktopRecorder {
  private readonly client = getSidecarClient();
  private readonly emitter = new EventEmitter();
  private pollTimer: NodeJS.Timeout | null = null;
  private active = false;
  private polling = false;
  private lastSeq = 0;
  // Inter-event timing — same idea as WebRecorder: capture the user's
  // think-time as a `wait` step so replays match the recorded rhythm.
  private lastEmitTsMs = 0;
  private recordWaits = true;
  private minRecordedWaitMs = DEFAULT_MIN_RECORDED_WAIT_MS;

  async start(): Promise<void> {
    if (this.active) return;
    await this.client.call('recording.start', null, 5000);
    this.active = true;
    this.lastEmitTsMs = 0;
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
    this.lastEmitTsMs = 0;
  }

  setRecordWaits(enabled: boolean): void {
    this.recordWaits = enabled;
  }

  setMinRecordedWaitMs(ms: number): void {
    this.minRecordedWaitMs = Math.max(0, ms);
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
      if (!step) continue;
      const evMs = Math.round(ev.ts * 1000);
      if (this.recordWaits && this.lastEmitTsMs > 0) {
        const diff = evMs - this.lastEmitTsMs;
        if (diff >= this.minRecordedWaitMs) {
          const waitStep: Step = {
            id: newId(),
            type: 'wait',
            enabled: true,
            label: `${diff}ms 待機（録画）`,
            params: { ms: diff },
            meta: {
              recordedAt: new Date(this.lastEmitTsMs).toISOString(),
              recordedBy: 'desktop-recorder',
              origin: 'recorded',
            },
          };
          this.emitter.emit('step', { step: waitStep, raw: ev });
        }
      }
      this.lastEmitTsMs = evMs;
      this.emitter.emit('step', { step, raw: ev });
    }
  }

  private toStep(ev: SidecarRecordingEvent): Step | null {
    if (ev.kind === 'click') return this.buildClickStep(ev);
    if (ev.kind === 'key') return this.buildKeyStep(ev);
    if (ev.kind === 'type') return this.buildTypeStep(ev);
    if (ev.kind === 'scroll') return this.buildScrollStep(ev);
    if (ev.kind === 'drag') return this.buildDragStep(ev);
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

  private buildScrollStep(ev: Extract<SidecarRecordingEvent, { kind: 'scroll' }>): Step {
    // Scroll replays at a screen point with accumulated pixel deltas; the
    // desktop scroll handler reads params.dx/dy. dy>0 scrolls down (the
    // sidecar already converted the wheel axis sign to this convention).
    const target: TargetRef = {
      layer: 'desktop',
      candidates: [{ kind: 'coords', x: ev.x, y: ev.y, anchor: 'screen' }],
    };
    return {
      id: newId(),
      type: 'scroll',
      enabled: true,
      target,
      params: { dx: ev.dx, dy: ev.dy },
      label: `Scroll (${Math.round(ev.dx)}, ${Math.round(ev.dy)})`,
      meta: {
        recordedAt: new Date(ev.ts * 1000).toISOString(),
        recordedBy: 'desktop-recorder',
        origin: 'recorded',
      },
    };
  }

  private buildDragStep(ev: Extract<SidecarRecordingEvent, { kind: 'drag' }>): Step {
    // `from` is the press point; the desktop drag handler reads it via the
    // coords candidate of target and `to` from params. An ax candidate is
    // kept first (when available) for later semantic resolution, exactly as
    // buildClickStep does — coordsFromTarget still finds the coords one.
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
    candidates.push({ kind: 'coords', x: ev.x, y: ev.y, anchor: 'screen' });

    const target: TargetRef = {
      layer: 'desktop',
      candidates,
    };
    return {
      id: newId(),
      type: 'drag',
      enabled: true,
      target,
      params: { to: { x: ev.toX, y: ev.toY } },
      label: `Drag → (${Math.round(ev.toX)}, ${Math.round(ev.toY)})`,
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
