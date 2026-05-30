/**
 * Transport seam for the sidecar JSON-RPC client.
 *
 * The client speaks line-delimited JSON over a bidirectional byte channel.
 * That channel is the only OS-specific piece: macOS uses a Unix Domain
 * Socket, Windows will use a named pipe. Node's `net` module dials both
 * through a path, so a single SocketTransport already covers them — the OS
 * difference collapses to the path string the caller supplies. Isolating
 * the connection here (instead of calling createConnection inline) keeps
 * that seam in one place for the eventual Windows swap and lets tests inject
 * a fake channel without a real socket.
 */
import { createConnection, type Socket } from 'node:net';

export interface Transport {
  /** Open the channel. Resolves once writable; rejects on error/timeout. */
  connect(): Promise<void>;
  /** Send one already-framed payload (the caller appends the newline). */
  write(data: string): Promise<void>;
  /** Open and writable right now? */
  readonly connected: boolean;
  /**
   * Register the inbound-data handler (decoded utf8 chunks, not yet framed).
   * Set once by the client; the binding survives reconnects.
   */
  onData(handler: (chunk: string) => void): void;
  /** Register the channel-closed handler. Set once; survives reconnects. */
  onClose(handler: () => void): void;
  /** Tear down the channel. Idempotent. */
  close(): void;
}

export interface SocketTransportOptions {
  /** UDS path (macOS) or named-pipe path (Windows: \\.\pipe\name). */
  path: string;
  /** Connect timeout in ms. */
  connectTimeoutMs?: number;
}

/**
 * `node:net` stream-socket transport. The same class serves a Unix Domain
 * Socket and a Windows named pipe — only `path` differs. Each connect()
 * creates a fresh socket (UDS/pipe sockets cannot be re-opened) and rewires
 * it to the persistent data/close handlers, so the client can reconnect
 * transparently after a drop.
 */
export class SocketTransport implements Transport {
  private socket: Socket | null = null;
  private dataHandler: ((chunk: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;

  constructor(private readonly opts: SocketTransportOptions) {}

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const sock = createConnection(this.opts.path);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Sidecar connect timed out: ${this.opts.path}`));
      }, this.opts.connectTimeoutMs ?? 5_000);
      sock.once('connect', () => {
        clearTimeout(timer);
        this.socket = sock;
        sock.setEncoding('utf8');
        sock.on('data', (chunk: string) => this.dataHandler?.(chunk));
        sock.on('close', () => {
          this.socket = null;
          this.closeHandler?.();
        });
        resolve();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  write(data: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('transport not connected'));
        return;
      }
      this.socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
