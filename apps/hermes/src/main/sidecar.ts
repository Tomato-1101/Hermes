/**
 * macOS native sidecar bridge.
 *
 * Responsibilities:
 *  - Spawn the `hermes-native` Swift binary as a child process.
 *  - Pick a per-run Unix Domain Socket path under the user's tmp dir.
 *  - Speak line-delimited JSON-RPC 2.0 over that socket.
 *  - Restart on unexpected exit (lazy: next call respawns).
 *  - Expose a typed `pingSidecar()` for the IPC layer.
 *
 * Phase 0 surface: only `ping`. Phase 1 adds findElement / click / type etc.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import type { z } from 'zod';
import type { SidecarPingResult } from '../shared/ipc.js';

export type SidecarPing = z.infer<typeof SidecarPingResult>;

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

class Sidecar {
  private child: ChildProcess | null = null;
  private socket: Socket | null = null;
  private socketPath: string | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private readBuf = '';
  private starting: Promise<void> | null = null;

  async ensureStarted(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    const binary = locateBinary();
    if (!binary) throw new Error('hermes-native binary not found');
    const sockPath = join(
      tmpdir(),
      `hermes-native-${process.pid}-${Date.now()}.sock`,
    );
    this.socketPath = sockPath;

    const child = spawn(binary, ['--socket', sockPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HERMES_NATIVE_SOCKET: sockPath },
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      console.error('[hermes-native]', chunk.trimEnd());
    });
    child.on('exit', (code, signal) => {
      console.warn(
        `[hermes-native] exited code=${code ?? '?'} signal=${signal ?? '?'}`,
      );
      this.failAllPending(new Error('sidecar exited'));
      this.socket?.destroy();
      this.socket = null;
      this.child = null;
    });

    // Wait until the binary announces it's listening (or the socket file appears).
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        rej(new Error('sidecar startup timed out (3s)'));
      }, 3000);
      const onStdout = (chunk: string) => {
        if (chunk.includes('hermes-native listening')) {
          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          res();
        }
      };
      child.stdout?.on('data', onStdout);
      child.on('error', (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });

    // Connect.
    await new Promise<void>((res, rej) => {
      const sock = createConnection(sockPath);
      const timer = setTimeout(() => {
        sock.destroy();
        rej(new Error('connect timed out (2s)'));
      }, 2000);
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.setEncoding('utf8');
        sock.on('data', (data: string) => this.onData(data));
        sock.on('close', () => {
          this.failAllPending(new Error('socket closed'));
          this.socket = null;
        });
        res();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        rej(err);
      });
    });
  }

  private onData(chunk: string): void {
    this.readBuf += chunk;
    let nl;
    while ((nl = this.readBuf.indexOf('\n')) >= 0) {
      const line = this.readBuf.slice(0, nl);
      this.readBuf = this.readBuf.slice(nl + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.warn('[hermes-native] malformed response:', line, err);
      return;
    }
    if (typeof msg.id !== 'number') return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async call(method: string, params?: unknown, timeoutMs = 5000): Promise<unknown> {
    await this.ensureStarted();
    if (!this.socket) throw new Error('sidecar socket unavailable');
    const id = this.nextId++;
    const body =
      JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`sidecar call '${method}' timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(body, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    this.failAllPending(new Error('disposing'));
    this.socket?.destroy();
    this.socket = null;
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
  }
}

function locateBinary(): string | null {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // Search order:
  //   1. HERMES_NATIVE_BIN env override
  //   2. packaged resources next to the app (process.resourcesPath/sidecars/hermes-native)
  //   3. monorepo dev build (sidecars/macos-native/.build/debug/hermes-native)
  //   4. monorepo release build (.build/release/hermes-native)
  const candidates: string[] = [];
  const env = process.env['HERMES_NATIVE_BIN'];
  if (env) candidates.push(env);
  if (app && app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'sidecars', 'hermes-native'));
  }
  const repoRoot = resolve(__dirname, '..', '..', '..', '..');
  candidates.push(
    join(repoRoot, 'sidecars', 'macos-native', '.build', 'debug', 'hermes-native'),
    join(repoRoot, 'sidecars', 'macos-native', '.build', 'release', 'hermes-native'),
  );
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      // ignore
    }
  }
  // ensure the dir exists for diagnostic logs
  try {
    mkdirSync(dirname(candidates[candidates.length - 1]!), { recursive: true });
  } catch {
    // ignore
  }
  return null;
}

const singleton = new Sidecar();

export async function pingSidecar(): Promise<SidecarPing> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: 'Sidecar is only available on macOS (phase 0).' };
  }
  const t0 = performance.now();
  try {
    const result = (await singleton.call('ping', null, 3000)) as {
      pong?: boolean;
      version?: string;
    };
    const latencyMs = performance.now() - t0;
    return {
      ok: result?.pong === true,
      reply: result?.version ?? 'pong',
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function disposeSidecar(): void {
  singleton.dispose();
}
