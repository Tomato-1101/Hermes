import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_SCHEMA_VERSION, newId, type Flow, type Step } from '@hermes/ir';
import type { RunEvent } from '@hermes/engine';
import { runFlow, runFlowFile, loadFlow, collectLayers } from '../src/index.js';

function flowOf(steps: Step[]): Flow {
  const now = '2026-05-30T00:00:00.000Z';
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name: 'cli-test',
    createdAt: now,
    updatedAt: now,
    inputs: [],
    outputs: [],
    variables: [],
    defaults: {
      timeoutMs: 2000,
      retry: { attempts: 1 },
      screenshotOnError: false,
      waitBetweenStepsMs: 0,
    },
    steps,
    metadata: { origin: 'recorded', targets: [], requiredPermissions: [] },
  };
}

const log = (message: string): Step => ({
  id: newId(),
  type: 'log',
  enabled: true,
  params: { message },
});

describe('collectLayers', () => {
  it('reports no providers for a log/wait flow', () => {
    const flow = flowOf([
      log('a'),
      { id: newId(), type: 'wait_for', enabled: true, params: { kind: 'time', ms: 1 } },
    ]);
    expect(collectLayers(flow)).toEqual({ web: false, desktop: false, screen: false, clipboard: false });
  });

  it('detects web from open_url', () => {
    const flow = flowOf([
      { id: newId(), type: 'open_url', enabled: true, params: { url: 'https://example.test' } },
    ]);
    expect(collectLayers(flow).web).toBe(true);
  });

  it('detects desktop from a nested desktop-layer step', () => {
    const flow = flowOf([
      {
        id: newId(),
        type: 'loop',
        enabled: true,
        params: { kind: 'for', count: 1 },
        children: [
          {
            id: newId(),
            type: 'click',
            enabled: true,
            target: {
              layer: 'desktop',
              candidates: [{ kind: 'coords', x: 1, y: 2, anchor: 'screen' }],
            },
          },
        ],
      },
    ]);
    expect(collectLayers(flow)).toEqual({
      web: false,
      desktop: true,
      screen: false,
      clipboard: false,
    });
  });

  it('detects screen (and desktop) from a screen-layer step', () => {
    const flow = flowOf([
      {
        id: newId(),
        type: 'click',
        enabled: true,
        target: {
          layer: 'screen',
          candidates: [{ kind: 'image', assetRef: 'assets/btn.png', threshold: 0.8 }],
        },
      },
    ]);
    expect(collectLayers(flow)).toEqual({
      web: false,
      desktop: true,
      screen: true,
      clipboard: false,
    });
  });

  it('detects clipboard (and desktop) from targetless clipboard steps', () => {
    const flow = flowOf([
      { id: newId(), type: 'clipboard_write', enabled: true, params: { value: '${var.x}' } },
      { id: newId(), type: 'clipboard_read', enabled: true, params: { into: 'y' } },
    ]);
    expect(collectLayers(flow)).toEqual({
      web: false,
      desktop: true,
      screen: false,
      clipboard: true,
    });
  });
});

describe('runFlow — provider-less execution', () => {
  it('runs log + wait_for + if + loop to success, building no providers', async () => {
    const flow = flowOf([
      log('start'),
      { id: newId(), type: 'wait_for', enabled: true, params: { kind: 'time', ms: 5 } },
      {
        id: newId(),
        type: 'if',
        enabled: true,
        params: { condition: 'true' },
        branches: [{ name: 'then', steps: [log('then-branch')] }],
      },
      {
        id: newId(),
        type: 'loop',
        enabled: true,
        params: { kind: 'for', count: 2 },
        children: [log('tick')],
      },
    ]);
    const events: RunEvent[] = [];
    const result = await runFlow(flow, { onEvent: (e) => events.push(e) });
    expect(result.outcome).toBe('success');
    expect(result.layers).toEqual({ web: false, desktop: false, screen: false, clipboard: false });
    expect(events.some((e) => e.type === 'run:end' && e.outcome === 'success')).toBe(true);
    // start + then-branch + 2 loop ticks
    expect(events.filter((e) => e.type === 'log').length).toBeGreaterThanOrEqual(4);
  });

  it('seeds inputs into variables used by an if condition', async () => {
    const flow = flowOf([
      {
        id: newId(),
        type: 'if',
        enabled: true,
        params: { condition: '${var.go}' },
        branches: [{ name: 'then', steps: [log('went')] }],
      },
    ]);
    const events: RunEvent[] = [];
    const result = await runFlow(flow, { inputs: { go: true }, onEvent: (e) => events.push(e) });
    expect(result.outcome).toBe('success');
    expect(events.some((e) => e.type === 'log' && e.message === 'went')).toBe(true);
  });
});

describe('loadFlow', () => {
  it('throws on invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-cli-'));
    try {
      const p = join(dir, 'bad.json');
      await writeFile(p, '{ not json');
      await expect(loadFlow(p)).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws on a JSON object that fails Flow validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hermes-cli-'));
    try {
      const p = join(dir, 'invalid.json');
      await writeFile(p, JSON.stringify({ schemaVersion: '1.0', steps: [] }));
      await expect(loadFlow(p)).rejects.toThrow(/Invalid Flow/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads and runs the committed smoke fixture to success', async () => {
    const fixture = fileURLToPath(new URL('../fixtures/smoke.flow.json', import.meta.url));
    const result = await runFlowFile(fixture);
    expect(result.outcome).toBe('success');
    expect(result.layers).toEqual({ web: false, desktop: false, screen: false, clipboard: false });
  });
});
