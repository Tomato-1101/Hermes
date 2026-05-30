import { describe, it, expect, vi } from 'vitest';
import {
  RPC_CONTRACT,
  RPC_METHODS,
  isRpcMethod,
  isKnownKeyToken,
  validateRpcParams,
  validateRpcResult,
  wrapWithContract,
  RpcContractError,
  MODIFIER_NAMES,
  KEY_NAMES,
} from './rpc-contract.js';

// The full method surface the macOS Swift sidecar dispatches (main.swift).
// Asserting the exact set catches an accidental contract drift on either side.
const EXPECTED_METHODS = [
  'ping',
  'accessibility.status',
  'accessibility.listApps',
  'accessibility.frontmostApp',
  'accessibility.elementAtPoint',
  'screen.mainSize',
  'screen.capture',
  'mouse.click',
  'mouse.move',
  'mouse.position',
  'mouse.move_smooth',
  'mouse.scroll',
  'mouse.drag',
  'keyboard.type',
  'keyboard.combo',
  'recording.start',
  'recording.stop',
  'recording.poll',
].sort();

describe('RPC contract — method surface', () => {
  it('covers exactly the sidecar dispatch table', () => {
    expect([...RPC_METHODS].sort()).toEqual(EXPECTED_METHODS);
  });

  it('isRpcMethod recognises known and rejects unknown', () => {
    expect(isRpcMethod('mouse.click')).toBe(true);
    expect(isRpcMethod('mouse.teleport')).toBe(false);
  });

  it('every contract entry has params + result schemas', () => {
    for (const m of RPC_METHODS) {
      expect(RPC_CONTRACT[m].params).toBeDefined();
      expect(RPC_CONTRACT[m].result).toBeDefined();
    }
  });
});

// Representative payloads exactly as macos.ts / desktop-recorder.ts send them.
// If any of these fail param validation, wrapping the live client in
// `throw`-on-params mode would break a real run — so this is the guard.
const REAL_PARAMS: Array<[string, unknown]> = [
  ['ping', null],
  ['accessibility.status', undefined],
  ['accessibility.listApps', undefined],
  ['accessibility.frontmostApp', undefined],
  ['accessibility.elementAtPoint', { x: 5, y: 5 }],
  ['screen.mainSize', undefined],
  ['screen.capture', {}],
  ['screen.capture', { region: { x: 0, y: 0, w: 100, h: 100 } }],
  ['mouse.click', { x: 10, y: 20, button: 'left', clickCount: 1 }],
  ['mouse.click', { x: 10, y: 20, button: 'right', clickCount: 2 }],
  ['mouse.move', { x: 10, y: 20 }],
  ['mouse.position', undefined],
  ['mouse.move_smooth', { toX: 10, toY: 20, durationMs: 200, steps: 16 }],
  ['mouse.scroll', { x: 10, y: 20, dx: 0, dy: -30 }],
  ['mouse.drag', { fromX: 1, fromY: 2, toX: 3, toY: 4 }],
  ['mouse.drag', { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 300, steps: 24 }],
  ['keyboard.type', { text: 'héllo 漢字', intervalMs: 50 }],
  ['keyboard.combo', { keys: ['primary', 'a'] }],
  ['keyboard.combo', { keys: ['delete'] }],
  ['recording.start', null],
  ['recording.stop', null],
  ['recording.poll', null],
];

describe('RPC contract — params (real call payloads accepted)', () => {
  it.each(REAL_PARAMS)('%s accepts its real payload', (method, params) => {
    expect(() => validateRpcParams(method, params)).not.toThrow();
  });
});

describe('RPC contract — params (malformed rejected)', () => {
  it('unknown method throws', () => {
    expect(() => validateRpcParams('mouse.teleport', { x: 1, y: 1 })).toThrow(RpcContractError);
  });

  it('mouse.click missing y throws', () => {
    expect(() => validateRpcParams('mouse.click', { x: 1 })).toThrow(RpcContractError);
  });

  it('non-finite coordinates throw', () => {
    expect(() => validateRpcParams('mouse.move', { x: NaN, y: 0 })).toThrow();
    expect(() => validateRpcParams('mouse.move', { x: Infinity, y: 0 })).toThrow();
  });

  it('invalid mouse button throws', () => {
    expect(() => validateRpcParams('mouse.click', { x: 1, y: 1, button: 'scroll' })).toThrow();
  });

  it('no-param methods reject an object payload', () => {
    expect(() => validateRpcParams('ping', { unexpected: true })).toThrow();
  });

  it('keyboard.type without text throws', () => {
    expect(() => validateRpcParams('keyboard.type', { intervalMs: 10 })).toThrow();
  });
});

describe('RPC contract — key-name convention', () => {
  it('all modifier + key names are recognised tokens', () => {
    for (const m of MODIFIER_NAMES) expect(isKnownKeyToken(m)).toBe(true);
    for (const k of KEY_NAMES) expect(isKnownKeyToken(k)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isKnownKeyToken('Cmd')).toBe(true);
    expect(isKnownKeyToken('A')).toBe(true);
    expect(() => validateRpcParams('keyboard.combo', { keys: ['Primary', 'S'] })).not.toThrow();
  });

  it('rejects unknown key tokens', () => {
    expect(isKnownKeyToken('hyperspace')).toBe(false);
    expect(() => validateRpcParams('keyboard.combo', { keys: ['primary', 'hyperspace'] })).toThrow();
  });

  it('rejects an empty key list', () => {
    expect(() => validateRpcParams('keyboard.combo', { keys: [] })).toThrow();
  });
});

