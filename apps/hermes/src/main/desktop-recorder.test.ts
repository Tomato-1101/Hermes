import { describe, expect, it, vi } from 'vitest';
import type { Step } from '@hermes/ir';

// Stub the sidecar bridge so constructing a DesktopRecorder never spawns the
// Swift binary or imports electron. `fakeCall` is driven per-test to feed
// recording.poll a canned event batch; we then invoke the (private) pollOnce
// and assert on the IR Steps the recorder emits.
const { fakeCall } = vi.hoisted(() => ({ fakeCall: vi.fn() }));
vi.mock('./sidecar.js', () => ({
  getSidecarClient: () => ({ call: fakeCall, dispose: () => undefined }),
}));

import { DesktopRecorder } from './desktop-recorder.js';

type RawEvent = Record<string, unknown>;

/** Feed `events` through the recorder's poll path and collect emitted steps. */
async function stepsFromEvents(events: RawEvent[]): Promise<Step[]> {
  fakeCall.mockImplementation(async (method: string) => {
    if (method === 'recording.poll') return { events, active: true };
    return { ok: true };
  });
  const rec = new DesktopRecorder();
  rec.setRecordWaits(false); // keep assertions to the mapped steps only
  const steps: Step[] = [];
  rec.on('step', (e) => steps.push(e.step));
  await (rec as unknown as { pollOnce(): Promise<void> }).pollOnce();
  return steps;
}

describe('DesktopRecorder — scroll / drag mapping', () => {
  it('maps a scroll event to a desktop scroll Step the handler can replay', async () => {
    const [step] = await stepsFromEvents([
      { seq: 1, kind: 'scroll', x: 120, y: 240, dx: 0, dy: -90, ts: 1 },
    ]);
    expect(step?.type).toBe('scroll');
    expect(step?.target?.layer).toBe('desktop');
    // Handler resolves the point via the coords candidate and reads dx/dy.
    expect(step?.target?.candidates[0]).toEqual({
      kind: 'coords',
      x: 120,
      y: 240,
      anchor: 'screen',
    });
    expect(step?.params).toEqual({ dx: 0, dy: -90 });
  });

  it('maps a drag event: from = press point (coords), to = params.to', async () => {
    const [step] = await stepsFromEvents([
      { seq: 1, kind: 'drag', x: 10, y: 20, toX: 200, toY: 300, ts: 1 },
    ]);
    expect(step?.type).toBe('drag');
    expect(step?.target?.layer).toBe('desktop');
    expect(step?.target?.candidates).toEqual([
      { kind: 'coords', x: 10, y: 20, anchor: 'screen' },
    ]);
    expect(step?.params).toEqual({ to: { x: 200, y: 300 } });
  });

  it('drag keeps an ax candidate first when the element snapshot is present', async () => {
    const [step] = await stepsFromEvents([
      {
        seq: 1,
        kind: 'drag',
        x: 10,
        y: 20,
        toX: 50,
        toY: 60,
        ts: 1,
        element: { role: 'AXList', title: 'Files', app: { bundleId: 'com.apple.finder' } },
      },
    ]);
    const candidates = step?.target?.candidates ?? [];
    expect(candidates[0]).toMatchObject({ kind: 'ax', role: 'AXList', title: 'Files' });
    // coords candidate (the from point) still present so coordsFromTarget resolves it.
    expect(candidates).toContainEqual({ kind: 'coords', x: 10, y: 20, anchor: 'screen' });
  });

  it('does not regress click mapping (still emitted on the poll path)', async () => {
    const [step] = await stepsFromEvents([
      { seq: 1, kind: 'click', button: 'left', x: 5, y: 6, ts: 1 },
    ]);
    expect(step?.type).toBe('click');
    expect(step?.target?.candidates).toContainEqual({
      kind: 'coords',
      x: 5,
      y: 6,
      anchor: 'screen',
    });
  });
});
