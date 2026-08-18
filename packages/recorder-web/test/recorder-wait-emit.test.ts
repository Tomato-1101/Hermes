import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Step } from '@hermes/ir';
import { WebRecorder, type RecorderPayload, type RecorderEvent } from '../src/recorder.js';

/**
 * The recorder turns the human's natural pause between two events into a
 * `wait` step so playback respects the rhythm of the recording. We exercise
 * that path directly by feeding synthetic payloads at controlled timestamps,
 * since spinning up Playwright just to test timing arithmetic is overkill.
 */
function feed(recorder: WebRecorder, payload: RecorderPayload): void {
  // handlePayload is private; reach into it directly for the unit test.
  (recorder as unknown as { handlePayload(p: RecorderPayload): void }).handlePayload(payload);
}

function clickAt(ts: number): RecorderPayload {
  return {
    kind: 'click',
    url: 'https://example.com/',
    button: 'left',
    element: { tag: 'button', text: 'Go' },
    ts,
  };
}

describe('WebRecorder wait emission', () => {
  let recorder: WebRecorder;
  let events: RecorderEvent[];

  beforeEach(() => {
    recorder = new WebRecorder();
    events = [];
    recorder.on('step', (e) => events.push(e));
    recorder.start();
  });

  afterEach(() => {
    recorder.stop();
  });

  it('does not emit a wait before the first event', () => {
    feed(recorder, clickAt(1000));
    expect(events).toHaveLength(1);
    expect(events[0]!.step.type).toBe('click');
  });

  it('emits a wait step before the second event when the gap meets the threshold', () => {
    feed(recorder, clickAt(1000));
    feed(recorder, clickAt(1500)); // 500ms gap, above default 200ms threshold
    const types = events.map((e) => e.step.type);
    expect(types).toEqual(['click', 'wait', 'click']);
    const wait = events[1]!.step as Step;
    expect(wait.params).toMatchObject({ ms: 500 });
    expect(wait.meta).toMatchObject({ recordedBy: 'web-recorder' });
  });

  it('suppresses tiny gaps below the threshold', () => {
    feed(recorder, clickAt(1000));
    feed(recorder, clickAt(1100)); // 100ms gap, below default 200ms
    const types = events.map((e) => e.step.type);
    expect(types).toEqual(['click', 'click']);
  });

  it('emits no wait when recordWaits is disabled, even for long gaps', () => {
    recorder.setRecordWaits(false);
    feed(recorder, clickAt(1000));
    feed(recorder, clickAt(5000)); // 4 seconds — would normally be recorded
    const types = events.map((e) => e.step.type);
    expect(types).toEqual(['click', 'click']);
  });

  it('respects an updated minRecordedWaitMs threshold', () => {
    recorder.setMinRecordedWaitMs(50);
    feed(recorder, clickAt(1000));
    feed(recorder, clickAt(1080)); // 80ms gap — above 50ms but below 200ms default
    const types = events.map((e) => e.step.type);
    expect(types).toEqual(['click', 'wait', 'click']);
  });

  it('resets timing on start/stop so the next recording does not back-fill a wait', () => {
    feed(recorder, clickAt(1000));
    recorder.stop();
    recorder.start();
    feed(recorder, clickAt(9000)); // would be 8000ms after the prior event, but reset
    const types = events.map((e) => e.step.type);
    expect(types).toEqual(['click', 'click']); // no wait between
  });
});
