import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, newId, type Flow, type Step } from '@hermes/ir';
import {
  HandlerRegistry,
  StepExecutor,
  type RunEvent,
  type StepHandler,
} from '../src/index.js';

function makeFlow(steps: Step[]): Flow {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId(),
    name: 't',
    createdAt: now,
    updatedAt: now,
    inputs: [],
    outputs: [],
    variables: [],
    defaults: {
      timeoutMs: 5000,
      retry: { attempts: 1 },
      screenshotOnError: false,
      waitBetweenStepsMs: 0,
    },
    steps,
    metadata: { origin: 'recorded', targets: ['web'], requiredPermissions: [] },
  };
}

function recordEvents(executor: StepExecutor): RunEvent[] {
  const events: RunEvent[] = [];
  executor.on((e) => events.push(e));
  return events;
}

describe('StepExecutor', () => {
  it('runs a single registered step to completion', async () => {
    const registry = new HandlerRegistry();
    let executed = 0;
    const handler: StepHandler = {
      type: 'click',
      execute: async () => {
        executed++;
        return { outcome: 'completed' };
      },
    };
    registry.register(handler);
    const exec = new StepExecutor({ registry });
    const events = recordEvents(exec);

    const outcome = await exec.run(
      makeFlow([{ id: newId(), type: 'click', enabled: true }]),
    );
    expect(outcome).toBe('success');
    expect(executed).toBe(1);
    expect(events.filter((e) => e.type === 'step:start')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step:end')).toHaveLength(1);
  });

  it('retries on failure when policy allows', async () => {
    const registry = new HandlerRegistry();
    let tries = 0;
    registry.register({
      type: 'click',
      execute: async () => {
        tries++;
        if (tries < 3) throw new Error('boom');
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    const outcome = await exec.run(
      makeFlow([
        {
          id: newId(),
          type: 'click',
          enabled: true,
          retry: { attempts: 3, backoff: { kind: 'fixed', initialMs: 0 } },
        },
      ]),
    );
    expect(outcome).toBe('success');
    expect(tries).toBe(3);
  });

  it('fails the run when retry attempts are exhausted', async () => {
    const registry = new HandlerRegistry();
    registry.register({
      type: 'click',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const exec = new StepExecutor({ registry });
    const outcome = await exec.run(
      makeFlow([{ id: newId(), type: 'click', enabled: true }]),
    );
    expect(outcome).toBe('failure');
  });

  it('skips disabled steps', async () => {
    const registry = new HandlerRegistry();
    let executed = 0;
    registry.register({
      type: 'click',
      execute: async () => {
        executed++;
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    await exec.run(makeFlow([{ id: newId(), type: 'click', enabled: false }]));
    expect(executed).toBe(0);
  });

  it('honors onError = "continue"', async () => {
    const registry = new HandlerRegistry();
    let secondRan = false;
    registry.register({
      type: 'click',
      execute: async () => {
        throw new Error('boom');
      },
    });
    registry.register({
      type: 'type',
      execute: async () => {
        secondRan = true;
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    const outcome = await exec.run(
      makeFlow([
        { id: newId(), type: 'click', enabled: true, onError: 'continue' },
        { id: newId(), type: 'type', enabled: true },
      ]),
    );
    expect(outcome).toBe('success');
    expect(secondRan).toBe(true);
  });

  it('aborts immediately on AbortSignal', async () => {
    const registry = new HandlerRegistry();
    registry.register({
      type: 'wait',
      execute: async (_step, ctx) => {
        // Wait long, but observe abort.
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    const controller = new AbortController();
    const flow = makeFlow([{ id: newId(), type: 'wait', enabled: true }]);
    const runP = exec.run(flow, { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    const outcome = await runP;
    expect(outcome).toBe('aborted');
  });

  it('executes a for-loop the right number of times', async () => {
    const registry = new HandlerRegistry();
    let count = 0;
    registry.register({
      type: 'click',
      execute: async () => {
        count++;
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    await exec.run(
      makeFlow([
        {
          id: newId(),
          type: 'loop',
          enabled: true,
          params: { kind: 'for', count: 5 },
          children: [{ id: newId(), type: 'click', enabled: true }],
        },
      ]),
    );
    expect(count).toBe(5);
  });

  it('runs the catch branch on try failure', async () => {
    const registry = new HandlerRegistry();
    registry.register({
      type: 'click',
      execute: async () => {
        throw new Error('boom');
      },
    });
    let caught = false;
    registry.register({
      type: 'screenshot',
      execute: async () => {
        caught = true;
        return { outcome: 'completed' };
      },
    });
    const exec = new StepExecutor({ registry });
    const outcome = await exec.run(
      makeFlow([
        {
          id: newId(),
          type: 'try',
          enabled: true,
          children: [{ id: newId(), type: 'click', enabled: true }],
          branches: [
            {
              name: 'catch',
              steps: [{ id: newId(), type: 'screenshot', enabled: true }],
            },
          ],
        },
      ]),
    );
    expect(outcome).toBe('success');
    expect(caught).toBe(true);
  });
});
