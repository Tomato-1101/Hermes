/**
 * Detect whether a system Google Chrome browser is currently running.
 *
 * When the user picks `system-chrome` profile mode, we need to bail out
 * before Playwright tries to take over a user-data-dir Chrome already holds
 * open — Chrome's SingletonLock would either reject our launch or, worse,
 * silently corrupt the profile.
 *
 * Strategy: shell out to `pgrep -fil 'Google Chrome'`. macOS-only; on other
 * platforms returns `false` (the caller will already have refused
 * system-chrome mode anyway).
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execp = promisify(exec);

export async function isChromeRunning(): Promise<boolean> {
  if (os.platform() !== 'darwin') return false;
  try {
    // Match the broader bundle path so Helper / Renderer / crashpad_handler
    // child processes count too. We've seen the user Cmd-Q the main
    // process while a Helper lingered just long enough to keep the
    // SingletonLock alive, so checking only Contents/MacOS/Google\ Chrome
    // (the original probe) missed real "Chrome is still alive" cases.
    const { stdout } = await execp(
      'pgrep -f "/Applications/Google Chrome.app"',
      { timeout: 3000 },
    );
    return stdout.trim().length > 0;
  } catch {
    // pgrep returns 1 (and exec rejects) when no matches. Treat that as
    // "not running"; any other failure is logged silently and treated as
    // "not running" too — the worst case is we let Playwright try and fail
    // with a clearer error than ours.
    return false;
  }
}

/**
 * Returns true when the chosen Chrome profile directory still holds a
 * singleton marker. Chrome creates `SingletonLock` / `SingletonSocket` /
 * `SingletonCookie` at the user-data-dir root (i.e. the parent of `Default`)
 * the first time the browser is launched and unlinks them on a clean
 * shutdown. A stale lock left behind after a crash will *also* trip
 * Playwright's launchPersistentContext, so we treat its presence as
 * "Chrome (or a ghost of it) is still holding this profile".
 *
 * `profilePath` is the *profile* directory the user picked (e.g. `.../Chrome/Default`).
 * The Singleton files live one level up — at the user-data-dir root.
 */
export function chromeSingletonLockExists(profilePath: string): boolean {
  if (!profilePath) return false;
  // The user typically picks ".../Chrome/Default" (a profile). Singleton
  // markers sit at ".../Chrome" (the user-data-dir). Check both, since some
  // setups point straight at the user-data-dir.
  const candidates = new Set<string>([profilePath]);
  const parent = join(profilePath, '..');
  candidates.add(parent);
  for (const dir of candidates) {
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Best-effort default Chrome user-data-dir for the picker UI's starting
 * directory. Returns the parent of `Default`, not `Default` itself, so the
 * file dialog lets the user pick which profile to use.
 */
export function defaultChromeUserDataDir(): string | null {
  if (os.platform() !== 'darwin') return null;
  const p = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return existsSync(p) ? p : null;
}