// Result payloads exactly as the Swift handlers produce them.
const REAL_RESULTS: Array<[string, unknown]> = [
  ['ping', { pong: true, version: '0.0.1', platform: 'darwin', ts: 123.4 }],
  ['accessibility.status', { granted: true }],
  ['accessibility.listApps', { apps: [{ bundleId: 'a.b', name: 'App', pid: 12, active: true }] }],
  ['accessibility.frontmostApp', { bundleId: 'a.b', name: 'App', pid: 12, windowTitle: 'Doc' }],
  ['accessibility.frontmostApp', null],
  [
    'accessibility.elementAtPoint',
    {
      role: 'AXButton',
      subrole: '',
      title: 'OK',
      description: '',
      value: '',
      identifier: '',
      position: { x: 1, y: 2 },
      size: { w: 3, h: 4 },
      app: { bundleId: 'a.b', name: 'App', pid: 12 },
    },
  ],
  ['accessibility.elementAtPoint', null],
  ['screen.mainSize', { w: 1440, h: 900, scale: 2 }],
  ['screen.mainSize', null],
  ['screen.capture', { data: 'AAAA', w: 100, h: 100, format: 'png' }],
  ['mouse.click', { ok: true }],
  ['mouse.move', { ok: true }],
  ['mouse.position', { x: 1, y: 2 }],
  ['mouse.move_smooth', { ok: true, actualFps: 160, maxSlipMs: 1.2, steps: 16, durationMs: 200 }],
  ['mouse.scroll', { ok: true }],
  ['mouse.drag', { ok: true }],
  ['keyboard.type', { ok: true }],
  ['keyboard.combo', { ok: true }],
  ['recording.start', { ok: true }],
  ['recording.stop', { ok: true, wasActive: false }],
  ['recording.stop', { ok: true }],
  ['recording.poll', { events: [{ kind: 'click', x: 1, y: 2 }], active: true }],
];

describe('RPC contract — results (real Swift shapes accepted)', () => {
  it.each(REAL_RESULTS)('%s accepts its real result', (method, result) => {
    expect(() => validateRpcResult(method, result)).not.toThrow();
  });

  it('rejects a malformed result', () => {
    expect(() => validateRpcResult('accessibility.status', { granted: 'yes' })).toThrow();
    expect(() => validateRpcResult('mouse.position', { x: 1 })).toThrow();
  });

  it('tolerates extra result fields (forward-compatible)', () => {
    expect(() =>
      validateRpcResult('mouse.click', { ok: true, futureField: 42 }),
    ).not.toThrow();
  });
});

describe('wrapWithContract', () => {
  function fakeClient(result: unknown) {
    const call = vi.fn(async () => result);
    const dispose = vi.fn();
    return { client: { call, dispose }, call, dispose };
  }

  it('passes a valid call through and returns the result untouched', async () => {
    const { client, call } = fakeClient({ ok: true });
    const wrapped = wrapWithContract(client);
    const res = await wrapped.call('mouse.click', { x: 1, y: 2, button: 'left', clickCount: 1 });
    expect(res).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('mouse.click', { x: 1, y: 2, button: 'left', clickCount: 1 }, undefined);
  });

  it('throws on invalid params before calling the client', async () => {
    const { client, call } = fakeClient({ ok: true });
    const wrapped = wrapWithContract(client);
    await expect(wrapped.call('mouse.click', { x: 1 })).rejects.toBeInstanceOf(RpcContractError);
    expect(call).not.toHaveBeenCalled();
  });

  it('warns (does not throw) on a bad result by default', async () => {
    const onIssue = vi.fn();
    const { client } = fakeClient({ granted: 'nope' });
    const wrapped = wrapWithContract(client, { onIssue });
    const res = await wrapped.call('accessibility.status', undefined);
    expect(res).toEqual({ granted: 'nope' }); // result still returned
    expect(onIssue).toHaveBeenCalledOnce();
    expect(onIssue.mock.calls[0]![0]).toBeInstanceOf(RpcContractError);
  });

  it('throws on a bad result when result policy is "throw"', async () => {
    const { client } = fakeClient({ granted: 'nope' });
    const wrapped = wrapWithContract(client, { result: 'throw' });
    await expect(wrapped.call('accessibility.status', undefined)).rejects.toBeInstanceOf(
      RpcContractError,
    );
  });

  it('ignores results when result policy is "off"', async () => {
    const onIssue = vi.fn();
    const { client } = fakeClient({ totally: 'wrong' });
    const wrapped = wrapWithContract(client, { result: 'off', onIssue });
    await expect(wrapped.call('accessibility.status', undefined)).resolves.toEqual({
      totally: 'wrong',
    });
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('passes unknown methods straight through (forward-compatible)', async () => {
    const { client, call } = fakeClient({ anything: true });
    const wrapped = wrapWithContract(client);
    await expect(wrapped.call('future.method', { whatever: 1 })).resolves.toEqual({
      anything: true,
    });
    expect(call).toHaveBeenCalledOnce();
  });

  it('forwards dispose', () => {
    const { client, dispose } = fakeClient({ ok: true });
    wrapWithContract(client).dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
