import { describe, expect, it } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  assertValidFlow,
  diffFlow,
  applyFlowPatch,
  migrateFlow,
  newId,
  validateFlow,
  type Flow,
} from '../src/index.js';

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  const now = '2026-05-28T00:00:00.000Z';
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
      waitBetweenStepsMs: 50,
    },
    steps: [],
    metadata: {
      origin: 'recorded',
      targets: ['web'],
      requiredPermissions: [],
    },
    ...overrides,
  };
}

describe('validateFlow', () => {
  it('accepts a minimal valid Flow', () => {
    const result = validateFlow(makeFlow());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a Flow with a Web click step having a selector candidate array', () => {
    const flow = makeFlow({
      steps: [
        {
          id: newId(),
          type: 'click',
          enabled: true,
          target: {
            layer: 'web',
            candidates: [
              { kind: 'role', role: 'button', name: 'Save' },
              { kind: 'testid', value: 'save-btn' },
              { kind: 'css', value: 'button.primary[data-id="42"]' },
            ],
          },
          assert: [
            { kind: 'vision_yes_no', prompt: '保存に成功した?', refs: 'after' },
          ],
        },
      ],
    });
    const result = validateFlow(flow);
    expect(result.valid).toBe(true);
  });

  it('rejects unknown step type', () => {
    const flow = makeFlow({
      steps: [{ id: newId(), type: 'launch_rocket' as unknown as 'click', enabled: true }],
    });
    const result = validateFlow(flow);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('enum'))).toBe(true);
  });

  it('rejects missing schemaVersion', () => {
    const flow = { ...makeFlow() } as Partial<Flow>;
    delete flow.schemaVersion;
    const result = validateFlow(flow);
    expect(result.valid).toBe(false);
  });

  it('assertValidFlow throws on invalid input', () => {
    expect(() => assertValidFlow({})).toThrow(/Invalid Flow/);
  });
});

describe('migrateFlow', () => {
  it('passes through a 1.0 flow unchanged', () => {
    const flow = makeFlow();
    expect(migrateFlow(flow)).toEqual(flow);
  });

  it('throws when schemaVersion is missing', () => {
    expect(() => migrateFlow({})).toThrow(/missing schemaVersion/);
  });

  it('throws when no migration path exists', () => {
    expect(() => migrateFlow({ schemaVersion: '0.1' })).toThrow(/No migration path/);
  });
});

describe('JSON Patch utilities', () => {
  it('computes and applies a diff round-trip', () => {
    const before = makeFlow({ name: 'before' });
    const after = makeFlow({ ...before, name: 'after', description: 'updated' });
    const patch = diffFlow(before, after);
    expect(patch.length).toBeGreaterThan(0);
    const result = applyFlowPatch(before, patch);
    expect(result.name).toBe('after');
    expect(result.description).toBe('updated');
  });
});

describe('newId', () => {
  it('returns a unique ulid each call', () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
