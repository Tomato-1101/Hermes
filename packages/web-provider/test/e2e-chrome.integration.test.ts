/**
 * End-to-end integration test: real system Chrome, real engine.
 *
 * This test launches Google Chrome via `channel: 'chrome'` (no Playwright
 * browser binary download required), runs a small Flow IR through the
 * StepExecutor, and asserts that open_url + extract + log all complete.
 *
 * Skipped unless HERMES_E2E=1 is set, because:
 *  - it actually launches a browser window (slow)
 *  - it makes a network request to example.com
 *
 * To run:  HERMES_E2E=1 pnpm --filter @hermes/web-provider test:run
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandlerRegistry, StepExecutor, type RunEvent } from '@hermes/engine';
import { CURRENT_SCHEMA_VERSION, newId, type Flow } from '@hermes/ir';
import { createWebProvider } from '../src/web-provider.js';
import { registerWebHandlers } from '../src/handlers.js';

const RUN_E2E = process.env['HERMES_E2E'] === '1';

(RUN_E2E ? describe : describe.skip)('e2e: system Chrome via channel:"chrome"', () => {
  it('opens example.com and extracts the headline', async () => {
    const profile = join(tmpdir(), `hermes-e2e-${Date.now()}`);
    await mkdir(profile, { recursive: true });

    const flow: Flow = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: newId(),
      name: 'e2e smoke',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputs: [],
      outputs: [],
      variables: [],
      defaults: {
        timeoutMs: 30_000,
        retry: { attempts: 1 },
        screenshotOnError: false,
        waitBetweenStepsMs: 0,
      },
      steps: [
        {
          id: newId(),
          type: 'open_url',
          enabled: true,
          params: { url: 'https://example.com/', waitUntil: 'load' },
        },
        {
          id: newId(),
          type: 'extract',
          enabled: true,
          target: {
            layer: 'web',
            candidates: [{ kind: 'css', value: 'h1' }],
          },
          params: { attribute: 'innerText', into: 'headline' },
        },
        {
          id: newId(),
          type: 'log',
          enabled: true,
          params: { level: 'info', message: 'opened example.com successfully' },
        },
      ],
      metadata: { origin: 'recorded', targets: ['web'], requiredPermissions: [] },
    };

    const provider = createWebProvider({
      profileDir: profile,
      headless: true,
      channel: 'chrome',
    });

    await provider.start();
    try {
      const registry = new HandlerRegistry();
      registerWebHandlers(registry);

      const executor = new StepExecutor({ registry, providers: { web: provider } });
      const events: RunEvent[] = [];
      executor.on((e) => events.push(e));

      const outcome = await executor.run(flow);

      expect(outcome).toBe('success');
      const endEvents = events.filter((e) => e.type === 'step:end');
      expect(endEvents.length).toBe(3);
      expect(endEvents.every((e) => e.type === 'step:end' && e.outcome === 'completed')).toBe(true);
    } finally {
      await provider.close();
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
});
