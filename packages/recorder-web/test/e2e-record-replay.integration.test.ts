/**
 * End-to-end integration: record actions against real Chrome, then
 * replay them through the engine. Verifies the entire phase-1 chain:
 * WebProvider → WebRecorder → IR → StepExecutor → WebProvider.
 *
 * Skipped unless HERMES_E2E=1.
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandlerRegistry, StepExecutor } from '@hermes/engine';
import { CURRENT_SCHEMA_VERSION, newId, type Flow, type Step } from '@hermes/ir';
import { createWebProvider, registerWebHandlers } from '@hermes/web-provider';
import { WebRecorder } from '../src/recorder.js';

const RUN_E2E = process.env['HERMES_E2E'] === '1';

(RUN_E2E ? describe : describe.skip)('e2e: record → replay loop', () => {
  it('captures click + input on a data: URL page and replays them', async () => {
    const profile1 = join(tmpdir(), `hermes-rec-${Date.now()}`);
    const profile2 = join(tmpdir(), `hermes-rep-${Date.now()}`);
    await mkdir(profile1, { recursive: true });
    await mkdir(profile2, { recursive: true });

    const html = `
      <!doctype html><html><body>
        <input id="name" data-testid="name-input" />
        <button id="go" data-testid="go-button">Go</button>
        <div id="out"></div>
        <script>
          const out = document.getElementById('out');
          const inp = document.getElementById('name');
          document.getElementById('go').addEventListener('click', () => {
            out.textContent = 'hello ' + inp.value;
          });
        </script>
      </body></html>`;
    const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

    // ----- RECORD PHASE -----
    const recProvider = createWebProvider({
      profileDir: profile1,
      headless: true,
      channel: 'chrome',
    });
    await recProvider.start();
    const recorder = new WebRecorder();
    await recorder.attach(recProvider);

    const captured: Step[] = [];
    recorder.on('step', (e) => captured.push(e.step));

    recorder.start();
    const page = recProvider.page();
    await page.goto(url);
    await page.click('[data-testid="name-input"]'); // captured as click
    await page.fill('[data-testid="name-input"]', 'world'); // captured as input
    await page.click('[data-testid="go-button"]'); // captured as click
    // Give the binding callbacks a tick to land.
    await page.waitForTimeout(200);
    recorder.stop();
    await recorder.detach();
    await recProvider.close();

    // Drop nav events (data: URL nav comes through too); keep input/click.
    const actionable = captured.filter((s) => s.type === 'click' || s.type === 'type');
    expect(actionable.length).toBeGreaterThanOrEqual(2); // at least click+input on input + click on go

    // ----- BUILD FLOW -----
    const flow: Flow = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: newId(),
      name: 'e2e replay',
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
          params: { url, waitUntil: 'load' },
        },
        ...actionable,
        {
          id: newId(),
          type: 'extract',
          enabled: true,
          target: { layer: 'web', candidates: [{ kind: 'css', value: '#out' }] },
          params: { attribute: 'innerText', into: 'out' },
        },
      ],
      metadata: { origin: 'recorded', targets: ['web'], requiredPermissions: [] },
    };

    // ----- REPLAY PHASE -----
    const repProvider = createWebProvider({
      profileDir: profile2,
      headless: true,
      channel: 'chrome',
    });
    await repProvider.start();
    try {
      const reg = new HandlerRegistry();
      registerWebHandlers(reg);
      const executor = new StepExecutor({ registry: reg, providers: { web: repProvider } });
      const outcome = await executor.run(flow);
      expect(outcome).toBe('success');
    } finally {
      await repProvider.close();
      await rm(profile1, { recursive: true, force: true }).catch(() => {});
      await rm(profile2, { recursive: true, force: true }).catch(() => {});
    }
  }, 90_000);
});
