/**
 * Process-wide Hermes preferences (browser profile choice, humanize defaults).
 *
 * Persisted as a single JSON file under the data root so it survives across
 * app launches and lives next to the existing flows/ tree. Fields are
 * additive — unknown keys are preserved on write so older binaries don't
 * trample values written by a newer one.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataRoot } from './flow-paths.js';

export type BrowserProfileMode =
  | 'hermes-profile'
  | 'system-chrome'
  | 'system-chrome-import';

export interface AppSettings {
  browser: {
    mode: BrowserProfileMode;
    /** Filesystem path to the directory Playwright should use as user-data-dir.
     *  For system-chrome / system-chrome-import this is the picked Chrome
     *  profile directory (e.g. `~/Library/Application Support/Google/Chrome/Default`). */
    systemChromePath?: string;
    /** Display label of the chosen Chrome profile (the basename of systemChromePath). */
    systemChromeProfileName?: string;
    channel?: 'chrome' | 'chromium';
  };
  humanize: {
    /** Pixels per second for click-time mouse interpolation. 0 = teleport. */
    mouseSpeedPxPerSec: number;
    /** Milliseconds between successive characters when typing. 0 = paste. */
    typeDelayMs: number;
    /** Lower bound on Playwright's mouse.move steps parameter. */
    mouseMinSteps: number;
    /** Upper bound on Playwright's mouse.move steps parameter. */
    mouseMaxSteps: number;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  browser: {
    // system-chrome-import copies the user's Chrome state into a Hermes-managed
    // profile, so the embedded Chromium never fights the real Chrome over
    // SingletonLock. system-chrome (live) is still selectable for users who hit
    // reCAPTCHA even with the imported state.
    mode: 'system-chrome-import',
    channel: 'chrome',
  },
  humanize: {
    mouseSpeedPxPerSec: 800,
    typeDelayMs: 50,
    // 16 floor / 1200 ceiling targets ~6ms per waypoint (~166 fps).
    // That's the smoothness sweet spot once you account for Swift loop
    // overhead — going finer made the Swift side slip and ironically
    // dropped visible fps. See Input.swift:postMouseMoveSmooth for the
    // four optimisations the 6ms cadence relies on (CGEvent reuse,
    // delta stamping, QoS, busy-spin).
    mouseMinSteps: 16,
    mouseMaxSteps: 1200,
  },
};

function settingsPath(): string {
  return join(dataRoot(), 'settings.json');
}

/** Partial all the way down — `saveSettings` accepts e.g. `{ humanize:
 *  { typeDelayMs: 75 } }` without forcing the caller to fill in every
 *  unrelated humanize / browser field. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Merge `over` onto `base`, preserving keys present only in `base`. Shallow
 *  recursive — sufficient for the AppSettings shape which is two levels deep. */
function mergeDeep<T>(base: T, over: DeepPartial<T>): T {
  if (!over || typeof over !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      cur &&
      typeof cur === 'object' &&
      !Array.isArray(cur)
    ) {
      out[k] = mergeDeep(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * One-shot fix-up for stale humanize values from older Hermes builds.
 *
 * Earlier builds shipped `mouseMaxSteps: 60` (and even smaller floors)
 * — fine at the time, way under the ~166fps cadence the current
 * adapter targets. Because settings.json is round-tripped through
 * mergeDeep, a stale 60 on disk **wins over** the new DEFAULT_SETTINGS
 * value of 1200, silently capping every replay at 60 steps regardless
 * of distance. The user never touched these values; they got frozen by
 * a saveSettings call on a previous version.
 *
 * Anything below the documented sane floor here is treated as a stale
 * old default and bumped to the current default. We only raise; if the
 * user has deliberately set a higher value we leave it alone.
 */
function migrateSettings(s: AppSettings): { settings: AppSettings; changed: boolean } {
  let changed = false;
  let humanize = s.humanize;
  if (humanize.mouseMaxSteps < 200) {
    humanize = { ...humanize, mouseMaxSteps: DEFAULT_SETTINGS.humanize.mouseMaxSteps };
    changed = true;
  }
  if (humanize.mouseMinSteps < 8) {
    humanize = { ...humanize, mouseMinSteps: DEFAULT_SETTINGS.humanize.mouseMinSteps };
    changed = true;
  }
  if (!changed) return { settings: s, changed: false };
  return { settings: { ...s, humanize }, changed: true };
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as DeepPartial<AppSettings>;
    const merged = mergeDeep(DEFAULT_SETTINGS, parsed);
    const { settings, changed } = migrateSettings(merged);
    if (changed) {
      // Persist immediately so we don't run the migration every boot.
      // Best-effort: a write failure here is non-fatal because the
      // in-memory `settings` is already migrated for this session.
      await writeMigratedSettings(settings).catch(() => undefined);
      // eslint-disable-next-line no-console
      console.warn(
        `[hermes:settings] migrated stale humanize values to {mouseMinSteps:${settings.humanize.mouseMinSteps}, mouseMaxSteps:${settings.humanize.mouseMaxSteps}}`,
      );
    }
    return settings;
  } catch {
    // First run / corrupted file: fall through to defaults.
    return DEFAULT_SETTINGS;
  }
}

/** Like saveSettings but skips the read-merge round-trip; used by the
 *  loadSettings migration path where the caller already has the merged
 *  shape and just needs to flush it. */
async function writeMigratedSettings(s: AppSettings): Promise<void> {
  const target = settingsPath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2), 'utf8');
  await rename(tmp, target);
}

/**
 * Persist the next AppSettings. We merge on top of what's already on disk
 * (rather than overwriting blindly) so:
 *   - Unknown keys from a newer-version of Hermes survive.
 *   - Partial updates ({ humanize: { typeDelayMs: 80 } }) don't drop the
 *     browser block.
 *   - The renderer can send only the section it changed without having to
 *     read-modify-write the whole settings tree first.
 */
export async function saveSettings(next: DeepPartial<AppSettings>): Promise<void> {
  const target = settingsPath();
  await mkdir(dirname(target), { recursive: true });
  const current = await loadSettings();
  const merged = mergeDeep(current, next);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
  await rename(tmp, target);
}
