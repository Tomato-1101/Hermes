import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { WebRecorder, type RecorderPayload, type RecorderEvent } from '../src/recorder.js';

/**
 * Form-control fidelity: a faithful recording must replay. <select>,
 * checkbox, and radio don't accept type()/fill(), so the recorder has to
 * classify them instead of emitting a blanket `type` step. We drive the
 * private payload handler directly (same approach as the wait-emit tests) to
 * assert the classification without booting Playwright.
 */
function feed(recorder: WebRecorder, payload: RecorderPayload): void {
  (recorder as unknown as { handlePayload(p: RecorderPayload): void }).handlePayload(payload);
}

const URL = 'https://example.com/form';

function inputPayload(element: Record<string, unknown>, value: string): RecorderPayload {
  return {
    kind: 'input',
    url: URL,
    element: element as never,
    value,
    isSecret: false,
    ts: 1000,
  } as RecorderPayload;
}

function clickPayload(element: Record<string, unknown>): RecorderPayload {
  return {
    kind: 'click',
    url: URL,
    button: 'left',
    element: element as never,
    ts: 1000,
  } as RecorderPayload;
}

describe('WebRecorder form-control classification', () => {
  let recorder: WebRecorder;
  let events: RecorderEvent[];

  beforeEach(() => {
    recorder = new WebRecorder();
    events = [];
    recorder.on('step', (e) => events.push(e));
    recorder.start();
  });

  afterEach(() => recorder.stop());

  it('records a <select> change as a type step routed to selectOption', () => {
    feed(recorder, inputPayload({ tag: 'select', label: 'Prefecture' }, 'tokyo'));
    expect(events).toHaveLength(1);
    const step = events[0]!.step;
    expect(step.type).toBe('type');
    expect(step.params).toMatchObject({ text: 'tokyo', control: 'select' });
    // selectOption replaces the value outright; clearFirst would call fill('')
    // on the <select> and throw, so it must not be set.
    expect(step.params).not.toHaveProperty('clearFirst');
  });

  it('drops the redundant click that lands on a <select>', () => {
    feed(recorder, clickPayload({ tag: 'select', label: 'Prefecture' }));
    expect(events).toHaveLength(0);
  });

  it('drops checkbox/radio change events (the click step owns the toggle)', () => {
    feed(recorder, inputPayload({ tag: 'input', type: 'checkbox', label: 'Agree' }, 'on'));
    feed(recorder, inputPayload({ tag: 'input', type: 'radio', label: 'Plan A' }, 'a'));
    expect(events).toHaveLength(0);
  });

  it('still records a text input as a clearing type step', () => {
    feed(recorder, inputPayload({ tag: 'input', type: 'text', label: 'Email' }, 'a@b.co'));
    expect(events).toHaveLength(1);
    const step = events[0]!.step;
    expect(step.type).toBe('type');
    expect(step.params).toMatchObject({ text: 'a@b.co', clearFirst: true });
    expect(step.params).not.toHaveProperty('control');
  });

  it('still records a click on a real button', () => {
    feed(recorder, clickPayload({ tag: 'button', text: 'Submit' }));
    expect(events).toHaveLength(1);
    expect(events[0]!.step.type).toBe('click');
  });
});
