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
 *
 * The OS-specific connection lives behind the Transport seam (transport.ts):
 * a Unix Domain Socket today, a Windows named pipe later, or a fake channel
 * in tests. This client owns only the transport-agnostic parts — line
 * framing, the JSON-RPC envelope, pending-call bookkeeping and timeouts.
 */
import { SocketTransport, type Transport } from './transport.js';

export { SocketTransport };
export type { Transport };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface SidecarClientOptions {
  /** UDS / named-pipe path. Required unless a transport is supplied. */
  socketPath?: string;
  /** Inject a transport (tests, alternate OS). Takes precedence over socketPath. */
  transport?: Transport;
  /** Default per-call timeout in ms. */
  defaultTimeoutMs?: number;
}

export class SidecarClient {
  private readonly transport: Transport;
  private readonly defaultTimeoutMs?: number;
  private handlersBound = false;
  private connecting: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';

  constructor(opts: SidecarClientOptions) {
    if (opts.transport) {
      this.transport = opts.transport;
    } else if (opts.socketPath) {
      this.transport = new SocketTransport({ path: opts.socketPath });
    } else {
      throw new Error('SidecarClient requires either socketPath or transport');
    }
    this.defaultTimeoutMs = opts.defaultTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.transport.connected) return;
    if (this.connecting) return this.connecting;
    // Bind framing + teardown once. The transport rewires these onto each
    // fresh socket it opens, so they survive reconnects.
    if (!this.handlersBound) {
      this.transport.onData((chunk) => this.onData(chunk));
      this.transport.onClose(() => this.failAll(new Error('Sidecar socket closed')));
      this.handlersBound = true;
    }
    this.connecting = this.transport.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    await this.connect();
    if (!this.transport.connected) throw new Error('sidecar not connected');
    const id = this.nextId++;
    const body =
      JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? null }) + '\n';
    const t = timeoutMs ?? this.defaultTimeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar call '${method}' timed out after ${t}ms`));
      }, t);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.write(body).catch((err) => {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  dispose(): void {
    this.failAll(new Error('client disposed'));
    this.transport.close();
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
