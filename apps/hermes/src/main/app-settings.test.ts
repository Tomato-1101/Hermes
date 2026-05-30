import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub out flow-paths so dataRoot() points at a per-test tmp dir. We do this
// via vi.mock because app-settings.ts captures the dataRoot() callable at
// import time on the module's top-level path resolver.
let currentTmp = '';
vi.mock('./flow-paths.js', () => ({
  dataRoot: () => currentTmp,
  flowsRoot: () => join(currentTmp, 'flows'),
  flowProfileDir: (id: string) => join(currentTmp, 'flows', id, 'browser-profile'),
}));

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './app-settings.js';

describe('app-settings persistence', () => {
  beforeEach(async () => {
    currentTmp = await mkdtemp(join(tmpdir(), 'hermes-settings-'));
  });
  afterEach(async () => {
    await rm(currentTmp, { recursive: true, force: true });
  });

  it('loadSettings returns DEFAULT_SETTINGS when no file exists', async () => {
    const got = await loadSettings();
    expect(got).toEqual(DEFAULT_SETTINGS);
  });

  it('default browser mode is system-chrome-import (post-fix)', () => {
    expect(DEFAULT_SETTINGS.browser.mode).toBe('system-chrome-import');
  });

  it('saveSettings persists then loadSettings reads back', async () => {
    await saveSettings({
      browser: { mode: 'system-chrome', systemChromePath: '/x/y' },
    });
    const got = await loadSettings();
    expect(got.browser.mode).toBe('system-chrome');
    expect(got.browser.systemChromePath).toBe('/x/y');
    // humanize defaults preserved
    expect(got.humanize).toEqual(DEFAULT_SETTINGS.humanize);
  });

  it('saveSettings preserves unknown keys already on disk', async () => {
    // Simulate a future Hermes version having written extra fields the
    // current build doesn't recognize. They must survive a round-trip.
    const target = join(currentTmp, 'settings.json');
    await writeFile(
      target,
      JSON.stringify({
        browser: { mode: 'system-chrome-import', futureKey: 'keep-me' },
        humanize: DEFAULT_SETTINGS.humanize,
        unknownTopLevel: { nested: 42 },
      }),
      'utf8',
    );

    // Touch only one section.
    await saveSettings({ humanize: { typeDelayMs: 75 } });

    const raw = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(raw['unknownTopLevel']).toEqual({ nested: 42 });
    const browser = raw['browser'] as Record<string, unknown>;
    expect(browser['futureKey']).toBe('keep-me');
    const humanize = raw['humanize'] as Record<string, unknown>;
    expect(humanize['typeDelayMs']).toBe(75);
  });

  it('saveSettings merges a partial browser patch with the existing path', async () => {
    // First write: set the picker path.
    await saveSettings({
      browser: { mode: 'system-chrome-import', systemChromePath: '/p/q' },
    });
    // Second write: change only the mode. The path must NOT be lost — this
    // is the bug AppSettingsPanel hit pre-fix (partial patches were
    // overwriting unrelated fields).
    await saveSettings({ browser: { mode: 'system-chrome' } });
    const got = await loadSettings();
    expect(got.browser.mode).toBe('system-chrome');
    expect(got.browser.systemChromePath).toBe('/p/q');
  });

  it('saveSettings writes atomically (no .tmp left on disk after success)', async () => {
    await saveSettings({ humanize: { typeDelayMs: 10 } });
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(currentTmp);
    expect(entries).toContain('settings.json');
    expect(entries).not.toContain('settings.json.tmp');
  });
});
