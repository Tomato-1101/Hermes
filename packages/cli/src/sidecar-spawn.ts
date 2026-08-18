/**
 * Headless macOS sidecar launcher for the CLI.
 *
 * apps/hermes spawns the Swift `hermes-native` binary from its Electron main
 * process; the CLI needs the same thing without Electron. This spawns the
 * binary, waits for its "listening" handshake on stdout, then connects a
 * SidecarClient over the per-run Unix Domain Socket. The A2 transport seam
 * means we just hand SidecarClient a socket path and it dials the UDS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarClient } from '@hermes/desktop-adapter/sidecar-client';

export interface SpawnSidecarOptions {
  /** Explicit binary path. Overrides env + build-dir lookup. */
  binaryPath?: string;
  /** How long to wait for the listening handshake. */
  startupTimeoutMs?: number;
}

export interface SidecarHandle {
  client: SidecarClient;
  dispose: () => void;
}

export async function spawnSidecar(opts: SpawnSidecarOptions = {}): Promise<SidecarHandle> {
  const binary = opts.binaryPath ?? locateBinary();
  if (!binary) {
    throw new Error(
      'hermes-native binary not found. Build it first: `pnpm sidecar:mac:build:debug` ' +
        '(or set HERMES_NATIVE_BIN).',
    );
  }
  const sockPath = join(tmpdir(), `hermes-native-cli-${process.pid}-${Date.now()}.sock`);
  const child = spawn(binary, ['--socket', sockPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_NATIVE_SOCKET: sockPath },
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => process.stderr.write(`[hermes-native] ${c}`));

  await waitForListening(child, opts.startupTimeoutMs ?? 3000);

  const client = new SidecarClient({ socketPath: sockPath });
  await client.connect();

  return {
    client,
    dispose: () => {
      client.dispose();
      if (!child.killed) child.kill('SIGTERM');
    },
  };
}

function waitForListening(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((res, rej) => {
    const timer = setTimeout(() => {
      rej(new Error(`sidecar startup timed out (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    const onData = (chunk: string): void => {
      if (chunk.includes('hermes-native listening')) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        res();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timer);
      rej(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rej(new Error(`sidecar exited before listening (code=${code ?? '?'})`));
    });
  });
}

function locateBinary(): string | null {
  const envBin = process.env['HERMES_NATIVE_BIN'];
  if (envBin && existsSync(envBin) && statSync(envBin).isFile()) return envBin;

  // packages/cli/src/ → repo root is three levels up.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(here, '..', '..', '..');
  const candidates = [
    join(repoRoot, 'sidecars', 'macos-native', '.build', 'debug', 'hermes-native'),
    join(repoRoot, 'sidecars', 'macos-native', '.build', 'release', 'hermes-native'),
  ];
  // Newest build wins, so a fresh `swift build -c release` is preferred over a
  // stale debug binary (same rule apps/hermes uses).
  let pick: { path: string; mtime: number } | null = null;
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      const s = statSync(c);
      if (!s.isFile()) continue;
      if (!pick || s.mtimeMs > pick.mtime) pick = { path: c, mtime: s.mtimeMs };
    } catch {
      // ignore — build dir may not exist yet
    }
  }
  return pick?.path ?? null;
}
