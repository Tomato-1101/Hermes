/**
 * Resolve filesystem paths for Hermes flows.
 *
 * One flow = one directory at `<root>/flows/<id>/` containing:
 *   flow.json            the IR
 *   browser-profile/     per-flow Chromium profile (cookies, localStorage)
 *   assets/              screenshots and other captured assets
 *   history/             past run logs (JSONL)
 *
 * `<root>` resolves to:
 *   - `HERMES_DATA_DIR` env override (used by tests)
 *   - `<userData>/data` when packaged
 *   - `<repo>/.hermes-dev` during development
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

export function dataRoot(): string {
  const env = process.env['HERMES_DATA_DIR'];
  if (env) return env;
  if (app && app.isPackaged) return join(app.getPath('userData'), 'data');
  // dev mode: keep alongside the repo so it's easy to inspect.
  return resolve(process.cwd(), '.hermes-dev');
}

export function flowsRoot(): string {
  return join(dataRoot(), 'flows');
}

export function flowDir(id: string): string {
  return join(flowsRoot(), id);
}

export function flowProfileDir(id: string): string {
  return join(flowDir(id), 'browser-profile');
}

export function flowExists(id: string): boolean {
  return existsSync(join(flowDir(id), 'flow.json'));
}
