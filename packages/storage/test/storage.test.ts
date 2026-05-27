import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_SCHEMA_VERSION, newId, type Flow } from '@hermes/ir';
import { FlowStore, InMemoryVaultBackend, MetaStore, Vault } from '../src/index.js';

let tmp = '';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hermes-storage-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeFlow(): Flow {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name: 'sample',
    createdAt: now,
    updatedAt: now,
    inputs: [],
    outputs: [],
    variables: [],
    defaults: {
      timeoutMs: 30000,
      retry: { attempts: 1 },
      screenshotOnError: true,
      waitBetweenStepsMs: 0,
    },
    steps: [],
    metadata: { origin: 'recorded', targets: ['web'], requiredPermissions: [] },
  };
}

describe('FlowStore', () => {
  it('writes and reads a flow round-trip', async () => {
    const store = new FlowStore(join(tmp, 'flows'));
    const flow = makeFlow();
    await store.writeFlow(flow);
    const back = await store.readFlow(flow.id);
    expect(back).toEqual(flow);
  });

  it('writes an asset and returns a relative reference', async () => {
    const store = new FlowStore(join(tmp, 'flows'));
    const flow = makeFlow();
    await store.init(flow.id);
    const ref = await store.writeAsset(flow.id, 'step-1.png', Buffer.from('PNGDATA'));
    expect(ref).toBe('assets/step-1.png');
  });
});

describe('MetaStore', () => {
  it('persists project, flow and run rows', () => {
    const store = new MetaStore(join(tmp, 'meta.db'));
    const now = new Date().toISOString();
    store.upsertProject({ id: 'p1', name: 'Demo', createdAt: now, updatedAt: now });
    store.upsertFlow({
      id: 'f1',
      projectId: 'p1',
      name: 'Login',
      description: null,
      origin: 'recorded',
      schemaVersion: '1.0',
      createdAt: now,
      updatedAt: now,
      diskPath: '/somewhere/flows/f1',
    });
    store.createRun({
      id: 'r1',
      flowId: 'f1',
      startedAt: now,
      endedAt: null,
      outcome: 'running',
      logPath: null,
    });
    store.finishRun('r1', 'success', new Date().toISOString(), '/somewhere/history/r1.jsonl.gz');

    expect(store.listProjects()).toHaveLength(1);
    expect(store.listFlows()).toHaveLength(1);
    const runs = store.listRuns('f1');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('success');
    store.close();
  });
});

describe('Vault (in-memory backend)', () => {
  it('stores and retrieves secrets', async () => {
    const vault = new Vault({ backend: new InMemoryVaultBackend() });
    expect(await vault.get('openrouter.apiKey')).toBeNull();
    await vault.set('openrouter.apiKey', 'sk-xxx');
    expect(await vault.get('openrouter.apiKey')).toBe('sk-xxx');
    expect((await vault.list()).map((r) => r.account)).toEqual(['openrouter.apiKey']);
    expect(await vault.delete('openrouter.apiKey')).toBe(true);
    expect(await vault.get('openrouter.apiKey')).toBeNull();
  });
});
