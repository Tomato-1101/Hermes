import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chromeSingletonLockExists } from './chrome-process.js';

describe('chromeSingletonLockExists', () => {
  let tmp = '';
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'hermes-chrome-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns false for an empty profile dir', () => {
    expect(chromeSingletonLockExists(tmp)).toBe(false);
  });

  it('detects SingletonLock at the user-data-dir root (one level above profile)', async () => {
    // Layout: <tmp>/Chrome/Default/  (profile) , <tmp>/Chrome/SingletonLock
    const userDataDir = join(tmp, 'Chrome');
    const profile = join(userDataDir, 'Default');
    await mkdir(profile, { recursive: true });
    await writeFile(join(userDataDir, 'SingletonLock'), '');
    expect(chromeSingletonLockExists(profile)).toBe(true);
  });

  it('detects SingletonSocket at the profile dir itself (user-data-dir directly picked)', async () => {
    await writeFile(join(tmp, 'SingletonSocket'), '');
    expect(chromeSingletonLockExists(tmp)).toBe(true);
  });

  it('detects SingletonCookie too (some Chrome builds only drop this one)', async () => {
    await writeFile(join(tmp, 'SingletonCookie'), '');
    expect(chromeSingletonLockExists(tmp)).toBe(true);
  });

  it('returns false for an empty string path (defensive)', () => {
    expect(chromeSingletonLockExists('')).toBe(false);
  });
});
