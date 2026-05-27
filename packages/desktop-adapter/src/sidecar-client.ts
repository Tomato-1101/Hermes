/**
 * JSON-RPC client over a Unix Domain Socket.
 *
 * Talks to the hermes-native Swift sidecar. The wire format is one JSON
 * request per line (with trailing newline), one JSON response per line.
 * The sidecar itself is line-delimited; we read until '\n', parse the
 * envelope, and resolve the matching pending call by id.
 *
 * The client does NOT spawn the sidecar — that's the caller's job (in
 * apps/hermes, the Main process does it). The client just connects to a
 * known socket path. This keeps the adapter usable from tests too.
 */
import { createConnection, type Socket } from 'node:net';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface SidecarClientOptions {
  socketPath: string;
  /** Default per-call timeout in ms. */
  defaultTimeoutMs?: number;
}

export class SidecarClient {
  private socket: Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';

  constructor(private readonly opts: SidecarClientOptions) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.opts.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Sidecar connect timed out: ${this.opts.socketPath}`));
      }, 5_000);
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.onData(chunk));
        sock.on('close', () => {
          this.failAll(new Error('Sidecar socket closed'));
          this.socket = null;
        });
        resolve();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    await this.connect();
    if (!this.socket) throw new Error('sidecar not connected');
    const id = this.nextId++;
    const body =
      JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n';
    const t = timeoutMs ?? this.opts.defaultTimeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar call '${method}' timed out after ${t}ms`));
      }, t);
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
    this.failAll(new Error('client disposed'));
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else {
      p.resolve(msg.result);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
